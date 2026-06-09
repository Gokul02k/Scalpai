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

export function getScalpingSuggestion(analysis, chgPct) {
  const base = getOverallSuggestion(analysis, chgPct);
  return {
    ...base,
    detail: 'Scalping suggestion only — quick in-and-out on your broker (e.g. Groww) if you agree.',
  };
}

export function getMarketSuggestion(analysis, chgPct) {
  const base = getOverallSuggestion(analysis, chgPct);
  return {
    ...base,
    detail: 'Market-based buy/sell view — not a scalping call. Use for swing or investment timing on your broker.',
  };
}

export function getWatchlistMarketSuggestion(symbol, quote) {
  const pct = quote?.changePercent ?? 0;
  const price = quote?.current;
  if (!price) {
    return { action: 'WAIT', label: 'Loading…', reason: 'Fetching live price…', confidence: 0, detail: '' };
  }
  if (pct >= 2) {
    return {
      action: 'SELL',
      label: 'Avoid fresh buy',
      reason: `${symbol} up ${pct}% today — extended move, wait for pullback`,
      confidence: 58,
      detail: 'Market momentum suggestion based on today\'s price action.',
    };
  }
  if (pct <= -2) {
    return {
      action: 'BUY',
      label: 'Watch for entry',
      reason: `${symbol} down ${Math.abs(pct)}% today — possible dip if trend intact`,
      confidence: 58,
      detail: 'Market momentum suggestion based on today\'s price action.',
    };
  }
  if (pct >= 0.8) {
    return {
      action: 'HOLD',
      label: 'Hold / wait',
      reason: `${symbol} mildly up (${pct}%) — no strong edge to chase`,
      confidence: 45,
      detail: 'Neutral — wait for clearer move.',
    };
  }
  if (pct <= -0.8) {
    return {
      action: 'BUY',
      label: 'Mild buy bias',
      reason: `${symbol} slightly weak (${pct}%) — may offer better entry`,
      confidence: 50,
      detail: 'Market momentum suggestion based on today\'s price action.',
    };
  }
  return {
    action: 'HOLD',
    label: 'Hold — flat day',
    reason: `${symbol} at ₹${price.toLocaleString('en-IN')} · today ${pct >= 0 ? '+' : ''}${pct}%`,
    confidence: 40,
    detail: 'No strong buy or sell signal from today\'s move.',
  };
}

export function getMoveTitle(assetName, direction) {
  if (direction === 'down') return `${assetName} is falling today`;
  if (direction === 'up') return `${assetName} is rising today`;
  return `${assetName} is trading flat today`;
}

function filterNewsForAsset(newsItems, assetName) {
  const name = assetName.toUpperCase();
  if (name === 'NIFTY') {
    return newsItems.filter((n) => {
      const h = (n.headline || '').toLowerCase();
      return /nifty|sensex|index|fii|fpi|market|bank nifty|rbi|repo/.test(h)
        || (n.stocks || []).some((s) => /NIFTY|SENSEX|BANK/.test(s));
    });
  }
  if (name === 'GOLD') {
    return newsItems.filter((n) => {
      const h = (n.headline || '').toLowerCase();
      return /gold|bullion|precious|xau|jewellery|jewelry|safe.?haven/.test(h);
    });
  }
  if (name === 'SILVER') {
    return newsItems.filter((n) => {
      const h = (n.headline || '').toLowerCase();
      return /silver|xag|precious|industrial metal/.test(h);
    });
  }
  return newsItems;
}

