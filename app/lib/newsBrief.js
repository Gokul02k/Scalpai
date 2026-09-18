/**
 * The AI market brief: what we ask for, and how the answer is read back.
 *
 * ## Why a model cannot simply be asked "what is the news"
 *
 * A language model's weights stop at a training cutoff. Asked for today's
 * market news with no way to look it up, it does not decline — it writes a
 * fluent, plausible, entirely invented session: a NIFTY close to four digits, a
 * reason for it, an RBI decision that never happened. In a dashboard somebody
 * trades from, that is the worst failure available, because invented numbers
 * are indistinguishable from real ones once they are on the screen.
 *
 * So every brief is grounded in something before the model sees it:
 *
 *   - **Live prices** come from the app's own feed and are handed over as
 *     facts, with an instruction not to invent or adjust any number. The model
 *     explains them; it does not source them.
 *   - **Real headlines** the app already fetched are passed in full, so there
 *     is genuine material to organise even when nothing else is available.
 *   - **Web search**, where the provider has it — Google Search grounding on
 *     Gemini, the Compound systems on Groq. This is the only thing that makes
 *     a brief genuinely current rather than a rearrangement of what we sent.
 *
 * Whether search actually ran is reported back to the reader rather than
 * assumed, because "today's brief" and "a summary of eight headlines we already
 * had" are different products and only one of them is worth refreshing.
 */

/** The sections a brief is organised into, in the order they are shown. */
export const BRIEF_SECTIONS = [
  { id: 'nifty', label: 'NIFTY 50', hint: 'the index itself — level, move, what drove it' },
  { id: 'india', label: 'India market', hint: 'breadth, sectors, FII/DII flows, rupee, policy' },
  { id: 'gold', label: 'Gold', hint: 'domestic and global gold, and why it moved' },
  { id: 'silver', label: 'Silver', hint: 'silver, including where it diverges from gold' },
  { id: 'watch', label: 'What to watch', hint: 'what lands next and could move these' },
];

const SECTION_IDS = BRIEF_SECTIONS.map((s) => s.id);

export const BRIEF_SYSTEM = `You are the market desk for ScalpAI, an Indian markets dashboard. You write one short daily brief on NIFTY, the broader India market, gold and silver.

Rules, in order of importance:
1. NEVER invent a number. Every price, level, percentage and date must come from the LIVE DATA block, the HEADLINES block, or a web search result. If you do not have a number, describe the move in words instead of guessing one.
2. Indian context: NSE/BSE, IST, rupees. Gold and silver mean the domestic contract unless you say otherwise.
3. If you genuinely have nothing current for a section, write "No notable news." for it. Padding a section with generic market commentary is worse than leaving it empty.
4. Attribute anything surprising: say which source said it.
5. Under 60 words per section. Short, factual lines. No preamble, no sign-off, no disclaimer — the app adds its own.

Format your whole reply as exactly these five blocks, each header on its own line:

[NIFTY]
- one point per line
[INDIA]
- one point per line
[GOLD]
- one point per line
[SILVER]
- one point per line
[WATCH]
- one point per line`;

