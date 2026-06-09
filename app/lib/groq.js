import { GROQ_VISION_MODEL, resolveGroqModel } from './groqModels';

export const GROQ_SETUP_HINT =
  'Add GROQ_API_KEY from https://console.groq.com in Vercel → Environment Variables, then redeploy.';

export function getGroqKey() {
  const key = process.env.GROQ_API_KEY?.trim();
  if (!key || key === 'your_groq_api_key_here') return null;
  return key;
}

export async function groqChat({
  system,
  messages,
  maxTokens = 1000,
  temperature = 0.5,
  model,
}) {
  const apiKey = getGroqKey();
  if (!apiKey) throw new Error(`GROQ_API_KEY is not set. ${GROQ_SETUP_HINT}`);

  const resolvedModel = resolveGroqModel(model);

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: resolvedModel,
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

export async function groqGenerate({
  system,
  userPrompt,
  maxTokens = 800,
  temperature = 0.35,
  model,
}) {
  return groqChat({
    system,
    messages: [{ role: 'user', content: userPrompt }],
    maxTokens,
    temperature,
    model,
  });
}

export async function groqVision({
  prompt,
  imageBase64,
  mediaType = 'image/jpeg',
  model = GROQ_VISION_MODEL,
  maxTokens = 2000,
}) {
  const apiKey = getGroqKey();
  if (!apiKey) throw new Error(`GROQ_API_KEY is not set. ${GROQ_SETUP_HINT}`);

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: resolveGroqModel(model) || GROQ_VISION_MODEL,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            {
              type: 'image_url',
              image_url: { url: `data:${mediaType};base64,${imageBase64}` },
            },
          ],
        },
      ],
      max_tokens: maxTokens,
      temperature: 0.1,
    }),
    cache: 'no-store',
  });

  const data = await res.json();
  if (!res.ok) {
    const msg = data?.error?.message || `Groq vision API error (${res.status})`;
    throw new Error(msg);
  }

  const text = data.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error('Empty response from Groq vision');
  return text;
}
