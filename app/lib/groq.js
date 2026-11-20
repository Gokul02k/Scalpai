import {
  isMissingModelError,
  pickGroqModel,
  pickSearchModel,
  resolveGroqModel,
  GROQ_SEARCH_MODELS,
  GROQ_BROWSER_SEARCH_TOOL,
} from './groqModels';
import { resolveKey } from './aiShared';

export const GROQ_SETUP_HINT =
  'Add a Groq key in Settings → Assistant, or set GROQ_API_KEY with SCALPAI_SHARED_KEYS=1 to share the deployment\'s own.';

/**
 * Longest wait for one provider call. Without a limit a stalled provider held
 * the route until the platform killed it, and the fallback to the next
 * provider never got its turn. Grounded briefs search first, so this is not
 * tight.
 */
const AI_TIMEOUT_MS = 25_000;

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
    signal: AbortSignal.timeout(AI_TIMEOUT_MS),
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
      signal: AbortSignal.timeout(AI_TIMEOUT_MS),
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
 * Read whatever a Groq response says about the tools it ran.
 *
 * `executed_tools` is the server's own record, and its per-tool shape is not
 * documented tightly enough to pattern-match on one field. Reading several
 * possible spellings costs nothing; guessing one and being wrong would report
 * a brief that genuinely searched as though it had not, which is a worse
 * failure than a missing citation.
 */
function readExecutedTools(message) {
  const executed = Array.isArray(message?.executed_tools) ? message.executed_tools : [];
  const sources = [];

  for (const tool of executed) {
    const results = tool?.search_results?.results
      || tool?.search_results
      || tool?.output?.results
      || tool?.output
      || [];
    for (const r of Array.isArray(results) ? results : []) {
      if (r?.url || r?.title) sources.push({ title: r.title, url: r.url });
    }
  }

  const name = (t) => String(t?.type || t?.name || t?.tool || '');
  return {
    ran: executed.length > 0,
    searched: executed.some((t) => /search|visit|browse/i.test(name(t))),
    queries: executed.map((t) => t?.arguments?.query || t?.query).filter(Boolean),
    sources,
  };
}

/**
 * One Groq completion with server-side web search switched on.
 *
 * Search used to mean choosing a Compound system — `groq/compound` — and those
 * were decommissioned on 21 September 2026. It is a built-in tool now, which
 * is the sturdier arrangement: `browser_search` rides on the ordinary GPT-OSS
 * models, so the capability no longer disappears when one model does.
 *
 * Two details that are easy to get wrong and expensive to debug:
 *
 *   - `reasoning_effort: 'low'` is Groq's own recommendation for this tool.
 *     Left higher, the model opens extended browsing sessions and spends far
 *     more tokens than a news brief is worth.
 *   - `tool_choice: 'required'` forces the search rather than leaving it to
 *     the model's judgement. For "what happened today" that judgement is the
 *     one thing we do not want exercised — an unsearched answer is fluent and
 *     out of date, and looks identical to a searched one.
 */
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

  const ask = async (withModel, { force }) => {
    const res = await fetch(`${GROQ_API}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: withModel,
        messages: [
          ...(system ? [{ role: 'system', content: system }] : []),
          { role: 'user', content: userPrompt },
        ],
        tools: [GROQ_BROWSER_SEARCH_TOOL],
        ...(force ? { tool_choice: 'required' } : {}),
        reasoning_effort: 'low',
        max_tokens: maxTokens,
        temperature,
      }),
      cache: 'no-store',
      signal: AbortSignal.timeout(AI_TIMEOUT_MS),
    });

    const data = await res.json().catch(() => null);
    if (!res.ok) {
      throw new Error(data?.error?.message || `Groq API error (${res.status})`);
    }

    const message = data?.choices?.[0]?.message;
    const text = message?.content?.trim();
    if (!text) throw new Error('Empty response from Groq');

    return { text, model: withModel, ...readExecutedTools(message) };
  };

  // Forcing the search is worth a try and not worth the feature. Groq refuses
  // unknown body properties outright, so if `tool_choice` is not accepted
  // alongside a built-in tool the whole grounded attempt would fail and the
  // brief would fall back to reorganising headlines — the precise symptom this
  // change exists to fix. Unforced still searches; it just lets the model
  // decide, and the prompt is emphatic about which answer we want.
  const attempt = async (withModel) => {
    try {
      return await ask(withModel, { force: true });
    } catch (error) {
      if (isMissingModelError(error.message)) throw error;
      return ask(withModel, { force: false });
    }
  };

  try {
    return await attempt(model);
  } catch (error) {
    // Same recovery as `groqChat`, for the same reason: a retired model reads
    // like a rejected key. Asked against the key's real catalogue rather than
    // this file's idea of it, because this file has already been wrong once —
    // it named the Compound systems, which no longer exist.
    if (!isMissingModelError(error.message)) throw error;

    const fallback = pickSearchModel(await groqListModels(key));
    if (!fallback || fallback === model) {
      throw new Error(`${error.message} (no search-capable model on this key)`);
    }
    return attempt(fallback);
  }
}

/* `groqVision` lived here. Nothing called it, and the model it named
 * (`llama-3.2-90b-vision-preview`) has been retired along with the rest of
 * the old catalogue — Groq currently serves no vision model at all. Left as
 * a note rather than a function that could only ever throw. */
