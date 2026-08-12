"""Local candle store.

Exists because the free providers all have a rolling window: yfinance serves
only the last 60 days of 5-minute bars and 8 days of 1-minute bars. Anything
older is gone for good unless it was captured. Running `sync` on a schedule
turns a 60-day window into permanent history that grows from today forward.

SQLite rather than Parquet: no extra dependency, and `INSERT OR REPLACE` on a
unique key makes re-fetching an overlapping window idempotent, which matters
because overlap is the normal case for a rolling window.
"""
from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from datetime import datetime, timedelta
from pathlib import Path

from .base import Candle, DataSource, Interval, Segment
from .timeutil import IST, to_epoch_ms

DEFAULT_DB = Path(__file__).resolve().parents[1] / "var" / "candles.db"

_SCHEMA = """
CREATE TABLE IF NOT EXISTS candles (
    symbol   TEXT    NOT NULL,
    segment  TEXT    NOT NULL,
    interval TEXT    NOT NULL,
    ts       INTEGER NOT NULL,
    o        REAL    NOT NULL,
    h        REAL    NOT NULL,
    l        REAL    NOT NULL,
    c        REAL    NOT NULL,
    v        REAL    NOT NULL,
    oi       REAL,
    source   TEXT    NOT NULL,
    PRIMARY KEY (symbol, segment, interval, ts)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_candles_lookup
    ON candles (symbol, segment, interval, ts);

CREATE TABLE IF NOT EXISTS sync_log (
    symbol     TEXT    NOT NULL,
    segment    TEXT    NOT NULL,
    interval   TEXT    NOT NULL,
    source     TEXT    NOT NULL,
    synced_at  INTEGER NOT NULL,
    rows_added INTEGER NOT NULL,
    first_ts   INTEGER,
    last_ts    INTEGER,
    PRIMARY KEY (symbol, segment, interval, source, synced_at)
);
"""


class CandleStore:
    def __init__(self, path: Path | str = DEFAULT_DB) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self._conn() as cx:
            cx.executescript(_SCHEMA)

    @contextmanager
    def _conn(self):
        cx = sqlite3.connect(self.path, timeout=30)
        cx.execute("PRAGMA journal_mode=WAL")
        cx.execute("PRAGMA synchronous=NORMAL")
        try:
            yield cx
            cx.commit()
        finally:
            cx.close()

    def write(
        self,
        symbol: str,
        segment: Segment,
        interval: Interval,
        candles: list[Candle],
        source: str,
    ) -> int:
        if not candles:
            return 0
        rows = [
            (symbol, segment, interval, c.ts, c.o, c.h, c.l, c.c, c.v, c.oi, source)
            for c in candles
        ]
        with self._conn() as cx:
            before = cx.execute(
                "SELECT COUNT(*) FROM candles WHERE symbol=? AND segment=? AND interval=?",
                (symbol, segment, interval),
            ).fetchone()[0]
            cx.executemany(
                "INSERT OR REPLACE INTO candles "
                "(symbol,segment,interval,ts,o,h,l,c,v,oi,source) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                rows,
            )
            after = cx.execute(
                "SELECT COUNT(*) FROM candles WHERE symbol=? AND segment=? AND interval=?",
                (symbol, segment, interval),
            ).fetchone()[0]
            added = after - before
            cx.execute(
                "INSERT OR REPLACE INTO sync_log "
                "(symbol,segment,interval,source,synced_at,rows_added,first_ts,last_ts) "
                "VALUES (?,?,?,?,?,?,?,?)",
                (
                    symbol,
                    segment,
                    interval,
                    source,
                    to_epoch_ms(datetime.now(IST)),
                    added,
                    candles[0].ts,
                    candles[-1].ts,
                ),
            )
        return added

    def read(
        self,
        symbol: str,
        segment: Segment,
        interval: Interval,
        start: datetime | None = None,
        end: datetime | None = None,
        limit: int | None = None,
    ) -> list[Candle]:
        sql = (
            "SELECT ts,o,h,l,c,v,oi FROM candles "
            "WHERE symbol=? AND segment=? AND interval=?"
        )
        args: list = [symbol, segment, interval]
        if start is not None:
            sql += " AND ts >= ?"
            args.append(to_epoch_ms(start))
        if end is not None:
            sql += " AND ts <= ?"
            args.append(to_epoch_ms(end))
        sql += " ORDER BY ts ASC"
        if limit:
            # Take the most recent `limit` bars, then restore ascending order.
            sql = (
                f"SELECT * FROM ({sql.replace('ORDER BY ts ASC', 'ORDER BY ts DESC')} "
                f"LIMIT {int(limit)}) ORDER BY ts ASC"
            )
        with self._conn() as cx:
            rows = cx.execute(sql, args).fetchall()
        return [Candle(ts=r[0], o=r[1], h=r[2], l=r[3], c=r[4], v=r[5], oi=r[6]) for r in rows]

    def coverage(self, symbol: str, segment: Segment, interval: Interval) -> dict:
        with self._conn() as cx:
            row = cx.execute(
                "SELECT COUNT(*), MIN(ts), MAX(ts) FROM candles "
                "WHERE symbol=? AND segment=? AND interval=?",
                (symbol, segment, interval),
            ).fetchone()
        count, lo, hi = row
        from .timeutil import from_epoch_ms

        return {
            "symbol": symbol,
            "segment": segment,
            "interval": interval,
            "count": count,
            "first": from_epoch_ms(lo).astimezone(IST).isoformat() if lo else None,
            "last": from_epoch_ms(hi).astimezone(IST).isoformat() if hi else None,
        }

    def inventory(self) -> list[dict]:
        with self._conn() as cx:
            rows = cx.execute(
                "SELECT symbol,segment,interval,COUNT(*),MIN(ts),MAX(ts) "
                "FROM candles GROUP BY symbol,segment,interval ORDER BY symbol,interval"
            ).fetchall()
        from .timeutil import from_epoch_ms

        return [
            {
                "symbol": r[0],
                "segment": r[1],
                "interval": r[2],
                "count": r[3],
                "first": from_epoch_ms(r[4]).astimezone(IST).date().isoformat(),
                "last": from_epoch_ms(r[5]).astimezone(IST).date().isoformat(),
            }
            for r in rows
        ]

    def sync(
        self,
        source: DataSource,
        symbol: str,
        interval: Interval,
        segment: Segment = "INDEX",
        days: int | None = None,
    ) -> dict:
        """Pull the provider's maximum available window and merge it in.

        Always fetches the full window rather than only since the last stored
        bar: providers restate recent bars, and re-fetching is idempotent.
        """
        limit = source.lookback_limit(interval)
        # No stated limit means daily-or-slower history, where providers go back
        # decades — ask for all of it rather than an arbitrary recent slice.
        span = days or limit or 7300
        if limit is not None:
            span = min(span, limit)

        end = datetime.now(IST)
        start = end - timedelta(days=span)
        candles = source.candles(symbol, interval, start, end, segment)
        added = self.write(symbol, segment, interval, candles, source.name)
        return {
            "symbol": symbol,
            "interval": interval,
            "fetched": len(candles),
            "new": added,
            "window_days": span,
            **self.coverage(symbol, segment, interval),
        }
