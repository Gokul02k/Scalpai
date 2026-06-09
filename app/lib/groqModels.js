export const DEFAULT_GROQ_MODEL = 'llama-3.3-70b-versatile';
export const GROQ_VISION_MODEL = 'llama-3.2-90b-vision-preview';

/** Models users can pick in the AI chat UI. */
export const GROQ_CHAT_MODELS = [
  { id: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B (best)' },
  { id: 'llama-3.1-8b-instant', label: 'Llama 3.1 8B (fast)' },
  { id: 'gemma2-9b-it', label: 'Gemma 2 9B' },
  { id: 'llama-3.2-90b-vision-preview', label: 'Llama 3.2 90B Vision' },
];

const ALLOWED = new Set(GROQ_CHAT_MODELS.map((m) => m.id));

export function resolveGroqModel(requested) {
  if (requested && ALLOWED.has(requested)) return requested;
  const envModel = process.env.GROQ_MODEL?.trim();
  if (envModel && ALLOWED.has(envModel)) return envModel;
  return DEFAULT_GROQ_MODEL;
}
