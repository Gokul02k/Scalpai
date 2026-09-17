export const dynamic = 'force-dynamic';
export const maxDuration = 30;

import { authorizeCron } from '../../../lib/cronAuth';
import { runNiftyLogTick } from '../../../lib/niftyLogTick';
import {
  claimTestPing,
  isNiftyLogStorageConfigured,
  TEST_PING_COOLDOWN_MIN,
} from '../../../lib/niftyLogStore';
import { isTelegramConfigured, sendTelegramMessage, formatTestAlert } from '../../../lib/telegram';
import { getMarketStatus } from '../../../lib/marketHours';
import { getAlertsEnabled } from '../../../lib/alertSettings';

export async function GET(request) {
  if (!authorizeCron(request)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const storage = isNiftyLogStorageConfigured();
  const market = getMarketStatus();

  // ?test=1 verifies auth, config and Telegram delivery without waiting for a
  // real signal, and deliberately ignores market hours — the whole point is to
  // check delivery while the market is shut.
  //
  // It is rate-limited because that same property makes it the one thing here
  // that can message you at 3am. The README tells you to append `&test=1` to
  // verify the endpoint, and a scheduler left pointing at that URL then sends
  // an identical ping every couple of minutes indefinitely. A person testing
  // presses once; only a scheduler returns inside the cooldown.
  if (new URL(request.url).searchParams.get('test')) {
    const { enabled } = await getAlertsEnabled();

    // Background alerts off means do not message me, and that has to include
    // the test ping. It did not: `enabled` was read here only to print in the
    // readout, so turning the switch off in Settings silenced real signals and
    // left the diagnostic pinging away — the one case where somebody has said
    // plainly that they want no messages.
    //
    // Checked before the cooldown is claimed, so a call that cannot send does
    // not spend the slot a real verification would need.
    if (!enabled) {
      return Response.json({
        test: true,
        config: {
          storage,
          telegram: isTelegramConfigured(),
          alertsEnabled: false,
          market: market.label,
        },
        alert: { sent: false, reason: 'alerts_disabled' },
        warning:
          'Background alerts are off in Settings, so nothing was sent. Turn ' +
          'them on to test delivery. If a scheduler keeps calling this URL, ' +
          'remove "&test=1" from it.',
      });
    }

    const claim = await claimTestPing();
    const alert = claim.allowed
      ? await sendTelegramMessage(formatTestAlert({
          storage,
          market: market.label,
          enabled,
          // Storage unavailable means the cooldown could not be checked, so do
          // not claim this is the first ping.
          repeated: Boolean(claim.reason),
        }))
      : { sent: false, reason: 'test_rate_limited' };

    return Response.json({
      test: true,
      config: {
        storage,
        telegram: isTelegramConfigured(),
        alertsEnabled: enabled,
        market: market.label,
      },
      alert,
      ...(claim.limited
        ? {
            rateLimited: true,
            cooldownMinutes: TEST_PING_COOLDOWN_MIN,
            warning:
              'Test pings are capped at one per ' + TEST_PING_COOLDOWN_MIN +
              ' minutes. If a scheduler is calling this URL, remove "&test=1" ' +
              'from it — test mode ignores market hours by design, so it is the ' +
              'only thing that messages you outside trading hours.',
          }
        : {}),
      ...(claim.reason ? { rateLimit: claim.reason } : {}),
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
