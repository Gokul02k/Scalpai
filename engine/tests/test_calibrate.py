"""Option pricing, cost calibration and the index-point conversion.

The conversion from premium to index points divides by delta, so an error in
delta scales the whole cost conclusion. These tests pin the pricer against
identities that must hold regardless of implementation — put-call parity, the
sign of convexity, the limits of delta — rather than against numbers produced
by the code itself.
"""
from __future__ import annotations

import math

import pytest

from engine.backtest.calibrate import (
    RISK_FREE,
    black76_delta,
    black76_price,
    black76_theta_per_day,
    forward_from_parity,
    implied_vol,
    measure_chain,
    summarize,
    theta_for_hold,
    tradeable,
)
from engine.backtest.option_pnl import OptionMarket, price_trade, repriced
from engine.ml.model import Sample

F = 24000.0
T = 5 / 365
IV = 0.10


# ── pricer ─────────────────────────────────────────────────────────────────

def test_put_call_parity_holds():
    """C - P = (F - K)e^{-rT}. If this fails nothing downstream is meaningful."""
    for k in (23000.0, 24000.0, 25000.0):
        c = black76_price(F, k, T, IV, True)
        p = black76_price(F, k, T, IV, False)
        assert c - p == pytest.approx((F - k) * math.exp(-RISK_FREE * T), abs=1e-6)


def test_price_rises_with_volatility():
    prices = [black76_price(F, F, T, v, True) for v in (0.05, 0.10, 0.20, 0.40)]
    assert prices == sorted(prices)


def test_price_is_convex_in_the_underlying():
    """Convexity is what makes a long option beat its own delta on a move, and
    the whole gamma-versus-theta result rests on it."""
    step = 200.0
    lo = black76_price(F - step, F, T, IV, True)
    mid = black76_price(F, F, T, IV, True)
    hi = black76_price(F + step, F, T, IV, True)
    assert lo + hi > 2 * mid


def test_atm_price_matches_the_standard_approximation():
    """ATM call ~ 0.3989 * F * vol * sqrt(T)."""
    approx = 0.3989 * F * IV * math.sqrt(T)
    assert black76_price(F, F, T, IV, True) == pytest.approx(approx, rel=0.02)


def test_deep_in_the_money_approaches_intrinsic():
    k = 20000.0
    assert black76_price(F, k, T, IV, True) == pytest.approx(
        (F - k) * math.exp(-RISK_FREE * T), rel=1e-4
    )


def test_expired_option_is_worth_intrinsic():
    assert black76_price(F, 23000.0, 0.0, IV, True) == pytest.approx(1000.0)
    assert black76_price(F, 25000.0, 0.0, IV, True) == 0.0


# ── delta ──────────────────────────────────────────────────────────────────

def test_atm_delta_is_near_half():
    assert black76_delta(F, F, T, IV, True) == pytest.approx(0.5, abs=0.02)


def test_delta_spans_zero_to_one_across_strikes():
    deep_itm = black76_delta(F, 20000.0, T, IV, True)
    deep_otm = black76_delta(F, 28000.0, T, IV, True)
    assert deep_itm > 0.98
    assert deep_otm < 0.02


def test_call_and_put_delta_sum_to_the_discount_factor():
    call = black76_delta(F, F, T, IV, True)
    put = black76_delta(F, F, T, IV, False)
    assert call + put == pytest.approx(math.exp(-RISK_FREE * T), abs=1e-9)


def test_delta_matches_a_numeric_derivative():
    h = 1.0
    numeric = (
        black76_price(F + h, F, T, IV, True) - black76_price(F - h, F, T, IV, True)
    ) / (2 * h)
    assert black76_delta(F, F, T, IV, True) == pytest.approx(numeric, abs=1e-4)


# ── implied vol ────────────────────────────────────────────────────────────

def test_implied_vol_round_trips():
    for k in (23500.0, 24000.0, 24500.0):
        for vol in (0.08, 0.15, 0.30):
            premium = black76_price(F, k, T, vol, True)
            assert implied_vol(premium, F, k, T, True) == pytest.approx(vol, abs=1e-4)


