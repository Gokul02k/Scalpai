"""The trend module must produce byte-identical output in both languages.

v1 renders this panel from `app/lib/trend.js` and v2 measures it from
`engine/core/trend.py`. If they drift, the dashboard shows one bias while the
backtest scored another, and neither number means anything.
"""
from __future__ import annotations

import pytest

from engine.core import trend as tr
from engine.core.indicators import candles_to_dicts
from engine.data import CandleStore
from engine.tests.jsbridge import call_js, diff, node_available

pytestmark = pytest.mark.skipif(not node_available(), reason="node not installed")


def _check(js, py):
    problems = diff(js, py, tol=0.0)
    assert not problems, "\n".join(problems[:25])


@pytest.fixture(scope="module")
def daily() -> list[dict]:
    rows = CandleStore().read("NIFTY", "INDEX", "1d", limit=400)
    if len(rows) < 100:
        pytest.skip("run `python -m engine.cli sync` first")
    return candles_to_dicts(rows)


@pytest.fixture(scope="module")
def session() -> list[dict]:
    rows = CandleStore().read("NIFTY", "INDEX", "5m", limit=12)
    return candles_to_dicts(rows)


@pytest.fixture(scope="module")
def vix() -> list[float]:
    rows = CandleStore().read("INDIAVIX", "INDEX", "1d", limit=40)
    return [c.c for c in rows]


def test_pre_open_factors(daily, vix):
    _check(call_js("trend", "preOpenFactors", daily, vix),
           tr.pre_open_factors(daily, vix))


def test_pre_open_trend(daily, vix):
    _check(call_js("trend", "preOpenTrend", daily, vix),
           tr.pre_open_trend(daily, vix))


def test_post_open_trend(daily, session, vix):
    vwap = sum(c["c"] for c in session) / len(session)
    _check(call_js("trend", "postOpenTrend", daily, session, vix, vwap),
           tr.post_open_trend(daily, session, vix, vwap))


def test_post_open_without_vwap(daily, session, vix):
    _check(call_js("trend", "postOpenTrend", daily, session, vix, None),
           tr.post_open_trend(daily, session, vix, None))


@pytest.mark.parametrize("size", [0, 1, 5, 20, 21, 22, 60])
def test_short_series_edges(daily, vix, size):
    """Guard clauses fire at different lengths; a port right on 400 bars can
    still be wrong on 21, which is exactly where the EMA window opens."""
    subset = daily[:size]
    _check(call_js("trend", "preOpenTrend", subset, vix),
           tr.pre_open_trend(subset, vix))


@pytest.mark.parametrize("n", [0, 19, 20, 25])
def test_vix_window_edges(daily, vix, n):
    _check(call_js("trend", "preOpenTrend", daily, vix[:n]),
           tr.pre_open_trend(daily, vix[:n]))


def test_a_volatility_spike_matches(daily):
    spiking = [12.0] * 20 + [24.0]
    _check(call_js("trend", "preOpenTrend", daily, spiking),
           tr.pre_open_trend(daily, spiking))
