const LIVE_SOURCES = new Set(['finnhub', 'yahoo']);

const SYMBOL_MAP = {
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
      return {
        ok: false,
        error: data.error || `API error (${res.status})`,
        source: 'error',
      };
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
  } catch (error) {
    console.error('Market data fetch failed:', error);
    return { ok: false, error: 'Network error', source: 'error' };
  }
}

export async function fetchAllMarketData() {
  const instruments = Object.keys(SYMBOL_MAP);
  const results = await Promise.all(
    instruments.map(async (inst) => {
      const data = await fetchRealMarketData(inst);
      return [inst, data];
    })
  );

  const prices = {};
  let liveCount = 0;
  let lastError = null;
  let source = null;

  for (const [inst, data] of results) {
    if (data.ok && LIVE_SOURCES.has(data.source)) {
      prices[inst] = {
        cur: data.cur,
        open: data.open,
        high: data.high,
        low: data.low,
        prev: data.prev,
      };
      liveCount++;
      source = source || data.source;
    } else if (data.error) {
      lastError = data.error;
    }
  }

  return {
    prices,
    isLive: liveCount > 0,
    liveCount,
    total: instruments.length,
    source,
    error: liveCount === 0 ? lastError : null,
  };
}
