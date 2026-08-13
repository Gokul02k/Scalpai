"""Volatility regime joining, and the filter-selection helper it feeds.

The load-bearing property here is that a trade is scored against the VIX a live
system could have read at the time. Reading the day's own close is a lookahead
that would be invisible in the output and would flatter exactly the days that
matter most.
"""
from __future__ import annotations

from datetime import datetime

import pytest

from engine.backtest.regime import VixSeries, split_by_regime
from engine.data.timeutil import IST
from engine.ml.model import Sample, out_of_sample_indices, walk_forward_selection


def _ts(day: str, hour: int = 11) -> int:
    d = datetime.strptime(day, "%Y-%m-%d").replace(hour=hour, tzinfo=IST)
    return int(d.timestamp() * 1000)


@pytest.fixture
def vix() -> VixSeries:
    return VixSeries({
        "2026-01-01": 11.0,
        "2026-01-02": 13.0,
        "2026-01-05": 17.0,
        "2026-01-06": 28.0,
    })


# ── lookup ─────────────────────────────────────────────────────────────────

def test_lookup_uses_the_previous_close(vix):
    """The day's own close is not knowable while the session is running."""
    assert vix.vix_at(_ts("2026-01-02")) == 11.0
    assert vix.vix_at(_ts("2026-01-05")) == 13.0
    assert vix.vix_at(_ts("2026-01-06")) == 17.0


def test_first_day_has_no_previous_close(vix):
    assert vix.vix_at(_ts("2026-01-01")) is None


def test_unknown_days_return_none(vix):
    assert vix.vix_at(_ts("2026-03-01")) is None
    assert vix.vix_at(0) is None


def test_close_on_returns_the_actual_close(vix):
    """Available for reporting, deliberately not used for scoring."""
    assert vix.close_on("2026-01-02") == 13.0
    assert vix.close_on("2026-01-03") is None


def test_span_reports_the_range(vix):
    assert vix.span == ("2026-01-01", "2026-01-06")


def test_empty_series_is_harmless():
    empty = VixSeries({})
    assert len(empty) == 0
    assert empty.span == ("", "")
    assert empty.vix_at(_ts("2026-01-02")) is None


# ── bucketing ──────────────────────────────────────────────────────────────

def _sample(day: str, points: float, label: int = 1) -> Sample:
    return Sample(
        ts_ms=_ts(day), features={}, label=label, points=points,
        date=day, hold_hours=1.0, status="target" if label else "stop",
    )


def test_trades_land_in_the_right_bucket(vix):
    samples = [
        _sample("2026-01-02", 10.0),   # prev close 11.0 -> calm
        _sample("2026-01-05", 20.0),   # prev close 13.0 -> low
        _sample("2026-01-06", 30.0),   # prev close 17.0 -> mid
    ]
    stats, unmatched = split_by_regime(samples, vix)
    assert unmatched == 0
    by_label = {s.label: s for s in stats}
    assert by_label["calm    <12"].trades == 1
    assert by_label["low   12-14"].trades == 1
    assert by_label["mid   14-18"].trades == 1
    assert by_label["high  18-25"].trades == 0


def test_unmatched_trades_are_counted_not_dropped_silently(vix):
    samples = [_sample("2026-01-02", 10.0), _sample("2026-07-01", 10.0)]
    stats, unmatched = split_by_regime(samples, vix)
    assert unmatched == 1
    assert sum(s.trades for s in stats) == 1


def test_shares_sum_to_a_hundred(vix):
    samples = [
        _sample("2026-01-02", 10.0),
        _sample("2026-01-05", 20.0),
        _sample("2026-01-06", 30.0),
    ]
    stats, _ = split_by_regime(samples, vix)
    assert sum(s.share for s in stats) == pytest.approx(100.0)


def test_option_nets_are_averaged_per_bucket(vix):
    samples = [_sample("2026-01-05", 20.0), _sample("2026-01-06", 30.0)]
    stats, _ = split_by_regime(samples, vix, option_net=[4.0, 10.0])
    by_label = {s.label: s for s in stats}
    assert by_label["low   12-14"].option_pts == pytest.approx(4.0)
    assert by_label["mid   14-18"].option_pts == pytest.approx(10.0)


# ── filter selection ───────────────────────────────────────────────────────

def _dataset(n: int = 1200) -> list[Sample]:
    """Samples where a feature predicts the label imperfectly.

    The noise is the point. With a perfectly separating feature the model
    outputs two spikes, a median threshold lands inside the lower one, and
    every trade clears it — which tests nothing about thresholding. Real
    scores are spread out, so the fixture makes them spread out.
    """
    import random

    rng = random.Random(11)
    out = []
    for i in range(n):
        x = rng.random()
        label = 1 if rng.random() < 0.15 + 0.6 * x else 0
        out.append(Sample(
            ts_ms=i * 60_000,
            features={"confidence": 40 + 50 * x, "rsi": rng.uniform(20, 80)},
            label=label,
            points=80.0 if label else -45.0,
            hold_hours=1.0,
            status="target" if label else "stop",
        ))
    return out


def test_selection_only_returns_out_of_sample_trades():
    """A trade in the first fold's training block was never scored out of
    sample, so it must not appear as a selection."""
    samples = _dataset()
    kept = walk_forward_selection(samples, keep_frac=0.5, seeds=(0, 1, 2))
    scored = out_of_sample_indices(samples)
    assert kept <= scored


def test_selection_keeps_roughly_the_requested_fraction():
    samples = _dataset()
    scored = out_of_sample_indices(samples)
    kept = walk_forward_selection(samples, keep_frac=0.5, seeds=(0, 1, 2))
    assert 0.2 * len(scored) < len(kept) < 0.8 * len(scored)


def test_a_tighter_keep_fraction_selects_fewer():
    samples = _dataset()
    loose = walk_forward_selection(samples, keep_frac=0.5, seeds=(0, 1))
    tight = walk_forward_selection(samples, keep_frac=0.1, seeds=(0, 1))
    assert len(tight) < len(loose)


def test_selection_finds_a_real_signal():
    """On data where the label is learnable, the kept set should skew towards
    winners. If this fails the plumbing is wrong, not the market."""
    samples = _dataset()
    kept = walk_forward_selection(samples, keep_frac=0.3, seeds=(0, 1, 2))
    if not kept:
        pytest.skip("no selections made")
    hit = sum(samples[i].label for i in kept) / len(kept)
    baseline = sum(s.label for s in samples) / len(samples)
    assert hit > baseline


def test_selection_is_empty_without_enough_data():
    assert walk_forward_selection(_dataset(50), seeds=(0,)) == set()


def test_out_of_sample_indices_exclude_the_warmup_block():
    samples = _dataset()
    scored = out_of_sample_indices(samples)
    assert len(scored) == len(samples) - 400
    assert min(scored) == 400
