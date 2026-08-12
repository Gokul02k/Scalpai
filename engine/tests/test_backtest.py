"""Correctness of the harness itself.

A backtest that quietly peeks at future bars produces encouraging numbers and
loses real money, so the no-lookahead property is asserted directly rather
than assumed from the shape of the code.
"""
from __future__ import annotations

import pytest

from engine.backtest import BacktestConfig, run_backtest
from engine.backtest.costs import (
    EquityIntradayCost,
    IndexPointCost,
    OptionBuyCost,
    get_cost_model,
)
from engine.core import indicators as ind
from engine.core import signal_log as slog
from engine.data import CandleStore


@pytest.fixture(scope="module")
def candles():
    rows = CandleStore().read("NIFTY", "INDEX", "5m", limit=1200)
    if len(rows) < 400:
        pytest.skip("run `python -m engine.cli sync` first")
    return rows


def test_analysis_sees_only_the_prefix(candles):
    """Analysis of bars 0..i must describe bar i and depend on nothing later.
    This is the property that makes the whole result mean anything."""
    rows = ind.candles_to_dicts(candles)
    for i in (400, 600, 800):
        prefix = ind.analyze_from_candles(rows[: i + 1], include_history=False)

        assert prefix["price"] == rows[i]["c"]
        # Support and resistance are the loudest place lookahead would show up.
        # Tolerance covers the 2-decimal rounding the JS applies to both.
        window = rows[max(0, i - 19): i + 1]
        assert prefix["sr"]["resistance"] == pytest.approx(
            max(c["h"] for c in window), abs=0.005
        )
        assert prefix["sr"]["support"] == pytest.approx(
            min(c["l"] for c in window), abs=0.005
        )
        # Appending future bars must not retroactively change bar i's verdict.
        assert prefix == ind.analyze_from_candles(rows[: i + 1], include_history=False)


def test_window_slicing_is_causal(candles):
    """Every window handed to the engine ends at the bar being evaluated."""
    rows = ind.candles_to_dicts(candles)
    config = BacktestConfig(window=100, warmup=120)
    for i in range(config.warmup, len(rows), 97):
        window = rows[max(0, i - config.window + 1): i + 1]
        assert window[-1]["ts"] == rows[i]["ts"]
        assert all(c["ts"] <= rows[i]["ts"] for c in window)
        assert len(window) <= config.window


def test_grading_rewards_a_correct_call(candles):
    """A signal whose target is hit must grade as passed, and one whose stop
    is hit must grade as failed — otherwise every downstream number is noise."""
    rows = ind.candles_to_dicts(candles)
    start = rows[len(rows) // 2]
    future = rows[len(rows) // 2:]
    hi = max(c["h"] for c in future[:50])
    lo = min(c["l"] for c in future[:50])
    now_ms = rows[-1]["ts"] + 60_000

    from datetime import datetime, timezone
    iso = datetime.fromtimestamp(start["ts"] / 1000, tz=timezone.utc).strftime(
        "%Y-%m-%dT%H:%M:%S.000Z"
    )

    def entry(target, stop):
        return {
            "id": "t", "ts": iso, "firstTs": iso, "action": "BUY", "instrument": "NIFTY",
            "entry": start["c"], "target": target, "stopLoss": stop, "price": start["c"],
            "confidence": 85, "time": "09:15:00 am",
        }

    reachable = slog.evaluate_signal_outcome(
        entry(hi - 1, lo - 500), rows, now_ms, min_favorable_points=0
    )
    assert reachable["status"] == "target"

    doomed = slog.evaluate_signal_outcome(
        entry(hi + 5000, lo + 1), rows, now_ms, min_favorable_points=0
    )
    assert doomed["status"] == "stop"


def test_ambiguous_bar_resolves_against_the_trade(candles):
    """When one bar spans both target and stop, intrabar order is unknown.
    Assuming the good fill is how a backtest flatters itself, so the stop wins."""
    rows = ind.candles_to_dicts(candles)
    bar = rows[len(rows) // 2]
    from datetime import datetime, timezone
    iso = datetime.fromtimestamp(bar["ts"] / 1000, tz=timezone.utc).strftime(
        "%Y-%m-%dT%H:%M:%S.000Z"
    )
    e = {
        "id": "t", "ts": iso, "firstTs": iso, "action": "BUY", "instrument": "NIFTY",
        "entry": bar["c"], "target": bar["h"], "stopLoss": bar["l"],
        "price": bar["c"], "confidence": 85, "time": "09:15:00 am",
    }
    out = slog.evaluate_signal_outcome(e, [bar], bar["ts"] + 1000, min_favorable_points=0)
    assert out["status"] == "stop"


def test_costs_are_deducted(candles):
    """Net expectancy must sit below gross by exactly the modelled cost."""
    config = BacktestConfig(min_confidence=75)
    free = run_backtest(candles, config, IndexPointCost(0.0))
    priced = run_backtest(candles, config, IndexPointCost(10.0))

    if not free.stats["resolved"]:
        pytest.skip("no resolved trades in this sample")

    assert free.stats["costPerTradePts"] == 0.0
    assert priced.stats["costPerTradePts"] == pytest.approx(10.0)
    assert priced.stats["expectancyNetPts"] == pytest.approx(
        free.stats["expectancyNetPts"] - 10.0
    )
    assert free.stats["expectancyGrossPts"] == pytest.approx(
        priced.stats["expectancyGrossPts"]
    )


def test_backtest_is_deterministic(candles):
    config = BacktestConfig(min_confidence=80)
    a = run_backtest(candles, config, IndexPointCost())
    b = run_backtest(candles, config, IndexPointCost())
    assert a.stats == b.stats
    assert [e["id"] for e in a.logs] == [e["id"] for e in b.logs]


def test_option_cost_is_dominated_by_spread():
    """Sanity-check the option model: for a cheap weekly option the bid-ask
    spread should outweigh the statutory charges, which is why an option scalp
    is harder than the index chart suggests."""
    model = OptionBuyCost(slippage_ticks_per_leg=1.0, lot_size=75)
    c = model.round_trip(entry_value=120.0, exit_value=140.0, qty=1)
    assert c.slippage > 0
    assert c.total > c.brokerage
    # One tick each way on 75 units is 7.5 rupees; brokerage alone is 40.
    assert c.slippage == pytest.approx(1.0 * 0.05 * 75 * 2)


def test_equity_brokerage_is_capped():
    model = EquityIntradayCost()
    small = model.round_trip(1000.0, 1010.0, qty=1)
    large = model.round_trip(1000.0, 1010.0, qty=1000)
    assert small.brokerage < large.brokerage
    assert large.brokerage == pytest.approx(40.0)  # capped at Rs 20 per leg


def test_cost_model_registry():
    for name in ("index_points", "option_buy", "equity_intraday", "equity_delivery"):
        assert get_cost_model(name).name == name
    with pytest.raises(ValueError):
        get_cost_model("nope")
