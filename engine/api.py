"""Read-only JSON over the engine, for the dashboard to render.

Phase 4's architecture line: the Python engine owns data, decisions and state,
and the Next.js app becomes a view over it. This is the seam. The dashboard
stops asking Yahoo what NIFTY did and asks the engine, which answers from the
same archive the backtest ran on — so the chart a trader looks at and the
number a backtest reports come from one source.

Three properties are deliberate:

  * **Read-only, and GET-only.** Nothing here can move money or mutate state
    beyond topping up the candle archive. When orders and positions land in a
    later phase, that must arrive as a separate authenticated service; adding a
    POST here would be the cheapest possible way to lose money to a stray
    request.
  * **Bound to localhost.** There is no authentication, because there is
    nothing to authenticate to yet. The Next.js server proxies to it, so the
    engine never faces the public net. `--host 0.0.0.0` exists for a container
    network and prints a warning, because on a VPS it would expose the archive.
  * **The archive is topped up, not bypassed.** During market hours a request
    for candles will pull the last couple of days from the live source when the
    newest stored bar has gone stale, then serve from the store. That keeps the
    dashboard live without letting it read a second, differently-shaped source
    behind the engine's back. A provider failure never fails the request: the
    response is served from the store and marked `stale`.
"""
from __future__ import annotations

import json
import logging
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable
from urllib.parse import parse_qs, urlparse

from .core import indicators as ind
from .core import signals as sig
from .core import smc
from .core import suggestion as sug
from .data import CandleStore, get_source, market_status
from .data.timeutil import IST, from_epoch_ms

log = logging.getLogger(__name__)

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8787

#: Interval to milliseconds, for deciding whether the newest bar is stale.
INTERVAL_MS: dict[str, int] = {
    "1m": 60_000,
    "5m": 300_000,
    "15m": 900_000,
    "1h": 3_600_000,
    "1d": 86_400_000,
}

#: Mirrors the cron's settings, so a suggestion served here matches the one the
#: live tick would produce for the same bars.
DEFAULT_SETTINGS: dict[str, Any] = {
    "riskLimit": 10000,
    "profitPct": 1.5,
    "slPct": 0.8,
    "ind": {"rsi": True, "macd": True, "bb": True, "ema20": True, "ema50": True, "vol": True},
}


@dataclass
class ApiConfig:
    host: str = DEFAULT_HOST
    port: int = DEFAULT_PORT
    #: Provider used to top the archive up. Fyers gives deep intraday history
    #: and the option chain on the same credentials the engine already holds.
    source: str = "fyers"
    #: Off for a machine with no broker credentials: the archive is then served
    #: exactly as synced, which is right for research and wrong for a live view.
    live: bool = True
    #: Responses are memoised for this long. The dashboard polls every five
    #: seconds per instrument, and recomputing an indicator bundle over 375 bars
    #: on every poll is work nobody asked for.
    ttl: float = 3.0
    #: Floor between provider calls for one series, whatever the poll rate.
    min_refresh_seconds: float = 20.0
    bars: int = 375


class _Cache:
    """Tiny TTL memo. Keyed on the request, cleared by time alone."""

    def __init__(self, ttl: float) -> None:
        self.ttl = ttl
        self._lock = threading.Lock()
        self._items: dict[str, tuple[float, Any]] = {}

    def get(self, key: str) -> Any | None:
        with self._lock:
            hit = self._items.get(key)
        if hit and time.monotonic() - hit[0] < self.ttl:
            return hit[1]
        return None

    def put(self, key: str, value: Any) -> Any:
        with self._lock:
            self._items[key] = (time.monotonic(), value)
        return value


class ApiError(Exception):
    def __init__(self, message: str, status: int = 400) -> None:
        super().__init__(message)
        self.status = status


