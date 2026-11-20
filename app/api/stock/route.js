export const dynamic = 'force-dynamic';

const istDay = (sec) =>
  new Date(sec * 1000).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

/**
 * Yesterday's close, from the daily bars themselves.
 *
 * This route asks for five days of daily bars, and `meta.chartPreviousClose`
 * is the close *before the first of them* — so "today's change" used to be
 * the change over the whole week. The last bar dated before the quote's own
 * session day is the real previous close.
 */
function previousSessionClose(result) {
  const ts = result?.timestamp || [];
  const closes = result?.indicators?.quote?.[0]?.close || [];
  const today = istDay(result?.meta?.regularMarketTime ?? Date.now() / 1000);
  for (let i = ts.length - 1; i >= 0; i--) {
    if (closes[i] != null && istDay(ts[i]) < today) return closes[i];
  }
  return null;
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const symbol = searchParams.get('symbol');
  if (!symbol) {
    return Response.json({ error: 'symbol required' }, { status: 400 });
  }

  const yahooSymbol = symbol.includes('.') || symbol.startsWith('^') ? symbol : `${symbol}.NS`;

  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?interval=1d&range=5d`;
    const res = await fetch(url, {
      cache: 'no-store',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ScalpAI/1.0)' },
    });

    if (!res.ok) {
      return Response.json({ error: `Yahoo HTTP ${res.status}` }, { status: 502 });
    }

    const body = await res.json();
    const result = body?.chart?.result?.[0];
    const meta = result?.meta;
    if (!meta?.regularMarketPrice) {
      return Response.json({ error: 'No quote' }, { status: 404 });
    }

    const current = meta.regularMarketPrice;
    const prev = previousSessionClose(result) ?? meta.previousClose ?? current;

    return Response.json({
      symbol: yahooSymbol,
      current,
      previousClose: prev,
      high: meta.regularMarketDayHigh ?? current,
      low: meta.regularMarketDayLow ?? current,
      open: meta.regularMarketOpen ?? prev,
      change: +(current - prev).toFixed(2),
      changePercent: prev ? +(((current - prev) / prev) * 100).toFixed(2) : 0,
      source: 'yahoo',
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('Stock fetch error:', error);
    return Response.json({ error: 'Failed to fetch stock' }, { status: 502 });
  }
}
