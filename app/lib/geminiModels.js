/**
 * Google's catalogue, which moves almost as fast as Groq's.
 *
 * This file named `gemini-2.5-flash` as the default until the 2.5 family was
 * put behind a grandfather clause: Google now limits those models to projects
 * that have already been using them, and tells new projects to use 3.5
 * Flash-Lite or 3.8 Flash instead. So the default was a model that a key
 * created today may simply not be able to reach — and the error for that reads
 * like a bad key, which is the same wrong diagnosis `groqModels.js` documents
 * at length.
 *
 * The list is therefore a preference, not a requirement, and the same shape as
 * the Groq one: name a favourite, ask the key what it actually has when the
 * favourite is missing, and use the best of those.
 */

export const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash';

/** Models users can pick in the AI chat UI, best first. */
export const GEMINI_CHAT_MODELS = [
  { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash (recommended)' },
  { id: 'gemini-3.7-flash', label: 'Gemini 3.7 Flash' },
  { id: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash' },
  { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash' },
  { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash-Lite (fastest)' },
  { id: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro (most capable)' },
  // Kept for keys that predate the restriction and can still reach them.
  { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash (legacy)' },
  { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro (legacy)' },
];

/**
 * Order to fall back through when a requested model is gone or unreachable.
 * Anything the key offers that is not named here still beats failing, so this
 * is a ranking rather than an allow-list.
 */
export const GEMINI_MODEL_PREFERENCE = GEMINI_CHAT_MODELS.map((m) => m.id);

/**
 * Models that cannot answer a text prompt, whatever else they are good at.
 *
 * `ListModels` returns the whole catalogue from one endpoint — image, video,
 * speech, music, embedding — so a naive "first model the key has" would
 * cheerfully send a market question to a text-to-speech model.
 */
const NOT_CHAT = [
  'tts', 'transcribe', 'live', 'image', 'embedding',
  'veo', 'lyria', 'imagen', 'robotics', 'computer-use', 'aqa',
];

export function isGeminiChatModel(id) {
  const lower = (id || '').toLowerCase();
  if (!lower.startsWith('gemini')) return false;
  return !NOT_CHAT.some((bad) => lower.includes(bad));
}

/** Best chat model out of what a key actually offers. */
export function pickGeminiModel(available) {
  const usable = (available || []).filter(isGeminiChatModel);
  if (!usable.length) return null;
  for (const preferred of GEMINI_MODEL_PREFERENCE) {
    if (usable.includes(preferred)) return preferred;
  }
  // Nothing recognised. Prefer the highest version string rather than the
  // first the API happened to list, so a newer catalogue beats a stale one.
  return [...usable].sort((a, b) => b.localeCompare(a, 'en', { numeric: true }))[0];
}

const ALLOWED = new Set(GEMINI_CHAT_MODELS.map((m) => m.id));

export function resolveGeminiModel(requested) {
  if (requested && ALLOWED.has(requested)) return requested;
  const envModel = process.env.GEMINI_MODEL?.trim();
  if (envModel) return envModel;
  return DEFAULT_GEMINI_MODEL;
}

/** True when a provider error means "that model is gone", not "bad key". */
export function isMissingGeminiModel(message) {
  return /not found|not supported|does not exist|do not have access|NOT_FOUND|unsupported/i
    .test(message || '');
}