export function explainAssetMove(price, newsItems = [], assetName = 'NIFTY') {
  if (!price?.cur) {
    return { direction: 'flat', title: `${assetName} — loading…`, summary: 'Market data loading…', reasons: [] };
  }

  const chg = price.cur - price.prev;
  const pct = price.prev ? (chg / price.prev) * 100 : 0;
  const direction = pct > 0.15 ? 'up' : pct < -0.15 ? 'down' : 'flat';
  const title = getMoveTitle(assetName, direction);

  const relevant = filterNewsForAsset(newsItems, assetName);
  const reasons = [];
  const neg = relevant.filter((n) => n.sentiment === 'negative').slice(0, 2);
  const pos = relevant.filter((n) => n.sentiment === 'positive').slice(0, 2);

  if (direction === 'down') {
    if (neg.length) neg.forEach((n) => reasons.push(n.headline));
    else if (assetName === 'GOLD') reasons.push('Strong dollar / higher US yields pressuring gold', 'Profit booking in gold ETFs');
    else if (assetName === 'SILVER') reasons.push('Industrial demand concerns weigh on silver', 'Risk-off sentiment in base metals');
    else reasons.push('Profit booking and weak global cues', 'Sector rotation out of heavyweights');
    if (pct < -0.5) reasons.unshift(`${assetName} down ${Math.abs(pct).toFixed(2)}% — selling pressure dominates`);
  } else if (direction === 'up') {
    if (pos.length) pos.forEach((n) => reasons.push(n.headline));
    else if (assetName === 'GOLD') reasons.push('Safe-haven demand supports gold', 'Weaker dollar / geopolitical uncertainty');
    else if (assetName === 'SILVER') reasons.push('Industrial demand and gold co-movement lift silver', 'Risk-on sentiment in commodities');
    else reasons.push('FII inflows and positive sector momentum', 'Short covering rally');
    if (pct > 0.5) reasons.unshift(`${assetName} up ${pct.toFixed(2)}% — buyers in control`);
  } else {
    if (assetName === 'GOLD') reasons.push('Gold consolidating — watch USD and Fed commentary', 'Range-bound ahead of macro data');
    else if (assetName === 'SILVER') reasons.push('Silver range-bound — tracking gold and industrial cues', 'No clear directional catalyst');
    else reasons.push('Range-bound session — no clear directional catalyst', 'Wait for breakout above resistance or break below support');
  }

  const chgStr = assetName === 'NIFTY'
    ? `${Math.abs(chg).toFixed(0)} pts (${pct.toFixed(2)}%)`
    : `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`;

  const summary =
    direction === 'down'
      ? `${assetName} is down ${chgStr} today. Likely drivers: ${reasons.slice(0, 2).join('; ')}.`
      : direction === 'up'
        ? `${assetName} is up ${chgStr} today. Likely drivers: ${reasons.slice(0, 2).join('; ')}.`
        : `${assetName} is flat (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%). ${reasons[0] || 'Consolidating with no strong trend.'}`;

  return { direction, title, summary, reasons: reasons.slice(0, 4), pct, chg };
}

/** @deprecated use explainAssetMove */
export function explainNiftyMove(niftyPrice, newsItems = []) {
  return explainAssetMove(niftyPrice, newsItems, 'NIFTY');
}

export function getStockSuggestion(stock, settings = { profitPct: 1.5, slPct: 0.8 }) {
  if (!stock?.cur || !stock?.buy) {
    return { action: 'WAIT', label: 'Loading…', reason: 'Waiting for live price.', confidence: 0 };
  }
  const chgPct = +(((stock.cur - stock.buy) / stock.buy) * 100).toFixed(2);
  const dayPct = stock.prev
    ? +(((stock.cur - stock.prev) / stock.prev) * 100).toFixed(2)
    : 0;

  if (chgPct <= -5) {
    return {
      action: 'BUY',
      label: 'Accumulate on dip',
      reason: `Down ${Math.abs(chgPct)}% from your avg ₹${stock.buy} — consider adding if fundamentals intact`,
      confidence: 65,
      detail: 'Suggestion only — verify on your broker before buying more.',
    };
  }
  if (chgPct >= settings.profitPct) {
    return {
      action: 'SELL',
      label: 'Book partial profit',
      reason: `Up ${chgPct}% from avg — near your ${settings.profitPct}% profit target`,
      confidence: 70,
      detail: 'Suggestion only — consider trimming on your broker.',
    };
  }
  if (chgPct <= -settings.slPct) {
    return {
      action: 'SELL',
      label: 'Review stop loss',
      reason: `Down ${Math.abs(chgPct)}% — exceeds ${settings.slPct}% loss threshold from avg`,
      confidence: 72,
      detail: 'Suggestion only — review whether to cut or hold.',
    };
  }
  if (dayPct >= 1.5) {
    return {
      action: 'SELL',
      label: 'Short-term strength — trim?',
      reason: `Up ${dayPct}% today — momentum may fade; consider partial booking`,
      confidence: 55,
      detail: 'Intraday strength — not a forced sell.',
    };
  }
  if (dayPct <= -1.5) {
    return {
      action: 'BUY',
      label: 'Watch for entry',
      reason: `Down ${Math.abs(dayPct)}% today — may be a dip if trend intact`,
      confidence: 55,
      detail: 'Wait for confirmation before adding.',
    };
  }
  return {
    action: 'HOLD',
    label: 'Hold — no clear edge',
    reason: `P&L ${chgPct >= 0 ? '+' : ''}${chgPct}% from avg · today ${dayPct >= 0 ? '+' : ''}${dayPct}%`,
    confidence: 45,
    detail: 'No strong buy or sell signal on this stock right now.',
  };
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
