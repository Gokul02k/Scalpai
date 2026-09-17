/**
 * The providers the assistant can talk to, in the order they are tried.
 *
 * One list, imported by both the browser and the route handlers, so the
 * settings page cannot offer a provider the server does not know how to reach
 * or name an environment variable the server does not read.
 *
 * `looksRight` is a hint for the settings page and nothing more. Providers
 * change their key formats without notice, so a key that fails the pattern is
 * still saved and still sent — the page says it looks unusual and gets out of
 * the way. Refusing it would be a guess overriding the person holding the key.
 */

export const AI_PROVIDERS = [
  {
    id: 'gemini',
    label: 'Gemini',
    /** Tried first when it has a key. */
    order: 1,
    keyUrl: 'https://aistudio.google.com/apikey',
    keyUrlLabel: 'aistudio.google.com/apikey',
    /** Read only when shared keys are switched on. First match wins. */
    envVars: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    hint: 'Usually starts with AIza',
    looksRight: (key) => /^AIza[\w-]{20,}$/.test(key),
    free: 'Free tier, no card',
  },
  {
    id: 'groq',
    label: 'Groq',
    order: 2,
    keyUrl: 'https://console.groq.com/keys',
    keyUrlLabel: 'console.groq.com/keys',
    envVars: ['GROQ_API_KEY'],
    hint: 'Usually starts with gsk_',
    looksRight: (key) => /^gsk_[A-Za-z0-9]{20,}$/.test(key),
    free: 'Free tier, no card',
  },
];

export const AI_PROVIDER_IDS = AI_PROVIDERS.map((p) => p.id);

export function aiProvider(id) {
  return AI_PROVIDERS.find((p) => p.id === id) || null;
}

/** Placeholders from `.env.example` are not keys. */
export function isPlaceholderKey(value) {
  const v = (value || '').trim();
  return !v || /^your_.*_here$/i.test(v);
}

/**
 * Enough of a key to recognise it again, and not enough to use it.
 *
 * Shown in the settings page so a saved key can be told apart from a different
 * saved key without ever rendering the secret.
 */
export function maskKey(value) {
  const v = (value || '').trim();
  if (!v) return '';
  if (v.length <= 8) return `${v.slice(0, 2)}…`;
  return `${v.slice(0, 4)}…${v.slice(-4)}`;
}
