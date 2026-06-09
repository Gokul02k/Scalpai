import { resolveGeminiKey, geminiChat } from '../../lib/gemini';

export const dynamic = 'force-dynamic';

export async function POST(request) {
  try {
    const { system, messages } = await request.json();

    if (!messages?.length) {
      return Response.json({ error: 'No messages provided' }, { status: 400 });
    }

    const { key: geminiKey, error: keyError } = resolveGeminiKey();
    if (keyError) {
      return Response.json({ error: keyError }, { status: 503 });
    }
    if (geminiKey) {
      const text = await geminiChat({ apiKey: geminiKey, system, messages });
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
    return Response.json({ error: error.message || 'Failed to reach AI service' }, { status: 502 });
  }
}
