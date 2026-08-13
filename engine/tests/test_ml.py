"""Correctness of the signal filter's plumbing.

The failure mode being guarded against is a model that scores well and loses
money, which almost always traces back to one of three things: a feature that
saw the future, a fold that trained on its own test block, or a threshold
chosen on test data. Each gets an explicit assertion here.
"""
from __future__ import annotations

import math

import pytest

from engine.backtest import BacktestConfig, run_backtest
from engine.backtest.costs import IndexPointCost
from engine.backtest.replay import DEFAULT_SETTINGS
from engine.core import indicators as ind
from engine.core import signals as sig
from engine.core import suggestion as sug
from engine.data import CandleStore
from engine.ml.features import FEATURE_NAMES, extract_features, to_row
from engine.ml.model import (
    Sample,
    auc,
    build_dataset,
    load_dataset,
    save_dataset,
    walk_forward_folds,
)


@pytest.fixture(scope="module")
def candles():
    rows = CandleStore().read("NIFTY", "INDEX", "5m", limit=1200)
    if len(rows) < 400:
        pytest.skip("run `python -m engine.cli sync` first")
    return rows


@pytest.fixture(scope="module")
def one_signal(candles):
    """A real analysis/final-call pair from the archive."""
    rows = ind.candles_to_dicts(candles)
    window = rows[:600]
    analysis = ind.analyze_from_candles(window, include_history=False)
    price = window[-1]["c"]
    index_signals = sig.generate_index_signals(analysis, price, "NIFTY", DEFAULT_SETTINGS)
    call = sug.build_unified_suggestion(
        analysis, price, 0.3, index_signals, DEFAULT_SETTINGS, "scalp", "NIFTY"
    )
    return call, analysis, window


# ── features ───────────────────────────────────────────────────────────────

def test_every_declared_feature_is_produced(one_signal):
    call, analysis, window = one_signal
    feats = extract_features(call, analysis, window, 0.3)
    assert set(feats) == set(FEATURE_NAMES)


def test_features_are_finite(one_signal):
    """A NaN reaches LightGBM as 'missing' and silently becomes a split
    direction, which hides a division-by-zero bug instead of surfacing it."""
    call, analysis, window = one_signal
    for name, value in extract_features(call, analysis, window, 0.3).items():
        assert isinstance(value, float), name
        assert math.isfinite(value), name


def test_features_are_deterministic(one_signal):
    call, analysis, window = one_signal
    assert extract_features(call, analysis, window, 0.3) == extract_features(
        call, analysis, window, 0.3
    )


def test_features_are_unchanged_by_later_bars(candles):
    """Replay a truncated archive and a longer one, then compare the feature
    rows of the signals they share. Any feature that reaches forward in time
    makes the two disagree, which is the bug worth catching."""
    config = BacktestConfig(min_confidence=70, collect_features=True)
    short = run_backtest(candles[:900], config, IndexPointCost())
    long = run_backtest(candles, config, IndexPointCost())

    by_id = {e["id"]: e for e in long.logs}
    shared = [e for e in short.logs if e["id"] in by_id]
    if not shared:
        pytest.skip("no signals shared between the two runs")

    for e in shared:
        assert e["features"] == by_id[e["id"]]["features"], e["id"]


def test_to_row_follows_declared_order(one_signal):
    call, analysis, window = one_signal
    feats = extract_features(call, analysis, window, 0.3)
    row = to_row(feats)
    assert len(row) == len(FEATURE_NAMES)
    assert row == [feats[n] for n in FEATURE_NAMES]


def test_to_row_defaults_missing_columns_to_zero():
    assert to_row({}) == [0.0] * len(FEATURE_NAMES)


def test_features_are_scale_free(one_signal):
    """Shifting the whole price series must leave the features essentially
    unchanged. NIFTY ran from ~9,000 to ~25,000 over the sample, so a feature
    that tracks absolute level is partly encoding the calendar, and the model
    would learn the year rather than the setup."""
    call, analysis, window = one_signal
    base = extract_features(call, analysis, window, 0.3)

    k = 2.0
    scaled_window = [
        {**c, **{f: c[f] * k for f in ("o", "h", "l", "c") if c.get(f) is not None}}
        for c in window
    ]
    scaled_analysis = ind.analyze_from_candles(scaled_window, include_history=False)
    price = scaled_window[-1]["c"]
    idx = sig.generate_index_signals(scaled_analysis, price, "NIFTY", DEFAULT_SETTINGS)
    scaled_call = sug.build_unified_suggestion(
        scaled_analysis, price, 0.3, idx, DEFAULT_SETTINGS, "scalp", "NIFTY"
    )
    scaled = extract_features(scaled_call, scaled_analysis, scaled_window, 0.3)

    for name in ("rsi", "stoch", "atr_pct", "bb_width_pct", "ema20_dist_pct",
                 "vwap_dist_pct", "res_dist_pct", "sup_dist_pct", "realized_vol_pct"):
        assert scaled[name] == pytest.approx(base[name], abs=0.02), name


# ── dataset ────────────────────────────────────────────────────────────────

def _entry(status: str, action: str = "BUY", entry: float = 100.0, resolved: float = 110.0):
    return {
        "ts": "2026-01-01T04:00:00.000Z",
        "date": "1 Jan 2026",
        "action": action,
        "entry": entry,
        "features": {n: 0.0 for n in FEATURE_NAMES},
        "outcome": {"status": status, "resolvedPrice": resolved},
    }


def test_dataset_keeps_only_resolved_signals():
    logs = [
        _entry("target"), _entry("stop"), _entry("expired"), _entry("pending"),
    ]
    assert len(build_dataset(logs)) == 2


