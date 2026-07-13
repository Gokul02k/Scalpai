import { geminiGenerate, hasGemini, GEMINI_SETUP_HINT } from '../../lib/gemini';
import { groqGenerate, getGroqKey } from '../../lib/groq';

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
    const ctx = await request.json();
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

    if (hasGemini()) {
      try {
        const text = await geminiGenerate({ system, userPrompt, maxTokens: 450 });
        return Response.json({ text, provider: 'gemini' });
      } catch (error) {
        console.error('Gemini EA error:', error);
        errors.push(`Gemini: ${error.message}`);
      }
    }

    if (getGroqKey()) {
      try {
        const text = await groqGenerate({ system, userPrompt, maxTokens: 450 });
        return Response.json({ text, provider: 'groq' });
      } catch (error) {
        console.error('Groq EA error:', error);
        errors.push(`Groq: ${error.message}`);
      }
    }

    const message = errors.length ? errors.join(' | ') : `AI is not configured. ${GEMINI_SETUP_HINT}`;
    const status = /not set|configured/i.test(message) ? 503 : 502;
    return Response.json({ error: message }, { status });
  } catch (error) {
    console.error('EA API error:', error);
    return Response.json({ error: error.message || 'Failed to reach AI provider' }, { status: 502 });
  }
}
