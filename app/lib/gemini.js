/** Google Gemini generateContent (free tier with API key from Google AI Studio). */

export function getGeminiModel() {
  return process.env.GEMINI_MODEL || 'gemini-2.0-flash';
}

/** AIza… = legacy keys; AQ.… = new Google AI Studio authentication keys. */
export function isGeminiApiKeyFormat(key) {
  return key.startsWith('AIza') || key.startsWith('AQ.');
}

function geminiUrl(model = getGeminiModel()) {
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
}

/** AQ. keys must use x-goog-api-key header; ?key= query param returns 401 for them. */
function geminiAuthHeaders(apiKey) {
  return {
    'Content-Type': 'application/json',
    'x-goog-api-key': apiKey,
  };
}

export async function geminiGenerateContent({ apiKey, body, model = getGeminiModel() }) {
  const res = await fetch(geminiUrl(model), {
    method: 'POST',
    headers: geminiAuthHeaders(apiKey),
    body: JSON.stringify(body),
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

export async function geminiGenerate({ apiKey, system, userPrompt, maxTokens = 800 }) {
  return geminiGenerateContent({
    apiKey,
    body: {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
      generationConfig: {
        maxOutputTokens: maxTokens,
        temperature: 0.35,
      },
    },
  });
}

export async function geminiChat({ apiKey, system, messages, maxTokens = 1000 }) {
  const history = messages
    .slice(0, -1)
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));
  const lastUser = messages[messages.length - 1]?.content || '';

  return geminiGenerateContent({
    apiKey,
    body: {
      systemInstruction: { parts: [{ text: system || '' }] },
      contents: [...history, { role: 'user', parts: [{ text: lastUser }] }],
      generationConfig: { maxOutputTokens: maxTokens, temperature: 0.5 },
    },
  });
}

export const GEMINI_KEY_HINT =
  'Create a free API key at https://aistudio.google.com/apikey (AIza… or AQ.… format). Set GEMINI_API_KEY in Vercel → Environment Variables, then redeploy.';

/** Returns { key, error } — error is set only when a key is present but unrecognized. */
export function resolveGeminiKey() {
  const raw = process.env.GEMINI_API_KEY || process.env.GOOGLE_GENERATIVE_AI_API_KEY || '';
  const key = raw.trim();
  if (!key || key === 'your_gemini_api_key_here') {
    return { key: null, error: null };
  }
  if (!isGeminiApiKeyFormat(key)) {
    const prefix = key.slice(0, Math.min(6, key.length));
    return {
      key: null,
      error: `GEMINI_API_KEY does not look like a Google AI Studio key (yours starts with "${prefix}…"). Expected AIza… or AQ.… format. ${GEMINI_KEY_HINT}`,
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
  if (status === 400 && /Multiple authentication credentials/i.test(raw)) {
    return 'Gemini rejected duplicate auth headers. If this persists, regenerate your API key at https://aistudio.google.com/apikey and redeploy.';
  }
  if (status === 400 && /API key not valid/i.test(raw)) {
    return 'GEMINI_API_KEY is not valid. Get a new key at https://aistudio.google.com/apikey and update your environment variables (redeploy after changing).';
  }
  if (status === 404 && /model/i.test(raw)) {
    return `Gemini model "${getGeminiModel()}" is unavailable. Set GEMINI_MODEL to a supported model (e.g. gemini-2.5-flash) and redeploy.`;
  }
  if (status === 429) {
    return 'Gemini rate limit / quota exceeded. Wait a bit and try again, or check your quota in Google AI Studio.';
  }
  return raw || `Gemini API error (${status})`;
}
