"""Time helpers. Everything internal is epoch milliseconds UTC; IST is only
applied at display and market-hours boundaries."""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

IST = ZoneInfo("Asia/Kolkata")
UTC = timezone.utc

MARKET_OPEN = (9, 15)
MARKET_CLOSE = (15, 30)
#: Intraday positions are squared off here, ahead of the close.
SQUARE_OFF = (15, 20)


def to_epoch_ms(dt: datetime) -> int:
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=IST)
    return int(dt.timestamp() * 1000)


def from_epoch_ms(ms: int) -> datetime:
    return datetime.fromtimestamp(ms / 1000, tz=UTC)


def now_ist() -> datetime:
    return datetime.now(IST)


def ist_minutes(dt: datetime) -> int:
    d = dt.astimezone(IST)
    return d.hour * 60 + d.minute


def _hm(pair: tuple[int, int]) -> int:
    return pair[0] * 60 + pair[1]


# NSE trading holidays. The JS `marketHours.js` only knows about weekends, which
# is harmless for a dashboard and wrong for an algo: without this the engine
# wakes up and tries to trade on Republic Day.
#
# Verify against the NSE circular each year before the year starts.
NSE_HOLIDAYS: dict[int, set[str]] = {
    2026: {
        "2026-01-26",  # Republic Day
        "2026-03-04",  # Holi
        "2026-03-21",  # Id-ul-Fitr
        "2026-03-27",  # Ram Navami
        "2026-04-01",  # Mahavir Jayanti
        "2026-04-03",  # Good Friday
        "2026-04-14",  # Dr. Ambedkar Jayanti
        "2026-05-01",  # Maharashtra Day
        "2026-05-27",  # Bakri Id
        "2026-08-15",  # Independence Day
        "2026-08-26",  # Ganesh Chaturthi
        "2026-10-02",  # Gandhi Jayanti
        "2026-10-20",  # Dussehra
        "2026-11-09",  # Diwali Laxmi Pujan (muhurat session separate)
        "2026-11-10",  # Diwali Balipratipada
        "2026-11-24",  # Guru Nanak Jayanti
        "2026-12-25",  # Christmas
    },
}


class HolidayCalendarMissing(RuntimeError):
    """Raised rather than guessing. An unknown year must not silently be
    treated as holiday-free while real money is at stake."""


def is_trading_holiday(d: date, *, strict: bool = True) -> bool:
    year = d.year
    if year not in NSE_HOLIDAYS:
        if strict:
            raise HolidayCalendarMissing(
                f"No NSE holiday list for {year}. Add it to NSE_HOLIDAYS in "
                f"engine/data/timeutil.py before trading in that year."
            )
        return False
    return d.isoformat() in NSE_HOLIDAYS[year]


def is_trading_day(d: date, *, strict: bool = True) -> bool:
    if d.weekday() >= 5:
        return False
    return not is_trading_holiday(d, strict=strict)


def market_status(now: datetime | None = None, *, strict: bool = True) -> dict:
    """Mirrors `app/lib/marketHours.js` plus the holiday calendar it lacks."""
    now = (now or now_ist()).astimezone(IST)
    today = now.date()

    if today.weekday() >= 5:
        return {"open": False, "label": "Market Closed (Weekend)", "reason": "weekend"}
    if is_trading_holiday(today, strict=strict):
        return {"open": False, "label": "Market Closed (Holiday)", "reason": "holiday"}

    mins = ist_minutes(now)
    if mins < _hm(MARKET_OPEN):
        return {"open": False, "label": "Pre-Market", "reason": "pre_open"}
    if mins >= _hm(MARKET_CLOSE):
        return {"open": False, "label": "Market Closed", "reason": "post_close"}
    return {
        "open": True,
        "label": "Market Open",
        "reason": "open",
        "past_square_off": mins >= _hm(SQUARE_OFF),
    }


def trading_days_between(start: date, end: date, *, strict: bool = False) -> list[date]:
    out, cur = [], start
    while cur <= end:
        if is_trading_day(cur, strict=strict):
            out.append(cur)
        cur += timedelta(days=1)
    return out