/** IST, which is the only timezone the brief is written in. */
function istStamp(now = new Date()) {
  return now.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function priceLine(label, p) {
  if (!p || !Number.isFinite(p.cur)) return `${label}: no live price`;
  const prev = Number.isFinite(p.prev) ? p.prev : null;
  if (prev == null || prev === 0) return `${label}: ${p.cur}`;
  const chg = p.cur - prev;
  const pct = (chg / prev) * 100;
  const sign = chg >= 0 ? '+' : '';
  return `${label}: ${p.cur.toFixed(2)} (${sign}${chg.toFixed(2)}, ${sign}${pct.toFixed(2)}% vs previous close ${prev.toFixed(2)})`;
}

/**
 * The prompt for one brief.
 *
 * The live block is labelled as authoritative and the headline block as
 * material, because the model treats an unlabelled list as equally citable and
 * will happily report a three-day-old headline as today's session.
 */
export function buildBriefPrompt({ prices = {}, headlines = [], marketStatus, now } = {}) {
  const lines = [
    `Right now it is ${istStamp(now)} IST.`,
    marketStatus ? `Market status: ${marketStatus}.` : null,
    '',
    "LIVE DATA — these figures are from the dashboard's own feed. Use them exactly as given; do not adjust or replace them.",
    priceLine('NIFTY 50', prices.NIFTY),
    priceLine('SENSEX', prices.SENSEX),
    priceLine('Gold (GOLDBEES ETF proxy)', prices.GOLD),
    priceLine('Silver (SILVERBEES ETF proxy)', prices.SILVER),
  ].filter((l) => l !== null);

  if (headlines.length) {
    lines.push('', `HEADLINES the dashboard already has (${headlines.length}, newest first). Real but not necessarily complete or current:`);
    for (const h of headlines.slice(0, 18)) {
      const when = h.time ? ` [${h.time}]` : '';
      const src = h.source ? ` — ${h.source}` : '';
      lines.push(`- ${h.headline}${when}${src}`);
    }
  } else {
    lines.push('', 'HEADLINES: none available from the dashboard feed.');
  }

  lines.push(
    '',
    'Search the web for anything more current than the above where you can.',
    'Now write the five blocks:',
    BRIEF_SECTIONS.map((s) => `[${s.id.toUpperCase()}] — ${s.hint}`).join('\n'),
  );

  return lines.join('\n');
}

// Headers a model actually produces when asked for `[NIFTY]`. The bracket form
// is what the prompt specifies, but markdown leaks in regardless — the same
// request comes back as `## NIFTY`, `**NIFTY**` or `NIFTY:` often enough that
// insisting on one spelling would throw away a perfectly good answer.
const HEADER = new RegExp(
  `^\\s*(?:[#*_\\->\\s]*)\\[?\\s*(${SECTION_IDS.join('|')})\\s*\\]?\\s*(?:[*_#:\\-–—]*)\\s*$`,
  'i'
);

/** Strip the markdown a model adds even when asked for plain lines. */
function cleanLine(line) {
  return line
    .replace(/^\s*(?:[-*•‣▪]|\d+[.)])\s*/, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/`(.+?)`/g, '$1')
    // Gemini returns grounded text with trailing citation markers like [1][3].
    .replace(/\s*\[\d+(?:,\s*\d+)*\]/g, '')
    .trim();
}

const NOTHING = /^no (?:notable|major|significant|new)\b.*$/i;

/**
 * Read a model's reply into sections.
 *
 * Deliberately lenient, and deliberately lossless. A brief that arrives in an
 * unexpected shape is still the answer the user waited and paid for, so a
 * parse that recognises nothing returns the whole text as one section rather
 * than an empty result — showing something imperfect beats showing nothing and
 * blaming the model.
 */
export function parseBrief(text) {
  const raw = String(text || '').trim();
  if (!raw) return { sections: [], unstructured: null };

  const found = new Map();
  let current = null;

  for (const line of raw.split(/\r?\n/)) {
    const header = line.match(HEADER);
    if (header) {
      current = header[1].toLowerCase();
      if (!found.has(current)) found.set(current, []);
      continue;
    }
    const cleaned = cleanLine(line);
    if (!cleaned) continue;
    if (current) found.get(current).push(cleaned);
  }

  if (!found.size) {
    // No headers at all. Keep every paragraph rather than discarding the reply.
    const points = raw.split(/\n\s*\n|\r?\n/).map(cleanLine).filter(Boolean);
    return { sections: [], unstructured: points };
  }

  const sections = BRIEF_SECTIONS
    .filter((s) => found.has(s.id))
    .map((s) => {
      const points = found.get(s.id);
      return {
        id: s.id,
        label: s.label,
        points,
        // Tracked rather than filtered out: a section the model had nothing for
        // is a fact about the day, and dropping it looks like a failed request.
        empty: points.length === 0 || (points.length === 1 && NOTHING.test(points[0])),
      };
    });

  return { sections, unstructured: null };
}

/**
 * Hosts worth naming next to a brief, shortened to something readable.
 *
 * Grounded replies cite redirect URLs on the provider's own domain, which are
 * long, opaque and identical to each other — so the title is preferred and the
 * host is only a fallback.
 */
export function tidySource(source = {}) {
  const title = (source.title || '').trim();
  const url = (source.url || '').trim();
  if (title) return { title: title.replace(/^www\./, ''), url };
  if (!url) return null;
  try {
    return { title: new URL(url).hostname.replace(/^www\./, ''), url };
  } catch {
    return { title: url.slice(0, 40), url };
  }
}

/** Drop duplicate sources, keeping first appearance order. */
export function dedupeSources(list = []) {
  const seen = new Set();
  const out = [];
  for (const s of list) {
    const tidy = tidySource(s);
    if (!tidy) continue;
    const key = tidy.url || tidy.title;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tidy);
  }
  return out;
}
