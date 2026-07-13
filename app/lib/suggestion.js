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
  return getOverallSuggestion(analysis, chgPct);
}

export function getMarketSuggestion(analysis, chgPct) {
  return getOverallSuggestion(analysis, chgPct);
}

const STRENGTH_W = { STRONG: 3, MODERATE: 2, WEAK: 1 };

function analyzeSRFactors(price, analysis) {
  const { sr, atr = 0 } = analysis;
  if (!sr?.support || !sr?.resistance || !price) return [];

  const range = sr.resistance - sr.support || 1;
  const distSupport = price - sr.support;
  const distResistance = sr.resistance - price;
  const nearBand = Math.max(atr * 0.6, range * 0.06);
  const factors = [];

  if (distSupport <= nearBand) {
    factors.push({
      type: 'BUY',
      name: 'Support zone',
      reason: `Price at/near support ₹${sr.support.toLocaleString('en-IN')} — bounce zone`,
      weight: 4,
    });
  } else if (distResistance <= nearBand) {
    factors.push({
      type: 'SELL',
      name: 'Resistance zone',
      reason: `Price at/near resistance ₹${sr.resistance.toLocaleString('en-IN')} — rejection zone`,
      weight: 4,
    });
  } else {
    const pos = distSupport / range;
    if (pos < 0.35) {
      factors.push({
        type: 'BUY',
        name: 'Support zone',
        reason: `Lower range — support ₹${sr.support.toLocaleString('en-IN')}, resistance ₹${sr.resistance.toLocaleString('en-IN')}`,
        weight: 2,
      });
    } else if (pos > 0.65) {
      factors.push({
        type: 'SELL',
        name: 'Resistance zone',
        reason: `Upper range — resistance ₹${sr.resistance.toLocaleString('en-IN')}, support ₹${sr.support.toLocaleString('en-IN')}`,
        weight: 2,
      });
    } else {
      factors.push({
        type: 'HOLD',
        name: 'S/R mid-range',
        reason: `Mid-range between support ₹${sr.support.toLocaleString('en-IN')} and resistance ₹${sr.resistance.toLocaleString('en-IN')}`,
        weight: 1,
      });
    }
  }
  return factors;
}

function analyzeLiquidityFactor(liquidity) {
  if (!liquidity) return null;
  const pct = Math.round(liquidity.ratio * 100);
  if (liquidity.high) {
    return {
      type: 'BUY',
      name: 'Liquidity',
      reason: `Volume ${pct}% of average — strong participation supports the move`,
      weight: 2,
    };
  }
  if (liquidity.low) {
    return {
      type: 'HOLD',
      name: 'Liquidity',
      reason: `Volume only ${pct}% of average — thin liquidity, signals less reliable`,
      weight: 2,
    };
  }
  return {
    type: 'HOLD',
    name: 'Liquidity',
    reason: `Normal volume (${pct}% of average) — adequate liquidity`,
    weight: 1,
  };
}

function collectFactors(analysis, indexSignals = [], { niftyScalp = false } = {}) {
  const factors = [];

  if (niftyScalp && analysis) {
    factors.push(...analyzeSRFactors(analysis.price, analysis));
    const liq = analyzeLiquidityFactor(analysis.liquidity);
    if (liq) factors.push(liq);
  }

  for (const row of analysis?.summary || []) {
    if (/^support$|^resistance$/i.test(row.n)) continue;
    if (!niftyScalp && row.t === 'HOLD' && /atr/i.test(row.n)) continue;
    factors.push({ type: row.t, name: row.n, reason: `${row.sig} · ${row.v}`, weight: 1 });
  }

  if (!niftyScalp) {
    for (const sig of indexSignals) {
      factors.push({
        type: sig.type,
        name: `${sig.str} setup`,
        reason: sig.reason,
        weight: STRENGTH_W[sig.str] || 1,
      });
    }
  }

  return factors;
}

