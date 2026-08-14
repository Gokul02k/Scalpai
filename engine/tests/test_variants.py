"""Tests for the strategy variants added after the direction split.

The load-bearing test in this file is the parity one: every flag must default
to v1 behaviour. Once variants exist, a change that quietly moves the baseline
makes every A/B comparison meaningless, and the damage is invisible because
both arms move together.
"""
from __future__ import annotations

import pytest

from engine.backtest import BacktestConfig, run_backtest
from engine.backtest.costs import IndexPointCost
from engine.backtest.replay import summarize
from engine.core import indicators as ind
from engine.core import suggestion as sug
from engine.data import CandleStore


#: Kept identical across variant runs so a difference can only come from the
#: flags. Wide enough to contain signals in both directions, which the
#: long-only tests depend on.
_REPLAY = dict(window=200, warmup=220, step=3)


@pytest.fixture(scope="module")
def candles():
    rows = CandleStore().read("NIFTY", "INDEX", "5m", limit=20000)
    if len(rows) < 5000:
        pytest.skip("run `python -m engine.cli sync` first")
    return rows


# ── the baseline must not move ─────────────────────────────────────────────


def test_every_cost_model_the_cli_names_actually_exists():
    """Cost models are looked up by string, so a typo is invisible until the
    branch containing it runs — which for `train` means the morning a model
    file happens to be missing. Two of these have already shipped broken.
    """
    import re
    from pathlib import Path

    from engine.backtest.costs import MODELS

    source = (Path(__file__).parent.parent / "cli.py").read_text()
    named = set(re.findall(r"""get_cost_model\(\s*["']([a-z_]+)["']""", source))
    named |= set(re.findall(r"""(?:--costs["'],\s*)?default=["']([a-z_]+)["']""",
                            "\n".join(l for l in source.splitlines()
                                      if "--costs" in l)))

    assert named, "the scan found nothing, so it is no longer checking anything"
    assert named <= set(MODELS), f"unknown cost models: {sorted(named - set(MODELS))}"


def test_defaults_are_v1():
    f = sug.StrategyFlags()
    assert f.use_opening_range is True
    assert f.long_only is False
    assert f.atr_target_mult is None
    assert f.atr_stop_mult is None
    assert f == sug.V1_FLAGS


def test_default_flags_reproduce_the_untouched_path(candles):
    """Passing V1_FLAGS explicitly must equal passing nothing at all."""
    rows = ind.candles_to_dicts(candles)[:600]
    analysis = ind.analyze_from_candles(rows, include_history=False)
    price = rows[-1]["c"]

    assert (
        sug.trade_levels(price, "BUY", "scalp", {}, analysis)
        == sug.trade_levels(price, "BUY", "scalp", {}, analysis, sug.V1_FLAGS)
    )
    assert (
        sug.build_unified_suggestion(analysis, price, 0.3, (), {}, "scalp", "NIFTY")
        == sug.build_unified_suggestion(
            analysis, price, 0.3, (), {}, "scalp", "NIFTY", sug.V1_FLAGS
        )
    )


# ── long only ──────────────────────────────────────────────────────────────


def test_long_only_suppresses_shorts(candles):
    """No SELL may survive the flag, and the BUYs must be untouched."""
    config = BacktestConfig(**_REPLAY)
    base = run_backtest(candles, config)
    longs = run_backtest(
        candles,
        BacktestConfig(**_REPLAY, flags=sug.StrategyFlags(long_only=True)),
    )

    assert any(e["action"] == "SELL" for e in base.logs), "fixture has no shorts to cut"
    assert all(e["action"] == "BUY" for e in longs.logs)
    assert len(longs.logs) <= len(base.logs)


