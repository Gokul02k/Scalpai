"""Re-price the strategy's trades as options instead of index points.

A scalar cost per trade cannot represent an option, and treating it as one gets
the answer wrong in both directions at once. The instrument is nonlinear:

  * **Theta** bleeds the position while it is held, a cost an index-points
    backtest cannot see at all. It is charged in calendar time, so a trade
    carried overnight pays for the night.
  * **Gamma** works for the buyer. A winning move earns more than
    `delta x move` because delta grows into the move, and a losing move costs
    less than `delta x move` for the same reason.

Subtracting theta alone therefore overstates the damage, and ignoring both
understates it. The only way to know the net is to price the option at entry
and at exit and take the difference, which is what this does.

Results are reported back in index points — premium divided by entry delta —
so they sit alongside the existing backtest numbers rather than in a second
unit nobody can compare.
"""
from __future__ import annotations

import statistics
from dataclasses import dataclass, replace
from typing import Callable, Sequence

from .calibrate import black76_delta, black76_price
from .costs import OptionBuyCost


@dataclass
class OptionMarket:
    """Market conditions the re-pricing assumes.

    Defaults come from a measured NIFTY weekly chain: 4.7 days to expiry,
    ~10% implied vol, 0.60 premium points of spread, delta near 0.52. Change
    them and re-run rather than trusting one snapshot — a calm-VIX chain is
    the friendly case.
    """

    days_to_expiry: float = 4.7
    iv: float = 0.10
    spread_pts: float = 0.60
    lot_size: int = 75
    #: Strike offset from spot, in index points. 0 is at-the-money.
    strike_offset: float = 0.0


@dataclass
class OptionTradeResult:
    entry_premium: float
    exit_premium: float
    entry_delta: float
    gross_premium: float
    costs_premium: float
    net_premium: float
    net_index_pts: float
    theta_premium: float
    gamma_gain_premium: float


def price_trade(
    entry_index: float,
    favourable_move: float,
    hold_hours: float,
    market: OptionMarket,
) -> OptionTradeResult | None:
    """Price one trade as a long option held for `hold_hours`.

    `favourable_move` is signed in the direction of the trade: positive means
    the trade made money, whichever way it was facing. A directional view is
    always expressed by *buying* a call or a put, never by writing, so the
    position is long gamma and short theta in both cases and a put on a
    falling index has the same profile as a call on a rising one. Pricing
    everything as a call is therefore exact here, not an approximation.
    """
    if entry_index <= 0 or market.days_to_expiry <= 0:
        return None

    t0 = market.days_to_expiry / 365.0
    t1 = max(t0 - (hold_hours / 24.0) / 365.0, 1e-6)

    strike = entry_index + market.strike_offset
    f0 = entry_index
    f1 = entry_index + favourable_move

    entry_premium = black76_price(f0, strike, t0, market.iv, True)
    exit_premium = black76_price(f1, strike, t1, market.iv, True)
    entry_delta = black76_delta(f0, strike, t0, market.iv, True)
    if entry_premium <= 0 or entry_delta <= 0.01:
        return None

    gross = exit_premium - entry_premium

    model = OptionBuyCost(
        slippage_ticks_per_leg=(market.spread_pts / 2) / OptionBuyCost.TICK,
        lot_size=market.lot_size,
    )
    costs = model.round_trip(entry_premium, max(exit_premium, 0.0), qty=1).total
    costs_premium = costs / market.lot_size

    # Split the P&L into decay and move, in that order: first hold the
    # underlying still and let time pass, then move it at the later time. The
    # delta used for the linear part is therefore also taken at the later
    # time, which makes the leftover a pure convexity term and guarantees it
    # is non-negative — mixing deltas from two different times would leak part
    # of the decay into what gets reported as gamma.
    held_flat = black76_price(f0, strike, t1, market.iv, True) - entry_premium
    delta_t1 = black76_delta(f0, strike, t1, market.iv, True)
    linear = (f1 - f0) * delta_t1

    return OptionTradeResult(
        entry_premium=entry_premium,
        exit_premium=exit_premium,
        entry_delta=entry_delta,
        gross_premium=gross,
        costs_premium=costs_premium,
        net_premium=gross - costs_premium,
        net_index_pts=(gross - costs_premium) / entry_delta,
        theta_premium=held_flat,
        gamma_gain_premium=gross - linear - held_flat,
    )


