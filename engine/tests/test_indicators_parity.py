"""Every indicator must produce byte-identical output to the v1 JavaScript.

Run against real archived NIFTY candles rather than synthetic data, because
the divergences that matter (rounding ties, empty-window guards, FVG fill
ordering) only surface on messy real price paths.
"""
from __future__ import annotations

import pytest

from engine.core import indicators as ind
from engine.data import CandleStore
from engine.tests.jsbridge import call_js, diff, node_available

pytestmark = pytest.mark.skipif(not node_available(), reason="node not installed")


@pytest.fixture(scope="module")
def candles() -> list[dict]:
    store = CandleStore()
    rows = store.read("NIFTY", "INDEX", "5m", limit=600)
    if len(rows) < 200:
        pytest.skip("run `python -m engine.cli sync` first")
    return ind.candles_to_dicts(rows)


@pytest.fixture(scope="module")
def closes(candles) -> list[float]:
    return [c["c"] for c in candles]


def _check(js, py, tol: float = 0.0):
    problems = diff(js, py, tol=tol)
    assert not problems, "\n".join(problems[:25])


def test_ema(closes):
    for period in (9, 12, 20, 26, 50):
        _check(call_js("indicators", "calcEMA", closes, period), ind.ema(closes, period))


def test_rsi(closes):
    _check(call_js("indicators", "calcRSI", closes, 14), ind.rsi(closes, 14))


def test_rsi_history(closes):
    _check(call_js("indicators", "calcRSIHistory", closes, 14), ind.rsi_history(closes, 14))


def test_macd(closes):
    _check(call_js("indicators", "calcMACD", closes), ind.macd(closes))


def test_macd_history(closes):
    _check(call_js("indicators", "calcMACDHistory", closes), ind.macd_history(closes))


def test_bollinger(closes):
    _check(call_js("indicators", "calcBollinger", closes, 20), ind.bollinger(closes, 20))


def test_atr(candles):
    _check(call_js("indicators", "calcATR", candles, 14), ind.atr(candles, 14))


def test_stochastic(candles):
    _check(call_js("indicators", "calcStochastic", candles, 14), ind.stochastic(candles, 14))


def test_support_resistance(candles):
    _check(
        call_js("indicators", "calcSupportResistance", candles, 20),
        ind.support_resistance(candles, 20),
    )


def test_liquidity(candles):
    _check(call_js("indicators", "calcLiquidity", candles), ind.liquidity(candles))


def test_intraday_session(candles):
    _check(
        call_js("indicators", "calcIntradaySession", candles, 15, 5),
        ind.intraday_session(candles, 15, 5),
    )


def test_detect_fvg(candles):
    _check(call_js("indicators", "detectFVG", candles), ind.detect_fvg(candles))


def test_fvg_signal(candles):
    zones = ind.detect_fvg(candles)
    price = candles[-1]["c"]
    _check(call_js("indicators", "fvgSignal", zones, price), ind.fvg_signal(zones, price))


def test_analyze_full(candles):
    """The aggregate, which is what the tick and backtest actually call."""
    _check(call_js("indicators", "analyzeFromCandles", candles), ind.analyze_from_candles(candles))


def test_sums_accumulate_the_way_javascript_does():
    """CPython 3.12 gave `sum` compensated summation for floats, making it more
    accurate than JS's reduce. More accurate is wrong here: these twenty closes
    average to 24576.685 under the builtin and 24576.684999999997672 under V8,
    which `toFixed(2)` turns into a whole paisa of disagreement.

    Pinned as a unit test because the real-data parity run only catches it when
    a freshly synced bar happens to land on a rounding boundary.
    """
    from engine.core.jsnum import js_sum

    closes = [
        24576.75, 24578.6, 24571.55, 24565.2, 24572.35, 24578.9, 24581.35,
        24576.05, 24572.9, 24578.45, 24583.1, 24580.7, 24574.35, 24569.9,
        24575.6, 24580.25, 24577.8, 24571.15, 24574.7, 24579.55,
    ]
    naive = 0.0
    for c in closes:
        naive += c
    assert js_sum(closes) == naive


def test_a_bollinger_mid_on_a_rounding_boundary_matches_v8(candles):
    """The exact case that broke: parity has to hold in the last bit, not just
    to within a paisa, because `toFixed` amplifies the last bit."""
    closes = [c["c"] for c in candles[:27]]
    _check(call_js("indicators", "calcBollinger", closes, 20),
           ind.bollinger(closes, 20))


@pytest.mark.parametrize("size", [0, 1, 2, 3, 5, 13, 14, 15, 19, 20, 25, 26, 27, 49, 50, 51])
def test_short_series_edges(candles, size):
    """Guard clauses fire at different lengths in each indicator; a port that
    is right on 600 bars can still be wrong on 14."""
    subset = candles[:size]
    sub_closes = [c["c"] for c in subset]
    _check(call_js("indicators", "calcRSI", sub_closes, 14), ind.rsi(sub_closes, 14))
    _check(call_js("indicators", "calcMACD", sub_closes), ind.macd(sub_closes))
    _check(call_js("indicators", "calcBollinger", sub_closes, 20), ind.bollinger(sub_closes, 20))
    _check(call_js("indicators", "calcATR", subset, 14), ind.atr(subset, 14))
    _check(call_js("indicators", "calcStochastic", subset, 14), ind.stochastic(subset, 14))
    _check(call_js("indicators", "detectFVG", subset), ind.detect_fvg(subset))
