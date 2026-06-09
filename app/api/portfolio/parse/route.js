import { groqVision, GROQ_SETUP_HINT } from '../../../lib/groq';
import { GROQ_VISION_MODEL } from '../../../lib/groqModels';

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

const PARSE_PROMPT = `This is a screenshot of an Indian stock portfolio (e.g. from Groww, Zerodha, etc.).

Extract every stock holding you can see. Return ONLY a JSON array, no other text:
[{"name":"RELIANCE","qty":10,"buy":2850,"sector":"Energy"}, ...]

Rules:
- "name" = NSE symbol in CAPS (RELIANCE not Reliance Industries)
- "qty" = number of shares
- "buy" = average buy price in ₹ (use 0 if not visible)
- "sector" = best guess or "Other"
If you cannot read the image, return []`;

export async function POST(request) {
  try {
    const { image, mediaType = 'image/jpeg' } = await request.json();
    if (!image) {
      return Response.json({ error: 'No image provided' }, { status: 400 });
    }

    const text = await groqVision({
      prompt: PARSE_PROMPT,
      imageBase64: image,
      mediaType,
      model: GROQ_VISION_MODEL,
      maxTokens: 2000,
    });

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
    const message = error.message || 'Failed to parse portfolio image';
    const status = /not set/i.test(message) ? 503 : 502;
    return Response.json(
      { error: message.includes(GROQ_SETUP_HINT) ? message : `${message} ${GROQ_SETUP_HINT}` },
      { status }
    );
  }
}
