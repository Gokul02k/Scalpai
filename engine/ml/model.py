"""Train and validate the signal filter.

The validation scheme matters more than the model. With ~1,400 samples and 37
features, a gradient booster will happily memorise the training set and report
a win rate that does not exist. Three rules keep the number honest:

  * Folds are chronological and expanding. Fold k trains on everything before
    a cut date and tests after it, which is the only split that matches how
    the model would actually be used.
  * The keep-threshold is a quantile of the *training* predictions. Choosing
    it on the test set would leak the answer through the back door, and it is
    the easiest mistake to make here.
  * Every reported figure comes from out-of-sample predictions only.

If out-of-sample AUC lands near 0.5, the honest conclusion is that the setup
features do not separate winners from losers, and the filter should be
abandoned rather than tuned until a fold looks good.
"""
from __future__ import annotations

import json
import math
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Sequence

from .features import FEATURE_NAMES, to_row

#: Deliberately small. The sample is ~1,400 trades; capacity beyond this fits
#: noise and the walk-forward folds will show it.
DEFAULT_PARAMS: dict[str, Any] = {
    "objective": "binary",
    "metric": "auc",
    "learning_rate": 0.03,
    "num_leaves": 8,
    "min_data_in_leaf": 40,
    "feature_fraction": 0.7,
    "bagging_fraction": 0.8,
    "bagging_freq": 1,
    "lambda_l2": 5.0,
    "verbose": -1,
    "seed": 7,
    "deterministic": True,
    "num_threads": 4,
}

DEFAULT_ROUNDS = 300


@dataclass
class Sample:
    """One graded signal: what was known at entry, and what happened."""

    ts_ms: int
    features: dict[str, float]
    label: int  # 1 = reached target, 0 = hit stop
    points: float  # realised index points, signed for direction
    date: str = ""
    #: Wall-clock hours from entry to resolution. Needed to price theta, which
    #: an index-points backtest cannot see: holding a decaying option for six
    #: hours costs real money even when the trade is eventually right.
    hold_hours: float = 0.0
    #: "target", "stop" or "expired". Expired trades carry no training label,
    #: but they must appear in any P&L that prices the instrument: they are
    #: precisely the trades that sat there decaying and paid for nothing.
    status: str = ""


def build_dataset(logs: Sequence[dict], include_expired: bool = False) -> list[Sample]:
    """Graded signals to training samples, oldest first.

    Still-active signals are always dropped; they have no outcome yet.

    Expired signals are dropped for *training* — "target before stop" is the
    question the filter needs answered, and a trade where neither happened
    carries no answer. They must be kept for *P&L*, though, because they are
    the trades that were held, decayed, and paid nothing. Excluding them from
    an options P&L quietly removes the worst cases and flatters the result.
    """
    keep = ("target", "stop", "expired") if include_expired else ("target", "stop")
    out: list[Sample] = []
    for e in logs:
        outcome = e.get("outcome") or {}
        status = outcome.get("status")
        if status not in keep:
            continue
        feats = e.get("features")
        if not feats:
            continue

        entry = e.get("entry")
        resolved = outcome.get("resolvedPrice")
        if entry is None or resolved is None:
            continue
        direction = 1 if e.get("action") == "BUY" else -1
        started = _ts_of(e)
        ended = _iso_ms(outcome.get("resolvedTs"))

        out.append(
            Sample(
                ts_ms=started,
                features=feats,
                label=1 if status == "target" else 0,  # expired counts as "not target"
                points=(resolved - entry) * direction,
                date=e.get("date", ""),
                hold_hours=(ended - started) / 3_600_000 if ended and started else 0.0,
                status=status,
            )
        )
    out.sort(key=lambda s: s.ts_ms)
    return out


