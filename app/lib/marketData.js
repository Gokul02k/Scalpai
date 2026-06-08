const LIVE_SOURCES = new Set(['finnhub', 'yahoo']);

export const SYMBOL_MAP = {
  'NIFTY': '^NSEI',
  'SENSEX': '^BSESN',
  'BANK NIFTY': '^NSEBANK',
  'FINNIFTY': '^NSEFI',
  'MIDCAP NIFTY': '^NSMIDCP',
};

export async function fetchRealMarketData(instrument) {
  const symbol = SYMBOL_MAP[instrument] || '^NSEI';

  try {
    const res = await fetch(
      `/api/market?symbol=${encodeURIComponent(symbol)}`,
      { cache: 'no-store' }
    );
    const data = await res.json();

    if (!res.ok || data.source === 'error') {
      return { ok: false, error: data.error || `API error (${res.status})`, source: 'error' };
    }

    return {
      ok: true,
      cur: data.current,
      open: data.open,
      high: data.high,
      low: data.low,
      prev: data.previousClose,
      change: data.change,
      changePercent: data.changePercent,
      source: data.source,
    };
  } catch {
    return { ok: false, error: 'Network error', source: 'error' };
  }
}

export async function fetchAllMarketData() {
  const instruments = Object.keys(SYMBOL_MAP);
  const results = await Promise.all(
    instruments.map(async (inst) => [inst, await fetchRealMarketData(inst)])
  );

  const prices = {};
  let liveCount = 0;
  let lastError = null;
  let source = null;

  for (const [inst, data] of results) {
    if (data.ok && LIVE_SOURCES.has(data.source)) {
      prices[inst] = { cur: data.cur, open: data.open, high: data.high, low: data.low, prev: data.prev };
      liveCount++;
      source = source || data.source;
    } else if (data.error) lastError = data.error;
  }

  return { prices, isLive: liveCount > 0, liveCount, total: instruments.length, source, error: liveCount === 0 ? lastError : null };
}

export async function fetchCandles(instrument, tf = '5m') {
  const symbol = SYMBOL_MAP[instrument] || '^NSEI';
  try {
    const res = await fetch(`/api/candles?symbol=${encodeURIComponent(symbol)}&tf=${tf}`, { cache: 'no-store' });
    const data = await res.json();
    return data.candles?.length ? data.candles : null;
  } catch {
    return null;
  }
}

export async function fetchStockQuote(symbol) {
  try {
    const res = await fetch(`/api/stock?symbol=${encodeURIComponent(symbol)}`, { cache: 'no-store' });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function fetchPortfolioPrices(portfolio) {
  const updated = await Promise.all(
    portfolio.map(async (s) => {
      const q = await fetchStockQuote(s.name);
      if (q?.current) return { ...s, cur: q.current };
      return s;
    })
  );
  return updated;
}

export async function fetchNews(stocks = []) {
  try {
    const res = await fetch(`/api/news?stocks=${stocks.join(',')}`, { cache: 'no-store' });
    if (!res.ok) return { news: [], overview: '' };
    return await res.json();
  } catch {
    return { news: [], overview: '' };
  }
}

export function genFallbackCandles(base, count = 65, vol = 0.0014) {
  const out = [];
  let p = base;
  const now = Date.now();
  for (let i = count; i >= 0; i--) {
    const d = ((Math.random() > 0.47 ? 1 : -1) * Math.random() * vol * p);
    const o = p;
    const c = p + d;
    const h = Math.max(o, c) + Math.random() * 0.35 * vol * p;
    const l = Math.min(o, c) - Math.random() * 0.35 * vol * p;
    out.push({
      t: new Date(now - i * 5 * 60000).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }),
      o: +o.toFixed(2), h: +h.toFixed(2), l: +l.toFixed(2), c: +c.toFixed(2),
      vol: Math.floor(80000 + Math.random() * 400000),
    });
    p = c;
  }
  return out;
}
