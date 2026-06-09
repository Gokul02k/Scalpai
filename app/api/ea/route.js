import { geminiGenerate, getGeminiKey } from '../../lib/gemini';

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
  const apiKey = getGeminiKey();
  if (!apiKey) {
    return Response.json(
      {
        error: 'Add GEMINI_API_KEY in Vercel → Settings → Environment Variables (get a free key at Google AI Studio), then redeploy.',
      },
      { status: 503 }
    );
  }

  try {
    const ctx = await request.json();
    if (!ctx?.instrument || !ctx?.finalCall) {
      return Response.json({ error: 'Missing instrument or signal context' }, { status: 400 });
    }

    const system = `You are EA (Expert Advisor) for Indian market trading on ScalpAI.
The user already has a rule-based BUY signal from live charts. Your job:
1. Review support/resistance context, liquidity, and indicators in the snapshot.
2. Say clearly: AGREE with the BUY, or CAUTION (wait / smaller size / skip).
3. Give 2-4 short bullet points: main reason, main risk, and what to watch before entering on Groww.
Keep under 120 words. Plain English. This is suggestion-only, not financial advice.`;

    const text = await geminiGenerate({
      apiKey,
      system,
      userPrompt: buildPrompt(ctx),
      maxTokens: 450,
    });

    return Response.json({ text });
  } catch (error) {
    console.error('EA API error:', error);
    return Response.json(
      { error: error.message || 'Failed to reach Gemini' },
      { status: 502 }
    );
  }
}
