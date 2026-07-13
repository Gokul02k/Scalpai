export const dynamic = 'force-dynamic';

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
    const meta = body?.chart?.result?.[0]?.meta;
    if (!meta?.regularMarketPrice) {
      return Response.json({ error: 'No quote' }, { status: 404 });
    }

    const current = meta.regularMarketPrice;
    const prev = meta.chartPreviousClose ?? meta.previousClose ?? current;

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
