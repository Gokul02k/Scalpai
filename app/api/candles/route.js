export const dynamic = 'force-dynamic';

import { engineCandles } from '../../lib/engineClient';

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

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const symbol = searchParams.get('symbol') || '^NSEI';
  const tf = searchParams.get('tf') || '5m';
  const { interval, range } = TF_MAP[tf] || TF_MAP['5m'];
  const yahooSymbol = YAHOO_INDEX[symbol] || symbol;

  // The engine serves the archive the backtest runs on, so the chart and the
  // measured strategy are looking at the same bars. Null means it is not
  // configured, not running, or has nothing for this symbol and timeframe.
  const fromEngine = await engineCandles(symbol, tf);
  if (fromEngine) {
    return Response.json(fromEngine, { headers: { 'Cache-Control': 'no-store' } });
  }

  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?interval=${interval}&range=${range}`;
    const res = await fetch(url, {
      cache: 'no-store',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ScalpAI/1.0)' },
    });

    if (!res.ok) {
      return Response.json({ error: `Yahoo HTTP ${res.status}`, candles: [] }, { status: 502 });
    }

    const body = await res.json();
    const result = body?.chart?.result?.[0];
    const timestamps = result?.timestamp || [];
    const q = result?.indicators?.quote?.[0] || {};

    const candles = timestamps.map((t, i) => ({
      t: new Date(t * 1000).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', ...(tf === '1d' ? { month: 'short', day: 'numeric' } : {}) }),
      ts: t * 1000,
      o: +(q.open?.[i] ?? 0).toFixed(2),
      h: +(q.high?.[i] ?? 0).toFixed(2),
      l: +(q.low?.[i] ?? 0).toFixed(2),
      c: +(q.close?.[i] ?? 0).toFixed(2),
      vol: Math.floor(q.volume?.[i] ?? 0),
    })).filter(c => c.c > 0);

    return Response.json(
      { candles, source: 'yahoo', symbol: yahooSymbol, tf },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    console.error('Candles fetch error:', error);
    return Response.json({ error: 'Failed to fetch candles', candles: [] }, { status: 502 });
  }
}
