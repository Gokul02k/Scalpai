import { geminiGenerate, hasGemini } from '../../lib/gemini';
import { groqGenerate, hasGroq } from '../../lib/groq';
import { keysFromBody, sharedKeysEnabled } from '../../lib/aiShared';

export const dynamic = 'force-dynamic';

function buildPrompt(ctx) {
  const lines = [
    `Instrument: ${ctx.instrument}`,
    `Mode: ${ctx.mode || 'scalp'}`,
    `Live price: ₹${ctx.price?.cur ?? '—'} (today ${ctx.price?.chgPct >= 0 ? '+' : ''}${ctx.price?.chgPct ?? 0}%)`,
    `App signal: ${ctx.finalCall?.label ?? '—'} (${ctx.finalCall?.confidence ?? 0}% confidence)`,
    `Entry: ₹${ctx.finalCall?.entry ?? '—'} | Target: ₹${ctx.finalCall?.target ?? '—'} | Stop: ₹${ctx.finalCall?.stopLoss ?? '—'} | R:R 1:${ctx.finalCall?.rr ?? '—'}`,
    '',
    'Technical factors the app used:',
  ];
  for (const f of ctx.finalCall?.factors || []) {
    lines.push(`- [${f.type}] ${f.name}: ${f.reason}`);
  }
  lines.push('');
  lines.push(`The app signal is: ${ctx.finalCall?.label ?? '—'} (${ctx.finalCall?.action ?? '—'}). Review for Indian markets (NSE).`);
  return lines.join('\n');
}

export async function POST(request) {
  try {
    const body = await request.json();
    // Split the keys off the context before anything reads it, so a key cannot
    // reach `buildPrompt` however that function grows later.
    const keys = keysFromBody(body);
    const { keys: _discard, ...ctx } = body || {};

    if (!ctx?.instrument || !ctx?.finalCall) {
      return Response.json({ error: 'Missing instrument or signal context' }, { status: 400 });
    }

    const system = `You are EA (Expert Advisor) for Indian market investing on ScalpAI.
The user already has a rule-based signal from live charts, fundamentals and news. Your job:
1. Review the signal, support/resistance, indicators, and (for holdings) valuation/quality context in the snapshot.
2. Say clearly: AGREE with the call, or CAUTION (wait / smaller size / skip).
3. Give 2-4 short bullet points: main reason, main risk, and what to watch before acting on Groww/Zerodha.
Keep under 120 words. Plain English. This is suggestion-only, not financial advice.`;

    const userPrompt = buildPrompt(ctx);
    const errors = [];

    if (hasGemini(keys.gemini)) {
      try {
        const text = await geminiGenerate({ system, userPrompt, maxTokens: 450, apiKey: keys.gemini });
        return Response.json({ text, provider: 'gemini' });
      } catch (error) {
        console.error('Gemini EA failed:', error.message);
        errors.push(`Gemini: ${error.message}`);
      }
    }

    if (hasGroq(keys.groq)) {
      try {
        const text = await groqGenerate({ system, userPrompt, maxTokens: 450, apiKey: keys.groq });
        return Response.json({ text, provider: 'groq' });
      } catch (error) {
        console.error('Groq EA failed:', error.message);
        errors.push(`Groq: ${error.message}`);
      }
    }

    if (errors.length) {
      return Response.json({ error: errors.join(' | ') }, { status: 502 });
    }
    return Response.json(
      {
        error: sharedKeysEnabled()
          ? 'AI is not configured. Add a key in Settings → Assistant, or set GEMINI_API_KEY on the server.'
          : 'Add your own Gemini or Groq key in Settings → Assistant. This deployment does not share one.',
        needsKey: true,
      },
      { status: 503 }
    );
  } catch (error) {
    console.error('EA API error:', error);
    return Response.json({ error: error.message || 'Failed to reach AI provider' }, { status: 502 });
  }
}