function voteFromFactors(factors, chgPct, mode) {
  let buyW = 0;
  let sellW = 0;
  let holdPenalty = 0;
  for (const f of factors) {
    const w = f.weight ?? STRENGTH_W[f.name?.split(' ')[0]] ?? 1;
    if (f.type === 'BUY') buyW += w;
    if (f.type === 'SELL') sellW += w;
    if (f.type === 'HOLD' && f.name === 'Liquidity' && f.reason?.includes('thin')) holdPenalty += 1;
  }
  const chgW = mode === 'longterm' ? 0.3 : 1;
  if (chgPct >= 0.5) buyW += chgW;
  if (chgPct <= -0.5) sellW += chgW;

  if (mode === 'longterm' && factors.length) {
    const ema = factors.find((f) => f.name === 'EMA 20/50');
    if (ema?.type === 'BUY') buyW += 2;
    if (ema?.type === 'SELL') sellW += 2;
  }

  const margin = buyW - sellW;
  let action = 'HOLD';
  const threshold = mode === 'scalp' ? 2 : 2;
  if (margin >= threshold) action = 'BUY';
  else if (margin <= -threshold) action = 'SELL';
  if (holdPenalty >= 1 && action !== 'HOLD') {
    action = 'HOLD';
  }

  const total = buyW + sellW || 1;
  const agreement = Math.abs(margin) / total;
  let confidence = Math.round(Math.min(90, 42 + agreement * 35 + Math.abs(margin) * 4));
  if (action === 'HOLD') confidence = Math.max(38, confidence - 12);
  if (holdPenalty && action === 'HOLD') confidence = Math.max(35, confidence - 5);

  return { action, buyW, sellW, confidence };
}

function tradeLevels(price, action, mode, settings = {}, analysis = null) {
  if (!price || action === 'HOLD' || action === 'WAIT') {
    return { entry: price, target: null, stopLoss: null, rr: null };
  }
  const profitPct = settings.profitPct ?? 1.5;
  const slPct = settings.slPct ?? 0.8;
  const pt = mode === 'longterm' ? 0.1 : mode === 'swing' ? profitPct * 2.5 / 100 : profitPct / 100;
  const sl = mode === 'longterm' ? 0.06 : mode === 'swing' ? slPct * 2 / 100 : slPct / 100;
  const buy = action === 'BUY';
  const entry = +price.toFixed(2);
  let target = +(price * (buy ? 1 + pt : 1 - pt)).toFixed(2);
  let stopLoss = +(price * (buy ? 1 - sl : 1 + sl)).toFixed(2);

  if (mode === 'scalp' && analysis?.sr) {
    const { support, resistance } = analysis.sr;
    if (buy) {
      stopLoss = +Math.min(stopLoss, support * 0.999).toFixed(2);
      target = +Math.min(Math.max(target, price * (1 + pt)), resistance * 0.998).toFixed(2);
    } else {
      stopLoss = +Math.max(stopLoss, resistance * 1.001).toFixed(2);
      target = +Math.max(Math.min(target, price * (1 - pt)), support * 1.002).toFixed(2);
    }
  }
  const rr = (Math.abs(target - entry) / Math.abs(entry - stopLoss)).toFixed(1);
  return { entry, target, stopLoss, rr };
}

const FINAL_LABELS = {
  BUY: 'BUY NOW',
  SELL: 'SELL NOW',
  HOLD: 'HOLD',
  WAIT: 'ANALYZING…',
};

