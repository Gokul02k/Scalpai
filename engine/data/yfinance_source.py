"""yfinance adapter.

Zero setup and no account, which makes it the right starting point. Its ceiling
is low and worth stating plainly:

  * 5-minute bars: rolling 60 days only
  * 1-minute bars: rolling 8 days only
  * No options data at all
  * Delayed, unofficial, and can stall without erroring

Good enough to build the engine and sanity-check the strategy. Not good enough
to backtest a scalp on, and never good enough to execute against. The store's
accumulator is what turns the rolling window into permanent history.
"""
from __future__ import annotations

import logging
from datetime import datetime

from .base import Candle, DataSource, DataSourceError, Interval, Quote, Segment
from .timeutil import IST

log = logging.getLogger(__name__)

#: Yahoo has no NSE options coverage, so OPTION/FUTURE are absent by design.
_SUFFIX: dict[str, str] = {"EQUITY": ".NS"}

#: Common index aliases so callers can say "NIFTY" and not care about tickers.
_INDEX_ALIASES: dict[str, str] = {
    "NIFTY": "^NSEI",
    "NIFTY 50": "^NSEI",
    "NIFTY50": "^NSEI",
    "BANKNIFTY": "^NSEBANK",
    "NIFTY BANK": "^NSEBANK",
    "SENSEX": "^BSESN",
    "INDIAVIX": "^INDIAVIX",
}


class YFinanceSource(DataSource):
    name = "yfinance"

    max_lookback_days = {
        "1m": 7,
        "5m": 59,
        "15m": 59,
        "30m": 59,
        "1h": 720,
        "1d": None,
    }

    def __init__(self) -> None:
        try:
            import yfinance  # noqa: F401
        except ImportError as e:  # pragma: no cover
            raise DataSourceError("yfinance not installed: pip install yfinance") from e

    def supports(self, segment: Segment, interval: Interval) -> bool:
        return segment in ("INDEX", "EQUITY")

    def resolve(self, symbol: str, segment: Segment) -> str:
        s = symbol.strip().upper()
        if segment == "INDEX":
            return _INDEX_ALIASES.get(s, symbol)
        if s.startswith("^") or "." in s:
            return s
        return f"{s}{_SUFFIX.get(segment, '')}"

    def candles(
        self,
        symbol: str,
        interval: Interval,
        start: datetime,
        end: datetime,
        segment: Segment = "INDEX",
    ) -> list[Candle]:
        if not self.supports(segment, interval):
            raise DataSourceError(
                f"yfinance has no {segment} coverage for NSE. Use a broker adapter."
            )

        import yfinance as yf

        ticker = self.resolve(symbol, segment)
        limit = self.lookback_limit(interval)
        if limit is not None:
            earliest = datetime.now(IST).timestamp() - limit * 86400
            if start.timestamp() < earliest:
                log.warning(
                    "%s %s: requested start clipped to provider limit of %s days",
                    ticker, interval, limit,
                )
                start = datetime.fromtimestamp(earliest, tz=IST)

        df = yf.Ticker(ticker).history(
            start=start, end=end, interval=interval, auto_adjust=False, raise_errors=False
        )
        if df is None or df.empty:
            return []

        out: list[Candle] = []
        for idx, row in df.iterrows():
            o, h, l, c = row["Open"], row["High"], row["Low"], row["Close"]
            # Yahoo emits NaN placeholder rows for halted or thin intervals.
            if any(v != v for v in (o, h, l, c)):
                continue
            vol = row.get("Volume", 0) or 0
            out.append(
                Candle(
                    ts=int(idx.timestamp() * 1000),
                    o=float(o), h=float(h), l=float(l), c=float(c),
                    v=float(vol),
                )
            )
        out.sort(key=lambda x: x.ts)
        return out

    def quote(self, symbol: str, segment: Segment = "INDEX") -> Quote:
        import yfinance as yf

        ticker = self.resolve(symbol, segment)
        t = yf.Ticker(ticker)
        info = getattr(t, "fast_info", None) or {}

        def pick(*keys):
            for k in keys:
                try:
                    v = info[k]
                except (KeyError, TypeError):
                    v = None
                if v:
                    return float(v)
            return None

        current = pick("last_price", "lastPrice", "regularMarketPrice")
        if current is None:
            df = t.history(period="2d", interval="1d")
            if df.empty:
                raise DataSourceError(f"no quote for {ticker}")
            current = float(df["Close"].iloc[-1])

        return Quote(
            symbol=symbol,
            current=current,
            previous_close=pick("previous_close", "previousClose"),
            high=pick("day_high", "dayHigh"),
            low=pick("day_low", "dayLow"),
            ts=int(datetime.now(IST).timestamp() * 1000),
            source=self.name,
        )