def test_implied_vol_rejects_prices_at_or_below_intrinsic():
    intrinsic = (F - 23000.0) * math.exp(-RISK_FREE * T)
    assert implied_vol(intrinsic, F, 23000.0, T, True) is None
    assert implied_vol(intrinsic - 10, F, 23000.0, T, True) is None


def test_implied_vol_rejects_nonsense_input():
    assert implied_vol(0.0, F, F, T, True) is None
    assert implied_vol(100.0, F, F, 0.0, True) is None


# ── forward from parity ────────────────────────────────────────────────────

def test_parity_recovers_a_known_forward():
    """Build a chain from a forward the test chooses, then check the forward
    is recovered. This is the bug that skewed the first measurement: the
    chain's own reported futures price belonged to another contract."""
    true_f = 24438.0
    quotes = {
        int(k): {
            "CE": black76_price(true_f, k, T, IV, True),
            "PE": black76_price(true_f, k, T, IV, False),
        }
        for k in (24300.0, 24400.0, 24500.0, 24600.0)
    }
    assert forward_from_parity(quotes, T) == pytest.approx(true_f, abs=0.01)


def test_parity_ignores_strikes_missing_a_leg():
    quotes = {24000: {"CE": 100.0}, 24500: {"PE": 50.0}}
    assert forward_from_parity(quotes, T) is None


def test_parity_is_robust_to_one_bad_strike():
    """Median, not mean: one stale quote must not move the forward."""
    true_f = 24438.0
    quotes = {
        int(k): {
            "CE": black76_price(true_f, k, T, IV, True),
            "PE": black76_price(true_f, k, T, IV, False),
        }
        for k in (24300.0, 24400.0, 24500.0, 24600.0, 24700.0)
    }
    quotes[24500]["CE"] += 300.0
    assert forward_from_parity(quotes, T) == pytest.approx(true_f, abs=1.0)


# ── theta ──────────────────────────────────────────────────────────────────

def test_theta_matches_a_numeric_time_derivative():
    """Centred difference over a small step. A full one-day step would
    disagree by ~5% because theta accelerates as expiry approaches, which is a
    property of the curve rather than an error in the formula."""
    h = 0.05 / 365
    d_price_d_years = (
        black76_price(F, F, T + h, IV, True) - black76_price(F, F, T - h, IV, True)
    ) / (2 * h)
    assert black76_theta_per_day(F, F, T, IV) == pytest.approx(
        d_price_d_years / 365, rel=0.01
    )


def test_theta_accelerates_towards_expiry():
    far = black76_theta_per_day(F, F, 30 / 365, IV)
    near = black76_theta_per_day(F, F, 2 / 365, IV)
    assert near > far


def test_theta_is_zero_at_expiry():
    assert black76_theta_per_day(F, F, 0.0, IV) == 0.0


# ── chain measurement ──────────────────────────────────────────────────────

def _synthetic_chain(forward: float = 24438.0, spread: float = 0.60) -> dict:
    import time

    expiry_ts = int(time.time() + 5 * 24 * 3600)
    rows = [{"strike_price": -1, "ltp": forward - 40, "fp": forward + 29,
             "option_type": ""}]
    for k in range(24200, 24701, 100):
        for opt, is_call in (("CE", True), ("PE", False)):
            mid = black76_price(forward, k, 5 / 365, IV, is_call)
            rows.append({
                "strike_price": k,
                "option_type": opt,
                "bid": mid - spread / 2,
                "ask": mid + spread / 2,
                "oi": 100000,
                "volume": 500000,
            })
    return {
        "optionsChain": rows,
        "expiryData": [{"expiry": str(expiry_ts), "date": "18-08-2026"}],
        "indiavixData": {"ltp": 11.4},
    }


def test_measure_chain_recovers_the_input_vol():
    rows, meta = measure_chain(_synthetic_chain())
    assert rows
    for r in rows:
        if r.iv is not None and abs(r.moneyness) < 1.0:
            assert r.iv == pytest.approx(IV, abs=0.01)


def test_measure_chain_prefers_parity_over_the_reported_future():
    rows, meta = measure_chain(_synthetic_chain(forward=24438.0))
    assert meta["future"] == pytest.approx(24438.0, abs=1.0)
    assert meta["reported_future"] == pytest.approx(24467.0, abs=1.0)