@dataclass
class OptionBacktestResult:
    trades: int
    win_rate: float
    index_net_per_trade: float
    option_net_per_trade: float
    median_hold_hours: float
    avg_theta_pts: float
    avg_gamma_pts: float
    avg_cost_pts: float
    total_net_pts: float

    def lines(self) -> list[str]:
        return [
            f"  trades                 {self.trades}",
            f"  median hold            {self.median_hold_hours:.1f} h",
            f"  win rate               {self.win_rate:.1f}%",
            "",
            f"  index-points net/trade {self.index_net_per_trade:+.2f}   "
            f"(what the replay reports, before option effects)",
            f"  option net/trade       {self.option_net_per_trade:+.2f}   "
            f"(re-priced, in index-point equivalents)",
            "",
            "  decomposition, per trade, in index points:",
            f"    theta                {self.avg_theta_pts:+.2f}",
            f"    gamma                {self.avg_gamma_pts:+.2f}",
            f"    spread + charges     {self.avg_cost_pts:+.2f}",
            "",
            f"  total net              {self.total_net_pts:+.0f} pts over "
            f"{self.trades} trades",
        ]


def price_all(
    samples: Sequence,
    market: OptionMarket | None = None,
    index_entry: float = 24000.0,
    iv_for: Callable[[object], float | None] | None = None,
) -> list[tuple[object, OptionTradeResult, float]]:
    """Price every sample, optionally at its own implied vol.

    `iv_for` is how a historical VIX series gets used: pricing every trade at
    one snapshot's volatility answers "what if today's regime had always held",
    which is not a question anyone asked. Supplying the vol that actually
    prevailed on each date turns the sensitivity table into a result.
    """
    market = market or OptionMarket()
    rows = []
    for s in samples:
        hold = s.hold_hours if s.hold_hours > 0 else 6.0
        m = market
        if iv_for is not None:
            iv = iv_for(s)
            if iv is None:
                continue
            m = replace(market, iv=iv)
        res = price_trade(
            entry_index=index_entry,
            favourable_move=s.points,
            hold_hours=hold,
            market=m,
        )
        if res:
            rows.append((s, res, hold))
    return rows


def repriced(
    samples: Sequence,
    market: OptionMarket | None = None,
    index_entry: float = 24000.0,
    iv_for: Callable[[object], float | None] | None = None,
) -> OptionBacktestResult | None:
    """Re-price a whole sample set as options.

    `index_entry` stands in for the index level, because a sample carries its
    realised points but not the price it started from. Premiums scale with the
    level, so this mainly affects the absolute premium and barely affects the
    index-point result, which is a ratio.
    """
    rows = price_all(samples, market, index_entry, iv_for)
    if not rows:
        return None

    n = len(rows)
    deltas = [r.entry_delta for _, r, _ in rows]

    def as_index(values):
        return statistics.mean(v / d for v, d in zip(values, deltas))

    return OptionBacktestResult(
        trades=n,
        win_rate=sum(s.label for s, _, _ in rows) / n * 100,
        index_net_per_trade=statistics.mean(s.points for s, _, _ in rows),
        option_net_per_trade=statistics.mean(r.net_index_pts for _, r, _ in rows),
        median_hold_hours=statistics.median(h for _, _, h in rows),
        avg_theta_pts=as_index([r.theta_premium for _, r, _ in rows]),
        avg_gamma_pts=as_index([r.gamma_gain_premium for _, r, _ in rows]),
        avg_cost_pts=as_index([-r.costs_premium for _, r, _ in rows]),
        total_net_pts=sum(r.net_index_pts for _, r, _ in rows),
    )