def save_dataset(samples: Sequence[Sample], path: Path, cost_pts: float) -> None:
    """Cache the replay output. Collecting it costs a full bar-by-bar pass over
    nine years, which is too slow to sit in the loop while tuning a model.

    The cost assumption is stored with the samples so a cached run reports the
    same economics as the run that produced it.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps({"cost_pts": cost_pts, "samples": [asdict(s) for s in samples]})
    )


def load_dataset(path: Path) -> tuple[list[Sample], float]:
    blob = json.loads(path.read_text())
    return [Sample(**row) for row in blob["samples"]], blob["cost_pts"]


def _iso_ms(value: str | None) -> int:
    from datetime import datetime

    if not value:
        return 0
    try:
        return int(datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() * 1000)
    except ValueError:
        return 0


def _ts_of(entry: dict) -> int:
    return _iso_ms(entry.get("ts"))


@dataclass
class Fold:
    index: int
    train: list[Sample]
    test: list[Sample]


def walk_forward_folds(
    samples: Sequence[Sample], n_folds: int = 4, min_train: int = 400
) -> list[Fold]:
    """Expanding-window chronological folds.

    Each fold trains on all history up to a cut and tests on the block after
    it, so early folds train on little and late folds train on a lot — the
    same position the live system is in as it accumulates trades.
    """
    n = len(samples)
    if n < min_train + n_folds:
        return []

    block = (n - min_train) // n_folds
    if block < 20:
        return []

    folds = []
    for k in range(n_folds):
        cut = min_train + k * block
        end = cut + block if k < n_folds - 1 else n
        folds.append(Fold(index=k, train=list(samples[:cut]), test=list(samples[cut:end])))
    return folds


def _matrix(samples: Sequence[Sample]):
    import numpy as np

    return (
        np.array([to_row(s.features) for s in samples], dtype=np.float64),
        np.array([s.label for s in samples], dtype=np.int32),
    )


def train(samples: Sequence[Sample], params: dict | None = None, rounds: int = DEFAULT_ROUNDS):
    import lightgbm as lgb

    X, y = _matrix(samples)
    dset = lgb.Dataset(X, label=y, feature_name=list(FEATURE_NAMES), free_raw_data=False)
    return lgb.train({**DEFAULT_PARAMS, **(params or {})}, dset, num_boost_round=rounds)


def predict(model, samples: Sequence[Sample]) -> list[float]:
    if not samples:
        return []
    return list(model.predict(_matrix(samples)[0]))


def auc(labels: Sequence[int], scores: Sequence[float]) -> float:
    """Rank-based AUC, ties averaged. 0.5 means the scores carry no ordering
    information about the outcome."""
    pairs = sorted(zip(scores, labels))
    n = len(pairs)
    pos = sum(labels)
    neg = n - pos
    if not pos or not neg:
        return float("nan")

    ranks = [0.0] * n
    i = 0
    while i < n:
        j = i
        while j + 1 < n and pairs[j + 1][0] == pairs[i][0]:
            j += 1
        avg = (i + j) / 2 + 1
        for k in range(i, j + 1):
            ranks[k] = avg
        i = j + 1

    rank_sum = sum(r for r, (_, lab) in zip(ranks, pairs) if lab == 1)
    return (rank_sum - pos * (pos + 1) / 2) / (pos * neg)


@dataclass
class KeepResult:
    """Economics of trading only the top `keep_frac` of scored signals."""

    keep_frac: float
    trades: int
    win_rate: float
    gross_per_trade: float
    net_per_trade: float
    total_net: float

    def line(self) -> str:
        return (
            f"  keep top {self.keep_frac:>4.0%}   {self.trades:5d} trades   "
            f"win {self.win_rate:5.1f}%   gross {self.gross_per_trade:+6.2f}   "
            f"net {self.net_per_trade:+6.2f}   total {self.total_net:+8.0f}"
        )


def _economics(kept: Sequence[Sample], keep_frac: float, cost_pts: float) -> KeepResult:
    n = len(kept)
    if not n:
        return KeepResult(keep_frac, 0, 0.0, 0.0, 0.0, 0.0)
    wins = sum(s.label for s in kept)
    gross = sum(s.points for s in kept) / n
    return KeepResult(
        keep_frac=keep_frac,
        trades=n,
        win_rate=wins / n * 100,
        gross_per_trade=gross,
        net_per_trade=gross - cost_pts,
        total_net=(gross - cost_pts) * n,
    )


@dataclass
class FoldReport:
    """One fold's out-of-sample block, filtered and unfiltered.

    Reported separately because an average across folds hides the case that
    matters most: a filter that worked in 2019 and stopped working in 2024 has
    an attractive mean and no future.
    """

    index: int
    period: str
    train_size: int
    auc: float
    baseline: KeepResult
    filtered: KeepResult

    def line(self) -> str:
        return (
            f"  fold {self.index}  {self.period:23}  train {self.train_size:4d}  "
            f"auc {self.auc:.3f}   base {self.baseline.net_per_trade:+6.2f}   "
            f"filtered {self.filtered.net_per_trade:+6.2f}   "
            f"({self.filtered.trades} trades, win {self.filtered.win_rate:.0f}%)"
        )


@dataclass
class WalkForwardReport:
    folds: int
    oos_samples: int
    oos_auc: float
    baseline: KeepResult
    keeps: list[KeepResult] = field(default_factory=list)
    fold_aucs: list[float] = field(default_factory=list)
    fold_reports: list[FoldReport] = field(default_factory=list)
    headline_keep: float = 0.5

    def lines(self) -> list[str]:
        out = [
            f"  folds                {self.folds}",
            f"  out-of-sample trades {self.oos_samples}",
            f"  out-of-sample AUC    {self.oos_auc:.3f}"
            + ("   (0.5 = no signal)" if self.oos_auc < 0.55 else ""),
            "  per-fold AUC         "
            + ", ".join(f"{a:.3f}" for a in self.fold_aucs),
            "",
            "  unfiltered baseline over the same out-of-sample trades:",
            self.baseline.line().replace("keep top 100%", "all       "),
            "",
            "  filtered:",
        ]
        out += [k.line() for k in self.keeps]
        if self.fold_reports:
            out += [
                "",
                f"  by fold, at keep top {self.headline_keep:.0%} "
                f"(does it still work in the recent period?):",
            ]
            out += [f.line() for f in self.fold_reports]
        return out


def walk_forward(
    samples: Sequence[Sample],
    cost_pts: float = 6.0,
    n_folds: int = 4,
    keep_fracs: Sequence[float] = (0.5, 0.4, 0.3, 0.2, 0.1),
    params: dict | None = None,
    rounds: int = DEFAULT_ROUNDS,
) -> WalkForwardReport | None:
    """Fit and score the filter without ever letting a fold see its own future."""
    folds = walk_forward_folds(samples, n_folds=n_folds)
    if not folds:
        return None

    oos: list[Sample] = []
    oos_scores: list[float] = []
    fold_aucs: list[float] = []
    fold_reports: list[FoldReport] = []
    # Threshold chosen per fold on training scores, then applied to that
    # fold's test block. Kept per keep-fraction so each is independent.
    kept: dict[float, list[Sample]] = {f: [] for f in keep_fracs}
    headline = max(keep_fracs) if keep_fracs else 0.5

    for fold in folds:
        model = train(fold.train, params, rounds)
        train_scores = predict(model, fold.train)
        test_scores = predict(model, fold.test)

        oos.extend(fold.test)
        oos_scores.extend(test_scores)
        fold_auc = auc([s.label for s in fold.test], test_scores)
        fold_aucs.append(fold_auc)

        ordered = sorted(train_scores)
        fold_kept: dict[float, list[Sample]] = {}
        for frac in keep_fracs:
            idx = min(len(ordered) - 1, max(0, int(math.ceil((1 - frac) * len(ordered))) - 1))
            threshold = ordered[idx]
            picked = [s for s, sc in zip(fold.test, test_scores) if sc >= threshold]
            fold_kept[frac] = picked
            kept[frac].extend(picked)

        fold_reports.append(
            FoldReport(
                index=fold.index,
                period=f"{fold.test[0].date} .. {fold.test[-1].date}" if fold.test else "-",
                train_size=len(fold.train),
                auc=fold_auc,
                baseline=_economics(fold.test, 1.0, cost_pts),
                filtered=_economics(fold_kept.get(headline, []), headline, cost_pts),
            )
        )

    return WalkForwardReport(
        folds=len(folds),
        oos_samples=len(oos),
        oos_auc=auc([s.label for s in oos], oos_scores),
        fold_aucs=fold_aucs,
        fold_reports=fold_reports,
        headline_keep=headline,
        baseline=_economics(oos, 1.0, cost_pts),
        keeps=[_economics(kept[f], f, cost_pts) for f in keep_fracs],
    )


@dataclass
class SeedSpread:
    """How much of a result is the strategy and how much is the seed."""

    keep_frac: float
    mean_net: float
    stdev_net: float
    worst_net: float
    best_net: float
    positive_seeds: int
    total_seeds: int

    @property
    def robust(self) -> bool:
        """Worth acting on only if every seed agrees on the sign. A mean that
        is positive because two seeds out of ten carried it is a coin flip
        wearing a lab coat."""
        return self.positive_seeds == self.total_seeds and self.worst_net > 0

    def line(self) -> str:
        return (
            f"  keep top {self.keep_frac:>4.0%}   net {self.mean_net:+6.2f} "
            f"± {self.stdev_net:4.2f}   worst {self.worst_net:+6.2f}   "
            f"best {self.best_net:+6.2f}   "
            f"{self.positive_seeds}/{self.total_seeds} seeds positive"
            + ("   <-- robust" if self.robust else "")
        )


def seed_robustness(
    samples: Sequence[Sample],
    cost_pts: float = 6.0,
    n_folds: int = 4,
    keep_fracs: Sequence[float] = (0.5, 0.4, 0.3, 0.2, 0.1),
    seeds: Sequence[int] = tuple(range(10)),
) -> tuple[list[SeedSpread], list[float], list[float]]:
    """Rerun the whole walk-forward under different seeds.

    Bagging and feature sampling make the fit stochastic, so a single run's
    number confounds the edge with the draw. If the spread across seeds
    straddles zero, there is no edge to deploy no matter how good the best
    seed looked.
    """
    import statistics as st

    by_frac: dict[float, list[float]] = {f: [] for f in keep_fracs}
    aucs: list[float] = []
    # The final fold is the most recent regime, and the only one that speaks
    # to whether the filter would work if switched on today.
    recent: list[float] = []

    for seed in seeds:
        report = walk_forward(
            samples,
            cost_pts=cost_pts,
            n_folds=n_folds,
            keep_fracs=keep_fracs,
            params={"seed": seed, "bagging_seed": seed, "feature_fraction_seed": seed},
        )
        if report is None:
            continue
        aucs.append(report.oos_auc)
        for keep in report.keeps:
            by_frac[keep.keep_frac].append(keep.net_per_trade)
        if report.fold_reports:
            recent.append(report.fold_reports[-1].filtered.net_per_trade)

    spreads = []
    for frac in keep_fracs:
        vals = by_frac[frac]
        if not vals:
            continue
        spreads.append(
            SeedSpread(
                keep_frac=frac,
                mean_net=st.mean(vals),
                stdev_net=st.pstdev(vals) if len(vals) > 1 else 0.0,
                worst_net=min(vals),
                best_net=max(vals),
                positive_seeds=sum(1 for v in vals if v > 0),
                total_seeds=len(vals),
            )
        )
    return spreads, aucs, recent


def enrich_with_vix(samples: Sequence[Sample], vix) -> int:
    """Attach volatility-regime features to samples already collected.

    Joined here rather than inside `extract_features` because VIX is a
    separate daily series and threading it through the bar-by-bar replay would
    couple the strategy path to a second data source for no gain. The join key
    is the trade's own timestamp, and `VixSeries` only ever exposes closes from
    strictly earlier days.

    Returns how many samples were matched, which matters: VIX history starts in
    2015 and the archive in 2017, but any gap leaves zeroed columns that would
    otherwise pass unnoticed.
    """
    matched = 0
    for s in samples:
        context = vix.context_at(s.ts_ms)
        if context:
            s.features.update(context)
            matched += 1
    return matched


def save_model(model, path: Path, meta: dict | None = None) -> None:
    """Persist a fitted booster plus the context needed to trust it later.

    The metadata is not decoration. A model file with no record of which
    features it was fit on, over what period, is impossible to audit once the
    feature list changes — and the feature list will change.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    model.save_model(str(path))
    path.with_suffix(".meta.json").write_text(
        json.dumps({"features": list(FEATURE_NAMES), **(meta or {})}, indent=1)
    )


