export const dynamic = 'force-dynamic';
export const maxDuration = 30;

import { authorizeCron } from '../../../lib/cronAuth';
import { runNiftyLogTick } from '../../../lib/niftyLogTick';
import { isNiftyLogStorageConfigured } from '../../../lib/niftyLogStore';
import { isTelegramConfigured, sendTelegramMessage, formatTestAlert } from '../../../lib/telegram';
import { getMarketStatus } from '../../../lib/marketHours';

export async function GET(request) {
  if (!authorizeCron(request)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const storage = isNiftyLogStorageConfigured();
  const market = getMarketStatus();

  // ?test=1 verifies auth, config and Telegram delivery without waiting for a
  // real signal — the tick itself only does anything during market hours.
  if (new URL(request.url).searchParams.get('test')) {
    const alert = await sendTelegramMessage(formatTestAlert({ storage, market: market.label }));
    return Response.json({
      test: true,
      config: { storage, telegram: isTelegramConfigured(), market: market.label },
      alert,
    });
  }

  try {
    const result = await runNiftyLogTick();
    return Response.json(result);
  } catch (error) {
    console.error('nifty-log cron:', error);
    return Response.json({ error: error.message || 'Cron tick failed' }, { status: 500 });
  }
}
