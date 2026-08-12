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
