"""Measure what a round trip actually costs, from a live option chain.

The backtest reports P&L in index points, but the index is not tradeable. The
execution vehicle is a weekly option, and its costs are denominated in premium.
Comparing the two requires a conversion, and the conversion is where an
optimistic backtest usually hides:

    index points of cost = premium points of cost / delta

An at-the-money option has delta near 0.5, so **every premium point of cost is
two index points of cost**. A 1.35-point bid-ask spread is not a rounding
error against a 78-point average win; it is 2.7 index points, and the whole
strategy has 5.65 points of gross expectancy to pay from.

Deltas come from a Black-76 implied vol solved off the mid price, using the
chain's own futures price. Black-76 rather than Black-Scholes because index
options settle against the future, and using spot with a nonzero cost of carry
biases delta — here the future is ~70 points above spot, which is most of a
strike.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import datetime
from typing import Sequence

from ..data.timeutil import IST
from .costs import OptionBuyCost

#: Rate used only to discount the option value inside Black-76. Delta is barely
#: sensitive to it over a one-week horizon.
RISK_FREE = 0.065


def _norm_cdf(x: float) -> float:
    return 0.5 * math.erfc(-x / math.sqrt(2))


def black76_price(f: float, k: float, t: float, vol: float, is_call: bool) -> float:
    if t <= 0 or vol <= 0 or f <= 0 or k <= 0:
        return max(0.0, (f - k) if is_call else (k - f))
    sqt = vol * math.sqrt(t)
    d1 = (math.log(f / k) + 0.5 * vol * vol * t) / sqt
    d2 = d1 - sqt
    disc = math.exp(-RISK_FREE * t)
    if is_call:
        return disc * (f * _norm_cdf(d1) - k * _norm_cdf(d2))
    return disc * (k * _norm_cdf(-d2) - f * _norm_cdf(-d1))


def black76_delta(f: float, k: float, t: float, vol: float, is_call: bool) -> float:
    """Delta with respect to the future. Returned unsigned: the sign only says
    which way the position leans, and every cost here is a magnitude."""
    if t <= 0 or vol <= 0 or f <= 0 or k <= 0:
        return 1.0 if (is_call and f > k) or (not is_call and f < k) else 0.0
    sqt = vol * math.sqrt(t)
    d1 = (math.log(f / k) + 0.5 * vol * vol * t) / sqt
    disc = math.exp(-RISK_FREE * t)
    return disc * (_norm_cdf(d1) if is_call else _norm_cdf(-d1))


def implied_vol(
    premium: float, f: float, k: float, t: float, is_call: bool
) -> float | None:
    """Bisection rather than Newton: slower, but it cannot diverge on the deep
    wings where vega collapses and a Newton step overshoots into nonsense."""
    if premium <= 0 or t <= 0:
        return None
    intrinsic = max(0.0, (f - k) if is_call else (k - f)) * math.exp(-RISK_FREE * t)
    if premium <= intrinsic:
        return None

    lo, hi = 1e-4, 5.0
    if black76_price(f, k, t, hi, is_call) < premium:
        return None
    for _ in range(80):
        mid = (lo + hi) / 2
        if black76_price(f, k, t, mid, is_call) < premium:
            lo = mid
        else:
            hi = mid
    return (lo + hi) / 2


@dataclass
class StrikeCost:
    """Round-trip cost of one strike, in premium points and index points."""

    strike: int
    option_type: str
    bid: float
    ask: float
    mid: float
    spread: float
    oi: int
    volume: int
    iv: float | None
    delta: float | None
    spread_pts: float
    charges_pts: float
    total_pts: float
    index_pts: float | None
    moneyness: float

    def line(self) -> str:
        iv = f"{self.iv * 100:5.1f}" if self.iv else "    -"
        delta = f"{self.delta:5.2f}" if self.delta else "    -"
        index = f"{self.index_pts:7.2f}" if self.index_pts else "      -"
        return (
            f"  {self.strike:6d} {self.option_type:3} {self.bid:8.2f} {self.ask:8.2f} "
            f"{self.spread:7.2f} {iv} {delta} {self.spread_pts:7.2f} "
            f"{self.charges_pts:7.2f} {self.total_pts:7.2f} {index} "
            f"{self.oi:10d} {self.volume:11d}"
        )

    @staticmethod
    def header() -> str:
        return (
            f"  {'strike':>6} {'typ':3} {'bid':>8} {'ask':>8} {'spread':>7} "
            f"{'iv%':>5} {'delta':>5} {'sprd_p':>7} {'chg_p':>7} {'tot_p':>7} "
            f"{'INDEX':>7} {'oi':>10} {'volume':>11}"
        )


def forward_from_parity(
    quotes: dict[int, dict[str, float]], t: float
) -> float | None:
    """Recover the forward the option market is actually pricing to, via
    put-call parity: F = K + (C - P)e^{rT}.

    Needed because the chain's reported futures price belongs to a different
    contract than the weekly being quoted — measured here at 24,467 against a
    parity forward of 24,438, a 29-point gap that is most of a strike. Feeding
    the wrong forward into the solver splits call and put implied vols apart
    (6-8% against 10-15%) and biases every delta, which is exactly the number
    the cost conversion divides by.

    The median across strikes is used because parity holds at all of them, so
    disagreement is quote noise rather than information.
    """
    import statistics as st

    disc = math.exp(RISK_FREE * t)
    forwards = [
        k + (v["CE"] - v["PE"]) * disc
        for k, v in quotes.items()
        if "CE" in v and "PE" in v
    ]
    return st.median(forwards) if forwards else None


def _years_to_expiry(expiry_ts: int, now: datetime | None = None) -> float:
    now = now or datetime.now(IST)
    seconds = expiry_ts - now.timestamp()
    return max(seconds, 0.0) / (365.0 * 24 * 3600)


def nearest_expiry(chain: dict, now: datetime | None = None) -> tuple[int, str] | None:
    """First expiry still in the future, which is what a scalp would trade."""
    now = now or datetime.now(IST)
    rows = []
    for row in chain.get("expiryData") or []:
        try:
            ts = int(row["expiry"])
        except (KeyError, TypeError, ValueError):
            continue
        if ts > now.timestamp():
            rows.append((ts, row.get("date", "")))
    return min(rows) if rows else None


def measure_chain(
    chain: dict,
    cost_model: OptionBuyCost | None = None,
    now: datetime | None = None,
) -> tuple[list[StrikeCost], dict]:
    """Per-strike round-trip cost from a live chain snapshot."""
    cost_model = cost_model or OptionBuyCost()
    rows = chain.get("optionsChain") or []
    if not rows:
        return [], {}

    underlying = next((r for r in rows if r.get("strike_price", -1) == -1), {})
    spot = float(underlying.get("ltp") or 0.0)
    reported_future = float(underlying.get("fp") or 0.0) or spot

    expiry = nearest_expiry(chain, now)
    t = _years_to_expiry(expiry[0], now) if expiry else 0.0

    mids: dict[int, dict[str, float]] = {}
    for r in rows:
        k, opt = r.get("strike_price", -1), r.get("option_type") or ""
        bid, ask = float(r.get("bid") or 0.0), float(r.get("ask") or 0.0)
        if k > 0 and opt in ("CE", "PE") and bid > 0 and ask >= bid:
            mids.setdefault(int(k), {})[opt] = (bid + ask) / 2

    future = forward_from_parity(mids, t) or reported_future

    out: list[StrikeCost] = []
    for r in rows:
        strike = r.get("strike_price", -1)
        opt = r.get("option_type") or ""
        if strike is None or strike < 0 or opt not in ("CE", "PE"):
            continue

        bid, ask = float(r.get("bid") or 0.0), float(r.get("ask") or 0.0)
        if bid <= 0 or ask <= 0 or ask < bid:
            continue
        mid = (bid + ask) / 2
        spread = ask - bid

        is_call = opt == "CE"
        iv = implied_vol(mid, future, strike, t, is_call)
        delta = black76_delta(future, strike, t, iv, is_call) if iv else None

        # Crossing the spread on both legs costs the full spread once, which is
        # half a spread per leg in the model's per-leg terms.
        model = OptionBuyCost(
            slippage_ticks_per_leg=(spread / 2) / cost_model.TICK,
            lot_size=cost_model.lot_size,
        )
        breakdown = model.round_trip(mid, mid, qty=1)
        per_unit = breakdown.total / cost_model.lot_size
        spread_pts = breakdown.slippage / cost_model.lot_size
        charges_pts = per_unit - spread_pts

        out.append(
            StrikeCost(
                strike=int(strike),
                option_type=opt,
                bid=bid,
                ask=ask,
                mid=mid,
                spread=spread,
                oi=int(r.get("oi") or 0),
                volume=int(r.get("volume") or 0),
                iv=iv,
                delta=delta,
                spread_pts=spread_pts,
                charges_pts=charges_pts,
                total_pts=per_unit,
                index_pts=(per_unit / delta) if delta and delta > 0.01 else None,
                moneyness=(strike - future) / future * 100 if future else 0.0,
            )
        )

    out.sort(key=lambda s: (s.strike, s.option_type))
    meta = {
        "spot": spot,
        "future": future,
        "reported_future": reported_future,
        "expiry_date": expiry[1] if expiry else "",
        "days_to_expiry": t * 365,
        "vix": float((chain.get("indiavixData") or {}).get("ltp") or 0.0),
        "lot_size": cost_model.lot_size,
    }
    return out, meta


def tradeable(
    rows: Sequence[StrikeCost], delta_band: tuple[float, float] = (0.35, 0.70)
) -> list[StrikeCost]:
    """Strikes a directional scalp would realistically use.

    Selected by delta rather than by distance from the money, because delta is
    what governs the conversion: below ~0.35 the premium barely tracks the
    index and each premium point of cost becomes three or more index points,
    while far above it the option is mostly intrinsic and ties up capital to
    little purpose. Liquidity is required too — a tight quote nobody trades is
    not a price you can get.
    """
    lo, hi = delta_band
    return [
        r for r in rows
        if r.delta is not None and lo <= r.delta <= hi
        and r.index_pts is not None and r.volume > 0
    ]


def black76_theta_per_day(f: float, k: float, t: float, vol: float) -> float:
    """Premium points lost per calendar day, near the money.

    Only the vega-decay term is kept; the discounting terms are immaterial at
    a one-week horizon and differ between calls and puts, while this one
    dominates and does not.
    """
    if t <= 0 or vol <= 0 or f <= 0 or k <= 0:
        return 0.0
    sqt = vol * math.sqrt(t)
    d1 = (math.log(f / k) + 0.5 * vol * vol * t) / sqt
    pdf = math.exp(-0.5 * d1 * d1) / math.sqrt(2 * math.pi)
    return (f * pdf * vol) / (2 * math.sqrt(t)) / 365.0


@dataclass
class ThetaCost:
    hold_hours: float
    theta_per_day: float
    premium_pts: float
    index_pts: float
    delta: float


def theta_for_hold(
    rows: Sequence[StrikeCost], future: float, t: float, hold_hours: float
) -> ThetaCost | None:
    """What holding a tradeable strike for `hold_hours` costs in index points.

    This is the cost an index-points backtest structurally cannot see. The
    replay records that price moved from A to B; it has no way to know the
    instrument used to capture that move was melting the whole time. On a
    weekly option with days to run, the decay over a single session is the
    same order as the bid-ask spread, so leaving it out is not conservative.

    Decay is charged in calendar time, not market time, because an option held
    across a night decays across that night.
    """
    usable = [r for r in rows if r.delta and r.iv]
    if not usable or t <= 0:
        return None

    import statistics as st

    iv = st.median(r.iv for r in usable)
    delta = st.median(r.delta for r in usable)
    per_day = black76_theta_per_day(future, future, t, iv)
    premium = per_day * (hold_hours / 24.0)
    return ThetaCost(
        hold_hours=hold_hours,
        theta_per_day=per_day,
        premium_pts=premium,
        index_pts=premium / delta if delta > 0.01 else 0.0,
        delta=delta,
    )


def summarize(rows: Sequence[StrikeCost]) -> dict | None:
    """Median rather than mean: one illiquid strike with a 20-point spread
    would otherwise set the headline number."""
    usable = [r for r in rows if r.index_pts is not None]
    if not usable:
        return None
    import statistics as st

    index_costs = sorted(r.index_pts for r in usable)
    return {
        "n": len(usable),
        "median_index_pts": st.median(index_costs),
        "best_index_pts": index_costs[0],
        "worst_index_pts": index_costs[-1],
        "median_spread_pts": st.median(r.spread for r in usable),
        "median_charges_pts": st.median(r.charges_pts for r in usable),
        "median_delta": st.median(r.delta for r in usable if r.delta),
    }
