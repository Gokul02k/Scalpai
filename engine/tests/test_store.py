"""The candle store must never let a worse source overwrite a better one.

A plain `sync` defaults to yfinance, and before source ranking it replaced
Fyers bars with zero-volume yfinance bars wherever the two windows overlapped.
"""
from __future__ import annotations

import sqlite3
from datetime import datetime

from engine.data import CandleStore
from engine.data.base import Candle
from engine.data.timeutil import IST, to_epoch_ms


def _bar(ts: int, price: float, vol: float) -> Candle:
    return Candle(ts=ts, o=price, h=price + 1, l=price - 1, c=price, v=vol)


def _sources(store: CandleStore, interval: str) -> list[tuple[int, str, float]]:
    with sqlite3.connect(store.path) as cx:
        return cx.execute(
            "SELECT ts, source, c FROM candles WHERE interval=? ORDER BY ts", (interval,)
        ).fetchall()


T0 = to_epoch_ms(datetime(2026, 6, 15, 9, 15, tzinfo=IST))
FIVE = 5 * 60_000


def test_yfinance_does_not_overwrite_fyers(tmp_path):
    store = CandleStore(tmp_path / "c.db")
    store.write("NIFTY", "INDEX", "5m", [_bar(T0, 100, 5000)], "fyers")
    store.write("NIFTY", "INDEX", "5m", [_bar(T0, 999, 0), _bar(T0 + FIVE, 101, 0)], "yfinance")

    rows = _sources(store, "5m")
    assert rows == [(T0, "fyers", 100), (T0 + FIVE, "yfinance", 101)]


def test_fyers_replaces_yfinance(tmp_path):
    store = CandleStore(tmp_path / "c.db")
    store.write("NIFTY", "INDEX", "5m", [_bar(T0, 999, 0)], "yfinance")
    store.write("NIFTY", "INDEX", "5m", [_bar(T0, 100, 5000)], "fyers")
    assert _sources(store, "5m") == [(T0, "fyers", 100)]


def test_same_source_still_refreshes(tmp_path):
    """Re-fetching a window from the same source must update it, or a bar
    captured while still forming would be frozen."""
    store = CandleStore(tmp_path / "c.db")
    store.write("NIFTY", "INDEX", "5m", [_bar(T0, 100, 10)], "fyers")
    store.write("NIFTY", "INDEX", "5m", [_bar(T0, 105, 20)], "fyers")
    assert _sources(store, "5m") == [(T0, "fyers", 105)]


def test_daily_bars_keep_one_per_date(tmp_path):
    """yfinance stamps daily bars at 00:00 IST and Fyers at 05:30 IST, so the
    primary key alone would keep two bars for one date."""
    yf = to_epoch_ms(datetime(2026, 6, 15, 0, 0, tzinfo=IST))
    fy = to_epoch_ms(datetime(2026, 6, 15, 5, 30, tzinfo=IST))
    nxt = to_epoch_ms(datetime(2026, 6, 16, 0, 0, tzinfo=IST))

    store = CandleStore(tmp_path / "c.db")
    store.write("NIFTY", "INDEX", "1d", [_bar(yf, 99, 0)], "yfinance")
    store.write("NIFTY", "INDEX", "1d", [_bar(fy, 100, 1)], "fyers")
    assert _sources(store, "1d") == [(fy, "fyers", 100)]

    # A later yfinance sync neither duplicates that date nor misses a new one.
    store.write("NIFTY", "INDEX", "1d", [_bar(yf, 98, 0), _bar(nxt, 101, 0)], "yfinance")
    assert _sources(store, "1d") == [(fy, "fyers", 100), (nxt, "yfinance", 101)]


def test_sync_keeps_completed_session_bars_only():
    from datetime import timedelta

    from engine.data.store import session_bars_only

    day = datetime(2026, 8, 14, tzinfo=IST)
    at = lambda h, m: to_epoch_ms(day.replace(hour=h, minute=m))  # noqa: E731
    bars = [_bar(at(h, m), 100, 1) for h, m in
            [(9, 10), (9, 15), (15, 20), (15, 25), (15, 30), (18, 0)]]

    # Fetched at 15:27: the 15:25 bar is still forming.
    now = day.replace(hour=15, minute=27)
    assert [c.ts for c in session_bars_only(bars, "5m", now)] == [at(9, 15), at(15, 20)]

    # After the close the last session bar is complete; pre-open and evening
    # special-session bars never enter.
    later = now + timedelta(hours=4)
    assert [c.ts for c in session_bars_only(bars, "5m", later)] == [at(9, 15), at(15, 20), at(15, 25)]
    assert session_bars_only(bars, "1d", now) == bars
