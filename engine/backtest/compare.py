"""Side-by-side comparison of strategy variants on the same bars.

A backtest number in isolation says very little — the useful question is always
"compared to what". Running variants over an identical candle set and printing
them together is the only way to attribute a change in the result to the change
in the strategy rather than to a different period or threshold.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Sequence

from ..data.base import Candle
from .costs import CostModel, IndexPointCost
from .replay import BacktestConfig, BacktestResult, run_backtest


@dataclass
class Variant:
    name: str
    config: BacktestConfig


#: Rows printed by `format_comparison`, as (label, stats key, format spec).
_ROWS: list[tuple[str, str, str]] = [
    ("trades", "resolved", "d"),
    ("win rate %", "winRate", ".1f"),
    ("avg win pts", "avgWinPts", "+.1f"),
    ("avg loss pts", "avgLossPts", "+.1f"),
    ("gross pts/trade", "expectancyGrossPts", "+.2f"),
    ("cost pts/trade", "costPerTradePts", ".2f"),
    ("net pts/trade", "expectancyNetPts", "+.2f"),
    ("total net pts", "totalNetPts", "+.0f"),
    ("profit factor", "profitFactor", ".2f"),
    ("max drawdown", "maxDrawdownPts", ".0f"),
]


def run_variants(
    candles: Sequence[Candle],
    variants: Sequence[Variant],
    cost_model: CostModel | None = None,
) -> list[tuple[str, BacktestResult]]:
    cost_model = cost_model or IndexPointCost()
    return [(v.name, run_backtest(candles, v.config, cost_model)) for v in variants]


def format_comparison(results: Sequence[tuple[str, BacktestResult]]) -> list[str]:
    if not results:
        return []
    width = max(14, max(len(name) for name, _ in results) + 2)
    header = f"  {'':<18}" + "".join(f"{name:>{width}}" for name, _ in results)
    lines = [header, "  " + "-" * (18 + width * len(results))]

    for label, key, spec in _ROWS:
        cells = []
        for _, res in results:
            v = res.stats.get(key)
            cells.append(f"{'-':>{width}}" if v is None else f"{format(v, spec):>{width}}")
        lines.append(f"  {label:<18}" + "".join(cells))

    base = results[0][1].stats.get("expectancyNetPts")
    if base is not None and len(results) > 1:
        cells = [f"{'base':>{width}}"]
        for _, res in results[1:]:
            v = res.stats.get("expectancyNetPts")
            cells.append(f"{'-':>{width}}" if v is None else f"{v - base:>+{width}.2f}")
        lines.append(f"  {'net vs base':<18}" + "".join(cells))

    return lines
