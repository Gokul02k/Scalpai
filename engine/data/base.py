"""Data source contract.

Every provider (yfinance today, a free broker API next, Groww later) implements
`DataSource`. The engine only ever sees `Candle` and `Quote`, so swapping the
provider is a config change and never a code change upstream.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from datetime import datetime
from typing import Literal

Interval = Literal["1m", "5m", "15m", "30m", "1h", "1d"]
Segment = Literal["INDEX", "EQUITY", "OPTION", "FUTURE"]


@dataclass(frozen=True, slots=True)
class Candle:
    """One OHLCV bar. `ts` is epoch milliseconds, matching the JS engine's
    `c.ts` so ported grading logic compares like for like."""

    ts: int
    o: float
    h: float
    l: float
    c: float
    v: float
    oi: float | None = None

    @property
    def dt(self) -> datetime:
        from .timeutil import IST, from_epoch_ms

        return from_epoch_ms(self.ts).astimezone(IST)


@dataclass(frozen=True, slots=True)
class Quote:
    symbol: str
    current: float
    previous_close: float | None
    high: float | None
    low: float | None
    ts: int
    source: str

    @property
    def change_pct(self) -> float:
        if not self.previous_close:
            return 0.0
        return round((self.current - self.previous_close) / self.previous_close * 100, 2)


class DataSourceError(RuntimeError):
    pass


class DataSource(ABC):
    """Read-only market data. Execution lives elsewhere, deliberately: a data
    adapter must never be able to place an order."""

    name: str = "base"

    #: Hard provider limits, in days, per interval. Used by the accumulator to
    #: decide how far back it is even worth asking. None means "no known limit".
    max_lookback_days: dict[str, int | None] = {}

    @abstractmethod
    def candles(
        self,
        symbol: str,
        interval: Interval,
        start: datetime,
        end: datetime,
        segment: Segment = "INDEX",
    ) -> list[Candle]:
        """Ascending by ts, market hours only, no synthetic bars."""

    @abstractmethod
    def quote(self, symbol: str, segment: Segment = "INDEX") -> Quote:
        ...

    def supports(self, segment: Segment, interval: Interval) -> bool:
        return True

    def lookback_limit(self, interval: Interval) -> int | None:
        return self.max_lookback_days.get(interval)
