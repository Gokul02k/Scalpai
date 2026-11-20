import {
  resolveGeminiModel,
  pickGeminiModel,
  isMissingGeminiModel,
} from './geminiModels';
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

/**
 * Longest wait for one provider call. Without a limit a stalled provider held
 * the route until the platform killed it, and the fallback to the next
 * provider never got its turn. Grounded briefs search first, so this is not
 * tight.
 */
const AI_TIMEOUT_MS = 25_000;

const GEMINI_API = 'https://generativelanguage.googleapis.com/v1beta';

/**
 * One cheap round trip that tells us whether a key works.
 *
 * Lists models rather than generating, so pressing Test never spends tokens
 * and never depends on a particular model still existing.
 */
/** Every model id a key can actually reach, without the `models/` prefix. */
export async function geminiListModels(apiKey) {
  const res = await fetch(`${GEMINI_API}/models?pageSize=200`, {
    headers: { 'x-goog-api-key': (apiKey || '').trim() },
    cache: 'no-store',
    signal: AbortSignal.timeout(AI_TIMEOUT_MS),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(data?.error?.message || `Gemini rejected the key (${res.status})`);
  }
  return (data?.models || [])
    // Only models that can answer a prompt at all. The endpoint lists the
    // whole catalogue, embeddings and media models included.
    .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map((m) => String(m.name || '').replace(/^models\//, ''))
    .filter(Boolean);
}

export async function geminiVerifyKey(apiKey) {
  const key = (apiKey || '').trim();
  if (!key) throw new Error('No key supplied');

  const models = await geminiListModels(key);
  const chosen = pickGeminiModel(models);
  if (!chosen) {
    throw new Error(`Key works, but offers no text model (${models.length} available)`);
  }
  // Names the model it would actually use. "Key accepted" is not the useful
  // answer when the failure people hit is a model their key cannot reach.
  return { ok: true, detail: `key works — will use ${chosen}` };
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

  const contents = (messages || [])
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));

  const ask = async (withModel) => {
    const body = {
      contents,
      generationConfig: { temperature, maxOutputTokens: maxTokens },
      ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    };

    const res = await fetch(
      `${GEMINI_API}/models/${encodeURIComponent(withModel)}:generateContent`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': key,
        },
        body: JSON.stringify(body),
        cache: 'no-store',
        signal: AbortSignal.timeout(AI_TIMEOUT_MS),
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
  };

  const wanted = resolveGeminiModel(model);
  try {
    return await ask(wanted);
  } catch (error) {
    // Same recovery as the grounded call: an unreachable model is not a dead
    // key, and the chat should not break because Google restricted a family.
    if (!isMissingGeminiModel(error.message)) throw error;

    const fallback = pickGeminiModel(await geminiListModels(key));
    if (!fallback || fallback === wanted) throw error;
    return ask(fallback);
  }
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

/**
 * One generation with Google Search switched on.
 *
 * Kept apart from `geminiChat` rather than added as a flag, because the useful
 * return value is different: a grounded answer is only worth having if you can
 * also say whether it searched and what it read, and the callers of
 * `geminiChat` want a string.
 *
 * `google_search` is the current tool name. Models before 2.0 took a
 * `google_search_retrieval` tool with a different shape, and asking for the
 * wrong one is rejected as an unknown field rather than ignored — so a caller
 * naming an old model gets an error it can report, not a silently ungrounded
 * brief presented as live.
 */
export async function geminiGenerateGrounded({
  system,
  userPrompt,
  maxTokens = 1400,
  temperature = 0.3,
  model,
  apiKey,
}) {
  const key = getGeminiKey(apiKey);
  if (!key) throw new Error(`No Gemini key. ${GEMINI_SETUP_HINT}`);

  const ask = async (withModel) => {
    const body = {
      contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
      tools: [{ google_search: {} }],
      generationConfig: { temperature, maxOutputTokens: maxTokens },
      ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    };

    const res = await fetch(
      `${GEMINI_API}/models/${encodeURIComponent(withModel)}:generateContent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify(body),
        cache: 'no-store',
        signal: AbortSignal.timeout(AI_TIMEOUT_MS),
      }
    );

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data?.error?.message || `Gemini API error (${res.status})`);
    }

    const cand = data?.candidates?.[0];
    const text = cand?.content?.parts?.map((p) => p.text).filter(Boolean).join('').trim();
    if (!text) {
      const reason = cand?.finishReason || data?.promptFeedback?.blockReason;
      throw new Error(reason ? `Gemini returned no text (${reason})` : 'Empty response from Gemini');
    }

    // The model decides per prompt whether searching would help, so grounding
    // metadata being absent is a normal outcome and not an error. It does mean
    // the answer is only as current as the training data plus what we sent,
    // which is the distinction the caller passes on to the reader.
    const meta = cand?.groundingMetadata || {};
    const sources = (meta.groundingChunks || [])
      .map((c) => ({ title: c?.web?.title, url: c?.web?.uri }))
      .filter((s) => s.title || s.url);

    return {
      text,
      model: withModel,
      searched: sources.length > 0 || (meta.webSearchQueries || []).length > 0,
      queries: meta.webSearchQueries || [],
      sources,
    };
  };

  const wanted = resolveGeminiModel(model);
  try {
    return await ask(wanted);
  } catch (error) {
    // A model this key cannot reach is not a dead key. Google now restricts
    // the 2.5 family to projects already using it, so a key made today is
    // refused a model that worked yesterday — and the message for that reads
    // like an auth failure. Ask the key what it really has.
    if (!isMissingGeminiModel(error.message)) throw error;

    const fallback = pickGeminiModel(await geminiListModels(key));
    if (!fallback || fallback === wanted) {
      throw new Error(`${error.message} (no reachable text model on this key)`);
    }
    return ask(fallback);
  }
}
