"""The dashboard and the engine must agree about whether the market is open.

`app/lib/marketHours.js` knew only about weekends until the engine grew a
holiday calendar, which meant the cron tick would log signals on Republic Day
while the engine stood aside. These tests hold the two together: same verdict,
same reason, same square-off flag, on the days most likely to differ.
"""
from __future__ import annotations

from datetime import datetime

import pytest

from engine.data.timeutil import IST, NSE_HOLIDAYS, market_status
from engine.tests.jsbridge import call_js, node_available

pytestmark = pytest.mark.skipif(not node_available(), reason="node not installed")

#: IST moments chosen for the boundaries, not the middles.
CASES = [
    ("republic day", "2026-01-26 11:00"),
    ("holi", "2026-03-04 10:30"),
    # 15 August is both a holiday and a Saturday, and both sides have to break
    # the tie the same way, so it is here as well as an ordinary weekend.
    ("independence day", "2026-08-15 12:00"),
    ("saturday", "2026-08-22 12:00"),
    ("sunday", "2026-08-16 12:00"),
    ("pre-open", "2026-08-17 09:00"),
    ("first minute", "2026-08-17 09:15"),
    ("mid session", "2026-08-17 12:30"),
    ("square-off", "2026-08-17 15:22"),
    ("last minute", "2026-08-17 15:29"),
    ("closing bell", "2026-08-17 15:30"),
    ("after hours", "2026-08-17 18:00"),
    ("unknown year", "2027-01-04 11:00"),
]


def _ms(when: str) -> int:
    return int(datetime.strptime(when, "%Y-%m-%d %H:%M").replace(tzinfo=IST).timestamp() * 1000)


@pytest.mark.parametrize("name,when", CASES, ids=[c[0] for c in CASES])
def test_both_sides_call_the_session_the_same_way(name, when):
    ms = _ms(when)
    js = call_js("marketHours", "getMarketStatus", ms)
    # Not strict: an unknown holiday year must be reported, not raised, or the
    # dashboard goes down on 1 January of whichever year nobody updated.
    py = market_status(datetime.fromtimestamp(ms / 1000, tz=IST), strict=False)

    assert js["open"] == py["open"], f"{name}: {js['label']} vs {py['label']}"
    assert js["label"] == py["label"]
    assert js["reason"] == py["reason"]
    assert js.get("pastSquareOff", False) == py.get("past_square_off", False)


def test_the_javascript_carries_the_same_holiday_list():
    """Two hand-maintained lists drifting apart is the failure this catches:
    the NSE circular gets applied to one file and not the other."""
    js = call_js("marketHours", "istDateKey", _ms("2026-01-26 11:00"))
    assert js == "2026-01-26"

    for year, days in NSE_HOLIDAYS.items():
        for day in days:
            ms = _ms(f"{day} 11:00")
            assert call_js("marketHours", "isTradingHoliday", ms) is True, day
            assert not market_status(
                datetime.fromtimestamp(ms / 1000, tz=IST), strict=False
            )["open"], day
        assert call_js("marketHours", "holidayCalendarKnown", _ms(f"{year}-06-01 11:00")) is True


def test_an_unknown_year_says_so_rather_than_guessing():
    unknown = max(NSE_HOLIDAYS) + 1
    ms = _ms(f"{unknown}-06-01 11:00")
    assert call_js("marketHours", "holidayCalendarKnown", ms) is False
    assert unknown not in NSE_HOLIDAYS


def test_holiday_list_matches_the_archive():
    """The parity test above only proves the two lists agree with each other,
    which a shared mistake passes: the 2026 list once carried five dates the
    market traded on and missed six it was shut. Every archived weekday must
    either have bars or be a holiday, never both and never neither."""
    import sqlite3
    from datetime import date, datetime, timedelta

    from engine.data.store import DEFAULT_DB
    from engine.data.timeutil import IST, NSE_HOLIDAYS

    if not DEFAULT_DB.exists():
        pytest.skip("no local archive")
    since = int(datetime(2026, 1, 1, tzinfo=IST).timestamp() * 1000)
    with sqlite3.connect(f"file:{DEFAULT_DB}?mode=ro", uri=True) as cx:
        traded = {
            r[0] for r in cx.execute(
                "SELECT DISTINCT date((ts/1000)+19800,'unixepoch') FROM candles "
                "WHERE symbol='NIFTY' AND interval='5m' AND ts>=?",
                (since,),
            )
        }
    if not traded:
        pytest.skip("archive has no 2026 NIFTY 5m bars")

    wrong = []
    d, last = date(2026, 1, 1), date.fromisoformat(max(traded))
    while d <= last:
        if d.weekday() < 5:
            key = d.isoformat()
            if (key in traded) == (key in NSE_HOLIDAYS[2026]):
                wrong.append(key)
        d += timedelta(days=1)
    assert not wrong, f"holiday list disagrees with archived sessions on {wrong}"
