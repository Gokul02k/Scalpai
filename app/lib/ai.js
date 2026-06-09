import { geminiChat, resolveGeminiKey } from './gemini';

function isQuotaError(err) {
  const msg = String(err?.message || err);
  return /quota|rate limit|429|RESOURCE_EXHAUSTED/i.test(msg);
}

/** Explicit AI_PROVIDER, or auto-detect from env (Groq → Ollama → Gemini → Anthropic). */
export function getAiProviders() {
  const explicit = process.env.AI_PROVIDER?.trim().toLowerCase();
  if (explicit && explicit !== 'auto') {
    return [explicit];
  }

  const available = [];
  if (process.env.GROQ_API_KEY?.trim()) available.push('groq');
  if (process.env.OLLAMA_BASE_URL?.trim()) available.push('ollama');
  if (resolveGeminiKey().key) available.push('gemini');
  if (process.env.ANTHROPIC_API_KEY?.trim()) available.push('anthropic');
  return available;
}

export const AI_SETUP_HINT =
  'Easiest free option: get GROQ_API_KEY at https://console.groq.com (free), set AI_PROVIDER=groq in Vercel, redeploy. Local dev: run Ollama and set OLLAMA_BASE_URL=http://127.0.0.1:11434.';

async function groqChat({ system, messages, maxTokens, temperature }) {
  const apiKey = process.env.GROQ_API_KEY?.trim();
  const model = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        ...(system ? [{ role: 'system', content: system }] : []),
        ...messages.filter((m) => m.role === 'user' || m.role === 'assistant'),
      ],
      max_tokens: maxTokens,
      temperature,
    }),
    cache: 'no-store',
  });

  const data = await res.json();
  if (!res.ok) {
    const msg = data?.error?.message || `Groq API error (${res.status})`;
    throw new Error(msg);
  }

  const text = data.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error('Empty response from Groq');
  return text;
}

async function ollamaChat({ system, messages, maxTokens, temperature }) {
  const base = (process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');
  const model = process.env.OLLAMA_MODEL || 'llama3.2';

  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        ...(system ? [{ role: 'system', content: system }] : []),
        ...messages.filter((m) => m.role === 'user' || m.role === 'assistant'),
      ],
      max_tokens: maxTokens,
      temperature,
      stream: false,
    }),
    cache: 'no-store',
  });

  const data = await res.json();
  if (!res.ok) {
    const msg = data?.error?.message || data?.error || `Ollama error (${res.status}). Is Ollama running?`;
    throw new Error(msg);
  }

  const text = data.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error('Empty response from Ollama');
  return text;
}

async function geminiProviderChat({ system, messages, maxTokens }) {
  const { key, error } = resolveGeminiKey();
  if (error) throw new Error(error);
  if (!key) throw new Error('GEMINI_API_KEY is not set');
  return geminiChat({ apiKey: key, system, messages, maxTokens });
}

async function anthropicChat({ system, messages, maxTokens }) {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: maxTokens,
      system: system || '',
      messages: messages.filter((m) => m.role === 'user' || m.role === 'assistant'),
    }),
    cache: 'no-store',
  });

  const data = await res.json();
  if (!res.ok) {
    const msg = data?.error?.message || data?.error || `Anthropic API error (${res.status})`;
    throw new Error(msg);
  }

  const text = data.content?.[0]?.text?.trim();
  if (!text) throw new Error('Empty response from Anthropic');
  return text;
}

async function runProvider(provider, opts) {
  switch (provider) {
    case 'groq':
      return groqChat(opts);
    case 'ollama':
      return ollamaChat(opts);
    case 'gemini':
      return geminiProviderChat(opts);
    case 'anthropic':
      return anthropicChat(opts);
    default:
      throw new Error(`Unknown AI_PROVIDER "${provider}". Use groq, ollama, gemini, anthropic, or auto.`);
  }
}

export async function aiChat({ system, messages, maxTokens = 1000, temperature = 0.5 }) {
  const providers = getAiProviders();
  if (!providers.length) {
    throw new Error(`No AI provider configured. ${AI_SETUP_HINT}`);
  }

  const opts = { system, messages, maxTokens, temperature };
  let lastError;

  for (let i = 0; i < providers.length; i++) {
    try {
      return await runProvider(providers[i], opts);
    } catch (err) {
      lastError = err;
      const hasFallback = i < providers.length - 1;
      if (hasFallback && isQuotaError(err)) continue;
      throw err;
    }
  }

  throw lastError || new Error(`No AI provider available. ${AI_SETUP_HINT}`);
}

export async function aiGenerate({ system, userPrompt, maxTokens = 800, temperature = 0.35 }) {
  return aiChat({
    system,
    messages: [{ role: 'user', content: userPrompt }],
    maxTokens,
    temperature,
  });
}
