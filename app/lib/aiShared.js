/**
 * Whether the deployment's own keys may be spent on other people's questions.
 *
 * Server-side only. Import from route handlers.
 *
 * The dashboard is deployed publicly, and a key in the environment used to be
 * reached by every visitor — so the owner paid for everyone's questions and had
 * no way to see it happening except on a billing page. Off by default now: a
 * visitor brings their own key, or the assistant says it is not configured.
 *
 * `SCALPAI_SHARED_KEYS=1` restores the old behaviour deliberately, which is the
 * right setting for a deployment only its owner can reach, and for local
 * development where the key in `.env.local` is the owner's anyway.
 */

import { aiProvider, isPlaceholderKey } from './aiProviders';

export function sharedKeysEnabled() {
  const raw = process.env.SCALPAI_SHARED_KEYS?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

/** The key this deployment holds for a provider, ignoring `.env.example` stubs. */
export function envKeyFor(id) {
  const provider = aiProvider(id);
  if (!provider) return null;
  for (const name of provider.envVars) {
    const value = process.env[name]?.trim();
    if (value && !isPlaceholderKey(value)) return value;
  }
  return null;
}

/**
 * The key to use for one request: what the caller sent, or the deployment's own
 * when sharing is switched on.
 *
 * A supplied key always wins. Patchvane resolves this the other way round so an
 * operator can pin a key the page cannot replace, which is the right answer for
 * something self-hosted per person; here the point is the opposite — to stop the
 * owner's key being the one that gets spent.
 */
export function resolveKey(id, supplied) {
  const fromCaller = typeof supplied === 'string' ? supplied.trim() : '';
  if (fromCaller && !isPlaceholderKey(fromCaller)) return fromCaller;
  return sharedKeysEnabled() ? envKeyFor(id) : null;
}

/**
 * Pull the per-provider keys out of a request body.
 *
 * Tolerates a missing or malformed `keys` object, because the request comes
 * from the page and a shape change should degrade to "no key supplied" rather
 * than throw inside a route.
 */
export function keysFromBody(body) {
  const keys = body?.keys;
  if (!keys || typeof keys !== 'object') return {};
  const out = {};
  for (const [id, value] of Object.entries(keys)) {
    if (typeof value === 'string' && value.trim()) out[id] = value.trim();
  }
  return out;
}