def load_model(path: Path):
    """Load a booster, refusing it if the feature list has moved underneath.

    Silently scoring today's features through a model fit on a different
    column order would produce plausible-looking nonsense, which is worse than
    an error.
    """
    import lightgbm as lgb

    meta_path = path.with_suffix(".meta.json")
    meta = json.loads(meta_path.read_text()) if meta_path.exists() else {}
    trained_on = meta.get("features")
    if trained_on and trained_on != list(FEATURE_NAMES):
        raise ValueError(
            f"{path.name} was fit on {len(trained_on)} features that no longer "
            f"match the current {len(FEATURE_NAMES)}. Retrain: engine.cli train"
        )
    return lgb.Booster(model_file=str(path)), meta


def score_one(model, features: dict[str, float]) -> float:
    """Probability that a single live signal reaches target before stop."""
    import numpy as np

    return float(model.predict(np.array([to_row(features)], dtype=np.float64))[0])


def threshold_for(model, samples: Sequence[Sample], keep_frac: float) -> float:
    """Score above which a signal is taken, set so that `keep_frac` of the
    training population would have qualified.

    Derived from the training distribution rather than picked as a round
    number, because the raw probabilities are not calibrated — 0.5 means
    nothing in particular, while "top 40% of what I have seen" does.
    """
    scores = sorted(predict(model, samples))
    if not scores:
        return 0.0
    idx = min(len(scores) - 1, max(0, int(math.ceil((1 - keep_frac) * len(scores))) - 1))
    return scores[idx]