@dataclass
class Engine:
    """What the handlers are allowed to touch."""

    config: ApiConfig
    store: CandleStore = field(default_factory=CandleStore)
    cache: _Cache = field(init=False)
    _last_refresh: dict[str, float] = field(default_factory=dict)
    _lock: threading.Lock = field(default_factory=threading.Lock)

    def __post_init__(self) -> None:
        self.cache = _Cache(self.config.ttl)

    # -- freshness ----------------------------------------------------------

    def _is_open(self) -> bool:
        # Not strict: an unknown holiday year must not take the dashboard down,
        # and the worst case here is one wasted provider call on a holiday.
        return bool(market_status(strict=False).get("open"))

    def refresh(self, symbol: str, segment: str, interval: str) -> str:
        """Top the archive up if the newest bar has aged out. Never raises."""
        if not self.config.live or not self._is_open():
            return "skipped"

        key = f"{symbol}:{segment}:{interval}"
        newest = self.store.read(symbol, segment, interval, limit=1)
        age = time.time() * 1000 - newest[0].ts if newest else float("inf")
        if age < INTERVAL_MS.get(interval, 300_000):
            return "fresh"

        with self._lock:
            since = time.monotonic() - self._last_refresh.get(key, 0.0)
            if since < self.config.min_refresh_seconds:
                return "throttled"
            self._last_refresh[key] = time.monotonic()

        try:
            self.store.sync(get_source(self.config.source), symbol, interval, segment, days=2)
            return "synced"
        except Exception as e:
            # A dead token at 09:20 must not blank the chart. Serve the archive
            # and let the response say it is stale.
            log.warning("refresh %s failed: %s", key, e)
            return "failed"

    # -- reads --------------------------------------------------------------

    def candles(self, symbol: str, segment: str, interval: str, limit: int) -> dict:
        state = self.refresh(symbol, segment, interval)
        rows = ind.candles_to_dicts(self.store.read(symbol, segment, interval, limit=limit))
        if not rows:
            raise ApiError(
                f"no {interval} bars archived for {symbol}. "
                f"Run: python -m engine.cli sync --symbol {symbol} --interval {interval}",
                status=404,
            )
        if interval in ("1d", "1wk"):
            for row in rows:
                row["t"] = from_epoch_ms(row["ts"]).astimezone(IST).strftime("%d %b")
        return {
            "symbol": symbol,
            "interval": interval,
            "candles": rows,
            "source": "engine",
            "refresh": state,
            "stale": self.is_stale(rows[-1]["ts"], interval),
        }

    def is_stale(self, newest_ts: int, interval: str) -> bool:
        """Behind the tape in a way that matters.

        Measured from the data rather than from whether the refresh succeeded,
        because those are different questions: outside market hours the newest
        bar is hours old and perfectly correct, while at 11:00 with a dead token
        the same bar is useless. Two intervals of slack absorbs the gap between
        a bar closing and the provider publishing it.
        """
        if not self._is_open():
            return False
        age = time.time() * 1000 - newest_ts
        return age > 2 * INTERVAL_MS.get(interval, 300_000)

    def quote(self, symbol: str, segment: str) -> dict:
        """Last price, with the day's open read from the archive.

        `Quote` carries no open — providers disagree about what it means for an
        index — so it comes from the first bar of the current session, which is
        the number the dashboard was showing anyway.
        """
        bars = self.store.read(symbol, segment, "5m", limit=self.config.bars)
        session = _todays_session(ind.candles_to_dicts(bars))

        current = previous = high = low = None
        source = "engine"
        if self.config.live:
            try:
                q = get_source(self.config.source).quote(symbol, segment)
                current, previous, high, low = q.current, q.previous_close, q.high, q.low
                source = q.source
            except Exception as e:
                log.warning("quote %s failed: %s", symbol, e)

        if current is None and session:
            current, high, low = session[-1]["c"], max(c["h"] for c in session), min(c["l"] for c in session)
            source = "engine-archive"
        if current is None:
            raise ApiError(f"no quote or archived bars for {symbol}", status=404)

        if previous is None:
            previous = _previous_close(ind.candles_to_dicts(bars))
        change = current - previous if previous else 0.0
        return {
            "symbol": symbol,
            "current": current,
            "open": session[0]["o"] if session else None,
            "high": high,
            "low": low,
            "previousClose": previous,
            "change": change,
            "changePercent": (change / previous * 100) if previous else 0.0,
            "source": source,
            "marketOpen": self._is_open(),
        }

    def analysis(self, symbol: str, segment: str, interval: str) -> dict:
        rows = ind.candles_to_dicts(
            self.store.read(symbol, segment, interval, limit=self.config.bars)
        )
        if len(rows) < 30:
            raise ApiError(f"only {len(rows)} bars archived for {symbol} {interval}", status=404)

        analysis = ind.analyze_from_candles(rows, include_history=True)
        price = rows[-1]["c"]
        previous = _previous_close(rows)
        chg_pct = round((price - previous) / previous * 100, 2) if previous else 0.0
        signals = sig.generate_index_signals(analysis, price, symbol, DEFAULT_SETTINGS)
        call = sug.build_unified_suggestion(
            analysis, price, chg_pct, signals, DEFAULT_SETTINGS, "scalp", symbol,
            sug.PRODUCTION_FLAGS,
        )
        return {
            "symbol": symbol,
            "interval": interval,
            "price": price,
            "changePercent": chg_pct,
            "analysis": analysis,
            "signals": signals,
            "suggestion": call,
            # Alongside the call, never inside it. The structure loses money as
            # a strategy and adds nothing to the filter; it is here to be drawn.
            "structure": smc.annotate(rows, min_sweep_pts=2),
        }


