/** Google Gemini generateContent (free tier with API key from Google AI Studio). */
export async function geminiGenerate({ apiKey, system, userPrompt, maxTokens = 800 }) {
  const model = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
      generationConfig: {
        maxOutputTokens: maxTokens,
        temperature: 0.35,
      },
    }),
    cache: 'no-store',
  });

  const data = await res.json();

  if (!res.ok) {
    throw new Error(friendlyGeminiError(res.status, data));
  }

  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text).join('')?.trim();
  if (!text) {
    throw new Error('Empty response from Gemini');
  }
  return text;
}

export const GEMINI_KEY_HINT =
  'Create a free API key at https://aistudio.google.com/apikey (it starts with AIza…). Set GEMINI_API_KEY in Vercel → Environment Variables, then redeploy.';

/** Returns { key, error } — error is set only when a key is present but wrong type. */
export function resolveGeminiKey() {
  const raw = process.env.GEMINI_API_KEY || process.env.GOOGLE_GENERATIVE_AI_API_KEY || '';
  const key = raw.trim();
  if (!key || key === 'your_gemini_api_key_here') {
    return { key: null, error: null };
  }
  if (!key.startsWith('AIza')) {
    const prefix = key.slice(0, Math.min(6, key.length));
    return {
      key: null,
      error: `GEMINI_API_KEY is the wrong credential type (yours starts with "${prefix}…"). Google AI Studio keys start with "AIza". ${GEMINI_KEY_HINT}`,
    };
  }
  return { key, error: null };
}

export function getGeminiKey() {
  return resolveGeminiKey().key;
}

/** Map raw Gemini API errors to clear, actionable messages. */
export function friendlyGeminiError(status, data) {
  const raw = data?.error?.message || '';
  const reason = data?.error?.status || '';

  if (status === 401 || status === 403 || reason === 'UNAUTHENTICATED' || reason === 'PERMISSION_DENIED') {
    return 'GEMINI_API_KEY is invalid or not authorized. Create a fresh key at https://aistudio.google.com/apikey, set it in your environment (Vercel → Settings → Environment Variables, then redeploy), and ensure the "Generative Language API" is enabled with no IP/referrer restrictions.';
  }
  if (status === 400 && /API key not valid/i.test(raw)) {
    return 'GEMINI_API_KEY is not valid. Get a new key at https://aistudio.google.com/apikey and update your environment variables (redeploy after changing).';
  }
  if (status === 404 && /model/i.test(raw)) {
    return `Gemini model "${process.env.GEMINI_MODEL || 'gemini-2.0-flash'}" is unavailable. Set GEMINI_MODEL to a supported model (e.g. gemini-2.5-flash) and redeploy.`;
  }
  if (status === 429) {
    return 'Gemini rate limit / quota exceeded. Wait a bit and try again, or check your quota in Google AI Studio.';
  }
  return raw || `Gemini API error (${status})`;
}
