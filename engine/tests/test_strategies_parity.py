"""Parity for the strategy split: `app/lib/strategies.js` against
`engine/core/strategies.py`.

The dashboard shows four calls per index and the backtest will be asked which of
them is worth anything. If the two implementations partition the factors
differently, the research grades a strategy nobody was shown — and neither side
reports a fault, because both produce a perfectly plausible list. Diffed with
zero tolerance, like the rest of the decision path.
"""
from __future__ import annotations

import pytest

from engine.core import indicators as ind
from engine.core import signals as sig
from engine.core import strategies as strat
from engine.core import suggestion as sug
from engine.data import CandleStore
from engine.tests.jsbridge import call_js, diff, node_available

pytestmark = pytest.mark.skipif(not node_available(), reason="node not installed")

SETTINGS = {
    "riskLimit": 10000,
    "profitPct": 1.5,
    "slPct": 0.8,
    "ind": {"rsi": True, "macd": True, "bb": True, "ema20": True, "ema50": True, "vol": True},
}


@pytest.fixture(scope="module")
def candles() -> list[dict]:
    rows = CandleStore().read("NIFTY", "INDEX", "5m", limit=600)
    if len(rows) < 200:
        pytest.skip("run `python -m engine.cli sync` first")
    return ind.candles_to_dicts(rows)


@pytest.fixture(scope="module")
def analysis(candles) -> dict:
    return ind.analyze_from_candles(candles, include_history=True)


def _check(js, py):
    problems = diff(js, py)
    assert not problems, "\n".join(problems[:25])


def test_the_registry_is_the_same_on_both_sides():
    """The registry decides which strategies exist and in what order. If the two
    copies drift, the app labels a call with one strategy's name and the engine
    grades it under another."""
    _check(call_js("strategies", "registrySnapshot"), strat.STRATEGIES)


@pytest.mark.parametrize("name", [
    "MACD", "EMA 20/50", "RSI (14)", "Bollinger Bands", "Stochastic",
    "Support zone", "Resistance zone", "S/R mid-range",
    "VWAP", "Opening range", "Liquidity", "Fair Value Gap",
    # Unassigned on purpose: a composite setup, a volatility reading, and names
    # no classifier has ever seen.
    "STRONG setup", "MODERATE setup", "ATR", "Supertrend", "", "Nonsense factor",
])
def test_factor_classification_agrees(name):
    assert call_js("strategies", "classifyFactor", name) == strat.classify_factor(name)


@pytest.mark.parametrize("instrument", ["NIFTY", "BANKNIFTY"])
@pytest.mark.parametrize("chg_pct", [0.0, 0.42, -0.8])
def test_run_strategies_agrees(analysis, candles, instrument, chg_pct):
    """Covers both factor sets: NIFTY scalp gets S/R zones and session factors,
    everything else gets the discrete setups instead."""
    price = candles[-1]["c"]
    idx = sig.generate_index_signals(analysis, price, instrument, SETTINGS)
    _check(
        call_js("strategies", "runStrategies", {
            "analysis": analysis, "price": price, "chgPct": chg_pct,
            "indexSignals": idx, "mode": "scalp", "instrument": instrument,
        }),
        strat.run_strategies(analysis, price, chg_pct, idx, "scalp", instrument),
    )


def test_consensus_agrees(analysis, candles):
    price = candles[-1]["c"]
    idx = sig.generate_index_signals(analysis, price, "NIFTY", SETTINGS)
    rows = strat.run_strategies(analysis, price, 0.42, idx, "scalp", "NIFTY")["strategies"]
    _check(
        call_js("strategies", "strategyConsensus", rows),
        strat.strategy_consensus(rows),
    )


def test_missing_inputs_produce_no_strategies():
    """The app renders before the first analysis lands, and an empty list is the
    only honest answer at that point."""
    _check(
        call_js("strategies", "runStrategies", {"analysis": None, "price": None}),
        strat.run_strategies(None, None),
    )


# ── invariants, not parity ─────────────────────────────────────────────────

def test_the_split_accounts_for_every_nifty_scalp_factor(analysis, candles):
    """The reason `unassigned` is reported rather than hidden. On the NIFTY scalp
    path -- the only path with a gate and a filter behind it -- every factor the
    vote counts must belong to a strategy, or the four calls shown are a partial
    view of the one that gets traded."""
    price = candles[-1]["c"]
    out = strat.run_strategies(analysis, price, 0.42, (), "scalp", "NIFTY")
    assert out["unassigned"] == 0


def test_a_strategy_with_no_factors_is_not_a_hold(analysis, candles):
    """`vote_from_factors([])` scores 38, which would render as a weak opinion
    instead of the absence of one."""
    price = candles[-1]["c"]
    empty = strat.run_strategies({**analysis, "fvg": None}, price, 0.0, (), "swing", "GOLD")
    imbalance = next(s for s in empty["strategies"] if s["key"] == "imbalance")
    assert not imbalance["available"]
    assert imbalance["action"] == "NONE"
    assert imbalance["confidence"] == 0
    assert strat.vote_from_factors([], 0.0, "scalp")["confidence"] == 38


def test_the_day_change_only_votes_in_momentum(analysis, candles):
    """Otherwise a trending day adds a vote to all four strategies and they agree
    for a reason that has nothing to do with what they measure."""
    price = candles[-1]["c"]
    flat = strat.run_strategies(analysis, price, 0.0, (), "scalp", "NIFTY")["strategies"]
    up = strat.run_strategies(analysis, price, 2.0, (), "scalp", "NIFTY")["strategies"]

    for a, b in zip(flat, up):
        if a["key"] == "momentum":
            continue
        assert (a["action"], a["confidence"]) == (b["action"], b["confidence"]), a["key"]


@pytest.mark.parametrize("instrument", ["NIFTY", "BANKNIFTY"])
def test_the_split_is_a_partition(analysis, candles, instrument):
    """Every factor lands in exactly one bucket. A factor counted twice would
    let one indicator vote in two strategies and make them agree for a reason
    that is not evidence."""
    price = candles[-1]["c"]
    idx = sig.generate_index_signals(analysis, price, instrument, SETTINGS)
    nifty_scalp = instrument == "NIFTY"
    factors = sug.collect_factors(analysis, idx, nifty_scalp)

    out = strat.run_strategies(analysis, price, 0.42, idx, "scalp", instrument)
    assigned = [f for s in out["strategies"] for f in s["factors"]]
    assert len(assigned) + out["unassigned"] == len(factors)
