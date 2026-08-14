"""One evaluation of the live market, and the management of what it opened.

The signal path here is imported from the same modules the backtest calls, in
the same order, with the same settings. That is the whole point: if the paper
results diverge from the replay, the difference has to come from the market
rather than from a second implementation that drifted.

Two things are genuinely new relative to the backtest, and both make the paper
run harsher than the replay:

* the strike is chosen from the live chain and priced at its quoted bid/ask,
  instead of a modelled spread applied uniformly
* the VIX gate reads the current print rather than the previous close, because
  live that number is on the screen
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from datetime import datetime, time, timedelta, timezone
from typing import Any, Sequence

from ..core import indicators as ind
from ..core import signal_log as slog
from ..core import signals as sig
from ..core import suggestion as sug
from ..backtest import calibrate as cal
from ..backtest.costs import OptionBuyCost
from ..backtest.replay import DEFAULT_SETTINGS
from ..data.base import DataSource
from ..data.timeutil import IST
from .book import ClosedTrade, PaperBook, Position


@dataclass
class PaperConfig:
    symbol: str = "NIFTY"
    interval: str = "5m"
    instrument: str = "NIFTY"
    mode: str = "scalp"
    settings: dict = field(default_factory=lambda: dict(DEFAULT_SETTINGS))
    flags: sug.StrategyFlags = sug.PRODUCTION_FLAGS

    #: Bars of context handed to the analysis. Matches the backtest window so
    #: the indicators see the same amount of history they were validated on.
    window: int = 375
    min_confidence: int = slog.NIFTY_LOG_MIN_CONFIDENCE

    #: Stand aside when India VIX is above this. Backtested range 13-18 all
    #: worked; 16 sits in the middle of that plateau rather than on its edge.
    gate: float = 16.0
    #: Learned-filter cutoff. None runs the strategy unfiltered.
    min_score: float | None = None

    lots: int = 1
    lot_size: int = 75
    max_open: int = 2
    #: Minutes before another entry in the same direction is allowed. Mirrors
    #: the dedupe window in the signal log, so paper trade counts stay
    #: comparable to backtested ones.
    cooldown_min: int = 20
    delta_band: tuple[float, float] = (0.35, 0.70)

    #: Follow declined signals as shadow positions. On by default: the filter
    #: takes roughly twenty trades a year, so without the refused ones there is
    #: nothing to judge it against for months.
    shadow: bool = True

    no_entry_after: time = time(15, 0)
    squareoff_at: time = time(15, 20)
    eval_window_ms: int = slog.NIFTY_EVAL_WINDOW_MS
    min_pass_points: float = slog.NIFTY_MIN_PASS_POINTS


@dataclass
class TickResult:
    """What the engine saw and what it decided. Rendered straight to stdout."""

    ts: datetime
    index: float | None = None
    vix: float | None = None
    action: str = "HOLD"
    confidence: int = 0
    score: float | None = None
    taken: bool = False
    reason: str = ""
    position: Position | None = None
    closed: list[ClosedTrade] = field(default_factory=list)

    def line(self) -> str:
        clock = self.ts.strftime("%H:%M:%S")
        index = f"{self.index:,.1f}" if self.index else "     -"
        vix = f"{self.vix:5.2f}" if self.vix else "    -"
        score = f"{self.score:.3f}" if self.score is not None else "  -  "
        mark = "ENTER" if self.taken else "  .  "
        return (
            f"{clock}  nifty {index}  vix {vix}  "
            f"{self.action:4} c={self.confidence:3d} s={score}  {mark}  {self.reason}"
        )


# ── entry ──────────────────────────────────────────────────────────────────


def evaluate(
    source: DataSource,
    book: PaperBook,
    config: PaperConfig,
    model: Any = None,
    now: datetime | None = None,
) -> TickResult:
    """Run one tick: manage what is open, then decide whether to open more."""
    now = now or datetime.now(IST)
    result = TickResult(ts=now)

    candles = _recent_candles(source, config, now)
    if len(candles) < config.window // 4:
        result.reason = f"only {len(candles)} bars, need more history"
        return result

    rows = ind.candles_to_dicts(candles)
    spot = rows[-1]["c"]
    result.index = spot

    chain = _safe_chain(source, config.symbol)
    result.closed = manage_open(book, config, rows, chain, spot, now)

    if now.time() >= config.squareoff_at:
        result.reason = "past square-off"
        return result
    if now.time() >= config.no_entry_after:
        result.reason = "too late for a new entry"
        return result

    vix = _vix(source, chain)
    result.vix = vix
    full = len(book.open_positions) >= config.max_open
    if full and not config.shadow:
        result.reason = f"{len(book.open_positions)} positions already open"
        return result

    window = rows[-config.window:]
    analysis = ind.analyze_from_candles(window, include_history=False)
    prev_close = _prev_close(source, config.symbol, rows)
    chg_pct = round((spot - prev_close) / prev_close * 100, 2) if prev_close else 0.0

    index_signals = sig.generate_index_signals(
        analysis, spot, config.instrument, config.settings
    )
    final_call = sug.build_unified_suggestion(
        analysis, spot, chg_pct, index_signals,
        config.settings, config.mode, config.instrument, config.flags,
    )

    result.action = final_call.get("action", "HOLD")
    result.confidence = int(final_call.get("confidence", 0) or 0)

    if result.action not in ("BUY", "SELL"):
        result.reason = "no directional call"
        return result
    if result.confidence < config.min_confidence:
        result.reason = f"confidence {result.confidence} below {config.min_confidence}"
        return result

    # Scored before the gate is applied rather than after, so a tick the gate
    # rejects still gets a score and can be followed as a shadow. The cost is
    # one model call on a signal that will not be taken.
    if model is not None:
        from ..ml.features import extract_features
        from ..ml.model import score_one

        features = extract_features(final_call, analysis, window, chg_pct)
        # The model is fitted with volatility-regime columns joined from the
        # daily series. Scoring without them would leave three of its most
        # important features at zero.
        if vix is not None:
            features.update(_vix_context(vix))
        result.score = score_one(model, features)

    declined = ""
    if vix is not None and vix > config.gate:
        declined = f"vix {vix:.2f} above gate {config.gate:.1f}"
    elif (config.min_score is not None and result.score is not None
            and result.score < config.min_score):
        declined = f"score {result.score:.3f} below {config.min_score:.3f}"
    elif full:
        declined = f"{len(book.open_positions)} positions already open"

    kind = "shadow" if declined else "live"
    if declined and not config.shadow:
        result.reason = declined
        return result

    blocked = _cooldown_block(book, result.action, now, config, kind)
    if blocked:
        result.reason = f"{declined}; {blocked}" if declined else blocked
        return result

    levels = _levels(final_call, spot)
    if levels is None:
        result.reason = "signal carried no usable target/stop"
        return result
    target, stop = levels

    pick = choose_strike(chain, result.action, config, now)
    if pick is None:
        result.reason = "no liquid strike in the delta band"
        return result

    pos = Position(
        id=uuid.uuid4().hex[:8],
        opened_at=now.isoformat(timespec="seconds"),
        action=result.action,
        entry_index=spot,
        target_index=target,
        stop_index=stop,
        confidence=result.confidence,
        ml_score=result.score if result.score is not None else -1.0,
        vix=vix if vix is not None else -1.0,
        symbol=pick["symbol"],
        strike=pick["strike"],
        option_type=pick["option_type"],
        expiry=pick["expiry"],
        entry_premium=pick["ask"],      # we cross the spread to get in
        entry_bid=pick["bid"],
        entry_ask=pick["ask"],
        delta=pick["delta"],
        iv=pick["iv"],
        lots=config.lots,
        lot_size=config.lot_size,
        reason=final_call.get("reason", "") or "",
        kind=kind,
        declined=declined,
    )
    book.open_position(pos)
    result.position = pos

    if declined:
        result.reason = f"declined ({declined}) — following as shadow"
        return result

    result.taken = True
    result.reason = (
        f"bought {pick['option_type']} {pick['strike']} @ {pick['ask']:.2f} "
        f"(target {target:,.0f} / stop {stop:,.0f})"
    )
    return result


# ── exit ───────────────────────────────────────────────────────────────────


def manage_open(
    book: PaperBook,
    config: PaperConfig,
    rows: Sequence[dict],
    chain: dict | None,
    spot: float,
    now: datetime,
) -> list[ClosedTrade]:
    """Resolve open positions against the price path since they were opened.

    Grading is delegated to the same routine the backtest uses, so the
    stop-wins-on-an-ambiguous-bar rule and the signal expiry window apply here
    unchanged rather than being re-derived and quietly softened.
    """
    closed: list[ClosedTrade] = []
    squareoff = now.time() >= config.squareoff_at

    for pos in list(book.open_positions) + list(book.shadow_open):
        opened = datetime.fromisoformat(pos.opened_at)
        entry = {
            "action": pos.action,
            "entry": pos.entry_index,
            "target": pos.target_index,
            "stopLoss": pos.stop_index,
            "ts": opened.astimezone(timezone.utc).isoformat(),
            "instrument": config.instrument,
            "price": pos.entry_index,
        }
        graded = slog.evaluate_signal_outcome(
            entry,
            [r for r in rows if r["ts"] >= opened.timestamp() * 1000],
            now_ms=int(now.timestamp() * 1000),
            window_ms=config.eval_window_ms,
            min_favorable_points=config.min_pass_points,
        ) or {}

        status = graded.get("status", "pending")
        if status == "pending" and not squareoff:
            continue

        reason = status if status in ("target", "stop", "expired") else "squareoff"

        exit_index = graded.get("resolvedPrice") or spot
        exit_premium = _exit_premium(pos, chain, exit_index, now)
        closed.append(_settle(pos, exit_index, exit_premium, reason, now))

    for trade in closed:
        book.close_position(trade)
    # Only real trades are reported to the tick line; shadows are accounting,
    # not results, and printing them alongside would blur the distinction.
    return [t for t in closed if t.position.get("kind") != "shadow"]


def _settle(
    pos: Position, exit_index: float, exit_premium: float, reason: str, now: datetime
) -> ClosedTrade:
    units = pos.lots * pos.lot_size
    gross = (exit_premium - pos.entry_premium) * units
    # Slippage is zero here because it is already paid: entry crossed to the
    # ask and exit hits the bid, so charging modelled ticks on top would
    # double-count the spread.
    charges = OptionBuyCost(
        slippage_ticks_per_leg=0.0, lot_size=pos.lot_size
    ).round_trip(pos.entry_premium, exit_premium, pos.lots).total

    opened = datetime.fromisoformat(pos.opened_at)
    net = gross - charges
    return ClosedTrade(
        position=pos.__dict__.copy(),
        closed_at=now.isoformat(timespec="seconds"),
        exit_index=exit_index,
        exit_premium=exit_premium,
        exit_reason=reason,
        hold_hours=(now - opened).total_seconds() / 3600,
        gross_premium=gross,
        charges=charges,
        net_rupees=net,
        # Reported in index points too, so a paper day can be laid directly
        # against the backtest's per-trade numbers.
        index_points=net / units if units else 0.0,
    )


def _exit_premium(
    pos: Position, chain: dict | None, exit_index: float, now: datetime
) -> float:
    """What we would receive: the live bid if the strike is quoted, otherwise
    a Black-76 mark less half the entry spread.

    The fallback is not a nicety. Once a strike drifts out of the fetched
    window there is no quote for it, and treating the position as worth its
    last known price would freeze losses in place.
    """
    quoted = _chain_quote(chain, pos.strike, pos.option_type)
    if quoted and quoted[0] > 0:
        return quoted[0]

    expiry = _expiry_ts(chain, now)
    t = max((expiry - now.timestamp()) / (365 * 24 * 3600), 1e-6) if expiry else 1e-6
    theo = cal.black76_price(
        exit_index, pos.strike, t, pos.iv or 0.12, pos.option_type == "CE"
    )
    half_spread = max((pos.entry_ask - pos.entry_bid) / 2, 0.0)
    return max(theo - half_spread, 0.0)


# ── strike selection ───────────────────────────────────────────────────────


def choose_strike(
    chain: dict | None, action: str, config: PaperConfig, now: datetime
) -> dict | None:
    """Pick the strike a directional scalp would actually buy.

    Delta is the selection criterion rather than distance from spot, because
    delta governs how much of an index move the premium captures. Among the
    qualifying strikes the cheapest round trip in index-point terms wins, which
    in practice keeps the choice near the money without hard-coding that.
    """
    if not chain:
        return None

    rows, meta = cal.measure_chain(chain, now=now)
    if not rows:
        return None

    want = "CE" if action == "BUY" else "PE"
    candidates = [r for r in cal.tradeable(rows, config.delta_band)
                  if r.option_type == want]
    if not candidates:
        return None

    best = min(candidates, key=lambda r: r.index_pts or 1e9)
    expiry = cal.nearest_expiry(chain, now)
    return {
        "symbol": _symbol_for(chain, best.strike, want),
        "strike": best.strike,
        "option_type": want,
        "expiry": expiry[1] if expiry else "",
        "bid": best.bid,
        "ask": best.ask,
        "delta": best.delta or 0.0,
        # A VIX-derived fallback rather than a fixed number: measured weekly
        # IV ran about 0.85x VIX on the chain we calibrated against.
        "iv": best.iv or (meta.get("vix", 0.0) / 100 * 0.85) or 0.12,
        "index_pts": best.index_pts,
    }


# ── plumbing ───────────────────────────────────────────────────────────────


def _levels(final_call: dict, spot: float) -> tuple[float, float] | None:
    target = final_call.get("target")
    stop = final_call.get("stopLoss") or final_call.get("stop_loss")
    if target is None or stop is None:
        return None
    return float(target), float(stop)


def _cooldown_block(
    book: PaperBook, action: str, now: datetime, config: PaperConfig,
    kind: str = "live",
) -> str | None:
    """One position per direction at a time, and a pause after one closes.

    Applied per book: a shadow must not be blocked by a live position or the
    comparison would be between different trade sets rather than between two
    verdicts on the same ones.
    """
    shadow = kind == "shadow"
    open_positions = book.shadow_open if shadow else book.open_positions
    closed = book.shadow_closed if shadow else book.closed

    for pos in open_positions:
        if pos.action == action:
            return f"already holding {action} ({pos.symbol})"

    cutoff = now - timedelta(minutes=config.cooldown_min)
    if any(t.position["action"] == action
           and datetime.fromisoformat(t.closed_at) > cutoff for t in closed):
        return f"cooldown: {action} closed less than {config.cooldown_min}m ago"
    return None


def _recent_candles(source: DataSource, config: PaperConfig, now: datetime) -> list:
    """Enough 5-minute bars to fill the analysis window.

    Calendar days are requested generously against bars needed, since weekends
    and holidays return nothing and a tight range would silently under-fill the
    window on a Monday morning.
    """
    per_day = 75 if config.interval == "5m" else 375
    days = max(7, int(config.window / per_day * 2) + 5)
    return source.candles(
        config.symbol, config.interval, now - timedelta(days=days), now, "INDEX"
    )


#: Loaded once. The archive is static during a session, and re-reading it every
#: two minutes would be pointless work.
_VIX_SERIES: object | None = None


def _vix_context(level: float) -> dict[str, float]:
    global _VIX_SERIES
    if _VIX_SERIES is None:
        from ..backtest.regime import load_vix

        _VIX_SERIES = load_vix()
    return _VIX_SERIES.live_context(level) if len(_VIX_SERIES) else {}


def _vix(source: DataSource, chain: dict | None) -> float | None:
    """Current India VIX. The chain carries it, so prefer that over a second
    network call, and fall back to a direct quote when the chain is absent."""
    embedded = float(((chain or {}).get("indiavixData") or {}).get("ltp") or 0.0)
    if embedded > 0:
        return embedded
    try:
        return float(source.quote("INDIAVIX", "INDEX").current)
    except Exception:
        return None


def _prev_close(source: DataSource, symbol: str, rows: Sequence[dict]) -> float | None:
    try:
        quoted = source.quote(symbol, "INDEX").previous_close
        if quoted:
            return float(quoted)
    except Exception:
        pass

    today = datetime.fromtimestamp(rows[-1]["ts"] / 1000, tz=IST).date()
    prior = [r for r in rows
             if datetime.fromtimestamp(r["ts"] / 1000, tz=IST).date() < today]
    return prior[-1]["c"] if prior else None


def _safe_chain(source: DataSource, symbol: str) -> dict | None:
    chain = getattr(source, "option_chain", None)
    if chain is None:
        return None
    try:
        return chain(symbol)
    except Exception:
        return None


def _chain_quote(chain: dict | None, strike: int, option_type: str) -> tuple[float, float] | None:
    for row in (chain or {}).get("optionsChain") or []:
        if int(row.get("strike_price", -1)) == strike and row.get("option_type") == option_type:
            return float(row.get("bid") or 0.0), float(row.get("ask") or 0.0)
    return None


def _symbol_for(chain: dict, strike: int, option_type: str) -> str:
    for row in chain.get("optionsChain") or []:
        if int(row.get("strike_price", -1)) == strike and row.get("option_type") == option_type:
            return str(row.get("symbol") or f"NIFTY{strike}{option_type}")
    return f"NIFTY{strike}{option_type}"


def _expiry_ts(chain: dict | None, now: datetime) -> int | None:
    found = cal.nearest_expiry(chain or {}, now)
    return found[0] if found else None
