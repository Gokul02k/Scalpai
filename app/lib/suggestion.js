/** Overall BUY / SELL / HOLD suggestion from technical analysis (suggestions only — no trading). */
export function getOverallSuggestion(analysis, chgPct) {
  if (!analysis) {
    return {
      action: 'WAIT',
      label: 'Analyzing…',
      reason: 'Loading chart data to generate a suggestion.',
      confidence: 0,
    };
  }

  let buyScore = 0;
  let sellScore = 0;
  const reasons = [];

  if (analysis.rsi < 30) {
    buyScore += 3;
    reasons.push(`RSI oversold at ${analysis.rsi}`);
  } else if (analysis.rsi < 40) {
    buyScore += 1;
    reasons.push(`RSI low at ${analysis.rsi}`);
  } else if (analysis.rsi > 70) {
    sellScore += 3;
    reasons.push(`RSI overbought at ${analysis.rsi}`);
  } else if (analysis.rsi > 60) {
    sellScore += 1;
    reasons.push(`RSI elevated at ${analysis.rsi}`);
  }

  if (analysis.macd.h > 0) {
    buyScore += 2;
    reasons.push('MACD bullish');
  } else {
    sellScore += 2;
    reasons.push('MACD bearish');
  }

  for (const row of analysis.summary) {
    if (row.t === 'BUY') buyScore += 1;
    if (row.t === 'SELL') sellScore += 1;
  }

  if (chgPct <= -0.5) sellScore += 1;
  if (chgPct >= 0.5) buyScore += 1;

  const confidence = Math.min(85, 50 + Math.abs(buyScore - sellScore) * 8);

  if (buyScore > sellScore + 1) {
    return {
      action: 'BUY',
      label: 'Better to BUY now',
      reason: reasons.slice(0, 3).join(' · ') || 'Technical indicators lean bullish',
      confidence,
      detail: 'Suggestion only — execute on your broker (e.g. Groww) if you agree.',
    };
  }
  if (sellScore > buyScore + 1) {
    return {
      action: 'SELL',
      label: 'Better to SELL / avoid fresh buys',
      reason: reasons.slice(0, 3).join(' · ') || 'Technical indicators lean bearish',
      confidence,
      detail: 'Suggestion only — consider booking profits or waiting on your broker.',
    };
  }
  return {
    action: 'HOLD',
    label: 'HOLD — wait for clearer signal',
    reason: reasons.length ? reasons.slice(0, 2).join(' · ') : 'Mixed signals — no strong edge right now',
    confidence: Math.max(40, confidence - 15),
    detail: 'No strong buy or sell edge. Watch signals below or wait for RSI/MACD alignment.',
  };
}

export function explainNiftyMove(niftyPrice, newsItems = []) {
  if (!niftyPrice?.cur) return { direction: 'flat', summary: 'Market data loading…', reasons: [] };

  const chg = niftyPrice.cur - niftyPrice.prev;
  const pct = niftyPrice.prev ? (chg / niftyPrice.prev) * 100 : 0;
  const direction = pct > 0.15 ? 'up' : pct < -0.15 ? 'down' : 'flat';

  const reasons = [];
  const neg = newsItems.filter((n) => n.sentiment === 'negative').slice(0, 2);
  const pos = newsItems.filter((n) => n.sentiment === 'positive').slice(0, 2);

  if (direction === 'down') {
    if (neg.length) neg.forEach((n) => reasons.push(n.headline));
    else reasons.push('Profit booking and weak global cues', 'Sector rotation out of heavyweights');
    if (pct < -0.5) reasons.unshift(`NIFTY down ${Math.abs(pct).toFixed(2)}% — selling pressure dominates`);
  } else if (direction === 'up') {
    if (pos.length) pos.forEach((n) => reasons.push(n.headline));
    else reasons.push('FII inflows and positive sector momentum', 'Short covering rally');
    if (pct > 0.5) reasons.unshift(`NIFTY up ${pct.toFixed(2)}% — buyers in control`);
  } else {
    reasons.push('Range-bound session — no clear directional catalyst', 'Wait for breakout above resistance or break below support');
  }

  const summary =
    direction === 'down'
      ? `NIFTY is down ${Math.abs(chg).toFixed(0)} pts (${pct.toFixed(2)}%) today. Likely drivers: ${reasons.slice(0, 2).join('; ')}.`
      : direction === 'up'
        ? `NIFTY is up ${chg.toFixed(0)} pts (${pct.toFixed(2)}%) today. Likely drivers: ${reasons.slice(0, 2).join('; ')}.`
        : `NIFTY is flat (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%). Market is consolidating — no strong trend yet.`;

  return { direction, summary, reasons: reasons.slice(0, 4), pct, chg };
}

export function newsMarketImpact(item) {
  const h = (item.headline || '').toLowerCase();
  const sent = item.sentiment;

  if (/rbi|repo rate|interest rate|mpc/.test(h)) {
    return sent === 'negative'
      ? 'Bearish for banks short-term; NIFTY may see 0.3–0.8% pressure if rate hike fears persist.'
      : 'Supportive for rate-sensitive sectors (auto, realty); NIFTY banks may rally.';
  }
  if (/fii|foreign|inflow|outflow/.test(h)) {
    return sent === 'positive'
      ? 'Bullish for NIFTY — FII buying typically lifts index heavyweights.'
      : 'Bearish near-term — FII selling often drags NIFTY and BANK NIFTY.';
  }
  if (/crude|oil|opec/.test(h)) {
    return 'Mixed for India: energy stocks up, but inflation fears can hurt broader NIFTY.';
  }
  if (/earnings|quarter|revenue|profit|guidance/.test(h)) {
    return sent === 'negative'
      ? 'Negative for IT/large-cap earnings sentiment; may weigh on NIFTY.'
      : 'Positive earnings surprise supports index; sector peers may follow.';
  }
  if (/bank|credit|npa/.test(h)) {
    return sent === 'positive'
      ? 'BANK NIFTY positive; NIFTY gets ~30% weight from financials.'
      : 'Banking weakness typically pulls NIFTY down 0.2–0.5%.';
  }
  if (/global|fed|us |china|war/.test(h)) {
    return sent === 'negative'
      ? 'Risk-off globally — NIFTY often opens gap-down on such headlines.'
      : 'Global risk-on supports emerging markets including India.';
  }
  if (sent === 'positive') return 'Mildly bullish — supports positive sentiment in related stocks and index.';
  if (sent === 'negative') return 'Mildly bearish — may add selling pressure in related sectors.';
  return 'Neutral headline — limited direct NIFTY impact unless volume spikes.';
}
