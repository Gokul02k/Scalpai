import { geminiChat, hasGemini } from '../../lib/gemini';
import { groqChat, getGroqKey } from '../../lib/groq';

export const dynamic = 'force-dynamic';

export async function POST(request) {
  const { system, messages, model } = await request.json();

  if (!messages?.length) {
    return Response.json({ error: 'No messages provided' }, { status: 400 });
  }

  const errors = [];

  // Primary: Gemini (when a key is configured)
  if (hasGemini()) {
    try {
      const text = await geminiChat({ system, messages, model });
      return Response.json({ text, provider: 'gemini' });
    } catch (error) {
      console.error('Gemini chat error:', error);
      errors.push(`Gemini: ${error.message}`);
    }
  }

  // Fallback: Groq
  if (getGroqKey()) {
    try {
      const text = await groqChat({ system, messages });
      return Response.json({ text, provider: 'groq' });
    } catch (error) {
      console.error('Groq chat error:', error);
      errors.push(`Groq: ${error.message}`);
    }
  }

  const message = errors.length
    ? errors.join(' | ')
    : 'No AI provider configured. Add GEMINI_API_KEY (or GROQ_API_KEY) in Vercel → Environment Variables.';
  const status = /not set|configured/i.test(message) ? 503 : 502;
  return Response.json({ error: message }, { status });
}