def walk_forward_selection(
    samples: Sequence[Sample],
    keep_frac: float = 0.5,
    n_folds: int = 4,
    seeds: Sequence[int] = tuple(range(10)),
    rounds: int = DEFAULT_ROUNDS,
) -> set[int]:
    """Indices the filter would have kept, out of sample.

    Each fold's threshold comes from its own training scores, and a sample is
    kept only if a majority of seeds agree — one seed's opinion is a draw, and
    the point of this is to feed a downstream comparison something stable.

    Samples in the first fold's training block are never scored out of sample
    and so are never returned. That is correct rather than a gap: the filter
    did not exist yet for those trades.
    """
    folds = walk_forward_folds(samples, n_folds=n_folds)
    if not folds:
        return set()

    index_of = {id(s): i for i, s in enumerate(samples)}
    votes: dict[int, int] = {}

    for seed in seeds:
        params = {"seed": seed, "bagging_seed": seed, "feature_fraction_seed": seed}
        for fold in folds:
            model = train(fold.train, params, rounds)
            train_scores = sorted(predict(model, fold.train))
            test_scores = predict(model, fold.test)

            pos = min(
                len(train_scores) - 1,
                max(0, int(math.ceil((1 - keep_frac) * len(train_scores))) - 1),
            )
            threshold = train_scores[pos]
            for s, sc in zip(fold.test, test_scores):
                if sc >= threshold:
                    votes[index_of[id(s)]] = votes.get(index_of[id(s)], 0) + 1

    majority = len(seeds) / 2
    return {i for i, v in votes.items() if v > majority}


def out_of_sample_indices(samples: Sequence[Sample], n_folds: int = 4) -> set[int]:
    """Indices that appear in some fold's test block, so filtered and
    unfiltered results are compared over the same trades."""
    folds = walk_forward_folds(samples, n_folds=n_folds)
    index_of = {id(s): i for i, s in enumerate(samples)}
    return {index_of[id(s)] for f in folds for s in f.test}


def importances(model) -> list[tuple[str, float]]:
    gains = model.feature_importance(importance_type="gain")
    total = sum(gains) or 1.0
    rows = [(name, g / total * 100) for name, g in zip(FEATURE_NAMES, gains)]
    return sorted(rows, key=lambda r: -r[1])