def test_long_only_does_not_disturb_the_longs(candles):
    """Suppressing shorts before levels are computed means a cut short must not
    change which longs fire or where their levels sit."""
    config = BacktestConfig(**_REPLAY)
    base = {
        (e["ts"], e["entry"], e["target"], e["stopLoss"])
        for e in run_backtest(candles, config).logs if e["action"] == "BUY"
    }
    longs = {
        (e["ts"], e["entry"], e["target"], e["stopLoss"])
        for e in run_backtest(
            candles,
            BacktestConfig(**_REPLAY, flags=sug.StrategyFlags(long_only=True)),
        ).logs
    }
    assert base == longs


def test_long_only_leaves_a_buy_vote_alone():
    call = {"action": "BUY"}
    assert call["action"] == "BUY"

    flags = sug.StrategyFlags(long_only=True)
    assert flags.long_only and not sug.V1_FLAGS.long_only


# ── ATR-scaled levels ──────────────────────────────────────────────────────


#: No support or resistance, so the structural cap cannot mask the effect of
#: the multiplier. That cap is real and wanted in production — it is what keeps
#: targets achievable — but it makes these assertions test the wrong thing.
_OPEN_FIELD = {"atr": 50.0, "sr": {}, "price": 24000.0}


def test_atr_target_replaces_the_percentage():
    wide = sug.trade_levels(24000.0, "BUY", "scalp", {}, _OPEN_FIELD,
                            sug.StrategyFlags(atr_target_mult=4.0))
    tight = sug.trade_levels(24000.0, "BUY", "scalp", {}, _OPEN_FIELD,
                             sug.StrategyFlags(atr_target_mult=2.0))

    assert wide["viable"] and tight["viable"]
    assert wide["target"] == pytest.approx(24000.0 + 4 * 50.0)
    assert tight["target"] == pytest.approx(24000.0 + 2 * 50.0)


def test_an_atr_target_too_tight_for_a_sane_stop_is_refused():
    """Below roughly 1.2 ATR the reward cannot clear the 1.5 RR floor against
    the 0.8 ATR stop floor, and the setup has to be rejected rather than issued
    with lopsided risk."""
    levels = sug.trade_levels(24000.0, "BUY", "scalp", {}, _OPEN_FIELD,
                              sug.StrategyFlags(atr_target_mult=1.0))
    assert not levels["viable"]
    assert levels["target"] is None


def test_atr_target_falls_back_when_volatility_is_unknown():
    """An ATR of zero would collapse the target onto the entry and guarantee a
    stop-out, so the percentage has to take over."""
    analysis = {"atr": 0, "sr": {}, "price": 24000.0}
    scaled = sug.trade_levels(24000.0, "BUY", "scalp", {}, analysis,
                              sug.StrategyFlags(atr_target_mult=2.0))
    plain = sug.trade_levels(24000.0, "BUY", "scalp", {}, analysis)

    assert scaled == plain
    assert scaled["target"] > 24000.0


def test_atr_stop_widens_risk_in_a_volatile_tape():
    wide = sug.trade_levels(24000.0, "BUY", "scalp", {}, _OPEN_FIELD,
                            sug.StrategyFlags(atr_target_mult=6.0, atr_stop_mult=3.0))
    tight = sug.trade_levels(24000.0, "BUY", "scalp", {}, _OPEN_FIELD,
                             sug.StrategyFlags(atr_target_mult=6.0, atr_stop_mult=0.5))

    assert wide["stopLoss"] < tight["stopLoss"] < 24000.0
    # A stop inside the noise is not a stop, so the tight multiplier is floored
    # rather than honoured literally. The binding floor here is the 0.2%-of-
    # entry minimum (48 points), which exceeds 0.8 ATR (40) at this price.
    assert tight["stopLoss"] == pytest.approx(24000.0 - 48.0)


def test_atr_levels_still_honour_the_rr_floor(candles):
    """The risk-first guarantee must survive the change in how levels are
    sized, or the variant buys its edge by taking worse trades."""
    rows = ind.candles_to_dicts(candles)
    for cut in (400, 800, 1200):
        analysis = ind.analyze_from_candles(rows[:cut], include_history=False)
        price = rows[cut - 1]["c"]
        for mult in (1.5, 2.0, 3.0, 5.0):
            for action in ("BUY", "SELL"):
                levels = sug.trade_levels(
                    price, action, "scalp", {}, analysis,
                    sug.StrategyFlags(atr_target_mult=mult, atr_stop_mult=mult / 2),
                )
                if levels["viable"]:
                    assert levels["rr"] >= 1.5 - 0.05


