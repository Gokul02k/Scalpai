import { resolveGeminiModel } from './geminiModels';
import { resolveKey } from './aiShared';

export const GEMINI_SETUP_HINT =
  'Add a Gemini key in Settings → Assistant, or set GEMINI_API_KEY with SCALPAI_SHARED_KEYS=1 to share the deployment\'s own.';

/**
 * The key for this request: the caller's, or the deployment's when sharing is
 * on. `apiKey` is what the settings page sent up with the request.
 */
export function getGeminiKey(apiKey) {
  return resolveKey('gemini', apiKey);
}

export function hasGemini(apiKey) {
  return Boolean(getGeminiKey(apiKey));
}

const GEMINI_API = 'https://generativelanguage.googleapis.com/v1beta';

/**
 * One cheap round trip that tells us whether a key works.
 *
 * Lists models rather than generating, so pressing Test never spends tokens
 * and never depends on a particular model still existing.
 */
export async function geminiVerifyKey(apiKey) {
  const key = (apiKey || '').trim();
  if (!key) throw new Error('No key supplied');

  const res = await fetch(`${GEMINI_API}/models`, {
    headers: { 'x-goog-api-key': key },
    cache: 'no-store',
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(data?.error?.message || `Gemini rejected the key (${res.status})`);
  }
  const count = (data?.models || []).length;
  return { ok: true, detail: count ? `${count} models available` : 'key accepted' };
}

export async function geminiChat({
  system,
  messages,
  maxTokens = 1000,
  temperature = 0.5,
  model,
  apiKey,
}) {
  const key = getGeminiKey(apiKey);
  if (!key) throw new Error(`No Gemini key. ${GEMINI_SETUP_HINT}`);

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
    `${GEMINI_API}/models/${encodeURIComponent(resolved)}:generateContent`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': key,
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
  apiKey,
}) {
  return geminiChat({
    system,
    messages: [{ role: 'user', content: userPrompt }],
    maxTokens,
    temperature,
    model,
    apiKey,
  });
}
