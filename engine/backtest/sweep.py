"""Parallel comparison of strategy variants, and time exits derived for free.

A full replay of the 5-minute archive takes about eight minutes single
threaded, so a naive sweep of a dozen variants is an hour of waiting. Two
things make it tractable.

Variants that change *which* signals fire — anything touching the vote or the
levels — need their own replay, and those run in parallel across cores.

Variants that only change *when a position is abandoned* do not. The signals
are identical; only the grading window differs. Those are derived by
re-grading an existing replay's logs, which costs milliseconds. Deriving
rather than re-running also removes a whole class of mistake, since the two
arms are then provably the same trades.
"""
from __future__ import annotations

from dataclasses import dataclass, field, replace
from typing import Sequence

from ..core import indicators as ind
from ..core import signal_log as slog
from ..core import suggestion as sug
from ..data.base import Candle
from .costs import CostModel, IndexPointCost
from .replay import BacktestConfig, run_backtest, summarize

#: One hour, in the milliseconds the log's window is measured in.
HOUR_MS = 60 * 60 * 1000

#: Set before forking so workers inherit the bars instead of pickling ~170k
#: candles once per process.
_CANDLES: list[Candle] = []


@dataclass(frozen=True)
class VariantSpec:
    """A variant that needs its own replay. Must stay picklable, so it carries
    plain values rather than a built config or any callable."""

    name: str
    flags: sug.StrategyFlags = sug.V1_FLAGS
    min_confidence: int | None = None

    def config(self, base: BacktestConfig) -> BacktestConfig:
        out = replace(base, flags=self.flags)
        if self.min_confidence is not None:
            out = replace(out, min_confidence=self.min_confidence)
        return out


@dataclass
class SweepResult:
    name: str
    stats: dict
    logs: list[dict] = field(default_factory=list)


def _run_spec(payload: tuple[VariantSpec, BacktestConfig, str]) -> SweepResult:
    spec, base, cost_name = payload
    from .costs import get_cost_model

    result = run_backtest(_CANDLES, spec.config(base), get_cost_model(cost_name))
    return SweepResult(spec.name, result.stats, result.logs)


def run_sweep(
    candles: Sequence[Candle],
    specs: Sequence[VariantSpec],
    base: BacktestConfig,
    cost_name: str = "index",
    jobs: int = 8,
) -> list[SweepResult]:
    global _CANDLES
    _CANDLES = list(candles)

    payloads = [(s, base, cost_name) for s in specs]
    if jobs <= 1 or len(specs) == 1:
        return [_run_spec(p) for p in payloads]

    import multiprocessing as mp

    # Fork, so the candle list is inherited rather than serialised.
    with mp.get_context("fork").Pool(min(jobs, len(specs))) as pool:
        return pool.map(_run_spec, payloads)


def regrade(
    logs: Sequence[dict],
    rows: Sequence[dict],
    window_ms: int,
    cost_model: CostModel | None = None,
    min_pass_points: float = slog.NIFTY_MIN_PASS_POINTS,
) -> dict:
    """Re-settle the same signals under a different maximum holding time.

    A shorter window is a time-based exit: anything that has not reached its
    target or stop by then is closed at the prevailing price and booked as
    `expired`. Those trades must be counted, which is why `count_expired` is
    forced on here — dropping them would delete exactly the trades the shorter
    window creates and make a time exit look free.
    """
    cost_model = cost_model or IndexPointCost()
    now_ms = rows[-1]["ts"] + 60_000 if rows else 0

    # Grading refuses to revisit a terminal outcome, so the previous verdict
    # has to be cleared before the window can be changed.
    fresh = [{k: v for k, v in e.items() if k != "outcome"} for e in logs]
    graded = slog.apply_outcome_to_logs(
        fresh, rows, now_ms, window_ms=window_ms, min_favorable_points=min_pass_points
    )["logs"]
    return summarize(graded, cost_model, count_expired=True)


def longs_only(logs: Sequence[dict]) -> list[dict]:
    """The long subset of a baseline replay.

    Equivalent to replaying with `long_only`, because dedupe merges only
    same-direction signals — a suppressed short never occupied a long's slot.
    `test_long_only_does_not_disturb_the_longs` holds this equivalence.
    """
    return [e for e in logs if e.get("action") == "BUY"]


#: Holding windows to try, from a scalp that must resolve within the hour to
#: the inherited 24-hour window that lets a position sit overnight.
DEFAULT_WINDOWS: tuple[tuple[str, int], ...] = (
    ("30m", HOUR_MS // 2),
    ("1h", HOUR_MS),
    ("2h", 2 * HOUR_MS),
    ("4h", 4 * HOUR_MS),
    ("8h", 8 * HOUR_MS),
    ("24h", 24 * HOUR_MS),
)


def format_rows(rows: Sequence[tuple[str, dict]], baseline: str | None = None) -> list[str]:
    """One line per variant. Wide-format because a sweep has more rows than a
    two-way A/B, and columns per variant would not fit."""
    out = [
        f"  {'variant':<26}{'trades':>8}{'win%':>7}{'gross':>9}{'cost':>8}"
        f"{'net':>9}{'total':>10}{'PF':>7}{'maxDD':>8}",
        "  " + "-" * 92,
    ]
    base_net = None
    for name, s in rows:
        if name == baseline:
            base_net = s.get("expectancyNetPts")

    for name, s in rows:
        n = s.get("resolved") or 0
        if not n:
            out.append(f"  {name:<26}{'-':>8}")
            continue
        pf = s.get("profitFactor")
        mark = ""
        net = s.get("expectancyNetPts", 0.0)
        if base_net is not None and name != baseline:
            mark = f"   {net - base_net:+.2f} vs base"
        out.append(
            f"  {name:<26}{n:>8d}{s.get('winRate') or 0:>7.1f}"
            f"{s.get('expectancyGrossPts', 0):>+9.2f}{s.get('costPerTradePts', 0):>8.2f}"
            f"{net:>+9.2f}{s.get('totalNetPts', 0):>+10.0f}"
            f"{(pf if pf is not None else 0):>7.2f}{s.get('maxDrawdownPts', 0):>8.0f}{mark}"
        )
    return out


def rows_to_dicts(candles: Sequence[Candle]) -> list[dict]:
    return ind.candles_to_dicts(candles)
