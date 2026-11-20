export const dynamic = 'force-dynamic';
export const revalidate = 0;

import { engineQuote } from '../../lib/engineClient';
import { fetchYahooQuote } from '../../lib/yahooServer';

async function fetchFromFinnhub(symbol, apiKey) {
  const quoteRes = await fetch(
    `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${apiKey}`,
    { cache: 'no-store' }
  );

  if (!quoteRes.ok) {
    return { ok: false, error: `Finnhub HTTP ${quoteRes.status}` };
  }

  const quote = await quoteRes.json();
  if (quote.error) return { ok: false, error: quote.error };
  if (quote.c == null || quote.c === 0) {
    return { ok: false, error: 'No Finnhub quote (Indian indices need a paid plan on free tier)' };
  }

  return {
    ok: true,
    data: {
      current: quote.c,
      high: quote.h,
      low: quote.l,
      open: quote.o,
      previousClose: quote.pc,
      change: quote.d,
      changePercent: quote.dp,
      timestamp: quote.t ? quote.t * 1000 : Date.now(),
    },
  };
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const symbol = searchParams.get('symbol') || '^NSEI';
  const apiKey = process.env.FINNHUB_API_KEY;
  const noStore = { headers: { 'Cache-Control': 'no-store, max-age=0' } };

  // The engine quotes from the broker the algo would actually trade through,
  // which is the price a signal should be measured against.
  const fromEngine = await engineQuote(symbol);
  if (fromEngine) {
    return Response.json(fromEngine, noStore);
  }

  // Try Finnhub first when key is configured
  if (apiKey) {
    try {
      const finnhub = await fetchFromFinnhub(symbol, apiKey);
      if (finnhub.ok) {
        return Response.json({ ...finnhub.data, source: 'finnhub' }, noStore);
      }
    } catch (error) {
      console.error('Finnhub fetch error:', error);
    }
  }

  // Yahoo Finance — free, works for NSE/BSE indices without an API key
  try {
    const yahoo = await fetchYahooQuote(symbol);
    if (yahoo.ok) {
      return Response.json({ ...yahoo.data, source: 'yahoo' }, noStore);
    }

    return Response.json(
      {
        error: yahoo.error || 'Could not fetch market data',
        source: 'error',
        hint: apiKey
          ? 'Finnhub free tier does not include Indian indices. Yahoo fallback also failed.'
          : 'Set FINNHUB_API_KEY (optional) or check symbol. Yahoo Finance is used by default for Indian indices.',
      },
      { status: 502, ...noStore }
    );
  } catch (error) {
    console.error('Yahoo fetch error:', error);
    return Response.json(
      { error: 'Failed to reach market data provider', source: 'error' },
      { status: 502, ...noStore }
    );
  }
}
