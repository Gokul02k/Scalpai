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

// NSE circular NSE/CMTR/71775 (12 Dec 2025), amended by NSE/CMTR/72260
// (12 Jan 2026) to add 15 Jan. Weekday holidays only: Mahashivratri (15 Feb),
// Id-Ul-Fitr (21 Mar), Independence Day (15 Aug) and Diwali Laxmi Pujan
// (8 Nov, muhurat session) fall on weekends and need no entry.
export const NSE_HOLIDAYS = {
  2026: [
    '2026-01-15', // Maharashtra municipal elections (NSE/CMTR/72260)
    '2026-01-26', // Republic Day
    '2026-03-03', // Holi
    '2026-03-26', // Shri Ram Navami
    '2026-03-31', // Shri Mahavir Jayanti
    '2026-04-03', // Good Friday
    '2026-04-14', // Dr. Baba Saheb Ambedkar Jayanti
    '2026-05-01', // Maharashtra Day
    '2026-05-28', // Bakri Id
    '2026-06-26', // Muharram
    '2026-09-14', // Ganesh Chaturthi
    '2026-10-02', // Mahatma Gandhi Jayanti
    '2026-10-20', // Dussehra
    '2026-11-10', // Diwali Balipratipada
    '2026-11-24', // Prakash Gurpurb Sri Guru Nanak Dev
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

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * "Opens tomorrow" was printed after every close, including Friday's and the
 * evening before a holiday. Walk forward to the next real session instead.
 * An unknown year counts weekdays only, which is the best that can be said.
 */
function nextOpenDetail(now) {
  const start = at(now).getTime();
  for (let i = 1; i <= 10; i++) {
    const day = new Date(start + i * DAY_MS);
    const ist = new Date(day.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const dow = ist.getDay();
    if (dow === 0 || dow === 6 || isTradingHoliday(day)) continue;
    const when = i === 1 ? 'tomorrow' : `${WEEKDAY[dow]} ${ist.getDate()}`;
    return `Opens ${when} 9:15 AM IST`;
  }
  return 'Opens next trading day 9:15 AM IST';
}

export function getMarketStatus(now = new Date()) {
  const ist = new Date(at(now).toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const day = ist.getDay();
  const mins = ist.getHours() * 60 + ist.getMinutes();
  const known = holidayCalendarKnown(now);

  if (day === 0 || day === 6) {
    return { open: false, label: 'Market Closed (Weekend)', detail: nextOpenDetail(now), reason: 'weekend', holidayCalendarKnown: known };
  }
  if (isTradingHoliday(now)) {
    return { open: false, label: 'Market Closed (Holiday)', detail: `NSE trading holiday · ${nextOpenDetail(now)}`, reason: 'holiday', holidayCalendarKnown: known };
  }
  if (mins < MARKET_OPEN) {
    const left = MARKET_OPEN - mins;
    return { open: false, label: 'Pre-Market', detail: `Opens in ${Math.floor(left / 60)}h ${left % 60}m`, reason: 'pre_open', holidayCalendarKnown: known };
  }
  if (mins >= MARKET_CLOSE) {
    return { open: false, label: 'Market Closed', detail: nextOpenDetail(now), reason: 'post_close', holidayCalendarKnown: known };
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
