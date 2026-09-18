export function generateIndexSignals(analysis, price, instrument, settings) {
  const { rsi, macd, bb, sr, stoch, atr, fvg } = analysis;
  const pt = settings.profitPct / 100;
  const sl = settings.slPct / 100;
  const signals = [];

  const add = (type, str, reason, prob, opts = {}) => {
    const buy = type === 'BUY';
    const target = +(price * (buy ? 1 + pt : 1 - pt)).toFixed(2);
    const stopLoss = +(price * (buy ? 1 - sl : 1 + sl)).toFixed(2);
    const rr = (Math.abs(target - price) / Math.abs(price - stopLoss)).toFixed(1);
    signals.push({ type, str, reason, prob, instrument, target, stopLoss, rr, scope: 'index', ...opts });
  };

  // Fair Value Gap: price-action imbalance. Fires independently of the
  // momentum ladder below so an FVG retest can stand on its own.
  const fvgSig = fvg?.signal;
  if (fvgSig) {
    const z = fvgSig.zone;
    const inside = fvgSig.status === 'inside';
    add(
      fvgSig.type,
      inside ? 'STRONG' : 'MODERATE',
      fvgSig.reason,
      inside ? 68 : 60,
      { tag: 'FVG', fvgZone: { type: z.type, top: z.top, bottom: z.bottom } },
    );
  }

  if (rsi < 30 && macd.h > 0) add('BUY', 'STRONG', `RSI oversold (${rsi}) + MACD turning bullish + near support ₹${sr.support}`, 72);
  else if (rsi < 35) add('BUY', 'MODERATE', `RSI ${rsi} approaching oversold + price near support`, 62);
  else if (rsi > 70 && macd.h < 0) add('SELL', 'STRONG', `RSI overbought (${rsi}) + MACD bearish + near resistance ₹${sr.resistance}`, 70);
  else if (rsi > 65) add('SELL', 'MODERATE', `RSI ${rsi} elevated + stochastic ${stoch}`, 58);
  else if (price <= bb.lower * 1.002) add('BUY', 'MODERATE', `Price at lower Bollinger band (₹${bb.lower}) + ATR ${atr}`, 64);
  else if (price >= bb.upper * 0.998) add('SELL', 'MODERATE', `Price at upper Bollinger band (₹${bb.upper})`, 63);
  else if (macd.h > 0 && rsi >= 40 && rsi <= 60) add('BUY', 'WEAK', `MACD bullish (${macd.h}) with neutral RSI — scalp long bias`, 54);

  return signals.slice(0, 3);
}

export function generatePortfolioSignals(portfolio, settings) {
  const signals = [];
  const pt = settings.profitPct / 100;
  const sl = settings.slPct / 100;

  for (const s of portfolio) {
    const chgPct = ((s.cur - s.buy) / s.buy) * 100;
    const buy = s.cur <= s.buy * 0.97;
    const sell = s.cur >= s.buy * (1 + pt) || chgPct <= -settings.slPct;

    if (buy) {
      signals.push({
        type: 'BUY',
        str: 'ACCUMULATE',
        reason: `${s.name} down ${Math.abs(chgPct).toFixed(1)}% from avg — add on dip near ₹${s.cur}`,
        prob: 61,
        instrument: s.name,
        target: +(s.cur * (1 + pt)).toFixed(2),
        stopLoss: +(s.cur * (1 - sl)).toFixed(2),
        scope: 'portfolio',
      });
    }
    if (sell && chgPct > 0) {
      signals.push({
        type: 'SELL',
        str: 'TAKE PROFIT',
        reason: `${s.name} up ${chgPct.toFixed(1)}% — near your ${settings.profitPct}% target`,
        prob: 68,
        instrument: s.name,
        target: s.cur,
        stopLoss: +(s.cur * (1 - sl)).toFixed(2),
        scope: 'portfolio',
      });
    } else if (chgPct <= -settings.slPct) {
      signals.push({
        type: 'SELL',
        str: 'STOP LOSS',
        reason: `${s.name} down ${Math.abs(chgPct).toFixed(1)}% — exceeds ${settings.slPct}% stop`,
        prob: 75,
        instrument: s.name,
        target: s.cur,
        stopLoss: s.cur,
        scope: 'portfolio',
      });
    }
  }
  return signals;
}

/* `parsePortfolioCSV` lived here, and read a broker export into holdings behind
 * an "Import stocks from CSV" button on the Portfolio tab. Both are gone.
 *
 * Rows it created are not. It wrote holdings with no `type` field at all, and
 * those are still sitting in saved portfolios — which is why `holdingType` in
 * page.js still has to normalise a missing type rather than trusting the two
 * values the app now writes. Removing the importer does not remove what it
 * imported. */
