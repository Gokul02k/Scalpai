export const dynamic = 'force-dynamic';

export async function POST(request) {
  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    return Response.json(
      {
        error:
          'AI not configured. Add ANTHROPIC_API_KEY in Vercel → Settings → Environment Variables, then redeploy.',
      },
      { status: 503 }
    );
  }

  try {
    const { system, messages } = await request.json();

    if (!messages?.length) {
      return Response.json({ error: 'No messages provided' }, { status: 400 });
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
