"""Indian market transaction costs.

Costs are the difference between a strategy that looks profitable and one that
is. A NIFTY scalp targeting fifty index points is working with roughly 0.2% of
notional, which is the same order of magnitude as the round-trip cost — so a
backtest that ignores them is not off by a little, it is answering a different
question.

Rates below are the standard retail schedule and should be checked against a
live contract note before any conclusion is acted on; they move with budgets
and exchange circulars.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass

GST_RATE = 0.18
SEBI_TURNOVER_RATE = 0.000001  # ₹10 per crore


@dataclass(frozen=True)
class CostBreakdown:
    brokerage: float = 0.0
    stt: float = 0.0
    exchange: float = 0.0
    sebi: float = 0.0
    stamp: float = 0.0
    gst: float = 0.0
    slippage: float = 0.0

    @property
    def total(self) -> float:
        return (
            self.brokerage + self.stt + self.exchange
            + self.sebi + self.stamp + self.gst + self.slippage
        )

    def __add__(self, other: "CostBreakdown") -> "CostBreakdown":
        return CostBreakdown(
            brokerage=self.brokerage + other.brokerage,
            stt=self.stt + other.stt,
            exchange=self.exchange + other.exchange,
            sebi=self.sebi + other.sebi,
            stamp=self.stamp + other.stamp,
            gst=self.gst + other.gst,
            slippage=self.slippage + other.slippage,
        )


class CostModel(ABC):
    """Cost of one complete round trip (entry plus exit)."""

    name = "base"
    #: Unit the returned cost is expressed in, and by implication what
    #: `entry_value` means. Index replays subtract the cost from a gross
    #: measured in index points, so pairing them with a rupee-denominated
    #: model produces a number that looks plausible and means nothing.
    unit = "index_points"

    @abstractmethod
    def round_trip(self, entry_value: float, exit_value: float, qty: int = 1) -> CostBreakdown:
        ...


class IndexPointCost(CostModel):
    """Costs expressed directly in index points, for the index-level sanity
    check before options enter the picture.

    A deliberate simplification: the index is not tradeable, so this stands in
    for whatever the execution vehicle would have charged. Treat the result as
    an upper bound on the strategy's edge, never as an achievable P&L.
    """

    name = "index_points"

    def __init__(self, points_per_round_trip: float = 6.0) -> None:
        self.points = points_per_round_trip

    def round_trip(self, entry_value: float, exit_value: float, qty: int = 1) -> CostBreakdown:
        return CostBreakdown(slippage=self.points * qty)


class OptionBuyCost(CostModel):
    """Buying (never writing) index options. Values are premium, not notional.

    Slippage is modelled per leg as a number of ticks because the bid-ask
    spread, not the statutory charges, is what actually erodes an option scalp.
    """

    name = "option_buy"
    unit = "rupees"

    BROKERAGE_PER_ORDER = 20.0
    STT_ON_SELL = 0.001         # 0.1% of premium, sell side only
    EXCHANGE_RATE = 0.0003503   # NSE F&O, on premium
    STAMP_ON_BUY = 0.00003      # 0.003%, buy side only
    TICK = 0.05

    def __init__(self, slippage_ticks_per_leg: float = 1.0, lot_size: int = 75) -> None:
        self.slippage_ticks = slippage_ticks_per_leg
        self.lot_size = lot_size

    def round_trip(self, entry_value: float, exit_value: float, qty: int = 1) -> CostBreakdown:
        """`entry_value` / `exit_value` are premiums per unit; `qty` is lots."""
        units = qty * self.lot_size
        buy_turnover = entry_value * units
        sell_turnover = exit_value * units

        brokerage = self.BROKERAGE_PER_ORDER * 2
        stt = sell_turnover * self.STT_ON_SELL
        exchange = (buy_turnover + sell_turnover) * self.EXCHANGE_RATE
        sebi = (buy_turnover + sell_turnover) * SEBI_TURNOVER_RATE
        stamp = buy_turnover * self.STAMP_ON_BUY
        gst = (brokerage + exchange + sebi) * GST_RATE
        slippage = self.slippage_ticks * self.TICK * units * 2

        return CostBreakdown(brokerage, stt, exchange, sebi, stamp, gst, slippage)


class EquityIntradayCost(CostModel):
    """Equity MIS. Fully automatable — unlike delivery, which needs TPIN."""

    name = "equity_intraday"
    unit = "rupees"

    BROKERAGE_RATE = 0.0003     # 0.03% or ₹20, whichever is lower
    BROKERAGE_CAP = 20.0
    STT_ON_SELL = 0.00025       # 0.025%
    EXCHANGE_RATE = 0.0000297
    STAMP_ON_BUY = 0.00003
    SLIPPAGE_RATE = 0.0005      # half a basis point each way on liquid large caps

    def round_trip(self, entry_value: float, exit_value: float, qty: int = 1) -> CostBreakdown:
        buy_turnover = entry_value * qty
        sell_turnover = exit_value * qty

        brokerage = sum(
            min(t * self.BROKERAGE_RATE, self.BROKERAGE_CAP)
            for t in (buy_turnover, sell_turnover)
        )
        stt = sell_turnover * self.STT_ON_SELL
        exchange = (buy_turnover + sell_turnover) * self.EXCHANGE_RATE
        sebi = (buy_turnover + sell_turnover) * SEBI_TURNOVER_RATE
        stamp = buy_turnover * self.STAMP_ON_BUY
        gst = (brokerage + exchange + sebi) * GST_RATE
        slippage = (buy_turnover + sell_turnover) * self.SLIPPAGE_RATE

        return CostBreakdown(brokerage, stt, exchange, sebi, stamp, gst, slippage)


class EquityDeliveryCost(CostModel):
    """Equity CNC. Note the algo can buy but cannot sell without manual TPIN
    verification, so a delivery strategy is only half-automatable."""

    name = "equity_delivery"
    unit = "rupees"

    BROKERAGE_PER_ORDER = 0.0   # most discount brokers charge nothing here
    STT_RATE = 0.001            # 0.1% both sides
    EXCHANGE_RATE = 0.0000297
    STAMP_ON_BUY = 0.00015      # 0.015%
    SLIPPAGE_RATE = 0.0005

    def round_trip(self, entry_value: float, exit_value: float, qty: int = 1) -> CostBreakdown:
        buy_turnover = entry_value * qty
        sell_turnover = exit_value * qty

        brokerage = self.BROKERAGE_PER_ORDER * 2
        stt = (buy_turnover + sell_turnover) * self.STT_RATE
        exchange = (buy_turnover + sell_turnover) * self.EXCHANGE_RATE
        sebi = (buy_turnover + sell_turnover) * SEBI_TURNOVER_RATE
        stamp = buy_turnover * self.STAMP_ON_BUY
        gst = (brokerage + exchange + sebi) * GST_RATE
        slippage = (buy_turnover + sell_turnover) * self.SLIPPAGE_RATE

        return CostBreakdown(brokerage, stt, exchange, sebi, stamp, gst, slippage)


MODELS: dict[str, type[CostModel]] = {
    "index_points": IndexPointCost,
    "option_buy": OptionBuyCost,
    "equity_intraday": EquityIntradayCost,
    "equity_delivery": EquityDeliveryCost,
}


def get_cost_model(name: str, **kwargs) -> CostModel:
    try:
        return MODELS[name](**kwargs)
    except KeyError:
        raise ValueError(f"unknown cost model {name!r}; have {sorted(MODELS)}") from None