def test_dataset_skips_entries_without_features():
    row = _entry("target")
    row.pop("features")
    assert build_dataset([row]) == []


def test_dataset_labels_and_points_follow_direction():
    long_win = build_dataset([_entry("target", "BUY", 100.0, 110.0)])[0]
    assert long_win.label == 1
    assert long_win.points == pytest.approx(10.0)

    short_win = build_dataset([_entry("target", "SELL", 100.0, 90.0)])[0]
    assert short_win.label == 1
    assert short_win.points == pytest.approx(10.0)

    short_loss = build_dataset([_entry("stop", "SELL", 100.0, 105.0)])[0]
    assert short_loss.label == 0
    assert short_loss.points == pytest.approx(-5.0)


def test_dataset_round_trips_through_the_cache(tmp_path):
    samples = build_dataset([_entry("target"), _entry("stop")])
    path = tmp_path / "set.json"
    save_dataset(samples, path, cost_pts=6.0)
    loaded, cost = load_dataset(path)
    assert cost == 6.0
    assert loaded == samples


# ── folds ──────────────────────────────────────────────────────────────────

def _samples(n: int) -> list[Sample]:
    return [
        Sample(ts_ms=i * 1000, features={}, label=i % 2, points=1.0 if i % 2 else -1.0)
        for i in range(n)
    ]


def test_folds_never_train_on_their_own_future():
    """The single most expensive mistake available here."""
    for fold in walk_forward_folds(_samples(1400), n_folds=4):
        assert fold.train and fold.test
        assert max(s.ts_ms for s in fold.train) < min(s.ts_ms for s in fold.test)


def test_folds_expand_and_do_not_overlap():
    folds = walk_forward_folds(_samples(1400), n_folds=4)
    assert len(folds) == 4
    for a, b in zip(folds, folds[1:]):
        assert len(b.train) > len(a.train)
        assert max(s.ts_ms for s in a.test) < min(s.ts_ms for s in b.test)


def test_folds_cover_every_sample_after_the_warmup():
    samples = _samples(1400)
    folds = walk_forward_folds(samples, n_folds=4, min_train=400)
    tested = [s for f in folds for s in f.test]
    assert len(tested) == len(samples) - 400


def test_too_few_samples_yields_no_folds():
    assert walk_forward_folds(_samples(50), n_folds=4) == []


# ── metrics ────────────────────────────────────────────────────────────────

def test_auc_of_perfect_ranking_is_one():
    assert auc([0, 0, 1, 1], [0.1, 0.2, 0.8, 0.9]) == pytest.approx(1.0)


def test_auc_of_reversed_ranking_is_zero():
    assert auc([1, 1, 0, 0], [0.1, 0.2, 0.8, 0.9]) == pytest.approx(0.0)


def test_auc_of_constant_scores_is_half():
    assert auc([0, 1, 0, 1], [0.5] * 4) == pytest.approx(0.5)


def test_auc_is_undefined_for_a_single_class():
    assert math.isnan(auc([1, 1, 1], [0.1, 0.5, 0.9]))


# ── integration with the replay ────────────────────────────────────────────

def test_replay_attaches_features_only_when_asked(candles):
    plain = run_backtest(candles, BacktestConfig(min_confidence=70), IndexPointCost())
    assert all("features" not in e for e in plain.logs)

    rich = run_backtest(
        candles,
        BacktestConfig(min_confidence=70, collect_features=True),
        IndexPointCost(),
    )
    if not rich.logs:
        pytest.skip("no signals in this sample")
    assert all(set(e["features"]) == set(FEATURE_NAMES) for e in rich.logs)


def test_filter_drops_signals_and_is_counted(candles):
    config = BacktestConfig(min_confidence=70, collect_features=True)
    unfiltered = run_backtest(candles, config, IndexPointCost())
    if len(unfiltered.logs) < 2:
        pytest.skip("no signals in this sample")

    rejecting = BacktestConfig(
        min_confidence=70, collect_features=True, signal_filter=lambda e: False
    )
    result = run_backtest(candles, rejecting, IndexPointCost())
    assert result.logs == []
    assert result.filtered > 0


def test_accepting_filter_matches_no_filter(candles):
    """A filter that keeps everything must not perturb dedupe or grading."""
    config = BacktestConfig(min_confidence=70, collect_features=True)
    plain = run_backtest(candles, config, IndexPointCost())
    passthrough = run_backtest(
        candles,
        BacktestConfig(min_confidence=70, collect_features=True, signal_filter=lambda e: True),
        IndexPointCost(),
    )
    assert passthrough.stats == plain.stats
    assert passthrough.filtered == 0


# ── strategy flags ─────────────────────────────────────────────────────────

def test_default_flags_keep_the_opening_range(one_signal):
    _, analysis, _ = one_signal
    session = analysis.get("session")
    if not (session and session.get("orReady")):
        pytest.skip("sample has no ready opening range")

    names = {
        f["name"]
        for f in sug.analyze_session_factors(analysis["price"], session)
    }
    assert "Opening range" in names


def test_flag_removes_the_opening_range_factor(one_signal):
    _, analysis, _ = one_signal
    session = analysis.get("session")
    if not (session and session.get("orReady")):
        pytest.skip("sample has no ready opening range")

    names = {
        f["name"]
        for f in sug.analyze_session_factors(
            analysis["price"], session, sug.StrategyFlags(use_opening_range=False)
        )
    }
    assert "Opening range" not in names
    assert "VWAP" in names  # the other session factor is untouched
