/**
 * Which sector a holding belongs to.
 *
 * The sector shown against a row used to come from one place: Yahoo's
 * `assetProfile`, fetched per symbol behind a cookie-and-crumb handshake. That
 * makes the sector a *network result*, and it fails in three ways that all land
 * a stock in "Other":
 *
 *   - The crumb handshake is refused, and no symbol resolves at all.
 *   - A symbol 404s on its own. TATAMOTORS.NS does today, after the demerger
 *     retired the listing Yahoo indexed — the company is fine, the row is not.
 *   - The profile arrives with every other field and no `sector`, which is
 *     ordinary for funds.
 *
 * None of those are visible to the reader. They see a portfolio where some
 * stocks are sectored and some are "Other", with no pattern to it, and a sector
 * filter that cannot find a stock it is plainly looking at. The table below is
 * what makes the common case survive all three: it answers offline, instantly,
 * and for symbols Yahoo has stopped serving.
 *
 * The vocabulary is deliberately Yahoo's own — Morningstar's eleven sectors,
 * spelled exactly as `assetProfile` spells them, every value here read back
 * from the live endpoint rather than written from memory. Sharing the
 * vocabulary is the whole point. "IT" and "Technology" are the same sector to a
 * reader and two different chips to a `Set`, so a table in any other dialect
 * would split each sector in half the moment the network filled in half a
 * portfolio — trading a bucket that is obviously wrong for two that are subtly
 * wrong.
 */
export const SECTOR_BY_SYMBOL = {
  ADANIENT: 'Energy',
  ADANIPORTS: 'Industrials',
  APOLLOHOSP: 'Healthcare',
  ASIANPAINT: 'Basic Materials',
  AXISBANK: 'Financial Services',
  BAJAJFINSV: 'Financial Services',
  BAJFINANCE: 'Financial Services',
  BHARTIARTL: 'Communication Services',
  BPCL: 'Energy',
  BRITANNIA: 'Consumer Defensive',
  CIPLA: 'Healthcare',
  COALINDIA: 'Energy',
  DIVISLAB: 'Healthcare',
  DRREDDY: 'Healthcare',
  EICHERMOT: 'Consumer Cyclical',
  GRASIM: 'Basic Materials',
  HCLTECH: 'Technology',
  HDFCBANK: 'Financial Services',
  HDFCLIFE: 'Financial Services',
  HEROMOTOCO: 'Consumer Cyclical',
  HINDALCO: 'Basic Materials',
  HINDUNILVR: 'Consumer Defensive',
  ICICIBANK: 'Financial Services',
  INDUSINDBK: 'Financial Services',
  INFY: 'Technology',
  ITC: 'Consumer Defensive',
  JSWSTEEL: 'Basic Materials',
  KOTAKBANK: 'Financial Services',
  LT: 'Industrials',
  'M&M': 'Consumer Cyclical',
  MARUTI: 'Consumer Cyclical',
  NESTLEIND: 'Consumer Defensive',
  NTPC: 'Utilities',
  ONGC: 'Energy',
  POWERGRID: 'Utilities',
  RELIANCE: 'Energy',
  SBILIFE: 'Financial Services',
  SBIN: 'Financial Services',
  SHREECEM: 'Basic Materials',
  SUNPHARMA: 'Healthcare',
  TATACONSUM: 'Consumer Defensive',
  TATAMOTORS: 'Consumer Cyclical',
  TATASTEEL: 'Basic Materials',
  TCS: 'Technology',
  TECHM: 'Technology',
  TITAN: 'Consumer Cyclical',
  ULTRACEMCO: 'Basic Materials',
  UPL: 'Basic Materials',
  WIPRO: 'Technology',
};

/** What a row shows when nothing can name its sector. */
export const UNKNOWN_SECTOR = 'Unsectored';

// Values that mean "nobody filled this in". They have to be screened rather
// than trusted, because a stored holding is not a controlled input: `qty`-era
// rows carry the literal string "Other", an argument-order bug stored the
// number 0, and rows left by the retired CSV importer carry whatever the
// broker printed in a sector column. Any of those reaching a chip row puts a
// placeholder on the screen as though it were a sector.
const PLACEHOLDERS = new Set(['', 'other', 'stock', 'na', 'n/a', 'none', 'unknown', '-', '—']);

/**
 * A sector name, or null when the value carries no information.
 *
 * Non-strings are rejected outright: truthiness is not enough of a test here,
 * since the number 0 is falsy but 1 is not, and one bad argument position is
 * all it takes to store either.
 */
export function normalizeSector(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || PLACEHOLDERS.has(trimmed.toLowerCase())) return null;
  return trimmed;
}

/** The table's answer for a symbol, if it has one. */
export function staticSector(symbol) {
  const key = String(symbol || '').toUpperCase().replace(/\.NS$/, '');
  return SECTOR_BY_SYMBOL[key] || null;
}

/**
 * The sector to show for a holding.
 *
 * Live profile first, because it is the only source that can be right about a
 * symbol nobody here has heard of. Then whatever the holding was stored with,
 * so a sector the assistant supplied — or one already saved against a row — is
 * not overruled by this file. The table last, as the offline floor.
 */
export function resolveSector({ symbol, fundamentalsSector, storedSector } = {}) {
  return normalizeSector(fundamentalsSector)
    || normalizeSector(storedSector)
    || staticSector(symbol)
    || UNKNOWN_SECTOR;
}

/**
 * Sector names in the order they should be offered.
 *
 * Alphabetical, except that the bucket for "we could not tell" sorts last
 * wherever it appears. It is not a sector, and alphabetising it into the middle
 * of the list reads as though it were one.
 */
export function sortSectors(names = []) {
  return [...names].sort((a, b) => {
    const au = a === UNKNOWN_SECTOR ? 1 : 0;
    const bu = b === UNKNOWN_SECTOR ? 1 : 0;
    return au - bu || a.localeCompare(b);
  });
}
