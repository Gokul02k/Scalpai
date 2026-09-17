import { geminiChat, hasGemini } from '../../lib/gemini';
import { groqChat, hasGroq } from '../../lib/groq';
import { keysFromBody, sharedKeysEnabled } from '../../lib/aiShared';

export const dynamic = 'force-dynamic';

export async function POST(request) {
  const body = await request.json();
  const { system, messages, model } = body;

  if (!messages?.length) {
    return Response.json({ error: 'No messages provided' }, { status: 400 });
  }

  // Keys the settings page sent with the request. Never logged, and never put
  // anywhere near the prompt.
  const keys = keysFromBody(body);
  const errors = [];

  // Primary: Gemini, when a key was supplied or the deployment shares its own.
  if (hasGemini(keys.gemini)) {
    try {
      const text = await geminiChat({ system, messages, model, apiKey: keys.gemini });
      return Response.json({ text, provider: 'gemini' });
    } catch (error) {
      console.error('Gemini chat failed:', error.message);
      errors.push(`Gemini: ${error.message}`);
    }
  }

  // Fallback: Groq.
  if (hasGroq(keys.groq)) {
    try {
      const text = await groqChat({ system, messages, model, apiKey: keys.groq });
      return Response.json({ text, provider: 'groq' });
    } catch (error) {
      console.error('Groq chat failed:', error.message);
      errors.push(`Groq: ${error.message}`);
    }
  }

  if (errors.length) {
    return Response.json({ error: errors.join(' | ') }, { status: 502 });
  }

  // Nothing to try. Said in terms of what the reader can do about it, which
  // differs depending on whether this deployment shares a key at all.
  return Response.json(
    {
      error: sharedKeysEnabled()
        ? 'No AI provider configured. Add a key in Settings → Assistant, or set GEMINI_API_KEY on the server.'
        : 'Add your own Gemini or Groq key in Settings → Assistant. This deployment does not share one.',
      needsKey: true,
    },
    { status: 503 }
  );
}