def _todays_session(rows: list[dict]) -> list[dict]:
    if not rows:
        return []
    today = from_epoch_ms(rows[-1]["ts"]).astimezone(IST).date()
    return [r for r in rows if from_epoch_ms(r["ts"]).astimezone(IST).date() == today]


def _previous_close(rows: list[dict]) -> float | None:
    """Last close of the session before the newest bar's session."""
    if not rows:
        return None
    day = from_epoch_ms(rows[-1]["ts"]).astimezone(IST).date()
    for row in reversed(rows):
        if from_epoch_ms(row["ts"]).astimezone(IST).date() != day:
            return row["c"]
    return None


def _one(params: dict[str, list[str]], name: str, default: str) -> str:
    return (params.get(name) or [default])[0]


def build_routes(engine: Engine) -> dict[str, Callable[[dict], dict]]:
    def health(_: dict) -> dict:
        return {"ok": True, "source": engine.config.source, "live": engine.config.live}

    def status(_: dict) -> dict:
        state = market_status(strict=False)
        year = datetime.now(IST).year
        from .data.timeutil import NSE_HOLIDAYS

        return {**state, "holidayCalendarKnown": year in NSE_HOLIDAYS, "year": year}

    def inventory(_: dict) -> dict:
        return {"series": engine.store.inventory()}

    def candles(p: dict) -> dict:
        return engine.candles(
            _one(p, "symbol", "NIFTY"),
            _one(p, "segment", "INDEX"),
            _one(p, "interval", "5m"),
            int(_one(p, "limit", str(engine.config.bars))),
        )

    def quote(p: dict) -> dict:
        return engine.quote(_one(p, "symbol", "NIFTY"), _one(p, "segment", "INDEX"))

    def analysis(p: dict) -> dict:
        return engine.analysis(
            _one(p, "symbol", "NIFTY"),
            _one(p, "segment", "INDEX"),
            _one(p, "interval", "5m"),
        )

    return {
        "/health": health,
        "/status": status,
        "/inventory": inventory,
        "/candles": candles,
        "/quote": quote,
        "/analysis": analysis,
    }


def make_handler(engine: Engine) -> type[BaseHTTPRequestHandler]:
    routes = build_routes(engine)

    class Handler(BaseHTTPRequestHandler):
        server_version = "ScalpAIEngine/1.0"

        def _send(self, payload: dict, status: int = 200) -> None:
            body = json.dumps(payload, default=str).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self) -> None:  # noqa: N802 - http.server's interface
            url = urlparse(self.path)
            handler = routes.get(url.path.rstrip("/") or "/health")
            if handler is None:
                self._send({"error": f"no route {url.path}", "routes": sorted(routes)}, 404)
                return

            params = parse_qs(url.query)
            key = f"{url.path}?{url.query}"
            cached = engine.cache.get(key)
            if cached is not None:
                self._send(cached)
                return
            try:
                self._send(engine.cache.put(key, handler(params)))
            except ApiError as e:
                self._send({"error": str(e)}, e.status)
            except Exception as e:
                log.exception("%s failed", url.path)
                self._send({"error": f"{type(e).__name__}: {e}"}, 500)

        def _reject(self) -> None:
            self._send({"error": "this service is read-only"}, 405)

        do_POST = do_PUT = do_DELETE = do_PATCH = _reject

        def log_message(self, fmt: str, *args) -> None:
            log.debug("%s %s", self.address_string(), fmt % args)

    return Handler


def serve(config: ApiConfig | None = None) -> None:
    config = config or ApiConfig()
    engine = Engine(config)
    httpd = ThreadingHTTPServer((config.host, config.port), make_handler(engine))

    print(f"\n  engine API on http://{config.host}:{config.port}")
    print(f"  source    {config.source}  (live top-up {'on' if config.live else 'off'})")
    print(f"  routes    {', '.join(sorted(build_routes(engine)))}")
    if config.host not in ("127.0.0.1", "localhost"):
        print("\n  WARNING: bound beyond localhost with no authentication. Put it")
        print("  behind the Next.js proxy or a firewall before a VPS sees it.")
    print("\n  Ctrl-C to stop.\n")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n  stopped.\n")
    finally:
        httpd.server_close()
