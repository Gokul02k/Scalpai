export function calcEMA(values, period) {
  if (!values.length) return [];
  const k = 2 / (period + 1);
  const out = [values[0]];
  for (let i = 1; i < values.length; i++) {
    out.push(values[i] * k + out[i - 1] * (1 - k));
  }
  return out;
}

export function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) avgGain += d;
    else avgLoss -= d;
  }
  avgGain /= period;
  avgLoss /= period;
  if (avgLoss === 0) return 100;
  return +((100 - 100 / (1 + avgGain / avgLoss)).toFixed(1));
}

export function calcRSIHistory(closes, period = 14) {
  const out = [];
  for (let i = period + 1; i <= closes.length; i++) {
    out.push({ i: out.length, rsi: calcRSI(closes.slice(0, i), period) });
  }
  return out.slice(-40);
}

export function calcMACD(closes) {
  if (closes.length < 26) return { v: 0, s: 0, h: 0 };
  const ema12 = calcEMA(closes, 12);
  const ema26 = calcEMA(closes, 26);
  const macdLine = ema12.map((v, i) => +(v - ema26[i]).toFixed(4));
  const signalLine = calcEMA(macdLine, 9);
  const v = macdLine[macdLine.length - 1];
  const s = signalLine[signalLine.length - 1];
  return { v: +v.toFixed(3), s: +s.toFixed(3), h: +((v - s).toFixed(3)) };
}

export function calcMACDHistory(closes) {
  if (closes.length < 26) return [];
  const ema12 = calcEMA(closes, 12);
  const ema26 = calcEMA(closes, 26);
  const macdLine = ema12.map((v, i) => v - ema26[i]);
  const signalLine = calcEMA(macdLine, 9);
  return macdLine
    .map((v, i) => ({ i, h: +((v - signalLine[i]).toFixed(3)) }))
    .slice(-40)
    .map((d, i) => ({ i, h: d.h }));
}

export function calcBollinger(closes, period = 20) {
  if (closes.length < period) return { upper: 0, mid: 0, lower: 0 };
  const slice = closes.slice(-period);
  const mid = slice.reduce((a, b) => a + b, 0) / period;
  const std = Math.sqrt(slice.reduce((s, v) => s + (v - mid) ** 2, 0) / period);
  return { upper: +(mid + 2 * std).toFixed(2), mid: +mid.toFixed(2), lower: +(mid - 2 * std).toFixed(2) };
}

export function calcATR(candles, period = 14) {
  if (candles.length < 2) return 0;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const prev = candles[i - 1];
    trs.push(Math.max(c.h - c.l, Math.abs(c.h - prev.c), Math.abs(c.l - prev.c)));
  }
  const slice = trs.slice(-period);
  return +(slice.reduce((a, b) => a + b, 0) / slice.length).toFixed(2);
}

export function calcStochastic(candles, period = 14) {
  if (candles.length < period) return 50;
  const slice = candles.slice(-period);
  const low = Math.min(...slice.map(c => c.l));
  const high = Math.max(...slice.map(c => c.h));
  const close = slice[slice.length - 1].c;
  if (high === low) return 50;
  return +(((close - low) / (high - low)) * 100).toFixed(1);
}

export function calcSupportResistance(candles, lookback = 20) {
  if (!candles.length) return { support: 0, resistance: 0 };
  const slice = candles.slice(-lookback);
  const lows = slice.map(c => c.l);
  const highs = slice.map(c => c.h);
  return {
    support: +Math.min(...lows).toFixed(2),
    resistance: +Math.max(...highs).toFixed(2),
  };
}

export function calcLiquidity(candles) {
  const vols = candles.map((c) => c.vol).filter((v) => v > 0);
  if (vols.length < 5) {
    return { ratio: 1, label: 'Unknown', high: false, low: false };
  }
  const avg = vols.reduce((a, b) => a + b, 0) / vols.length;
  const recent = vols.slice(-5);
  const recentAvg = recent.reduce((a, b) => a + b, 0) / recent.length;
  const ratio = +(recentAvg / avg).toFixed(2);
  return {
    ratio,
    label: ratio >= 1.25 ? 'High' : ratio <= 0.75 ? 'Low' : 'Normal',
    high: ratio >= 1.25,
    low: ratio <= 0.75,
  };
}

/**
 * Intraday session metrics from timestamped candles (needs `ts` in ms):
 *  - vwap: volume-weighted average price for the current IST trading day
 *  - orHigh/orLow: the opening-range (first `openMinutes`) high/low
 *  - orReady: true once at least one bar has printed after the opening range
 * Returns null for candle sets without timestamps (e.g. daily bars).
 */
