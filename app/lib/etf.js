/**
 * Fair value for an exchange-traded fund, and the premium it trades at.
 *
 * An ETF should change hands near the value of what it holds. When it does not,
 * the gap is worth seeing before placing an order: buying a fund at a premium
 * means paying for something the fund does not own, and the premium can close
 * against you while the index goes nowhere.
 *
 * **This is not the premium to NAV, and it must not be described as one.** The
 * exchange publishes iNAV every fifteen seconds and serves it from no API;
 * Fyers does not carry it either -- its ETF quote returns bid, ask, spread, atp,
 * volume and OHLC, and nothing about the underlying basket. So fair value here
 * is derived from the index the fund tracks:
 *
 *     ratio   = median(etf_close / index_close) over a recent window
 *     fair    = index_price * ratio
 *     premium = price / fair - 1
 *
 * Two consequences bound what the number can be used for, and both are the
 * reason it starts life as a column rather than as a signal:
 *
 *   - It measures **dislocation from the fund's own recent tracking
 *     relationship**, not distance from NAV. A fund that sat thirty basis
 *     points rich all month reads as fair, because the median absorbed it.
 *   - A ratio is only a tracking ratio if it holds still. Dispersion is
 *     measured alongside it, and a relationship too loose to be tracking
 *     reports no fair value at all -- so a wrong entry in TRACKED_INDEX
 *     produces silence instead of a confident fiction.
 *
 * Mirrored line-for-line by `engine/core/etf.py` and diffed against it in
 * `engine/tests/test_etf_parity.py`. Keep the two structurally identical: the
 * point of the parity suite is that a change here cannot quietly become a
 * different number in the backtest.
 */

/** ETF -> the index whose level prices it, by the engine's own symbol name. */
export const TRACKED_INDEX = {
  NIFTYBEES: 'NIFTY',
  SETFNIF50: 'NIFTY',
  NIFTYIETF: 'NIFTY',
  BANKBEES: 'BANKNIFTY',
  SETFNIFBK: 'BANKNIFTY',
  ITBEES: 'NIFTYIT',
  PSUBNKBEES: 'NIFTYPSUBANK',
  INFRABEES: 'NIFTYINFRA',
  ALPHA: 'NIFTYALPHA50',
  DIVOPPBEES: 'NIFTYDIVOPPS50',
};

export const RATIO_WINDOW = 20;
export const MIN_RATIO_SAMPLES = 8;
export const MAX_RATIO_DISPERSION = 0.01;

/** Middle value, averaging the pair when the count is even. */
export function median(values = []) {
  const clean = values.filter((v) => v != null).sort((a, b) => a - b);
  const n = clean.length;
  if (!n) return null;
  const mid = Math.floor(n / 2);
  if (n % 2) return clean[mid];
  return (clean[mid - 1] + clean[mid]) / 2;
}

/**
 * Closes for the bars both series actually have, matched on timestamp.
 *
 * Positional pairing would be the obvious shortcut and is wrong: the two series
 * are synced independently, so one missing session silently shifts every
 * earlier bar against a different day's index level.
 */
export function alignCloses(etfRows = [], indexRows = []) {
  const byTs = new Map();
  for (const row of indexRows) {
    if (row?.ts != null && row.c) byTs.set(row.ts, row.c);
  }
  const out = [];
  for (const row of etfRows) {
    const level = byTs.get(row?.ts);
    if (row?.ts == null || !row.c || !level) continue;
    out.push([row.ts, Number(row.c), Number(level)]);
  }
  return out;
}

/**
 * The fund's ratio to its index, and how steadily it has held.
 *
 * Null when there is too little history to estimate; `stable: false` when there
 * is enough but the relationship is too loose to be tracking. Those are
 * different answers and the caller renders them differently.
 */
export function tracking(aligned = [], window = RATIO_WINDOW) {
  const recent = aligned.slice(-window);
  if (recent.length < MIN_RATIO_SAMPLES) return null;

  const ratios = recent.filter(([, , level]) => level).map(([, etf, level]) => etf / level);
  const mid = median(ratios);
  if (!mid) return null;

  // Median absolute deviation, relative to the ratio itself. Robust to the step
  // a dividend puts in the series, which a standard deviation would read as the
  // pair having come apart.
  const spread = median(ratios.map((r) => Math.abs(r - mid))) || 0;
  const dispersion = spread / mid;
  return {
    ratio: mid,
    dispersion,
    samples: recent.length,
    stable: dispersion <= MAX_RATIO_DISPERSION,
  };
}

export function fairValue(indexPrice, ratio) {
  if (!indexPrice || !ratio) return null;
  return indexPrice * ratio;
}

/** How far above its tracked value the fund is trading, in percent. */
export function premiumPct(price, fair) {
  if (!price || !fair) return null;
  return +((price / fair - 1) * 100).toFixed(2);
}

/**
 * Everything the dashboard needs for one fund's premium column.
 *
 * Always returns an object with a `status`, because "we cannot price this one"
 * has to be displayable. A column that silently blanks is indistinguishable
 * from a fund trading exactly at fair value, and those mean opposite things.
 */
export function basis(symbol, price, indexPrice, etfRows = [], indexRows = [], window = RATIO_WINDOW) {
  const tracked = TRACKED_INDEX[String(symbol).toUpperCase()];
  if (!tracked) return { symbol, status: 'unmapped', index: null };

  const fit = tracking(alignCloses(etfRows, indexRows), window);
  if (fit === null) return { symbol, status: 'insufficient-history', index: tracked };
  if (!fit.stable) {
    return {
      symbol,
      status: 'unstable',
      index: tracked,
      dispersion: fit.dispersion,
      samples: fit.samples,
    };
  }

  const fair = fairValue(indexPrice, fit.ratio);
  const premium = premiumPct(price, fair);
  if (premium === null) return { symbol, status: 'no-quote', index: tracked };

  return {
    symbol,
    status: 'ok',
    index: tracked,
    price,
    fair,
    premiumPct: premium,
    ratio: fit.ratio,
    dispersion: fit.dispersion,
    samples: fit.samples,
  };
}
