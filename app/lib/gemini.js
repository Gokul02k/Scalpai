import { resolveGeminiModel } from './geminiModels';

export const GEMINI_SETUP_HINT =
  'Add GEMINI_API_KEY from https://aistudio.google.com/apikey in Vercel → Environment Variables, then redeploy.';

export function getGeminiKey() {
  const key = (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY)?.trim();
  if (!key || key === 'your_gemini_api_key_here') return null;
  return key;
}

export function hasGemini() {
  return Boolean(getGeminiKey());
}

export async function geminiChat({
  system,
  messages,
  maxTokens = 1000,
  temperature = 0.5,
  model,
}) {
  const apiKey = getGeminiKey();
  if (!apiKey) throw new Error(`GEMINI_API_KEY is not set. ${GEMINI_SETUP_HINT}`);

  const resolved = resolveGeminiModel(model);

  const contents = (messages || [])
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));

  const body = {
    contents,
    generationConfig: { temperature, maxOutputTokens: maxTokens },
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
  };

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(resolved)}:generateContent`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify(body),
      cache: 'no-store',
    }
  );

  const data = await res.json();
  if (!res.ok) {
    const msg = data?.error?.message || `Gemini API error (${res.status})`;
    throw new Error(msg);
  }

  const cand = data?.candidates?.[0];
  const text = cand?.content?.parts?.map((p) => p.text).filter(Boolean).join('').trim();
  if (!text) {
    const reason = cand?.finishReason || data?.promptFeedback?.blockReason;
    throw new Error(reason ? `Gemini returned no text (${reason})` : 'Empty response from Gemini');
  }
  return text;
}

export async function geminiGenerate({
  system,
  userPrompt,
  maxTokens = 800,
  temperature = 0.35,
  model,
}) {
  return geminiChat({
    system,
    messages: [{ role: 'user', content: userPrompt }],
    maxTokens,
    temperature,
    model,
  });
}
