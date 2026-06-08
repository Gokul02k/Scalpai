export function generateIndexSignals(analysis, price, instrument, settings) {
  const { rsi, macd, bb, sr, stoch, atr } = analysis;
  const pt = settings.profitPct / 100;
  const sl = settings.slPct / 100;
  const signals = [];

  const add = (type, str, reason, prob) => {
    const buy = type === 'BUY';
    const target = +(price * (buy ? 1 + pt : 1 - pt)).toFixed(2);
    const stopLoss = +(price * (buy ? 1 - sl : 1 + sl)).toFixed(2);
    const rr = (Math.abs(target - price) / Math.abs(price - stopLoss)).toFixed(1);
    signals.push({ type, str, reason, prob, instrument, target, stopLoss, rr, scope: 'index' });
  };

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

export function parsePortfolioCSV(text) {
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map(h => h.trim().toLowerCase().replace(/"/g, ''));
  const nameIdx = headers.findIndex(h => /symbol|name|stock|instrument/.test(h));
  const qtyIdx = headers.findIndex(h => /qty|quantity|shares/.test(h));
  const priceIdx = headers.findIndex(h => /price|buy|avg|cost|entry/.test(h));
  const sectorIdx = headers.findIndex(h => /sector/.test(h));
  if (nameIdx < 0 || qtyIdx < 0) return [];

  return lines.slice(1).map((line, i) => {
    const cols = line.split(',').map(c => c.trim().replace(/"/g, ''));
    const name = cols[nameIdx]?.toUpperCase();
    const qty = +cols[qtyIdx] || 1;
    const buy = priceIdx >= 0 ? (+cols[priceIdx] || 0) : 0;
    const sector = sectorIdx >= 0 ? cols[sectorIdx] : 'Other';
    if (!name) return null;
    return { id: Date.now() + i, name, qty, buy, cur: buy || 100, sector };
  }).filter(Boolean);
}
