/**
 * Groq's catalogue, which turns over faster than anything else here.
 *
 * Every model this file used to name — `llama-3.3-70b-versatile`,
 * `llama-3.1-8b-instant`, `gemma2-9b-it`, `llama-3.2-90b-vision-preview` — has
 * since been retired. A valid key answered "the model does not exist or you do
 * not have access to it", which reads exactly like a rejected key and sent the
 * diagnosis in the wrong direction entirely.
 *
 * So the list below is a preference, not a requirement. `groqChat` asks the key
 * which models it actually has when a named one turns out to be gone, and
 * retries on the best of those. Hard-coding a catalogue that changes under you
 * is the thing that broke; naming a favourite and coping without it is not.
 */

export const DEFAULT_GROQ_MODEL = 'openai/gpt-oss-120b';

/** Models offered in the picker, best first. */
export const GROQ_CHAT_MODELS = [
  { id: 'openai/gpt-oss-120b', label: 'GPT-OSS 120B (best)' },
  { id: 'openai/gpt-oss-20b', label: 'GPT-OSS 20B (fast)' },
  { id: 'groq/compound', label: 'Groq Compound' },
  { id: 'groq/compound-mini', label: 'Groq Compound Mini (fast)' },
  { id: 'qwen/qwen3.8-27b', label: 'Qwen 3.8 27B' },
];

/**
 * Order to fall back through when a requested model is gone. Anything the key
 * offers that is not in this list still beats failing, so it is a ranking
 * rather than an allow-list.
 */
export const GROQ_MODEL_PREFERENCE = GROQ_CHAT_MODELS.map((m) => m.id);

/**
 * Models that cannot hold a conversation, whatever else they are good at.
 *
 * Groq serves speech, text-to-speech and moderation models from the same
 * endpoint, so a naive "first model the key has" would cheerfully send a
 * trading question to Whisper.
 */
const NOT_CHAT = [
  'whisper',        // speech to text
  'orpheus',        // text to speech
  'prompt-guard',   // prompt-injection classifier
  'safeguard',      // moderation
  'guard',          // ditto, other namings
  'tts',
];

export function isGroqChatModel(id) {
  const lower = (id || '').toLowerCase();
  if (!lower) return false;
  return !NOT_CHAT.some((bad) => lower.includes(bad));
}

/** Best chat model out of what a key actually offers. */
export function pickGroqModel(available) {
  const usable = (available || []).filter(isGroqChatModel);
  if (!usable.length) return null;
  for (const preferred of GROQ_MODEL_PREFERENCE) {
    if (usable.includes(preferred)) return preferred;
  }
  return usable[0];
}

const ALLOWED = new Set(GROQ_CHAT_MODELS.map((m) => m.id));

export function resolveGroqModel(requested) {
  if (requested && ALLOWED.has(requested)) return requested;
  const envModel = process.env.GROQ_MODEL?.trim();
  if (envModel) return envModel;
  return DEFAULT_GROQ_MODEL;
}

/** True when a provider error means "that model is gone", not "bad key". */
export function isMissingModelError(message) {
  return /does not exist|do not have access|decommission|model_not_found|not found/i
    .test(message || '');
}
