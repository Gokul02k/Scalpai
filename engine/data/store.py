"""Local candle store.

Exists because the free providers all have a rolling window: yfinance serves
only the last 60 days of 5-minute bars and 8 days of 1-minute bars. Anything
older is gone for good unless it was captured. Running `sync` on a schedule
turns a 60-day window into permanent history that grows from today forward.

SQLite rather than Parquet: no extra dependency, and an upsert on a unique key
makes re-fetching an overlapping window idempotent, which matters because
overlap is the normal case for a rolling window.

Sources are ranked, and a bar is only ever replaced by one from a source of
equal or higher rank. Without that, a plain `sync` (yfinance by default)
silently overwrote Fyers bars with yfinance ones that carry zero index volume,
breaking session VWAP for every day it touched. yfinance still fills gaps.
"""
from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from datetime import datetime, timedelta
from pathlib import Path

from .base import Candle, DataSource, Interval, Segment
from .timeutil import IST, to_epoch_ms

DEFAULT_DB = Path(__file__).resolve().parents[1] / "var" / "candles.db"

#: Higher wins. A bar is replaced only by an equal or higher ranked source.
#: Unknown sources rank lowest, so a new adapter cannot clobber Fyers either.
SOURCE_RANK = {"fyers": 2, "yfinance": 1}


def source_rank(source: str) -> int:
    return SOURCE_RANK.get(source, 0)


def _rank_sql(column: str) -> str:
    cases = " ".join(f"WHEN '{name}' THEN {rank}" for name, rank in SOURCE_RANK.items())
    return f"(CASE {column} {cases} ELSE 0 END)"


# Replace on conflict only when the incoming source ranks at least as high.
_UPSERT = (
    "INSERT INTO candles (symbol,segment,interval,ts,o,h,l,c,v,oi,source) "
    "VALUES (?,?,?,?,?,?,?,?,?,?,?) "
    "ON CONFLICT(symbol,segment,interval,ts) DO UPDATE SET "
    "o=excluded.o, h=excluded.h, l=excluded.l, c=excluded.c, v=excluded.v, "
    "oi=excluded.oi, source=excluded.source "
    f"WHERE {_rank_sql('excluded.source')} >= {_rank_sql('candles.source')}"
)


def _ist_day(ts_ms: int) -> str:
    return datetime.fromtimestamp(ts_ms / 1000, tz=IST).date().isoformat()

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


_BAR_MS = {"1m": 60_000, "5m": 300_000, "15m": 900_000, "30m": 1_800_000, "1h": 3_600_000}


def session_bars_only(candles: list[Candle], interval: str, now: datetime) -> list[Candle]:
    """Completed bars inside the regular 09:15-15:30 session.

    What the archive stores is what every backtest reads, so it holds only
    what the strategies assume exists:

      * no bar that was still forming when fetched. A partial bar written at
        15:27 was never revisited, because refreshes stop at the close, and
        stayed frozen as that session's last bar;
      * nothing outside the regular session. Fyers also returns 09:10 pre-open
        bars and evening special-session bars, which skewed session VWAP, the
        opening range and the previous close.

    Daily bars pass through untouched.
    """
    bar_ms = _BAR_MS.get(interval)
    if not bar_ms:
        return candles
    from .timeutil import MARKET_CLOSE, MARKET_OPEN

    open_m = MARKET_OPEN[0] * 60 + MARKET_OPEN[1]
    close_m = MARKET_CLOSE[0] * 60 + MARKET_CLOSE[1]
    now_ms = to_epoch_ms(now)
    out = []
    for c in candles:
        t = datetime.fromtimestamp(c.ts / 1000, tz=IST)
        mins = t.hour * 60 + t.minute
        if open_m <= mins < close_m and c.ts + bar_ms <= now_ms:
            out.append(c)
    return out


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
            if interval == "1d":
                rows = self._reconcile_daily(cx, symbol, segment, rows, source)
            cx.executemany(_UPSERT, rows)
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

    @staticmethod
    def _reconcile_daily(cx, symbol, segment, rows, source):
        """One daily bar per IST date, from the best source that has it.

        Providers stamp daily bars differently (yfinance at 00:00 IST, Fyers at
        05:30 IST), so the primary key alone would keep both bars for one date.
        Incoming bars lose to a better-ranked bar already stored for that date;
        they replace stored bars of lower rank.
        """
        if not rows:
            return rows
        rank = source_rank(source)
        lo = min(r[3] for r in rows) - 86_400_000
        hi = max(r[3] for r in rows) + 86_400_000
        existing = cx.execute(
            "SELECT ts, source FROM candles WHERE symbol=? AND segment=? "
            "AND interval='1d' AND ts BETWEEN ? AND ?",
            (symbol, segment, lo, hi),
        ).fetchall()
        by_day: dict[str, list[tuple[int, str]]] = {}
        for ts, src in existing:
            by_day.setdefault(_ist_day(ts), []).append((ts, src))

        keep = []
        for row in rows:
            ts = row[3]
            others = [(t, s) for t, s in by_day.get(_ist_day(ts), []) if t != ts]
            if any(source_rank(s) > rank for _, s in others):
                continue
            for t, s in others:
                if source_rank(s) <= rank:
                    cx.execute(
                        "DELETE FROM candles WHERE symbol=? AND segment=? "
                        "AND interval='1d' AND ts=?",
                        (symbol, segment, t),
                    )
            keep.append(row)
        return keep

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
        candles = session_bars_only(source.candles(symbol, interval, start, end, segment),
                                    interval, end)
        added = self.write(symbol, segment, interval, candles, source.name)
        return {
            "symbol": symbol,
            "interval": interval,
            "fetched": len(candles),
            "new": added,
            "window_days": span,
            **self.coverage(symbol, segment, interval),
        }
