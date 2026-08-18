"""Parity for the chart overlay: `app/lib/smc.js` against `engine/core/smc.py`.

The dashboard draws the structure and the engine measures it. If the two ever
disagree about where a sweep or an order block is, one of them is lying to
somebody — the trader looking at the chart, or the backtest that said the setup
does not pay. Diffed with zero tolerance on real archived candles.
"""
from __future__ import annotations

import pytest

from engine.core import smc
from engine.core.indicators import candles_to_dicts
from engine.data import CandleStore
from engine.tests.jsbridge import call_js, diff, node_available

pytestmark = pytest.mark.skipif(not node_available(), reason="node not installed")


@pytest.fixture(scope="module")
def rows():
    candles = CandleStore().read("NIFTY", "INDEX", "5m", limit=600)
    if len(candles) < 200:
        pytest.skip("run `python -m engine.cli sync` first")
    return candles_to_dicts(candles)


def test_swings_agree(rows):
    for span in (2, 3):
        assert call_js("smc", "swingHighs", rows, span) == smc.swing_highs(rows, span)
        assert call_js("smc", "swingLows", rows, span) == smc.swing_lows(rows, span)


def test_order_blocks_agree(rows):
    js = call_js("smc", "orderBlock", rows, 300, "short", 10)
    py = smc.order_block(rows, 300, smc.SHORT, 10)
    assert (js is None) == (py is None)
    if py is not None:
        assert [js["index"], js["lo"], js["hi"]] == [py.idx, py.lo, py.hi]


def test_break_kind_agrees(rows):
    for upto in (100, 250, 400):
        for direction in ("short", "long"):
            assert call_js("smc", "breakKind", rows, upto, direction, 2) == smc.break_kind(
                rows, upto, direction, 2
            )


def test_the_whole_annotation_agrees(rows):
    js = call_js("smc", "annotateStructure", rows, {"span": 2, "minSweepPts": 2})
    py = smc.annotate(rows, span=2, min_sweep_pts=2)
    mismatches = diff(js, py, "annotate")
    assert not mismatches, "\n".join(mismatches[:20])


def test_a_short_series_annotates_to_nothing_on_both_sides(rows):
    js = call_js("smc", "annotateStructure", rows[:3], {})
    assert not diff(js, smc.annotate(rows[:3]), "annotate")
