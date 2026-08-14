"""Bar-by-bar replay of the live decision path.

The engine sees exactly what it would have seen at that moment: a trailing
window of completed bars and nothing after. Grading then uses later bars,
which is measurement rather than lookahead — the decision was already fixed.

Two properties are what make the output trustworthy:

  * The same functions run here as in `niftyLogTick.js` — analyse, generate
    signals, vote, gate on confidence, dedupe. Not a reimplementation.
  * Outcomes are graded by the same `evaluate_signal_outcome` that grades live
    signals, so the backtest number and the live number are comparable.
"""
from __future__ import annotations

import statistics
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable, Sequence

from ..core import indicators as ind
from ..core import signal_log as slog
from ..core import signals as sig
from ..core import suggestion as sug
from ..data.base import Candle
from ..data.timeutil import IST
from .costs import CostModel, IndexPointCost

#: Mirrors the cron's DEFAULT_SETT in niftyLogTick.js.
DEFAULT_SETTINGS: dict[str, Any] = {
    "riskLimit": 10000,
    "profitPct": 1.5,
    "slPct": 0.8,
    "ind": {"rsi": True, "macd": True, "bb": True, "ema20": True, "ema50": True, "vol": True},
}


@dataclass
class BacktestConfig:
    symbol: str = "NIFTY"
    interval: str = "5m"
    #: Bars handed to the engine per evaluation. Production requests range=5d
    #: at 5m, which is ~375 bars, so the backtest sees the same history depth.
    window: int = 375
    #: Bars to skip before evaluating, so early signals aren't made on a
    #: half-warmed EMA.
    warmup: int = 60
    mode: str = "scalp"
    instrument: str = "NIFTY"
    settings: dict = field(default_factory=lambda: dict(DEFAULT_SETTINGS))
    min_confidence: int = slog.NIFTY_LOG_MIN_CONFIDENCE
    eval_window_ms: int = slog.NIFTY_EVAL_WINDOW_MS
    min_pass_points: float = slog.NIFTY_MIN_PASS_POINTS
    #: Evaluate every Nth bar. The live cron ticks every 2 minutes against
    #: 5-minute candles, so 1 is the faithful setting.
    step: int = 1
    #: Production caps the log at 300 to keep the dashboard light. A replay
    #: must not, or it quietly throws away its own early history and reports
    #: on a shorter period than it ran.
    max_entries: int = 100_000
    #: Strategy variant. Defaults to v1 so a run is comparable to the
    #: dashboard unless a deviation is asked for explicitly.
    flags: sug.StrategyFlags = sug.V1_FLAGS
    #: Attach a feature row to each logged signal, for model training. Off by
    #: default so a plain replay produces logs shaped exactly like production.
    collect_features: bool = False
    #: Gate applied after the engine produces a signal and before it is logged.
    #: Returning False drops the signal as if it never fired. Used by the ML
    #: filter; requires `collect_features`.
    signal_filter: Callable[[dict], bool] | None = None
    #: Settle signals that never touched either level at the last price rather
    #: than discarding them. Required for any comparison that shortens
    #: `eval_window_ms` into a time-based exit.
    count_expired: bool = False


@dataclass
class BacktestResult:
    config: BacktestConfig
    logs: list[dict]
    bars: int
    evaluated: int
    stats: dict
    cost_model: str
    filtered: int = 0

    def summary_lines(self) -> list[str]:
        s = self.stats
        first = self.logs[-1]["date"] if self.logs else "-"
        last = self.logs[0]["date"] if self.logs else "-"
        out = [
            f"symbol            {self.config.symbol} {self.config.interval}  "
            f"mode={self.config.mode}",
            f"bars              {self.bars}  (evaluated {self.evaluated})",
            f"period            {first} .. {last}",
        ]
        if self.filtered:
            out.append(f"dropped by filter {self.filtered}")
        out += [
            f"signals logged    {s['total']}",
            f"  passed          {s['passed']}",
            f"  failed          {s['failed']}",
            f"  expired         {s['expired']}",
            f"  still active    {s['active']}",
            f"resolved          {s['resolved']}",
        ]
        if s["resolved"]:
            out += [
                f"win rate          {s['winRate']}%",
                f"avg win           {s['avgWinPts']:+.1f} pts",
                f"avg loss          {s['avgLossPts']:+.1f} pts",
                f"expectancy gross  {s['expectancyGrossPts']:+.2f} pts/trade",
                f"cost per trade    {s['costPerTradePts']:.2f} pts  ({self.cost_model})",
                f"expectancy net    {s['expectancyNetPts']:+.2f} pts/trade",
                f"total net         {s['totalNetPts']:+.1f} pts over {s['resolved']} trades",
                f"profit factor     {s['profitFactor']}",
                f"max drawdown      {s['maxDrawdownPts']:.1f} pts",
            ]
        else:
            out.append("(no resolved trades — widen the period or lower the threshold)")
        return out


def _prev_day_closes(candles: Sequence[Candle]) -> dict[str, float]:
    """Last close of each IST trading day, used for the change-percent input
    the live tick gets from the quote's previousClose."""
    by_day: dict[str, float] = {}
    for c in candles:
        by_day[datetime.fromtimestamp(c.ts / 1000, tz=IST).strftime("%Y-%m-%d")] = c.c

    days = sorted(by_day)
    return {day: by_day[days[i - 1]] for i, day in enumerate(days) if i > 0}


