"""Does the wider-pool result survive the only fold that matters?

Long-only looked like the best change in the last sweep and died on exactly
this test: strong over nine years, negative in the current regime. A filter is
only worth switching on if it works on the tape it is about to trade, so this
reports the most recent fold and a per-year split rather than the average.

    .venv/bin/python -m engine.tools.loose_recent
"""
from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

from engine.backtest.regime import load_vix
from engine.ml.model import (
    enrich_with_vix, load_dataset, seed_robustness, walk_forward,
)

VAR = Path(__file__).parent.parent / "var"


def load(name: str):
    samples, cost = load_dataset(VAR / f"mlset_{name}.json")
    vix = load_vix()
    if len(vix):
        enrich_with_vix(samples, vix)
    return [s for s in samples if s.status in ("target", "stop")], cost


def year_of(s) -> int:
    return datetime.fromtimestamp((s.ts or 0) / 1000, tz=timezone.utc).year


def check(name: str, keep: float) -> None:
    samples, cost = load(name)
    wf = walk_forward(samples, cost_pts=cost, n_folds=4, keep_fracs=(keep,))

    print(f"\n  {name}, keeping the top {keep:.0%}")
    print(f"  per-fold AUC   " + ", ".join(f"{a:.3f}" for a in wf.fold_aucs))

    _, _, recent = seed_robustness(samples, cost_pts=cost, n_folds=4,
                                   keep_fracs=(keep,), seeds=range(6))
    if recent:
        ok = sum(1 for v in recent if v > 0)
        print(f"  most recent fold, across 6 seeds: net {min(recent):+.2f} "
              f"to {max(recent):+.2f}, {ok}/6 positive")

    print(f"  {'fold':>6}  {'period':<26}{'trades':>8}{'unfiltered':>12}"
          f"{'filtered':>10}")
    for f in wf.fold_reports:
        print(f"  {f.index:>6}  {f.period:<26}{f.filtered.trades:>8}"
              f"{f.baseline.net_per_trade:>+12.2f}{f.filtered.net_per_trade:>+10.2f}")


def main() -> int:
    check("strict", 0.40)
    check("loose", 0.20)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
