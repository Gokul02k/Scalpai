import {
  isMissingModelError,
  pickGroqModel,
  resolveGroqModel,
} from './groqModels';
import { resolveKey } from './aiShared';

export const GROQ_SETUP_HINT =
  'Add a Groq key in Settings → Assistant, or set GROQ_API_KEY with SCALPAI_SHARED_KEYS=1 to share the deployment\'s own.';

const GROQ_API = 'https://api.groq.com/openai/v1';

export function getGroqKey(apiKey) {
  return resolveKey('groq', apiKey);
}

export function hasGroq(apiKey) {
  return Boolean(getGroqKey(apiKey));
}

/** Every model id a key can reach. */
export async function groqListModels(apiKey) {
  const res = await fetch(`${GROQ_API}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    cache: 'no-store',
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(data?.error?.message || `Groq rejected the key (${res.status})`);
  }
  return (data?.data || []).map((m) => m.id).filter(Boolean);
}

/**
 * Lists models rather than generating, so Test costs nothing — and names the
 * model it would actually use, since "key works" is not the useful answer when
 * the failure everyone hits is a retired model.
 */
export async function groqVerifyKey(apiKey) {
  const key = (apiKey || '').trim();
  if (!key) throw new Error('No key supplied');

  const models = await groqListModels(key);
  const chosen = pickGroqModel(models);
  if (!chosen) {
    throw new Error(`Key works, but offers no chat model (${models.length} available)`);
  }
  return { ok: true, detail: `key works — will use ${chosen}` };
}

export async function groqChat({
  system,
  messages,
  maxTokens = 1000,
  temperature = 0.5,
  model,
  apiKey,
}) {
  const key = getGroqKey(apiKey);
  if (!key) throw new Error(`No Groq key. ${GROQ_SETUP_HINT}`);

  const body = (withModel) => JSON.stringify({
    model: withModel,
    messages: [
      ...(system ? [{ role: 'system', content: system }] : []),
      ...messages.filter((m) => m.role === 'user' || m.role === 'assistant'),
    ],
    max_tokens: maxTokens,
    temperature,
  });

  const ask = async (withModel) => {
    const res = await fetch(`${GROQ_API}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: body(withModel),
      cache: 'no-store',
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      throw new Error(data?.error?.message || `Groq API error (${res.status})`);
    }
    const text = data?.choices?.[0]?.message?.content?.trim();
    if (!text) throw new Error('Empty response from Groq');
    return text;
  };

  const wanted = resolveGroqModel(model);
  try {
    return await ask(wanted);
  } catch (error) {
    // A retired model is not a dead key, and the provider's message for the two
    // is nearly identical. Ask what this key can actually reach and use the
    // best of it rather than reporting a failure the caller cannot act on.
    if (!isMissingModelError(error.message)) throw error;

    const fallback = pickGroqModel(await groqListModels(key));
    if (!fallback || fallback === wanted) {
      throw new Error(`${error.message} (no working chat model on this key)`);
    }
    return ask(fallback);
  }
}

export async function groqGenerate({
  system,
  userPrompt,
  maxTokens = 800,
  temperature = 0.35,
  model,
  apiKey,
}) {
  return groqChat({
    system,
    messages: [{ role: 'user', content: userPrompt }],
    maxTokens,
    temperature,
    model,
    apiKey,
  });
}

/**
 * Groq's Compound systems, which search the web server-side.
 *
 * These are not models but small agent systems wrapped behind the same
 * completions endpoint: `groq/compound` may run several tools per request,
 * `groq/compound-mini` exactly one and answers faster. Nothing has to be sent
 * to enable it — choosing the id is what turns search on — so this is an
 * ordinary completion with a fixed model and a richer return value.
 *
 * Custom tools are not accepted by these systems, which is why the retired-model
 * retry in `groqChat` is not reused here: there is no equivalent to fall back
 * to, and quietly answering from weights alone would present a brief as current
 * when it is not.
 */
export const GROQ_SEARCH_MODELS = ['groq/compound', 'groq/compound-mini'];

export async function groqGenerateGrounded({
  system,
  userPrompt,
  maxTokens = 1400,
  temperature = 0.3,
  model = GROQ_SEARCH_MODELS[0],
  apiKey,
}) {
  const key = getGroqKey(apiKey);
  if (!key) throw new Error(`No Groq key. ${GROQ_SETUP_HINT}`);

  const res = await fetch(`${GROQ_API}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        ...(system ? [{ role: 'system', content: system }] : []),
        { role: 'user', content: userPrompt },
      ],
      max_tokens: maxTokens,
      temperature,
    }),
    cache: 'no-store',
  });

  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(data?.error?.message || `Groq API error (${res.status})`);
  }

  const message = data?.choices?.[0]?.message;
  const text = message?.content?.trim();
  if (!text) throw new Error('Empty response from Groq');

  // `executed_tools` is the system's own record of what it ran. A search tool
  // reports the results it read, which is where the citable sources come from.
  const executed = message.executed_tools || [];
  const sources = [];
  for (const tool of executed) {
    const results = tool?.search_results?.results || tool?.output?.results || [];
    for (const r of Array.isArray(results) ? results : []) {
      if (r?.url || r?.title) sources.push({ title: r.title, url: r.url });
    }
  }

  return {
    text,
    model,
    searched: executed.some((t) => /search|visit|browse/i.test(t?.type || t?.name || '')),
    queries: executed.map((t) => t?.arguments?.query).filter(Boolean),
    sources,
  };
}

/* `groqVision` lived here. Nothing called it, and the model it named
 * (`llama-3.2-90b-vision-preview`) has been retired along with the rest of
 * the old catalogue — Groq currently serves no vision model at all. Left as
 * a note rather than a function that could only ever throw. */
