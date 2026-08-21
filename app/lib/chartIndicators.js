/**
 * Overlays the chart draws and nothing else reads.
 *
 * Deliberately separate from `indicators.js`, which is the ported v1 strategy
 * and is pinned line-for-line against `engine/core/indicators.py`. Nothing here
 * feeds a signal, so it carries no parity obligation — but it also must not be
 * imported into one, or that obligation appears without anyone noticing.
 */

/**
 * Session-anchored VWAP: the average price paid today, weighted by volume.
 *
 * Anchored to the IST calendar day rather than run continuously, because that
 * is the number desks are measured against — a VWAP carried over from
 * yesterday describes nothing anybody trades. Bars with no volume fall back to
 * a plain typical-price mean, which is what Yahoo's zero-volume index candles
 * would otherwise turn into a division by zero.
 *
 * Returns one value per candle, null until a session has a bar.
 */
export function vwapSeries(candles = []) {
  const out = [];
  let day = null;
  let pv = 0;
  let vol = 0;
  let tpSum = 0;
  let n = 0;

  for (const c of candles) {
    const key = c.ts
      ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(c.ts))
      : c.t;
    if (key !== day) {
      day = key;
      pv = 0; vol = 0; tpSum = 0; n = 0;
    }
    const tp = (c.h + c.l + c.c) / 3;
    const v = c.vol || 0;
    pv += tp * v;
    vol += v;
    tpSum += tp;
    n += 1;
    out.push(vol > 0 ? pv / vol : tpSum / n);
  }
  return out;
}

/**
 * Supertrend: an ATR band that flips side when price closes through it.
 *
 * Wilder's ATR, as the indicator's author defined it, rather than the simple
 * mean `indicators.js` uses for RSI — this is a new overlay rather than a port,
 * so it follows the textbook.
 *
 * Returns `{ value, up }` per candle: the band price, and which side of it
 * price is on. Null while the ATR window is still filling.
 */
export function supertrendSeries(candles = [], period = 10, multiplier = 3) {
  const out = candles.map(() => null);
  if (candles.length < period + 1) return out;

  let atr = 0;
  for (let i = 1; i <= period; i++) {
    const c = candles[i];
    const prev = candles[i - 1].c;
    atr += Math.max(c.h - c.l, Math.abs(c.h - prev), Math.abs(c.l - prev));
  }
  atr /= period;

  let upper = 0;
  let lower = 0;
  let up = true;

  for (let i = period; i < candles.length; i++) {
    const c = candles[i];
    const prev = candles[i - 1];
    if (i > period) {
      const tr = Math.max(c.h - c.l, Math.abs(c.h - prev.c), Math.abs(c.l - prev.c));
      atr = (atr * (period - 1) + tr) / period;
    }

    const mid = (c.h + c.l) / 2;
    const rawUpper = mid + multiplier * atr;
    const rawLower = mid - multiplier * atr;

    // The bands only ever tighten towards price while the trend holds; they
    // reset outward on the bar that breaks it. Without the ratchet the line
    // whipsaws on every wide bar.
    upper = i === period || rawUpper < upper || prev.c > upper ? rawUpper : upper;
    lower = i === period || rawLower > lower || prev.c < lower ? rawLower : lower;

    if (i === period) up = c.c >= mid;
    else if (up && c.c < lower) up = false;
    else if (!up && c.c > upper) up = true;

    out[i] = { value: up ? lower : upper, up };
  }
  return out;
}
