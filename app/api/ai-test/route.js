/**
 * Does this key work? One cheap round trip behind the Test button.
 *
 * Both providers are asked to list their models rather than to generate
 * anything, so pressing Test costs no tokens and does not depend on a
 * particular model still existing — which matters because providers retire
 * them and a dead model id would otherwise read as a dead key.
 *
 * The key arrives in the body, never the query string, because query strings
 * are the part of a request that ends up in access logs.
 */

import { geminiVerifyKey } from '../../lib/gemini';
import { groqVerifyKey } from '../../lib/groq';
import { aiProvider } from '../../lib/aiProviders';
import { envKeyFor, sharedKeysEnabled } from '../../lib/aiShared';

export const dynamic = 'force-dynamic';

const VERIFY = { gemini: geminiVerifyKey, groq: groqVerifyKey };

/**
 * Which providers this deployment can answer with on its own.
 *
 * Lets the settings page say "bring your own key" rather than offering a chat
 * that will fail on the first message. Reports only whether a key exists, not
 * the key.
 */
export async function GET() {
  const shared = sharedKeysEnabled();
  return Response.json(
    {
      shared,
      available: Object.keys(VERIFY).filter((id) => shared && Boolean(envKeyFor(id))),
    },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}

export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: 'Malformed request' }, { status: 400 });
  }

  const id = typeof body?.provider === 'string' ? body.provider : '';
  const verify = VERIFY[id];
  if (!verify || !aiProvider(id)) {
    return Response.json({ ok: false, error: 'Unknown provider' }, { status: 400 });
  }

  // Testing with no key supplied checks the deployment's own, so the settings
  // page can show whether the shared key works without ever being sent it.
  const supplied = typeof body?.key === 'string' ? body.key.trim() : '';
  const key = supplied || (sharedKeysEnabled() ? envKeyFor(id) : null);
  if (!key) {
    return Response.json(
      { ok: false, error: 'No key to test' },
      { status: 400 }
    );
  }

  try {
    const result = await verify(key);
    return Response.json({
      ok: true,
      provider: id,
      detail: result.detail,
      shared: !supplied,
    });
  } catch (error) {
    // The provider's own wording is more useful than ours, and it does not
    // contain the key: both providers take it in a header.
    console.error(`${id} key test failed:`, error.message);
    return Response.json({ ok: false, error: error.message }, { status: 200 });
  }
}
