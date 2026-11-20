import { isUpstashConfigured, upstashCommand } from './upstash';

const ALERTS_KEY = 'scalpai:alerts-enabled';

/**
 * Whether the background tick may message Telegram, flipped from Settings.
 * It silences messages only: signals are still logged and graded either way.
 *
 * An absent key means it was never set, which counts as on so alerts start
 * working as soon as the env vars are in place.
 */
export async function getAlertsEnabled() {
  if (!isUpstashConfigured()) return { enabled: false, configured: false };

  try {
    const raw = await upstashCommand(['GET', ALERTS_KEY]);
    return { enabled: raw == null ? true : raw === '1', configured: true };
  } catch (error) {
    console.error('alertSettings get:', error);
    // Fail closed. When the switch cannot be read, the one thing known is that
    // somebody may have turned it off, and a message sent after "off" is the
    // failure the owner asked not to have. A missed alert on a storage blip is
    // the smaller cost: the signal is still logged.
    return { enabled: false, configured: true, error: error.message };
  }
}

export async function setAlertsEnabled(enabled) {
  if (!isUpstashConfigured()) return { enabled: false, configured: false };
  await upstashCommand(['SET', ALERTS_KEY, enabled ? '1' : '0']);
  return { enabled: Boolean(enabled), configured: true };
}
