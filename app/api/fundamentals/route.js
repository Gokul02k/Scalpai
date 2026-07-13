export const dynamic = 'force-dynamic';

import { fetchYahooFundamentals } from '../../lib/yahooServer';

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const symbol = searchParams.get('symbol');
  if (!symbol) {
    return Response.json({ error: 'symbol required' }, { status: 400 });
  }

  try {
    const data = await fetchYahooFundamentals(symbol);
    return Response.json(data, {
      headers: { 'Cache-Control': 's-maxage=600, stale-while-revalidate=3600' },
    });
  } catch (error) {
    console.error('fundamentals fetch error:', error);
    return Response.json({ ok: false, error: 'Failed to fetch fundamentals' }, { status: 502 });
  }
}
