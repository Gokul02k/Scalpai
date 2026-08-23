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

/**
 * Every fund the app recognises, and whether its value can be derived.
 *
 * `tracks` is the index whose level prices the fund, by the engine's own symbol
 * name, and null when there is no series to price it against. `why` then says
 * which kind of gap it is, because the answers are not interchangeable: an
 * index we have not archived is a job, while a foreign market shut during NSE
 * hours is a fact about the instrument.
 *
 * Every symbol here was checked against the live Fyers quote endpoint, and
 * every `tracks` against the index quote endpoint. Guessing either would put a
 * fund in the portfolio that silently never prices.
 */
export const ETFS = {
  // Indian index funds whose underlying the archive can serve.
  NIFTYBEES: { kind: 'index', tracks: 'NIFTY', label: 'Nifty 50' },
  SETFNIF50: { kind: 'index', tracks: 'NIFTY', label: 'Nifty 50' },
  NIFTYIETF: { kind: 'index', tracks: 'NIFTY', label: 'Nifty 50' },
  BANKBEES: { kind: 'index', tracks: 'BANKNIFTY', label: 'Bank Nifty' },
  SETFNIFBK: { kind: 'index', tracks: 'BANKNIFTY', label: 'Bank Nifty' },
  ITBEES: { kind: 'index', tracks: 'NIFTYIT', label: 'Nifty IT' },
  PSUBNKBEES: { kind: 'index', tracks: 'NIFTYPSUBANK', label: 'Nifty PSU Bank' },
  INFRABEES: { kind: 'index', tracks: 'NIFTYINFRA', label: 'Nifty Infra' },
  ALPHA: { kind: 'index', tracks: 'NIFTYALPHA50', label: 'Nifty Alpha 50' },
  DIVOPPBEES: { kind: 'index', tracks: 'NIFTYDIVOPPS50', label: 'Nifty Div Opps 50' },

  // Indian index funds whose index Fyers does not expose. Priceable in
  // principle, blocked on a series rather than on anything conceptual.
  JUNIORBEES: { kind: 'index', tracks: null, label: 'Nifty Next 50', why: 'index-unavailable' },
  CPSEETF: { kind: 'index', tracks: null, label: 'Nifty CPSE', why: 'index-unavailable' },
  ICICIB22: { kind: 'index', tracks: null, label: 'S&P BSE Bharat 22', why: 'index-unavailable' },
  MOM100: { kind: 'index', tracks: null, label: 'Nifty Midcap 100', why: 'index-unavailable' },
  MOMENTUM50: { kind: 'index', tracks: null, label: 'Momentum 50', why: 'index-unavailable' },

  // Commodity funds. There is no index behind these, only a metal price the
  // app does not archive, so fair value needs a spot feed rather than a series.
  GOLDBEES: { kind: 'commodity', tracks: null, label: 'Domestic gold', why: 'no-spot-feed' },
  SILVERBEES: { kind: 'commodity', tracks: null, label: 'Domestic silver', why: 'no-spot-feed' },

  // Funds on foreign indices. These are where premium matters most, and also
  // where a ratio is least meaningful: the underlying market is closed while
  // they trade here, so the gap measures the time difference.
  MON100: { kind: 'global', tracks: null, label: 'Nasdaq 100', why: 'underlying-shut' },
  MAFANG: { kind: 'global', tracks: null, label: 'NYSE FANG+', why: 'underlying-shut' },
  HNGSNGBEES: { kind: 'global', tracks: null, label: 'Hang Seng', why: 'underlying-shut' },

  // A cash park that trades at a fixed face value. Premium is not a concept
  // that applies, rather than a number we are missing.
  LIQUIDBEES: { kind: 'debt', tracks: null, label: 'Overnight liquid', why: 'not-applicable' },
};

/**
 * ETF -> the index whose level prices it. Derived from `ETFS` rather than
 * written twice, so a fund cannot be priceable in one place and not the other.
 */
export const TRACKED_INDEX = Object.fromEntries(
  Object.entries(ETFS).filter(([, meta]) => meta.tracks).map(([sym, meta]) => [sym, meta.tracks])
);

/** Whether a symbol is a fund rather than a company. */
export function isETF(symbol) {
  return Boolean(ETFS[String(symbol || '').toUpperCase()]);
}

export function etfMeta(symbol) {
  return ETFS[String(symbol || '').toUpperCase()] || null;
}

// The parity harness can only call functions, and the registry is the thing
// most worth pinning: it decides which funds ever get a fair value at all.
export function registrySnapshot() { return ETFS; }
export function trackedIndexSnapshot() { return TRACKED_INDEX; }

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
