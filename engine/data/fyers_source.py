"""Fyers API v3 adapter (direct REST).

Free — no data subscription — with minute candles back to 3 July 2017, roughly
nine years against yfinance's rolling sixty days. That depth is what makes a
scalp backtest meaningful rather than decorative, and it also covers options,
which yfinance does not carry for NSE at all.

Deliberately not using the official `fyers-apiv3` SDK. It hard-pins
`aiohttp==3.9.3`, which has no Python 3.13 wheel and fails to build, and it
pulls `aws_lambda_powertools` and therefore boto3 into a trading process. The
v3 REST surface is four endpoints, so `requests` is the smaller risk.

Provider constraints handled here:
  * 100 days per request for intraday resolutions -> paginated transparently
  * 366 days per request for daily
  * Access tokens expire daily -> cached to disk with a clear re-auth error
  * Trailing partial candle -> excluded, never acted on

Setup:
    1. Open a Fyers account, create an app at https://myapi.fyers.in/dashboard
    2. Put FYERS_CLIENT_ID / FYERS_SECRET_KEY / FYERS_REDIRECT_URI in .env.local
    3. python -m engine.cli fyers-auth      (once per trading day)
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import time
from datetime import date, datetime, timedelta
from pathlib import Path
from urllib.parse import urlencode

import requests

from .base import Candle, DataSource, DataSourceError, Interval, Quote, Segment
from .timeutil import IST

log = logging.getLogger(__name__)

API_BASE = "https://api-t1.fyers.in/api/v3"
DATA_BASE = "https://api-t1.fyers.in/data"
SYMBOL_MASTER = "https://public.fyers.in/sym_details"

TOKEN_PATH = Path(__file__).resolve().parents[1] / "var" / "fyers_token.json"

_RESOLUTION: dict[str, str] = {
    "1m": "1", "5m": "5", "15m": "15", "30m": "30", "1h": "60", "1d": "D",
}

#: Max days Fyers returns in a single history call.
_MAX_SPAN_DAYS: dict[str, int] = {
    "1m": 100, "5m": 100, "15m": 100, "30m": 100, "1h": 100, "1d": 366,
}

_INTERVAL_MINUTES = {"1m": 1, "5m": 5, "15m": 15, "30m": 30, "1h": 60}

#: Minute history starts here; asking earlier only wastes calls.
_INTRADAY_EPOCH = date(2017, 7, 3)

_INDEX_SYMBOLS: dict[str, str] = {
    "NIFTY": "NSE:NIFTY50-INDEX",
    "NIFTY 50": "NSE:NIFTY50-INDEX",
    "NIFTY50": "NSE:NIFTY50-INDEX",
    "BANKNIFTY": "NSE:NIFTYBANK-INDEX",
    "NIFTY BANK": "NSE:NIFTYBANK-INDEX",
    "FINNIFTY": "NSE:FINNIFTY-INDEX",
    "MIDCPNIFTY": "NSE:MIDCPNIFTY-INDEX",
    "SENSEX": "BSE:SENSEX-INDEX",
    "INDIAVIX": "NSE:INDIAVIX-INDEX",
    "INDIA VIX": "NSE:INDIAVIX-INDEX",
    "VIX": "NSE:INDIAVIX-INDEX",
}


class FyersAuthError(DataSourceError):
    """Token missing or expired. Fyers tokens are single-day, so this is a
    routine daily event rather than a bug."""


# ── auth ───────────────────────────────────────────────────────────────────

def _app_id_hash() -> str:
    client_id = os.environ["FYERS_CLIENT_ID"]
    secret = os.environ["FYERS_SECRET_KEY"]
    return hashlib.sha256(f"{client_id}:{secret}".encode()).hexdigest()


def build_auth_url(state: str = "scalpai") -> str:
    """Step one of the daily login: the URL to open in a browser."""
    missing = [
        k for k in ("FYERS_CLIENT_ID", "FYERS_SECRET_KEY", "FYERS_REDIRECT_URI")
        if not os.environ.get(k)
    ]
    if missing:
        raise FyersAuthError(f"unset: {', '.join(missing)} — see .env.example")

    params = {
        "client_id": os.environ["FYERS_CLIENT_ID"],
        "redirect_uri": os.environ["FYERS_REDIRECT_URI"],
        "response_type": "code",
        "state": state,
    }
    return f"{API_BASE}/generate-authcode?{urlencode(params)}"


def exchange_auth_code(auth_code: str) -> str:
    """Step two: trade the redirected auth_code for a one-day access token."""
    resp = requests.post(
        f"{API_BASE}/validate-authcode",
        json={
            "grant_type": "authorization_code",
            "appIdHash": _app_id_hash(),
            "code": auth_code.strip(),
        },
        timeout=30,
    )
    try:
        body = resp.json()
    except ValueError:
        raise FyersAuthError(f"non-JSON response ({resp.status_code}): {resp.text[:200]}") from None

    token = body.get("access_token")
    if not token:
        raise FyersAuthError(f"token exchange failed: {body.get('message', body)}")
    save_token(os.environ["FYERS_CLIENT_ID"], token)
    return token


def save_token(client_id: str, access_token: str) -> None:
    TOKEN_PATH.parent.mkdir(parents=True, exist_ok=True)
    TOKEN_PATH.write_text(
        json.dumps(
            {
                "client_id": client_id,
                "access_token": access_token,
                "issued_date": datetime.now(IST).date().isoformat(),
                "issued_at": datetime.now(IST).isoformat(),
            },
            indent=2,
        )
    )
    TOKEN_PATH.chmod(0o600)


def load_token() -> tuple[str, str] | None:
    env_id = os.environ.get("FYERS_CLIENT_ID")
    env_tok = os.environ.get("FYERS_ACCESS_TOKEN")
    if env_id and env_tok:
        return env_id, env_tok
    if not TOKEN_PATH.exists():
        return None
    try:
        blob = json.loads(TOKEN_PATH.read_text())
    except (OSError, json.JSONDecodeError):
        return None
    if blob.get("issued_date") != datetime.now(IST).date().isoformat():
        log.warning("Fyers token issued %s has expired", blob.get("issued_date"))
        return None
    cid, tok = blob.get("client_id"), blob.get("access_token")
    return (cid, tok) if cid and tok else None


# ── source ─────────────────────────────────────────────────────────────────

class FyersSource(DataSource):
    name = "fyers"

    max_lookback_days = {k: None for k in _RESOLUTION}

    #: Conservative client-side throttle. A deep-history crawl is the one thing
    #: likely to trip the published per-second limits.
    min_request_interval_s = 0.15
    timeout_s = 30

    def __init__(self, client_id: str | None = None, access_token: str | None = None) -> None:
        creds = (client_id, access_token) if client_id and access_token else load_token()
        if not creds:
            raise FyersAuthError(
                "No valid Fyers token for today. Run: python -m engine.cli fyers-auth"
            )
        self.client_id, self._token = creds
        self._last_call = 0.0
        self._session = requests.Session()
        self._session.headers.update(
            {"Authorization": f"{self.client_id}:{self._token}", "Accept": "application/json"}
        )

    def _get(self, url: str, params: dict) -> dict:
        gap = time.monotonic() - self._last_call
        if gap < self.min_request_interval_s:
            time.sleep(self.min_request_interval_s - gap)
        self._last_call = time.monotonic()

        resp = self._session.get(url, params=params, timeout=self.timeout_s)
        if resp.status_code == 401:
            raise FyersAuthError("401 — token rejected; re-run fyers-auth")
        try:
            body = resp.json()
        except ValueError:
            raise DataSourceError(
                f"non-JSON from {url} ({resp.status_code}): {resp.text[:200]}"
            ) from None

        if body.get("s") != "ok":
            msg = str(body.get("message", body))
            if "token" in msg.lower() or body.get("code") in (-15, -16, -17):
                raise FyersAuthError(f"auth rejected: {msg}")
            raise DataSourceError(f"{url}: {msg}")
        return body

    def supports(self, segment: Segment, interval: Interval) -> bool:
        return interval in _RESOLUTION

    def resolve(self, symbol: str, segment: Segment) -> str:
        s = symbol.strip().upper()
        if ":" in s:  # already fully qualified
            return s
        if segment == "INDEX":
            try:
                return _INDEX_SYMBOLS[s]
            except KeyError:
                raise DataSourceError(f"unknown index alias {symbol!r}") from None
        if segment == "EQUITY":
            return f"NSE:{s}-EQ"
        return f"NSE:{s}"

    @staticmethod
    def option_symbol(
        underlying: str,
        expiry: date,
        strike: int,
        option_type: str,
        *,
        monthly: bool = False,
        exchange: str = "NSE",
    ) -> str:
        """Fyers option symbols come in two shapes and picking the wrong one
        yields "invalid symbol" rather than a useful error:

            weekly : NIFTY<YY><M><DD><STRIKE><CE|PE>   e.g. NIFTY26814 24500CE
            monthly: NIFTY<YY><MMM><STRIKE><CE|PE>     e.g. NIFTY26AUG24500CE

        In the weekly form the month is one character: 1-9 for Jan-Sep, then
        O, N, D for Oct, Nov, Dec.
        """
        opt = option_type.upper()
        if opt not in ("CE", "PE"):
            raise ValueError("option_type must be CE or PE")

        u = underlying.upper()
        yy = expiry.strftime("%y")
        if monthly:
            return f"{exchange}:{u}{yy}{expiry.strftime('%b').upper()}{strike}{opt}"
        month_char = {10: "O", 11: "N", 12: "D"}.get(expiry.month, str(expiry.month))
        return f"{exchange}:{u}{yy}{month_char}{expiry.strftime('%d')}{strike}{opt}"

    def candles(
        self,
        symbol: str,
        interval: Interval,
        start: datetime,
        end: datetime,
        segment: Segment = "INDEX",
        include_oi: bool = False,
    ) -> list[Candle]:
        if interval not in _RESOLUTION:
            raise DataSourceError(f"unsupported interval {interval!r}")

        fy_symbol = self.resolve(symbol, segment)
        resolution = _RESOLUTION[interval]
        span = _MAX_SPAN_DAYS[interval]

        start_d = start.astimezone(IST).date()
        end_d = end.astimezone(IST).date()
        if interval != "1d" and start_d < _INTRADAY_EPOCH:
            start_d = _INTRADAY_EPOCH

        # The bar covering "now" is still forming. Acting on it means acting on
        # incomplete information, so it never enters the dataset.
        step = _INTERVAL_MINUTES.get(interval)
        if step:
            end_d = min(end_d, (datetime.now(IST) - timedelta(minutes=step)).date())
        if start_d > end_d:
            return []

        rows: list[list] = []
        cursor, pages = start_d, 0
        while cursor <= end_d:
            chunk_end = min(cursor + timedelta(days=span - 1), end_d)
            params = {
                "symbol": fy_symbol,
                "resolution": resolution,
                "date_format": "1",
                "range_from": cursor.isoformat(),
                "range_to": chunk_end.isoformat(),
                "cont_flag": "1",
            }
            if include_oi:
                params["oi_flag"] = "1"
            try:
                rows.extend(self._get(f"{DATA_BASE}/history", params).get("candles") or [])
            except DataSourceError as e:
                # A window with no trading (long holiday stretch, pre-listing)
                # is normal mid-crawl and must not abort the whole range.
                if "no data" in str(e).lower():
                    log.info("%s: empty window %s..%s", fy_symbol, cursor, chunk_end)
                else:
                    raise
            cursor = chunk_end + timedelta(days=1)
            pages += 1

        if pages > 1:
            log.info("%s %s: %d pages -> %d rows", fy_symbol, interval, pages, len(rows))

        out: list[Candle] = []
        seen: set[int] = set()
        for r in rows:
            if len(r) < 6:
                continue
            ts_ms = int(r[0]) * 1000  # Fyers returns epoch seconds
            if ts_ms in seen:  # page boundaries can repeat a bar
                continue
            seen.add(ts_ms)
            out.append(
                Candle(
                    ts=ts_ms,
                    o=float(r[1]), h=float(r[2]), l=float(r[3]), c=float(r[4]),
                    v=float(r[5]),
                    oi=float(r[6]) if include_oi and len(r) > 6 else None,
                )
            )
        out.sort(key=lambda c: c.ts)
        return out

    def quote(self, symbol: str, segment: Segment = "INDEX") -> Quote:
        fy_symbol = self.resolve(symbol, segment)
        body = self._get(f"{DATA_BASE}/quotes", {"symbols": fy_symbol})
        entries = body.get("d") or []
        if not entries:
            raise DataSourceError(f"no quote for {fy_symbol}")

        v = entries[0].get("v", {})

        def num(key):
            val = v.get(key)
            return float(val) if val not in (None, "") else None

        return Quote(
            symbol=symbol,
            current=num("lp") or 0.0,
            previous_close=num("prev_close_price"),
            high=num("high_price"),
            low=num("low_price"),
            ts=int(datetime.now(IST).timestamp() * 1000),
            source=self.name,
        )

    def option_chain(self, symbol: str = "NIFTY", strike_count: int = 10) -> dict:
        """Live chain for strike selection. yfinance cannot do this at all,
        which is the main reason the options track needs a broker adapter."""
        fy_symbol = self.resolve(symbol, "INDEX")
        body = self._get(
            f"{DATA_BASE}/options-chain-v3",
            {"symbol": fy_symbol, "strikecount": strike_count, "timestamp": ""},
        )
        return body.get("data", {})
