"""Does the wider pool still work once the VIX gate is applied on top?

The gate and the filter overlap: both refuse trades, and stacking two selective
rules can leave too little to trade or select the same setups twice. This
prices the combination that would actually run.

    .venv/bin/python -m engine.tools.loose_gate
"""
from __future__ import annotations

from pathlib import Path

from engine.backtest.regime import load_vix
from engine.ml.model import enrich_with_vix, load_dataset, seed_robustness, walk_forward

VAR = Path(__file__).parent.parent / "var"


def run(name: str, keep: float, gate: float | None) -> None:
    samples, cost = load_dataset(VAR / f"mlset_{name}.json")
    vix = load_vix()
    enrich_with_vix(samples, vix)
    samples = [s for s in samples if s.status in ("target", "stop")]

    if gate is not None:
        before = len(samples)
        samples = [s for s in samples
                   if 0 < (s.features or {}).get("vix_level", 0) <= gate]
        print(f"\n  {name}, gate {gate:.0f}: {before} -> {len(samples)} samples")
    else:
        print(f"\n  {name}, no gate: {len(samples)} samples")

    if len(samples) < 500:
        print("   too few samples to validate honestly")
        return

    wf = walk_forward(samples, cost_pts=cost, n_folds=4, keep_fracs=(keep,))
    k = wf.keeps[0]
    print(f"   keep {keep:.0%}   AUC {wf.oos_auc:.3f}   {k.trades} oos trades   "
          f"win {k.win_rate:.1f}%   net {k.net_per_trade:+.2f}   "
          f"total {k.total_net:+.0f}")
    for f in wf.fold_reports:
        print(f"     {f.period:<26}{f.filtered.trades:>6} trades"
              f"{f.filtered.net_per_trade:>+9.2f}")
    _, _, recent = seed_robustness(samples, cost_pts=cost, n_folds=4,
                                   keep_fracs=(keep,), seeds=range(6))
    if recent:
        ok = sum(1 for v in recent if v > 0)
        print(f"     recent fold across seeds {min(recent):+.2f}..{max(recent):+.2f}"
              f"  {ok}/6 positive")


def main() -> int:
    run("strict", 0.40, 16.0)
    run("loose", 0.20, 16.0)
    run("loose", 0.30, 16.0)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
