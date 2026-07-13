export const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';

/** Models users can pick in the AI chat UI (Google Gemini). */
export const GEMINI_CHAT_MODELS = [
  { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash (recommended)' },
  { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash (newest)' },
  { id: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash-Lite (fast)' },
  { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro (most capable)' },
];

const ALLOWED = new Set(GEMINI_CHAT_MODELS.map((m) => m.id));

export function resolveGeminiModel(requested) {
  if (requested && ALLOWED.has(requested)) return requested;
  const envModel = process.env.GEMINI_MODEL?.trim();
  if (envModel) return envModel;
  return DEFAULT_GEMINI_MODEL;
}
