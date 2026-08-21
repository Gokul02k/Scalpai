"""Parity for the ETF premium column: `app/lib/etf.js` against `engine/core/etf.py`.

The dashboard shows the premium and the engine will be asked whether it predicts
anything. If the two ever compute it differently, the research answers a
question about a number nobody was shown. Diffed with zero tolerance.

The index series is real archived NIFTY; the fund is derived from it at a known
ratio. That is deliberate — parity is a claim about two implementations agreeing,
so the input needs to be reproducible, while the timestamps and levels stay
real enough to exercise the alignment.
"""
from __future__ import annotations

import pytest

from engine.core import etf
from engine.core.indicators import candles_to_dicts
from engine.data import CandleStore
from engine.tests.jsbridge import call_js, diff, node_available

pytestmark = pytest.mark.skipif(not node_available(), reason="node not installed")

#: Roughly NIFTYBEES against NIFTY: about a hundredth of the index level.
RATIO = 0.0114


@pytest.fixture(scope="module")
def index_rows():
    candles = CandleStore().read("NIFTY", "INDEX", "1d", limit=60)
    if len(candles) < 30:
        pytest.skip("run `python -m engine.cli sync` first")
    return candles_to_dicts(candles)


def fund_rows(index_rows, wobble=0.0004, gap=None):
    """A fund tracking the index, with a deterministic wobble.

    `gap` drops one session, which is what the alignment has to survive: the two
    series are synced independently, so a hole in one of them is routine.
    """
    out = []
    for i, row in enumerate(index_rows):
        if gap is not None and i == gap:
            continue
        drift = 1 + (wobble if i % 2 else -wobble)
        out.append({**row, "c": row["c"] * RATIO * drift})
    return out


def test_median_agrees():
    for values in ([], [1.0], [3.0, 1.0, 2.0], [4.0, 1.0, 3.0, 2.0], [2.5, 2.5, 1.0]):
        assert call_js("etf", "median", values) == etf.median(values)


def test_alignment_agrees_and_survives_a_missing_session(index_rows):
    fund = fund_rows(index_rows, gap=7)
    js = call_js("etf", "alignCloses", fund, index_rows)
    py = [list(t) for t in etf.align_closes(fund, index_rows)]

    assert not diff(js, py, "alignCloses")
    # The dropped session must be absent rather than pairing the fund against a
    # neighbouring day's level.
    assert len(py) == len(index_rows) - 1


def test_tracking_agrees(index_rows):
    fund = fund_rows(index_rows)
    aligned = etf.align_closes(fund, index_rows)
    js = call_js("etf", "tracking", [list(t) for t in aligned], etf.RATIO_WINDOW)
    py = etf.tracking(aligned, etf.RATIO_WINDOW)

    assert not diff(js, py, "tracking")
    assert py["stable"] is True
    assert py["ratio"] == pytest.approx(RATIO, rel=1e-3)


def test_premium_agrees_across_the_sign(index_rows):
    for price, fair in ((276.8, 275.0), (275.0, 276.8), (100.0, 100.0), (0, 100.0)):
        assert call_js("etf", "premiumPct", price, fair) == etf.premium_pct(price, fair)


def test_the_whole_basis_agrees(index_rows):
    fund = fund_rows(index_rows)
    price, level = fund[-1]["c"], index_rows[-1]["c"]

    js = call_js("etf", "basis", "NIFTYBEES", price, level, fund, index_rows, etf.RATIO_WINDOW)
    py = etf.basis("NIFTYBEES", price, level, fund, index_rows, etf.RATIO_WINDOW)

    mismatches = diff(js, py, "basis")
    assert not mismatches, "\n".join(mismatches[:20])
    assert py["status"] == "ok"


def test_an_unmapped_fund_says_so_in_both(index_rows):
    fund = fund_rows(index_rows)
    js = call_js("etf", "basis", "LIQUIDBEES", 1000.0, 24000.0, fund, index_rows)
    py = etf.basis("LIQUIDBEES", 1000.0, 24000.0, fund, index_rows)

    assert not diff(js, py, "basis")
    assert py["status"] == "unmapped"


def test_a_thin_history_reports_insufficient_rather_than_a_ratio(index_rows):
    short = index_rows[: etf.MIN_RATIO_SAMPLES - 1]
    fund = fund_rows(short)
    js = call_js("etf", "basis", "NIFTYBEES", fund[-1]["c"], short[-1]["c"], fund, short)
    py = etf.basis("NIFTYBEES", fund[-1]["c"], short[-1]["c"], fund, short)

    assert not diff(js, py, "basis")
    assert py["status"] == "insufficient-history"


def test_a_wrong_mapping_refuses_to_price_the_fund(index_rows):
    """The safeguard that makes the registry self-checking. A fund paired with
    an index it does not track has no stable ratio, and reporting a premium off
    an unstable one would be inventing a number with a plausible shape."""
    noise = fund_rows(index_rows, wobble=0.08)
    js = call_js("etf", "basis", "NIFTYBEES", noise[-1]["c"], index_rows[-1]["c"], noise, index_rows)
    py = etf.basis("NIFTYBEES", noise[-1]["c"], index_rows[-1]["c"], noise, index_rows)

    assert not diff(js, py, "basis")
    assert py["status"] == "unstable"
    assert "premiumPct" not in py
