/**
 * NSE market hours, including the holiday calendar.
 *
 * Mirrors `engine/data/timeutil.py` and is diffed against it by
 * `engine/tests/test_market_hours_parity.py`. Weekends alone were enough for a
 * dashboard, and wrong for anything that acts: without the holiday list the
 * cron tick logs signals on Republic Day, and the engine and the UI disagree
 * about whether the market is open.
 *
 * Verify against the NSE circular each year before the year starts. An unknown
 * year is reported through `holidayCalendarKnown` rather than guessed, so a
 * missing calendar is visible instead of silently treated as holiday-free.
 */

export const NSE_HOLIDAYS = {
  2026: [
    '2026-01-26', // Republic Day
    '2026-03-04', // Holi
    '2026-03-21', // Id-ul-Fitr
    '2026-03-27', // Ram Navami
    '2026-04-01', // Mahavir Jayanti
    '2026-04-03', // Good Friday
    '2026-04-14', // Dr. Ambedkar Jayanti
    '2026-05-01', // Maharashtra Day
    '2026-05-27', // Bakri Id
    '2026-08-15', // Independence Day
    '2026-08-26', // Ganesh Chaturthi
    '2026-10-02', // Gandhi Jayanti
    '2026-10-20', // Dussehra
    '2026-11-09', // Diwali Laxmi Pujan (muhurat session separate)
    '2026-11-10', // Diwali Balipratipada
    '2026-11-24', // Guru Nanak Jayanti
    '2026-12-25', // Christmas
  ],
};

const MARKET_OPEN = 9 * 60 + 15;
const MARKET_CLOSE = 15 * 60 + 30;
export const SQUARE_OFF = 15 * 60 + 20;

/** Accepts a Date or an epoch-millisecond timestamp. */
const at = (now) => (now instanceof Date ? now : new Date(now));

/** IST calendar date as YYYY-MM-DD, which is how the holiday list is keyed. */
export function istDateKey(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at(now));
}

export function isTradingHoliday(now = new Date()) {
  const key = istDateKey(now);
  return (NSE_HOLIDAYS[+key.slice(0, 4)] || []).includes(key);
}

export function holidayCalendarKnown(now = new Date()) {
  return +istDateKey(now).slice(0, 4) in NSE_HOLIDAYS;
}

export function getMarketStatus(now = new Date()) {
  const ist = new Date(at(now).toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const day = ist.getDay();
  const mins = ist.getHours() * 60 + ist.getMinutes();
  const known = holidayCalendarKnown(now);

  if (day === 0 || day === 6) {
    return { open: false, label: 'Market Closed (Weekend)', detail: 'Opens Mon 9:15 AM IST', reason: 'weekend', holidayCalendarKnown: known };
  }
  if (isTradingHoliday(now)) {
    return { open: false, label: 'Market Closed (Holiday)', detail: 'NSE trading holiday', reason: 'holiday', holidayCalendarKnown: known };
  }
  if (mins < MARKET_OPEN) {
    const left = MARKET_OPEN - mins;
    return { open: false, label: 'Pre-Market', detail: `Opens in ${Math.floor(left / 60)}h ${left % 60}m`, reason: 'pre_open', holidayCalendarKnown: known };
  }
  if (mins >= MARKET_CLOSE) {
    return { open: false, label: 'Market Closed', detail: 'Opens tomorrow 9:15 AM IST', reason: 'post_close', holidayCalendarKnown: known };
  }
  const left = MARKET_CLOSE - mins;
  return {
    open: true,
    label: 'Market Open',
    detail: `Closes in ${Math.floor(left / 60)}h ${left % 60}m`,
    reason: 'open',
    pastSquareOff: mins >= SQUARE_OFF,
    holidayCalendarKnown: known,
  };
}
