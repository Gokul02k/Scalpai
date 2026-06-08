export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const symbol = searchParams.get('symbol') || '^NSEI';
  const apiKey = process.env.FINNHUB_API_KEY;

  if (!apiKey) {
    return Response.json(
      { error: 'API key not configured' },
      { status: 400 }
    );
  }

  try {
    const quoteRes = await fetch(
      `https://finnhub.io/api/v1/quote?symbol=${symbol}&token=${apiKey}`
    );
    const quote = await quoteRes.json();

    if (!quote.c) {
      return Response.json({
        current: 25000,
        high: 25200,
        low: 24800,
        open: 24950,
        previousClose: 24900,
        timestamp: Date.now(),
        source: 'mock',
      });
    }

    return Response.json({
      current: quote.c,
      high: quote.h,
      low: quote.l,
      open: quote.o,
      previousClose: quote.pc,
      timestamp: quote.t * 1000,
      source: 'finnhub',
    });
  } catch (error) {
    console.error('Market data fetch error:', error);
    return Response.json({
      current: 25000,
      high: 25200,
      low: 24800,
      open: 24950,
      previousClose: 24900,
      timestamp: Date.now(),
      source: 'mock',
      error: 'Using fallback data',
    });
  }
}