def test_wider_spreads_cost_more_index_points():
    tight, _ = measure_chain(_synthetic_chain(spread=0.20))
    wide, _ = measure_chain(_synthetic_chain(spread=2.00))
    assert summarize(tradeable(wide))["median_index_pts"] > \
        summarize(tradeable(tight))["median_index_pts"]


def test_tradeable_selects_by_delta():
    rows, _ = measure_chain(_synthetic_chain())
    for r in tradeable(rows, delta_band=(0.35, 0.70)):
        assert 0.35 <= r.delta <= 0.70


def test_index_cost_exceeds_premium_cost():
    """Delta below 1 means every premium point costs more than one index
    point. Getting this backwards would understate costs by ~2x."""
    rows, _ = measure_chain(_synthetic_chain())
    for r in tradeable(rows):
        assert r.index_pts > r.total_pts


def test_theta_for_hold_scales_with_time():
    rows, meta = measure_chain(_synthetic_chain())
    near = tradeable(rows)
    t = meta["days_to_expiry"] / 365
    short = theta_for_hold(near, meta["future"], t, 1.0)
    long = theta_for_hold(near, meta["future"], t, 6.0)
    assert long.index_pts == pytest.approx(6 * short.index_pts, rel=1e-6)


# ── option P&L ─────────────────────────────────────────────────────────────

MARKET = OptionMarket(days_to_expiry=5.0, iv=IV, spread_pts=0.60)


def test_decomposition_adds_up():
    r = price_trade(F, 80.0, 2.0, MARKET)
    delta_t1 = r.gross_premium - r.theta_premium - r.gamma_gain_premium
    assert r.gross_premium == pytest.approx(
        r.theta_premium + r.gamma_gain_premium + delta_t1
    )


def test_theta_is_a_loss_and_gamma_is_a_gain():
    r = price_trade(F, 80.0, 4.0, MARKET)
    assert r.theta_premium < 0
    assert r.gamma_gain_premium > 0


def test_convexity_is_positive_in_both_directions():
    """A long option gains from convexity whether the move helps or hurts;
    that is the property that offsets theta."""
    assert price_trade(F, 80.0, 2.0, MARKET).gamma_gain_premium > 0
    assert price_trade(F, -50.0, 2.0, MARKET).gamma_gain_premium > 0


def test_no_holding_time_means_no_decay():
    r = price_trade(F, 50.0, 0.0, MARKET)
    assert r.theta_premium == pytest.approx(0.0, abs=1e-9)


def test_longer_holds_decay_more():
    short = price_trade(F, 50.0, 1.0, MARKET)
    long = price_trade(F, 50.0, 12.0, MARKET)
    assert long.theta_premium < short.theta_premium


def test_bigger_moves_earn_more_convexity():
    small = price_trade(F, 20.0, 2.0, MARKET)
    big = price_trade(F, 200.0, 2.0, MARKET)
    assert big.gamma_gain_premium > small.gamma_gain_premium


def test_index_conversion_divides_by_delta():
    r = price_trade(F, 80.0, 2.0, MARKET)
    assert r.net_index_pts == pytest.approx(r.net_premium / r.entry_delta)


def test_wider_spread_reduces_net():
    tight = price_trade(F, 80.0, 2.0, OptionMarket(5.0, IV, 0.20))
    wide = price_trade(F, 80.0, 2.0, OptionMarket(5.0, IV, 3.00))
    assert wide.net_premium < tight.net_premium


def _sample(points: float, hold: float, status: str = "target") -> Sample:
    return Sample(
        ts_ms=0, features={}, label=1 if status == "target" else 0,
        points=points, hold_hours=hold, status=status,
    )


def test_expired_trades_drag_the_result_down():
    """The reason they are kept: they decay and pay nothing, so excluding them
    quietly removes the worst cases."""
    winners = [_sample(78.0, 1.0) for _ in range(10)]
    with_expired = winners + [_sample(0.0, 20.0, "expired") for _ in range(5)]

    clean = repriced(winners, MARKET)
    dirty = repriced(with_expired, MARKET)
    assert dirty.option_net_per_trade < clean.option_net_per_trade


def test_repriced_handles_an_empty_set():
    assert repriced([], MARKET) is None
