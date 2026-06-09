/** Google Gemini generateContent (free tier with API key from Google AI Studio). */
export async function geminiGenerate({ apiKey, system, userPrompt, maxTokens = 800 }) {
  const model = process.env.GEMINI_MODEL || 'gemini-1.5-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
      generationConfig: {
        maxOutputTokens: maxTokens,
        temperature: 0.35,
      },
    }),
    cache: 'no-store',
  });

  const data = await res.json();

  if (!res.ok) {
    const msg = data?.error?.message || `Gemini API error (${res.status})`;
    throw new Error(msg);
  }

  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text).join('')?.trim();
  if (!text) {
    throw new Error('Empty response from Gemini');
  }
  return text;
}

export function getGeminiKey() {
  return process.env.GEMINI_API_KEY || process.env.GOOGLE_GENERATIVE_AI_API_KEY || null;
}