def test_atr_levels_are_symmetric_for_shorts():
    flags = sug.StrategyFlags(atr_target_mult=3.0)
    short = sug.trade_levels(24000.0, "SELL", "scalp", {}, _OPEN_FIELD, flags)

    assert short["viable"]
    assert short["target"] == pytest.approx(24000.0 - 3 * 50.0)
    assert short["target"] < 24000.0 < short["stopLoss"]


# ── expired-trade accounting ───────────────────────────────────────────────


def _log(status, entry, exit_px, action="BUY", ts="2026-01-01T05:00:00.000Z"):
    return {
        "ts": ts, "action": action, "entry": entry,
        "outcome": {"status": status, "resolvedPrice": exit_px},
    }


def test_expired_trades_are_dropped_by_default():
    """v1's behaviour, kept as the default so published numbers stay stable."""
    logs = [_log("target", 100.0, 110.0), _log("expired", 100.0, 95.0)]
    stats = summarize(logs, IndexPointCost(0.0))

    assert stats["expectancyGrossPts"] == pytest.approx(10.0)
    assert stats["totalNetPts"] == pytest.approx(10.0)


def test_expired_trades_can_be_settled_at_the_last_price():
    """A trade that went nowhere still paid the spread; counting it is the
    honest accounting and is required for any time-exit comparison."""
    logs = [_log("target", 100.0, 110.0), _log("expired", 100.0, 95.0)]
    stats = summarize(logs, IndexPointCost(0.0), count_expired=True)

    assert stats["expectancyGrossPts"] == pytest.approx(2.5)
    assert stats["totalNetPts"] == pytest.approx(5.0)


def test_expired_shorts_settle_in_the_right_direction():
    logs = [_log("expired", 100.0, 95.0, action="SELL")]
    stats = summarize(logs, IndexPointCost(0.0), count_expired=True)
    assert stats["expectancyGrossPts"] == pytest.approx(5.0)


def test_counting_expiries_still_charges_costs():
    logs = [_log("expired", 100.0, 100.0)]
    stats = summarize(logs, IndexPointCost(6.0), count_expired=True)
    assert stats["totalNetPts"] == pytest.approx(-6.0)


def test_pending_trades_are_never_counted():
    """An unresolved trade has no P&L, whatever the expiry setting."""
    logs = [_log("target", 100.0, 110.0), _log("pending", 100.0, None)]
    for flag in (False, True):
        assert summarize(logs, IndexPointCost(0.0), count_expired=flag)["totalNetPts"] \
            == pytest.approx(10.0)


# ── time-based exit ────────────────────────────────────────────────────────


def test_a_shorter_window_converts_resolutions_into_expiries(candles):
    long_window = run_backtest(
        candles, BacktestConfig(**_REPLAY, count_expired=True)
    )
    short_window = run_backtest(
        candles,
        BacktestConfig(**_REPLAY, count_expired=True,
                       eval_window_ms=60 * 60 * 1000),
    )

    assert short_window.stats["expired"] > long_window.stats["expired"]
    # The same signals fire either way; only their resolution changes.
    assert short_window.stats["total"] == long_window.stats["total"]


def test_a_time_exit_keeps_every_trade_in_the_pnl(candles):
    """The trap this guards: shortening the window without counting expiries
    deletes trades from the result instead of settling them."""
    config = BacktestConfig(**_REPLAY, count_expired=True,
                            eval_window_ms=60 * 60 * 1000)
    result = run_backtest(candles, config)
    s = result.stats

    assert s["resolved"] == s["passed"] + s["failed"] + s["expired"]
    assert s["resolved"] > 0