export function calcIntradaySession(candles = [], openMinutes = 15, barMinutes = 5) {
  const last = candles[candles.length - 1];
  if (!last || last.ts == null) return null;
  const dayKey = (ts) => new Date(ts).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const today = dayKey(last.ts);
  const session = candles.filter((c) => c.ts != null && dayKey(c.ts) === today);
  if (!session.length) return null;

  let pv = 0;
  let vol = 0;
  for (const c of session) {
    const tp = (c.h + c.l + c.c) / 3;
    const v = c.vol || 0;
    pv += tp * v;
    vol += v;
  }
  const vwap = vol > 0
    ? +(pv / vol).toFixed(2)
    : +(session.reduce((s, c) => s + c.c, 0) / session.length).toFixed(2);

  const orBars = Math.max(1, Math.round(openMinutes / barMinutes));
  const orCandles = session.slice(0, orBars);
  const orHigh = +Math.max(...orCandles.map((c) => c.h)).toFixed(2);
  const orLow = +Math.min(...orCandles.map((c) => c.l)).toFixed(2);

  return { vwap, orHigh, orLow, orReady: session.length > orBars, bars: session.length };
}

/**
 * Fair Value Gap (FVG) detection — a 3-candle imbalance pattern used in
 * price-action / ICT trading.
 *
 *  - Bullish FVG: candle[i-1].high < candle[i+1].low. The untouched space
 *    between them (bottom = prev high, top = next low) acts as a demand zone —
 *    price often revisits it before continuing up → BUY interest.
 *  - Bearish FVG: candle[i-1].low > candle[i+1].high. The gap (top = prev low,
 *    bottom = next high) acts as a supply zone → SELL interest.
 *
 * A zone is "filled" (mitigated) once a later candle trades fully back through
 * the far edge of the gap. `index` is the middle candle's index in `candles`.
 *
 * @returns {Array<{type:'bullish'|'bearish', top:number, bottom:number, mid:number,
 *   index:number, gap:number, gapPct:number, filled:boolean, touched:boolean, ts?:number, t?:string}>}
 */
export function detectFVG(candles = [], { lookback = 80, minGapPct = 0.03, maxZones = 8 } = {}) {
  const n = candles.length;
  if (n < 3) return [];
  const startScan = Math.max(1, n - lookback);
  const zones = [];

  for (let i = startScan; i < n - 1; i++) {
    const prev = candles[i - 1];
    const next = candles[i + 1];
    const mid = candles[i];
    const ref = mid.c || mid.o || 1;

    if (prev.h < next.l) {
      const bottom = prev.h;
      const top = next.l;
      const gap = top - bottom;
      const gapPct = (gap / ref) * 100;
      if (gapPct >= minGapPct) {
        zones.push({ type: 'bullish', top: +top.toFixed(2), bottom: +bottom.toFixed(2), mid: +ref.toFixed(2), index: i, gap: +gap.toFixed(2), gapPct: +gapPct.toFixed(3), ts: mid.ts, t: mid.t });
      }
    } else if (prev.l > next.h) {
      const top = prev.l;
      const bottom = next.h;
      const gap = top - bottom;
      const gapPct = (gap / ref) * 100;
      if (gapPct >= minGapPct) {
        zones.push({ type: 'bearish', top: +top.toFixed(2), bottom: +bottom.toFixed(2), mid: +ref.toFixed(2), index: i, gap: +gap.toFixed(2), gapPct: +gapPct.toFixed(3), ts: mid.ts, t: mid.t });
      }
    }
  }

  for (const z of zones) {
    let filled = false;
    let touched = false;
    for (let j = z.index + 2; j < n; j++) {
      const cc = candles[j];
      if (cc.l <= z.top && cc.h >= z.bottom) touched = true;
      if (z.type === 'bullish' && cc.l <= z.bottom) { filled = true; break; }
      if (z.type === 'bearish' && cc.h >= z.top) { filled = true; break; }
    }
    z.filled = filled;
    z.touched = touched;
  }

  return zones.slice(-maxZones);
}

/**
 * Turns detected FVG zones into a single actionable BUY/SELL bias.
 *  - Price currently inside an unfilled bullish gap → BUY (demand retest).
 *  - Price currently inside an unfilled bearish gap → SELL (supply retest).
 *  - Otherwise the newest unfilled gap sets the directional bias (buy/sell on retest).
 * Returns null when there is no fresh (unfilled) gap to act on.
 */
