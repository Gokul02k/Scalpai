"""The research module decides what gets built next, so its arithmetic has to
be right. A miscomputed p-value here sends months of work in a wrong direction.
"""
from __future__ import annotations

import math
import random

import pytest

from engine.data.base import Candle
from engine.research import edges
# Aliased on import: pytest would otherwise collect `test_mean` and
# `test_proportion` as test cases and call them with no arguments.
from engine.research.stats import bonferroni_threshold, norm_sf
from engine.research.stats import test_mean as mean_test
from engine.research.stats import test_proportion as proportion_test


def test_norm_sf_against_known_values():
    """Standard critical values — if these drift, every p-value is wrong."""
    assert norm_sf(0.0) == pytest.approx(0.5, abs=1e-9)
    assert norm_sf(1.0) == pytest.approx(0.1586553, abs=1e-6)
    assert norm_sf(1.6448536) == pytest.approx(0.05, abs=1e-6)
    assert norm_sf(1.959964) == pytest.approx(0.025, abs=1e-6)
    assert norm_sf(2.5758293) == pytest.approx(0.005, abs=1e-6)
    assert norm_sf(-1.0) == pytest.approx(0.8413447, abs=1e-6)


def test_mean_recovers_a_known_effect():
    """A sample with a real effect must be detected; pure noise must not."""
    rng = random.Random(42)
    noise = [rng.gauss(0.0, 1.0) for _ in range(2000)]
    signal = [rng.gauss(0.2, 1.0) for _ in range(2000)]

    null = mean_test("noise", noise)
    assert null.p_value > 0.05
    assert null.crosses_zero

    real = mean_test("signal", signal)
    assert real.p_value < 0.001
    assert not real.crosses_zero
    assert real.mean == pytest.approx(0.2, abs=0.06)


def test_mean_against_nonzero_baseline():
    """Comparing to the unconditional mean rather than zero is the difference
    between 'this subset moves' and 'this subset moves differently'."""
    rng = random.Random(11)
    values = [rng.gauss(1.0, 1.0) for _ in range(500)]

    assert mean_test("vs zero", values, 0.0).p_value < 0.001
    # Against its own mean the same sample is unremarkable.
    assert mean_test("vs own mean", values, 1.0).p_value > 0.05


def test_zero_variance_is_reported_not_declared_significant():
    """A constant sample has no dispersion to test against; claiming
    significance there would be an artefact, not a finding."""
    f = mean_test("constant", [1.0] * 100, 0.0)
    assert f.p_value == pytest.approx(1.0)
    assert "zero variance" in f.note


def test_confidence_interval_width():
    rng = random.Random(7)
    values = [rng.gauss(0.0, 1.0) for _ in range(400)]
    f = mean_test("x", values)
    lo, hi = f.ci95
    expected_half = 1.96 * f.std / math.sqrt(f.n)
    assert (hi - lo) / 2 == pytest.approx(expected_half, rel=1e-9)


def test_proportion_detects_a_biased_coin():
    fair = proportion_test("fair", 500, 1000, 0.5)
    assert fair.p_value > 0.05

    biased = proportion_test("biased", 600, 1000, 0.5)
    assert biased.p_value < 0.001
    assert biased.mean == pytest.approx(0.6)


def test_small_samples_are_flagged_not_trusted():
    f = mean_test("tiny", [1.0, 2.0, 3.0])
    assert "n<30" in f.note
    assert not f.significant  # significance requires n >= 30


def test_bonferroni_tightens_with_more_tests():
    assert bonferroni_threshold(1) == pytest.approx(0.05)
    assert bonferroni_threshold(50) == pytest.approx(0.001)
    assert bonferroni_threshold(0) == pytest.approx(0.05)


# ── edge functions on synthetic data with a known answer ───────────────────

def _candle(ts: int, o: float, h: float, l: float, c: float) -> Candle:
    return Candle(ts=ts, o=o, h=h, l=l, c=c, v=1000.0)


def _series_with_overnight_drift(days: int, overnight: float, intraday: float) -> list[Candle]:
    """Construct a series where the split between overnight and session drift
    is known exactly, so the decomposition can be checked against truth."""
    out = []
    close = 1000.0
    ts = 1_600_000_000_000
    for i in range(days):
        open_ = close * (1 + overnight)
        next_close = open_ * (1 + intraday)
        out.append(_candle(ts + i * 86_400_000, open_,
                           max(open_, next_close) * 1.001,
                           min(open_, next_close) * 0.999,
                           next_close))
        close = next_close
    return out


def test_overnight_decomposition_recovers_the_split():
    series = _series_with_overnight_drift(1000, overnight=0.001, intraday=-0.0005)
    findings = {f.name: f for f in edges.overnight_vs_intraday(series)}

    assert findings["Overnight (prev close -> open)"].mean == pytest.approx(0.1, abs=0.001)
    assert findings["Intraday (open -> close)"].mean == pytest.approx(-0.05, abs=0.001)
    assert findings["Overnight (prev close -> open)"].p_value < 1e-6


def test_no_drift_series_produces_no_finding():
    series = _series_with_overnight_drift(1000, overnight=0.0, intraday=0.0)
    for f in edges.overnight_vs_intraday(series):
        assert f.crosses_zero or f.mean == pytest.approx(0.0, abs=1e-9)


def test_period_split_isolates_a_regime_change():
    """An effect present early and absent later must show up as such — this is
    the check that catches a decayed anomaly."""
    early = _series_with_overnight_drift(600, overnight=0.002, intraday=0.0)
    late = _series_with_overnight_drift(600, overnight=0.0, intraday=0.0)
    # Shift the later block forward so it lands in different year buckets.
    shift = 600 * 86_400_000
    combined = early + [
        Candle(ts=c.ts + shift, o=c.o, h=c.h, l=c.l, c=c.c, v=c.v) for c in late
    ]

    findings = edges.overnight_drift_by_period(combined, years_per_bucket=1)
    means = [f.mean for f in findings]
    assert max(means) > 0.15
    assert min(means) < 0.05


def test_gap_fill_counts_correctly():
    series = [
        _candle(0, 100, 101, 99, 100),
        # Gaps up to 101, trades back to 99.5 -> fills the gap.
        _candle(86_400_000, 101, 102, 99.5, 100.5),
        # Gaps up to 102, low of 101.5 never reaches prior close -> unfilled.
        _candle(172_800_000, 102, 103, 101.5, 102.5),
    ]
    filled = [f for f in edges.gap_fill(series, threshold=0.3) if "up" in f.name][0]
    assert filled.n == 2
    assert filled.mean == pytest.approx(0.5)
