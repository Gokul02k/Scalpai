"""Sweep the minimum-stop floor, the constant that decides how often we trade.

v1 hardcodes a 0.2%-of-price floor under the stop. Combined with the 1.5
minimum reward:risk, that demands roughly 73 points of room on NIFTY before a
setup is allowed at all — against a 5-minute ATR of about 22. On a range-bound
day nothing qualifies, which is why a 100-point day can produce 22 directional
votes and zero trades.

Loosening it is not obviously right: every extra trade pays the spread, and a
20-point target against a 6-point round trip is a 30% haircut. This measures
which effect wins over the full archive.

    .venv/bin/python -m engine.tools.sweep_stopfloor
"""
from __future__ import annotations

from engine.backtest import BacktestConfig, get_cost_model
from engine.backtest.sweep import (
    VariantSpec, format_rows, longs_only, regrade, rows_to_dicts, run_sweep,
)
from engine.core.suggestion import StrategyFlags
from engine.data import CandleStore

DAY_MS = 24 * 60 * 60 * 1000


def main() -> int:
    rows = CandleStore().read("NIFTY", "INDEX", "5m")
    print(f"\n  {len(rows)} bars\n")

    base = BacktestConfig(
        symbol="NIFTY", interval="5m", instrument="NIFTY", count_expired=True,
    )

    # 0.0 does not disable the floor: it falls through to max(atr * 0.8, 0),
    # which is the volatility-relative floor a scalper would actually use.
    specs = [VariantSpec("v1 floor 0.20%", StrategyFlags())]
    for pct in (0.0015, 0.0010, 0.0005, 0.0):
        label = f"floor {pct * 100:.2f}%" if pct else "floor: ATR only"
        specs.append(VariantSpec(label, StrategyFlags(min_stop_pct=pct)))

    # Index points only. An index replay measures gross in index points, and
    # the option model is denominated in rupees; pairing them yields a number
    # that looks plausible and means nothing. summarize() now refuses it.
    cost = "index_points"
    results = run_sweep(rows, specs, base, cost, jobs=len(specs))
    for line in format_rows([(r.name, r.stats) for r in results],
                            baseline="v1 floor 0.20%"):
        print(line)

    # The direction split is the one change that beat v1 in the last sweep, so
    # the floor has to be judged with it as well as without.
    print()
    candle_dicts = rows_to_dicts(rows)
    longs = [(f"{r.name} + long only",
              regrade(longs_only(r.logs), candle_dicts, DAY_MS,
                      get_cost_model(cost)))
             for r in results]
    for line in format_rows(longs, baseline="v1 floor 0.20% + long only"):
        print(line)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