/** One final call + factor list + levels aligned to the final action. */
export function buildUnifiedSuggestion({
  analysis,
  price,
  chgPct = 0,
  indexSignals = [],
  settings = {},
  mode = 'scalp',
  instrument = '',
}) {
  if (!analysis || !price) {
    return {
      action: 'WAIT',
      label: FINAL_LABELS.WAIT,
      confidence: 0,
      factors: [],
      entry: null,
      target: null,
      stopLoss: null,
      rr: null,
    };
  }

  const niftyScalp = mode === 'scalp' && instrument === 'NIFTY';
  const factors = collectFactors(analysis, indexSignals, { niftyScalp });
  const { action, confidence } = voteFromFactors(factors, chgPct, mode);
  const levels = tradeLevels(price, action, mode, settings, analysis);

  return {
    action,
    label: FINAL_LABELS[action] || action,
    confidence,
    factors,
    ...levels,
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

function clampNum(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Score a stock's fundamentals into a directional bias (+ bullish / - bearish)
 * with human-readable factors. Returns { score, factors, available }.
 * Heuristics use absolute thresholds suitable for Indian large/mid caps.
 */
export function scoreFundamentals(f, price) {
  if (!f) return { score: 0, factors: [], available: false };
  let score = 0;
  const factors = [];
  const add = (type, name, reason, weight = 2) => factors.push({ type, name, reason, weight });

  if (f.trailingPE != null && f.trailingPE > 0) {
    if (f.trailingPE < 15) { score += 1; add('BUY', 'Valuation (P/E)', `Low P/E ${f.trailingPE.toFixed(1)} — attractively valued`); }
    else if (f.trailingPE > 45) { score -= 1; add('SELL', 'Valuation (P/E)', `High P/E ${f.trailingPE.toFixed(1)} — richly valued`); }
  }
  if (f.priceToBook != null && f.priceToBook > 0) {
    if (f.priceToBook < 1.5) { score += 0.5; add('BUY', 'Price/Book', `P/B ${f.priceToBook.toFixed(2)} — cheap vs book value`); }
    else if (f.priceToBook > 10) { score -= 0.5; add('SELL', 'Price/Book', `P/B ${f.priceToBook.toFixed(1)} — expensive vs book value`); }
  }
  if (f.returnOnEquity != null) {
    if (f.returnOnEquity >= 15) { score += 1; add('BUY', 'Quality (ROE)', `Strong ROE ${f.returnOnEquity}%`); }
    else if (f.returnOnEquity < 5) { score -= 0.5; add('SELL', 'Quality (ROE)', `Weak ROE ${f.returnOnEquity}%`); }
  }
  if (f.profitMargins != null) {
    if (f.profitMargins < 0) { score -= 1; add('SELL', 'Profitability', `Loss-making — net margin ${f.profitMargins}%`); }
    else if (f.profitMargins >= 15) { score += 0.5; add('BUY', 'Profitability', `Healthy net margin ${f.profitMargins}%`); }
  }
  if (f.debtToEquity != null) {
    if (f.debtToEquity > 150) { score -= 1; add('SELL', 'Leverage', `High debt/equity ${f.debtToEquity.toFixed(0)}`); }
    else if (f.debtToEquity < 40) { score += 0.5; add('BUY', 'Leverage', `Low debt/equity ${f.debtToEquity.toFixed(0)}`); }
  }
  if (f.earningsGrowth != null) {
    if (f.earningsGrowth >= 10) { score += 0.5; add('BUY', 'Earnings growth', `Earnings +${f.earningsGrowth}%`); }
    else if (f.earningsGrowth <= -10) { score -= 0.5; add('SELL', 'Earnings growth', `Earnings ${f.earningsGrowth}%`); }
  }
  if (f.revenueGrowth != null) {
    if (f.revenueGrowth >= 10) { score += 0.5; add('BUY', 'Revenue growth', `Revenue +${f.revenueGrowth}%`); }
    else if (f.revenueGrowth <= -5) { score -= 0.5; add('SELL', 'Revenue growth', `Revenue ${f.revenueGrowth}%`); }
  }
  if (f.pegRatio != null && f.pegRatio > 0 && f.pegRatio < 1) {
    score += 0.5; add('BUY', 'PEG', `PEG ${f.pegRatio.toFixed(2)} — growth at a fair price`);
  }
  if (f.targetMeanPrice != null && price) {
    const up = ((f.targetMeanPrice - price) / price) * 100;
    if (up >= 12) { score += 1; add('BUY', 'Analyst target', `~${up.toFixed(0)}% upside to avg target`); }
    else if (up <= -8) { score -= 1; add('SELL', 'Analyst target', `Trading above avg analyst target`); }
  }
  if (f.recommendationKey) {
    if (/buy/.test(f.recommendationKey)) { score += 0.5; add('BUY', 'Analyst rating', `Consensus: ${f.recommendationKey.replace(/_/g, ' ')}`); }
    else if (/sell|underperform/.test(f.recommendationKey)) { score -= 0.5; add('SELL', 'Analyst rating', `Consensus: ${f.recommendationKey.replace(/_/g, ' ')}`); }
  }

  return { score: +score.toFixed(2), factors, available: true };
}

/**
 * Portfolio holding suggestion blending live chart technicals, company
 * fundamentals (P/E, P/B, ROE, debt, growth, analyst view) and recent news —
 * NOT the user's profit/loss. Fundamentals are weighted more for long-term.
 */
export function getPortfolioSuggestion({ stock, analysis, newsItems = [], quote, fundamentals = null, settings = {}, mode = 'swing' }) {
  const price = quote?.current ?? stock?.cur ?? null;
  if (!analysis || !price) {
    return {
      action: 'WAIT',
      label: 'Analyzing…',
      confidence: 0,
      reason: 'Loading chart indicators, fundamentals and recent news…',
      detail: 'Suggestion blends technicals, fundamentals and news — not your P&L.',
      factors: [],
      newsCount: 0,
      fundamentalScore: null,
    };
  }

  const dayPct = quote?.changePercent
    ?? (stock?.prev ? +(((price - stock.prev) / stock.prev) * 100).toFixed(2) : 0);

  // 1) Technical base from indicators.
  const base = buildUnifiedSuggestion({ analysis, price, chgPct: dayPct, settings, mode });
  let action = base.action;
  let confidence = base.confidence;
  const techFactors = [...base.factors];

  // 2) Recent news sentiment.
  const recent = (newsItems || []).slice(0, 8);
  const pos = recent.filter((n) => n.sentiment === 'positive').length;
  const neg = recent.filter((n) => n.sentiment === 'negative').length;
  const newsScore = pos - neg;
  const newsFactors = [];
  if (recent.length) {
    const type = newsScore > 0 ? 'BUY' : newsScore < 0 ? 'SELL' : 'HOLD';
    newsFactors.push({
      type,
      name: 'Recent news',
      reason: `${pos} positive / ${neg} negative recent headline${recent.length === 1 ? '' : 's'}`,
      weight: 2,
    });
    if (newsScore <= -2 && action === 'BUY') { action = 'HOLD'; confidence = Math.max(40, confidence - 15); }
    else if (newsScore >= 2 && action === 'BUY') { confidence = Math.min(92, confidence + 8); }
    else if (newsScore <= -2 && action === 'SELL') { confidence = Math.min(92, confidence + 8); }
    else if (newsScore >= 2 && action === 'SELL') { action = 'HOLD'; confidence = Math.max(40, confidence - 12); }
  }

  // 3) Fundamentals — weighted more heavily for the long-term horizon.
  const fund = scoreFundamentals(fundamentals, price);
  if (fund.available) {
    const fw = mode === 'longterm' ? 7 : 3;
    confidence += Math.round(clampNum(fund.score, -3, 3) * fw);
    if (mode === 'longterm') {
      if (fund.score >= 2 && action === 'HOLD') action = 'BUY';
      if (fund.score >= 1.5 && action === 'SELL') action = 'HOLD';
      if (fund.score <= -2 && action === 'BUY') action = 'HOLD';
      if (fund.score <= -3) action = 'SELL';
    } else if (fund.score <= -2 && action === 'BUY') {
      action = 'HOLD';
    }
    confidence = Math.round(clampNum(confidence, 30, 95));
  }

  const labelMap = { BUY: 'Add / Buy', SELL: 'Trim / Sell', HOLD: 'Hold', WAIT: 'Analyzing…' };
  const rankedFund = [...fund.factors].sort((a, b) => (b.type === action ? 1 : 0) - (a.type === action ? 1 : 0));
  const factors = [...rankedFund.slice(0, 3), ...newsFactors, ...techFactors].slice(0, 7);

  const techReason = base.factors.slice(0, 2).map((f) => f.name).join(' · ') || 'Technical setup';
  const fundReason = fund.available
    ? (fund.score >= 1 ? 'fundamentals supportive' : fund.score <= -1 ? 'fundamentals weak' : 'fundamentals neutral')
    : 'fundamentals N/A';
  const newsReason = recent.length ? `news ${pos}↑/${neg}↓` : 'no recent news';

  return {
    action,
    label: labelMap[action] || action,
    confidence,
    reason: `${techReason} · ${fundReason} · ${newsReason}`,
    detail: 'Blends chart technicals, fundamentals (P/E, ROE, debt, growth…) and recent news.',
    factors,
    entry: base.entry,
    target: base.target,
    stopLoss: base.stopLoss,
    rr: base.rr,
    dayPct,
    newsCount: recent.length,
    fundamentalScore: fund.available ? fund.score : null,
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
