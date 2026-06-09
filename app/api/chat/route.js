import { getGeminiKey } from '../../lib/gemini';

export const dynamic = 'force-dynamic';

function toGeminiMessages(messages) {
  return messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));
}

export async function POST(request) {
  try {
    const { system, messages } = await request.json();

    if (!messages?.length) {
      return Response.json({ error: 'No messages provided' }, { status: 400 });
    }

    const geminiKey = getGeminiKey();
    if (geminiKey) {
      const history = toGeminiMessages(messages.slice(0, -1));
      const lastUser = messages[messages.length - 1]?.content || '';
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${process.env.GEMINI_MODEL || 'gemini-1.5-flash'}:generateContent?key=${encodeURIComponent(geminiKey)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: system || '' }] },
            contents: [
              ...history,
              { role: 'user', parts: [{ text: lastUser }] },
            ],
            generationConfig: { maxOutputTokens: 1000, temperature: 0.5 },
          }),
          cache: 'no-store',
        }
      );
      const data = await res.json();
      if (!res.ok) {
        const msg = data?.error?.message || `Gemini error (${res.status})`;
        return Response.json({ error: msg }, { status: res.status });
      }
      const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text).join('')?.trim() || '';
      return Response.json({ text });
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return Response.json(
        {
          error:
            'AI not configured. Add GEMINI_API_KEY (free at Google AI Studio) or ANTHROPIC_API_KEY in Vercel → Environment Variables, then redeploy.',
        },
        { status: 503 }
      );
    }

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        system: system || '',
        messages,
      }),
      cache: 'no-store',
    });

    const data = await res.json();

    if (!res.ok) {
      const msg = data?.error?.message || data?.error || `Anthropic API error (${res.status})`;
      console.error('Anthropic error:', msg);
      return Response.json({ error: msg }, { status: res.status });
    }

    const text = data.content?.[0]?.text ?? '';
    return Response.json({ text });
  } catch (error) {
    console.error('Chat API error:', error);
    return Response.json({ error: 'Failed to reach AI service' }, { status: 502 });
  }
}