def run_backtest(
    candles: Sequence[Candle],
    config: BacktestConfig | None = None,
    cost_model: CostModel | None = None,
) -> BacktestResult:
    config = config or BacktestConfig()
    cost_model = cost_model or IndexPointCost()

    rows = ind.candles_to_dicts(candles)
    prev_closes = _prev_day_closes(candles)

    logs: list[dict] = []
    evaluated = 0
    filtered = 0

    for i in range(config.warmup, len(rows), config.step):
        window = rows[max(0, i - config.window + 1): i + 1]
        bar = rows[i]
        evaluated += 1

        analysis = ind.analyze_from_candles(window, include_history=False)
        price = bar["c"]

        day = datetime.fromtimestamp(bar["ts"] / 1000, tz=IST).strftime("%Y-%m-%d")
        prev = prev_closes.get(day)
        chg_pct = round((price - prev) / prev * 100, 2) if prev else 0

        index_signals = sig.generate_index_signals(
            analysis, price, config.instrument, config.settings
        )
        final_call = sug.build_unified_suggestion(
            analysis, price, chg_pct, index_signals,
            config.settings, config.mode, config.instrument,
            config.flags,
        )

        if final_call.get("action") not in ("BUY", "SELL"):
            continue
        if final_call.get("confidence", 0) < config.min_confidence:
            continue

        entry = slog.build_nifty_signal_log_entry(
            final_call,
            {"cur": price, "prev": prev, "high": bar["h"], "low": bar["l"]},
            analysis,
            chg_pct,
            index_signals,
            None,
            now=datetime.fromtimestamp(bar["ts"] / 1000, tz=timezone.utc),
        )
        entry["instrument"] = config.instrument

        if config.collect_features:
            from ..ml.features import extract_features

            entry["features"] = extract_features(final_call, analysis, window, chg_pct)

        # Filtering here rather than after grading is deliberate: a dropped
        # signal must not occupy the dedupe slot, or the filter would silently
        # change which *other* signals get merged away.
        if config.signal_filter is not None and not config.signal_filter(entry):
            filtered += 1
            continue

        logs = slog.apply_nifty_log_update(logs, entry, config.max_entries)["logs"]

    # Grading uses the full price path. This is not lookahead: each decision
    # above was already fixed using only bars available at that moment.
    now_ms = rows[-1]["ts"] + 60_000 if rows else 0
    graded = slog.apply_outcome_to_logs(
        logs, rows, now_ms,
        window_ms=config.eval_window_ms,
        min_favorable_points=config.min_pass_points,
    )["logs"]

    return BacktestResult(
        config=config,
        logs=graded,
        bars=len(rows),
        evaluated=evaluated,
        filtered=filtered,
        stats=summarize(graded, cost_model, config.count_expired),
        cost_model=cost_model.name,
    )


def summarize(
    logs: Sequence[dict], cost_model: CostModel, count_expired: bool = False
) -> dict:
    """Aggregate graded signals into economics.

    `count_expired` decides whether signals that ran out their window without
    touching either level are settled at the last price or dropped. Dropping
    them is v1's behaviour and flatters the result — those trades paid the
    spread and got nothing — but changing the default would silently move every
    number already published here. It must be on when comparing a time-based
    exit against the baseline, since a shorter window converts resolutions into
    expiries and would otherwise delete the trades it was meant to measure.
    """
    if getattr(cost_model, "unit", "index_points") != "index_points":
        raise ValueError(
            f"cost model {cost_model.name!r} is denominated in "
            f"{cost_model.unit}, but this replay measures gross in index "
            "points. Subtracting one from the other produces a number that "
            "looks plausible and means nothing. Use 'index_points' here, and "
            "price the option leg separately."
        )

    base = slog.summarize_outcomes(logs)
    settled = ("target", "stop", "expired") if count_expired else ("target", "stop")

    wins: list[float] = []
    losses: list[float] = []
    pnl_sequence: list[float] = []
    costs = 0.0

    for e in sorted(logs, key=lambda x: x["ts"]):
        outcome = e.get("outcome") or {}
        if outcome.get("status") not in settled:
            continue
        entry_px = e.get("entry")
        exit_px = outcome.get("resolvedPrice")
        if entry_px is None or exit_px is None:
            continue

        direction = 1 if e["action"] == "BUY" else -1
        gross = (exit_px - entry_px) * direction
        cost = cost_model.round_trip(entry_px, exit_px).total
        costs += cost
        net = gross - cost

        (wins if gross > 0 else losses).append(gross)
        pnl_sequence.append(net)

    resolved = len(pnl_sequence)
    if not resolved:
        return {**base, "total": len(logs), "avgWinPts": 0.0, "avgLossPts": 0.0,
                "expectancyGrossPts": 0.0, "expectancyNetPts": 0.0,
                "costPerTradePts": 0.0, "totalNetPts": 0.0,
                "profitFactor": None, "maxDrawdownPts": 0.0}

    gross_total = sum(wins) + sum(losses)
    gross_profit = sum(wins)
    gross_loss = abs(sum(losses))

    equity = 0.0
    peak = 0.0
    max_dd = 0.0
    for pnl in pnl_sequence:
        equity += pnl
        peak = max(peak, equity)
        max_dd = max(max_dd, peak - equity)

    return {
        **base,
        "total": len(logs),
        # Overrides the base count, which only ever recognises target and stop.
        # Leaving it would report a total net over a trade count that excludes
        # the settled expiries the total includes.
        "resolved": resolved,
        "avgWinPts": statistics.mean(wins) if wins else 0.0,
        "avgLossPts": statistics.mean(losses) if losses else 0.0,
        "expectancyGrossPts": gross_total / resolved,
        "costPerTradePts": costs / resolved,
        "expectancyNetPts": sum(pnl_sequence) / resolved,
        "totalNetPts": sum(pnl_sequence),
        "profitFactor": round(gross_profit / gross_loss, 2) if gross_loss else None,
        "maxDrawdownPts": max_dd,
    }
