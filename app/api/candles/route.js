export const dynamic = 'force-dynamic';

import { engineCandles } from '../../lib/engineClient';
import { fetchYahooChart } from '../../lib/yahooServer';

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const symbol = searchParams.get('symbol') || '^NSEI';
  const tf = searchParams.get('tf') || '5m';

  // The engine serves the archive the backtest runs on, so the chart and the
  // measured strategy are looking at the same bars. Null means it is not
  // configured, not running, or has nothing for this symbol and timeframe.
  const fromEngine = await engineCandles(symbol, tf);
  if (fromEngine) {
    return Response.json(fromEngine, { headers: { 'Cache-Control': 'no-store' } });
  }

  const { candles, yahooSymbol, error } = await fetchYahooChart(symbol, tf);
  if (error) {
    console.error('Candles fetch error:', error);
    return Response.json({ error, candles: [] }, { status: 502 });
  }
  return Response.json(
    { candles, source: 'yahoo', symbol: yahooSymbol, tf },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}
