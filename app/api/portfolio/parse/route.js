export const dynamic = 'force-dynamic';

function extractJsonArray(text) {
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

export async function POST(request) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return Response.json(
      { error: 'Add ANTHROPIC_API_KEY on Vercel to read portfolio screenshots.' },
      { status: 503 }
    );
  }

  try {
    const { image, mediaType = 'image/jpeg' } = await request.json();
    if (!image) {
      return Response.json({ error: 'No image provided' }, { status: 400 });
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
        max_tokens: 2000,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: { type: 'base64', media_type: mediaType, data: image },
              },
              {
                type: 'text',
                text: `This is a screenshot of an Indian stock portfolio (e.g. from Groww, Zerodha, etc.).

Extract every stock holding you can see. Return ONLY a JSON array, no other text:
[{"name":"RELIANCE","qty":10,"buy":2850,"sector":"Energy"}, ...]

Rules:
- "name" = NSE symbol in CAPS (RELIANCE not Reliance Industries)
- "qty" = number of shares
- "buy" = average buy price in ₹ (use 0 if not visible)
- "sector" = best guess or "Other"
If you cannot read the image, return []`,
              },
            ],
          },
        ],
      }),
      cache: 'no-store',
    });

    const data = await res.json();
    if (!res.ok) {
      return Response.json(
        { error: data?.error?.message || 'AI could not read the image' },
        { status: res.status }
      );
    }

    const text = data.content?.[0]?.text ?? '[]';
    const holdings = extractJsonArray(text) || [];
    const portfolio = holdings
      .filter((h) => h?.name)
      .map((h, i) => ({
        id: Date.now() + i,
        name: String(h.name).toUpperCase().replace(/\.NS$/, ''),
        qty: +h.qty || 1,
        buy: +h.buy || 0,
        cur: +h.buy || 0,
        sector: h.sector || 'Other',
      }));

    return Response.json({ portfolio, count: portfolio.length });
  } catch (error) {
    console.error('Portfolio parse error:', error);
    return Response.json({ error: 'Failed to parse portfolio image' }, { status: 502 });
  }
}
