const YAHOO_INDEX = {
  '^NSEI': '^NSEI',
  '^BSESN': '^BSESN',
  '^NSEBANK': '^NSEBANK',
  '^NSEFI': '^CNXFIN',
  '^NSMIDCP': 'NIFTY_MID_SELECT.NS',
  'GOLDBEES.NS': 'GOLDBEES.NS',
  'SILVERBEES.NS': 'SILVERBEES.NS',
};

const TF_MAP = {
  '1m': { interval: '1m', range: '1d' },
  '5m': { interval: '5m', range: '5d' },
  '15m': { interval: '15m', range: '5d' },
  '1h': { interval: '60m', range: '1mo' },
  '1d': { interval: '1d', range: '3mo' },
};

const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; ScalpAI/1.0)' };

export async function fetchYahooQuote(symbol = '^NSEI') {
  const yahooSymbol = YAHOO_INDEX[symbol] || symbol;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?interval=1m&range=1d`;

  try {
    const res = await fetch(url, { cache: 'no-store', headers: UA });
    if (!res.ok) return { ok: false, error: `Yahoo HTTP ${res.status}` };

    const body = await res.json();
    const meta = body?.chart?.result?.[0]?.meta;
    if (!meta?.regularMarketPrice) {
      return { ok: false, error: `No Yahoo quote for ${yahooSymbol}` };
    }

    const current = meta.regularMarketPrice;
    const previousClose = meta.chartPreviousClose ?? meta.previousClose ?? current;
    const change = current - previousClose;

    return {
      ok: true,
      data: {
        current,
        high: meta.regularMarketDayHigh ?? current,
        low: meta.regularMarketDayLow ?? current,
        open: meta.regularMarketOpen ?? previousClose,
        previousClose,
        change: +change.toFixed(2),
        changePercent: previousClose ? +((change / previousClose) * 100).toFixed(2) : 0,
      },
    };
  } catch (error) {
    return { ok: false, error: error.message || 'Yahoo quote fetch failed' };
  }
}

export async function fetchYahooCandles(symbol = '^NSEI', tf = '5m') {
  const yahooSymbol = YAHOO_INDEX[symbol] || symbol;
  const { interval, range } = TF_MAP[tf] || TF_MAP['5m'];

  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?interval=${interval}&range=${range}`;
    const res = await fetch(url, { cache: 'no-store', headers: UA });
    if (!res.ok) return [];

    const body = await res.json();
    const result = body?.chart?.result?.[0];
    const timestamps = result?.timestamp || [];
    const q = result?.indicators?.quote?.[0] || {};

    return timestamps.map((t, i) => ({
      t: new Date(t * 1000).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }),
      o: +(q.open?.[i] ?? 0).toFixed(2),
      h: +(q.high?.[i] ?? 0).toFixed(2),
      l: +(q.low?.[i] ?? 0).toFixed(2),
      c: +(q.close?.[i] ?? 0).toFixed(2),
      vol: Math.floor(q.volume?.[i] ?? 0),
    })).filter((c) => c.c > 0);
  } catch {
    return [];
  }
}
