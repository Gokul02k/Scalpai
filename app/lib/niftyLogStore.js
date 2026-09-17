import { isUpstashConfigured, upstashCommand } from './upstash';

const LOG_KEY = 'scalpai:nifty-log';

export function isNiftyLogStorageConfigured() {
  return isUpstashConfigured();
}

export async function getNiftyLogs() {
  if (!isNiftyLogStorageConfigured()) {
    return { logs: [], configured: false };
  }

  try {
    const raw = await upstashCommand(['GET', LOG_KEY]);
    const logs = raw ? JSON.parse(raw) : [];
    return { logs: Array.isArray(logs) ? logs : [], configured: true };
  } catch (error) {
    console.error('niftyLogStore get:', error);
    return { logs: [], configured: true, error: error.message };
  }
}

export async function saveNiftyLogs(logs) {
  if (!isNiftyLogStorageConfigured()) return false;
  await upstashCommand(['SET', LOG_KEY, JSON.stringify(logs)]);
  return true;
}

export async function clearNiftyLogs() {
  if (!isNiftyLogStorageConfigured()) return false;
  await upstashCommand(['DEL', LOG_KEY]);
  return true;
}

const TEST_PING_KEY = 'scalpai:test-ping';

/** Minutes between test pings. A person verifying presses once; only a
 *  scheduler comes back inside this window. */
export const TEST_PING_COOLDOWN_MIN = 15;

/**
 * Claim the right to send one test ping, or report that one just went out.
 *
 * `?test=1` is a human diagnostic with no market-hours check, which is correct
 * — the point is to verify delivery while the market is shut. What it was not
 * built for is a scheduler calling it every two minutes forever, which is what
 * happens when the verification URL from the README is pasted straight into
 * cron-job.org: the same message, around the clock.
 *
 * `SET NX EX` makes the cooldown atomic, so two overlapping calls cannot both
 * decide they are the one allowed to send.
 *
 * With no storage configured there is nothing to rate-limit against, and the
 * caller is told as much rather than silently spared.
 */
export async function claimTestPing() {
  if (!isNiftyLogStorageConfigured()) {
    return { allowed: true, limited: false, reason: 'storage_not_configured' };
  }
  try {
    const result = await upstashCommand([
      'SET', TEST_PING_KEY, String(Date.now()),
      'NX', 'EX', String(TEST_PING_COOLDOWN_MIN * 60),
    ]);
    // Upstash answers "OK" when it set the key, and null when it was already
    // there — which is the whole signal: somebody pinged very recently.
    return result ? { allowed: true, limited: false } : { allowed: false, limited: true };
  } catch (error) {
    console.error('claimTestPing:', error);
    return { allowed: true, limited: false, reason: 'rate_limit_unavailable' };
  }
}
