import { isUpstashConfigured, upstashCommand } from './upstash';

const ALERTS_KEY = 'scalpai:alerts-enabled';

/**
 * Master switch for the background tick, flipped from the app's Alerts panel.
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
    // Fail open — a storage blip shouldn't silently stop the alerts.
    return { enabled: true, configured: true, error: error.message };
  }
}

export async function setAlertsEnabled(enabled) {
  if (!isUpstashConfigured()) return { enabled: false, configured: false };
  await upstashCommand(['SET', ALERTS_KEY, enabled ? '1' : '0']);
  return { enabled: Boolean(enabled), configured: true };
}
