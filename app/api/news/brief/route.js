import { geminiGenerateGrounded, geminiGenerate, hasGemini } from '../../../lib/gemini';
import { groqGenerateGrounded, groqGenerate, hasGroq, GROQ_SEARCH_MODELS } from '../../../lib/groq';
import { keysFromBody, sharedKeysEnabled } from '../../../lib/aiShared';
import { BRIEF_SYSTEM, buildBriefPrompt, parseBrief, dedupeSources } from '../../../lib/newsBrief';

export const dynamic = 'force-dynamic';

/**
 * The best model available for one market brief.
 *
 * "Best" here is not the general capability ranking used elsewhere. For this
 * one question the only property that matters much is whether the provider can
 * search the web, because a brief that cannot see past its training cutoff is
 * not a brief about today however articulate the model is. So the order is:
 *
 *   1. Gemini with Google Search grounding.
 *   2. Groq's Compound system, which searches server-side.
 *   3. Gemini with no tools.
 *   4. Any Groq chat model, with no search at all.
 *
 * The searchless attempts are worth keeping because they are still useful —
 * they organise and explain the real headlines the page sends up — but they
 * report themselves as ungrounded, so the reader is never told a rearrangement
 * of headlines we already had is the latest news.
 *
 * They also catch the case where a search tool is refused rather than absent: a
 * Gemini model too old for the `google_search` tool rejects the request outright,
 * and without a plain attempt behind it a user holding only a Gemini key would
 * get no brief at all rather than a slightly staler one.
 */
const ungrounded = (text) => ({ text, model: null, searched: false, queries: [], sources: [] });

const ATTEMPTS = [
  {
    provider: 'gemini',
    grounded: true,
    available: (keys) => hasGemini(keys.gemini),
    run: ({ system, userPrompt, keys }) =>
      geminiGenerateGrounded({ system, userPrompt, apiKey: keys.gemini }),
  },
  {
    provider: 'groq',
    grounded: true,
    available: (keys) => hasGroq(keys.groq),
    run: ({ system, userPrompt, keys }) =>
      groqGenerateGrounded({ system, userPrompt, apiKey: keys.groq, model: GROQ_SEARCH_MODELS[0] }),
  },
  {
    provider: 'gemini',
    grounded: false,
    available: (keys) => hasGemini(keys.gemini),
    run: async ({ system, userPrompt, keys }) =>
      ungrounded(await geminiGenerate({ system, userPrompt, maxTokens: 1400, apiKey: keys.gemini })),
  },
  {
    provider: 'groq',
    grounded: false,
    available: (keys) => hasGroq(keys.groq),
    run: async ({ system, userPrompt, keys }) =>
      ungrounded(await groqGenerate({ system, userPrompt, maxTokens: 1400, apiKey: keys.groq })),
  },
];

export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Malformed request' }, { status: 400 });
  }

  const keys = keysFromBody(body);
  const usable = ATTEMPTS.filter((a) => a.available(keys));

  if (!usable.length) {
    return Response.json(
      {
        error: sharedKeysEnabled()
          ? 'No AI key. Add one in Settings → Assistant, or set GEMINI_API_KEY on the server.'
          : 'Add a Gemini or Groq key in Settings → Assistant to get a brief. This deployment does not share one.',
        needsKey: true,
      },
      { status: 503 }
    );
  }

  const system = BRIEF_SYSTEM;
  const userPrompt = buildBriefPrompt({
    prices: body?.prices || {},
    headlines: Array.isArray(body?.headlines) ? body.headlines : [],
    marketStatus: body?.marketStatus,
  });

  const errors = [];
  for (const attempt of usable) {
    try {
      const result = await attempt.run({ system, userPrompt, keys });
      const { sections, unstructured } = parseBrief(result.text);

      // A reply that parsed into nothing at all is not a brief. Falling through
      // to the next provider beats rendering an empty card, and the raw text is
      // still carried so the page can show it rather than lose the answer.
      if (!sections.length && !unstructured?.length) {
        throw new Error('Model returned nothing usable');
      }

      return Response.json({
        sections,
        unstructured,
        provider: attempt.provider,
        model: result.model,
        // What the reader needs to judge the brief: whether anything was looked
        // up, or whether this is only our own headlines, reorganised.
        searched: Boolean(result.searched),
        grounding: attempt.grounded ? (result.searched ? 'web' : 'model') : 'headlines',
        queries: result.queries || [],
        sources: dedupeSources(result.sources || []),
        generatedAt: new Date().toISOString(),
        // Earlier providers that failed. Shown as a note, not an error, since
        // the brief itself succeeded.
        fellBackFrom: errors.length ? errors : undefined,
      });
    } catch (error) {
      console.error(`News brief via ${attempt.provider} failed:`, error.message);
      errors.push(`${attempt.provider}: ${error.message}`);
    }
  }

  // Deduplicated. A rejected key fails the grounded and the plain attempt for
  // the same provider with the same sentence, and reporting it twice reads like
  // two different problems.
  const distinct = [...new Set(errors)];
  return Response.json(
    { error: distinct.join(' | ') || 'Could not reach any AI provider' },
    { status: 502 }
  );
}
