export const dynamic = 'force-dynamic';
export const revalidate = 0;

import { engineDecision } from '../../lib/engineClient';

/**
 * The call the paper trader would act on, for the dashboard to render.
 *
 * There is no fallback here on purpose. Every other route can substitute Yahoo
 * for the engine because a price is a price, but the verdict is the engine's
 * production flags, VIX gate and fitted filter — none of which exist in the
 * browser. So an unreachable engine answers `available: false` and the caller
 * shows its own v1 call, labelled as such, rather than being handed a looser
 * decision under the same name.
 */
export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const symbol = searchParams.get('symbol') || '^NSEI';
  const interval = searchParams.get('interval') || '5m';
  const noStore = { headers: { 'Cache-Control': 'no-store, max-age=0' } };

  try {
    const decision = await engineDecision(symbol, interval);
    if (!decision) {
      return Response.json({ available: false, reason: 'engine unavailable' }, noStore);
    }
    return Response.json({ available: true, ...decision }, noStore);
  } catch {
    return Response.json({ available: false, reason: 'engine error' }, noStore);
  }
}