export function fvgSignal(zones = [], price) {
  if (!zones.length || !price) return null;
  const fresh = zones.filter((z) => !z.filled);
  if (!fresh.length) return null;

  const inBull = [...fresh].reverse().find((z) => z.type === 'bullish' && price >= z.bottom && price <= z.top);
  const inBear = [...fresh].reverse().find((z) => z.type === 'bearish' && price >= z.bottom && price <= z.top);
  if (inBull) return { type: 'BUY', status: 'inside', zone: inBull, reason: `Price trading inside bullish FVG ${inBull.bottom}–${inBull.top} (demand imbalance) — long bias` };
  if (inBear) return { type: 'SELL', status: 'inside', zone: inBear, reason: `Price trading inside bearish FVG ${inBear.bottom}–${inBear.top} (supply imbalance) — short bias` };

  const newest = fresh[fresh.length - 1];
  if (newest.type === 'bullish') return { type: 'BUY', status: 'formed', zone: newest, reason: `Bullish FVG formed ${newest.bottom}–${newest.top} — buy on retest of the gap` };
  return { type: 'SELL', status: 'formed', zone: newest, reason: `Bearish FVG formed ${newest.bottom}–${newest.top} — sell on retest of the gap` };
}

export function analyzeFromCandles(candles) {
  const closes = candles.map(c => c.c);
  const rsi = calcRSI(closes);
  const macd = calcMACD(closes);
  const bb = calcBollinger(closes);
  const ema20 = calcEMA(closes, 20);
  const ema50 = calcEMA(closes, 50);
  const price = closes[closes.length - 1] ?? 0;
  const atr = calcATR(candles);
  const stoch = calcStochastic(candles);
  const sr = calcSupportResistance(candles);
  const liquidity = calcLiquidity(candles);
  const fvgZones = detectFVG(candles);
  const fvgSig = fvgSignal(fvgZones, price);
  const ema20v = ema20[ema20.length - 1];
  const ema50v = ema50[ema50.length - 1];

  let emaSig = 'Neutral';
  let emaAction = 'HOLD';
  if (price > ema20v && price > ema50v) { emaSig = 'Price above 20 & 50 EMA'; emaAction = 'BUY'; }
  else if (price < ema20v && price < ema50v) { emaSig = 'Price below 20 & 50 EMA'; emaAction = 'SELL'; }

  let bbSig = 'Mid-band';
  let bbAction = 'HOLD';
  if (price <= bb.lower) { bbSig = 'At lower band (oversold zone)'; bbAction = 'BUY'; }
  else if (price >= bb.upper) { bbSig = 'At upper band (overbought zone)'; bbAction = 'SELL'; }

  return {
    rsi,
    rsiHist: calcRSIHistory(closes),
    macdHist: calcMACDHistory(closes),
    macd,
    bb,
    ema20: ema20v,
    ema50: ema50v,
    atr,
    stoch,
    sr,
    liquidity,
    fvg: { zones: fvgZones, signal: fvgSig },
    session: calcIntradaySession(candles),
    price,
    summary: [
      { n: 'RSI (14)', v: rsi.toFixed(1), sig: rsi > 70 ? 'Overbought' : rsi < 30 ? 'Oversold' : 'Neutral', t: rsi > 70 ? 'SELL' : rsi < 30 ? 'BUY' : 'HOLD' },
      { n: 'MACD', v: macd.h.toFixed(2), sig: macd.h > 0 ? 'Bullish crossover' : 'Bearish crossover', t: macd.h > 0 ? 'BUY' : 'SELL' },
      { n: 'EMA 20/50', v: price > ema20v ? 'Above' : 'Below', sig: emaSig, t: emaAction },
      { n: 'Bollinger Bands', v: price > bb.mid ? 'Upper half' : 'Lower half', sig: bbSig, t: bbAction },
      { n: 'Stochastic', v: stoch.toFixed(0), sig: stoch > 80 ? 'Overbought' : stoch < 20 ? 'Oversold' : 'Neutral momentum', t: stoch > 80 ? 'SELL' : stoch < 20 ? 'BUY' : 'HOLD' },
      { n: 'ATR', v: atr.toFixed(2), sig: 'Intraday volatility measure', t: 'HOLD' },
      { n: 'Support', v: sr.support.toFixed(2), sig: 'Recent swing low', t: 'HOLD' },
      { n: 'Resistance', v: sr.resistance.toFixed(2), sig: 'Recent swing high', t: 'HOLD' },
      {
        n: 'Fair Value Gap',
        v: fvgSig ? `${fvgSig.zone.bottom}–${fvgSig.zone.top}` : (fvgZones.length ? `${fvgZones.length} zones` : 'None'),
        sig: fvgSig ? (fvgSig.status === 'inside' ? `Price inside ${fvgSig.zone.type} gap` : `${fvgSig.zone.type} gap formed`) : 'No unfilled imbalance',
        t: fvgSig ? fvgSig.type : 'HOLD',
      },
    ],
  };
}
