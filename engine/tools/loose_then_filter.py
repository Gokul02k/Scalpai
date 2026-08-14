"""Can a learned filter do the job the 0.2% stop floor is currently doing?

The floor blocks a 100-point day from producing a single trade. Removing it
outright is monotonically worse -- gross falls from +6.41 to +3.58 per trade
because the extra setups are genuinely poorer, not merely cost-marginal.

But that test took *every* extra signal. The floor is a hand-tuned selectivity
knob applied before anything has been learned, and the obvious alternative is
to widen the candidate pool and let the model choose from it. If the filter can
find 1,000 good trades inside 4,994 loose candidates, that beats 600 good
trades inside 1,491 strict ones -- more trades and more money, which is the
thing actually being asked for.

If it cannot, the floor is carrying real information and stays.

    .venv/bin/python -m engine.tools.loose_then_filter
"""
from __future__ import annotations

from pathlib import Path

from engine.backtest import BacktestConfig, get_cost_model, run_backtest
from engine.backtest.regime import load_vix
from engine.core.suggestion import StrategyFlags
from engine.data import CandleStore
from engine.ml.model import (
    build_dataset, enrich_with_vix, load_dataset, save_dataset,
    seed_robustness, walk_forward,
)

VAR = Path(__file__).parent.parent / "var"
YEARS = 9.05  # Jul 2017 .. Aug 2026, for a per-year trade count


def dataset(name: str, flags: StrategyFlags, rows):
    cache = VAR / f"mlset_{name}.json"
    if cache.exists():
        samples, cost = load_dataset(cache)
        print(f"  {name:12s} {len(samples):5d} signals (cached)")
    else:
        print(f"  {name:12s} replaying {len(rows)} bars…")
        result = run_backtest(
            rows,
            BacktestConfig(symbol="NIFTY", interval="5m", instrument="NIFTY",
                           collect_features=True, flags=flags),
            get_cost_model("index_points"),
        )
        samples = build_dataset(result.logs, include_expired=True)
        cost = result.stats.get("costPerTradePts") or 6.0
        save_dataset(samples, cache, cost)
        print(f"  {name:12s} {len(samples):5d} signals")

    vix = load_vix()
    if len(vix):
        enrich_with_vix(samples, vix)
    return [s for s in samples if s.status in ("target", "stop")], cost


def report(name: str, samples, cost: float) -> None:
    wf = walk_forward(samples, cost_pts=cost, n_folds=4,
                      keep_fracs=(1.0, 0.5, 0.4, 0.3, 0.2, 0.1))
    if wf is None:
        print(f"  {name}: not enough samples")
        return

    print(f"\n  {name}  —  {len(samples)} resolved, out-of-sample AUC {wf.oos_auc:.3f}")
    print(f"  {'keep':>6}{'oos trades':>12}{'per year':>10}{'win%':>7}"
          f"{'net/trade':>11}{'total net':>11}")
    print("  " + "-" * 57)
    for k in wf.keeps:
        # Out-of-sample trades come from the test blocks only, roughly the last
        # three quarters of the period once the first fold is spent training.
        print(f"  {k.keep_frac:>5.0%}{k.trades:>12d}{k.trades / YEARS * 1.35:>10.0f}"
              f"{k.win_rate:>7.1f}{k.net_per_trade:>+11.2f}{k.total_net:>+11.0f}")

    spreads, aucs, recent = seed_robustness(samples, cost_pts=cost, n_folds=4,
                                            seeds=range(6))
    print(f"\n  across 6 seeds, AUC {min(aucs):.3f}..{max(aucs):.3f}")
    for s in spreads:
        print("   ", s.line())


def main() -> int:
    rows = CandleStore().read("NIFTY", "INDEX", "5m")
    print(f"\n  {len(rows)} bars\n")

    strict, c1 = dataset("strict", StrategyFlags(), rows)
    loose, c2 = dataset("loose", StrategyFlags(min_stop_pct=0.0), rows)

    print("\n" + "=" * 62)
    report("v1 floor 0.20%  (what runs today)", strict, c1)
    print("\n" + "=" * 62)
    report("ATR floor, filter picks from the wider pool", loose, c2)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
