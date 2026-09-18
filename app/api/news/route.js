export const dynamic = 'force-dynamic';

/**
 * Headlines for the dashboard.
 *
 * ## Why this is not Yahoo any more
 *
 * This route used to call Yahoo's `/v1/finance/search` with `newsCount=12`. It
 * still answers, still returns HTTP 200, and now returns `news: []` — so the
 * News tab had a working feed that silently went empty, with no error anywhere
 * to say so. A source that fails by returning nothing is worse than one that
 * fails loudly, because nothing about the response says it is broken.
 *
 * Google News' RSS search needs no key, covers the Indian financial press the
 * dashboard actually cares about (Moneycontrol, Livemint, Economic Times,
 * Business Standard) and carries a real publish time and publisher per item.
 * Yahoo is kept behind it as a fallback, on `query1` — the host that still
 * returns a handful of items where `query2` returns none.
 *
 * ## On the fields that are guesses
 *
 * `cat` and `sentiment` are keyword heuristics, and they are labelled as such
 * here because they do not stay in this file: `sentiment` is counted by the
 * portfolio suggestion as a mild factor, so changing or removing it moves
 * recommendations. They are kept deliberately crude and never presented as
 * analysis. The AI brief in `api/news/brief` is what actually reads the news.
 *
 * A third guess used to ship beside them — `impact: title.length > 80 ? 'HIGH'
 * : 'MEDIUM'`, a severity badge decided by how long the headline was — along
 * with a `marketImpact` sentence picked from a table by keyword. Both are gone.
 * Neither had a reader left once the brief existed, and a fabricated severity
 * is most harmful exactly where it was shown: at the top of the card, which is
 * what a reader scans first.
 */

const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; ScalpAI/1.0)' };

function timeAgo(ms) {
  const diff = Math.floor((Date.now() - ms) / 60000);
  if (diff < 1) return 'just now';
  if (diff < 60) return `${diff}m ago`;
  if (diff < 1440) return `${Math.floor(diff / 60)}h ago`;
  return `${Math.floor(diff / 1440)}d ago`;
}

const ENTITIES = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'",
  '&#39;': "'", '&nbsp;': ' ', '&#160;': ' ',
};

function decodeEntities(s = '') {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&[a-z]+;|&#\d+;/gi, (m) => ENTITIES[m.toLowerCase()] ?? m)
    .trim();
}

function tagText(block, tag) {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  if (!m) return null;
  return decodeEntities(m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1'));
}

/**
 * One RSS item into a headline.
 *
 * Google News titles arrive as "Headline - Publisher". The suffix is stripped
 * because it is already carried in `<source>`, and leaving it duplicated the
 * publisher on every card and wasted the width that the headline needs on a
 * phone. Only the last separator is cut, so a headline that legitimately
 * contains " - " keeps everything before the publisher.
 */
function fromRssItem(block, stocks = []) {
  const rawTitle = tagText(block, 'title');
  if (!rawTitle) return null;

  const source = tagText(block, 'source');
  let headline = rawTitle;
  if (source && headline.endsWith(` - ${source}`)) {
    headline = headline.slice(0, -(source.length + 3)).trim();
  }

  const pub = tagText(block, 'pubDate');
  const ts = pub ? Date.parse(pub) : NaN;

  return {
    id: tagText(block, 'guid') || tagText(block, 'link') || headline,
    headline,
    time: Number.isFinite(ts) ? timeAgo(ts) : 'Recent',
    ts: Number.isFinite(ts) ? ts : 0,
    link: tagText(block, 'link'),
    source: source || 'Google News',
    stocks: stocks.length ? stocks : ['NIFTY'],
  };
}

async function fetchGoogleNews(query, stocks = []) {
  const params = new URLSearchParams({ q: query, hl: 'en-IN', gl: 'IN', ceid: 'IN:en' });
  try {
    const res = await fetch(`https://news.google.com/rss/search?${params}`, {
      cache: 'no-store',
      headers: UA,
    });
    if (!res.ok) return [];
    const xml = await res.text();
    const items = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
    return items.map((b) => fromRssItem(b, stocks)).filter(Boolean);
  } catch {
    return [];
  }
}

async function fetchYahooNews(query, stocks = []) {
  const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=0&newsCount=12`;
  try {
    const res = await fetch(url, { cache: 'no-store', headers: UA });
    if (!res.ok) return [];
    const data = await res.json();
    return (data?.news || []).map((n) => {
      const ts = n.providerPublishTime ? n.providerPublishTime * 1000 : NaN;
      return {
        id: n.uuid || n.link || n.title,
        headline: n.title || '',
        time: Number.isFinite(ts) ? timeAgo(ts) : 'Recent',
        ts: Number.isFinite(ts) ? ts : 0,
        link: n.link,
        source: n.publisher || 'Yahoo Finance',
        stocks: stocks.length ? stocks : ['NIFTY'],
      };
    }).filter((n) => n.headline);
  } catch {
    return [];
  }
}

// Rough buckets for scanning, and a mild factor in the portfolio suggestion.
// Neither is analysis — see the note at the top of the file.
function classify(item) {
  const lower = item.headline.toLowerCase();
  let cat = 'Market';
  if (/earn|quarter|revenue|profit/.test(lower)) cat = 'Earnings';
  else if (/gold|silver|bullion|mcx/.test(lower)) cat = 'Commodity';
  else if (/bank|auto|it |pharma|sector/.test(lower)) cat = 'Sector';
  else if (/rbi|gdp|inflation|fed|crude|oil|rupee/.test(lower)) cat = 'Global';
  else if (/deal|jv|merger|ipo/.test(lower)) cat = 'Corporate';

  let sentiment = 'neutral';
  if (/surge|rally|gain|beat|buy|inflow|jump|up /.test(lower)) sentiment = 'positive';
  if (/fall|drop|miss|cut|down |loss|outflow|slump|slide/.test(lower)) sentiment = 'negative';

  return { ...item, cat, sentiment };
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const stocksParam = searchParams.get('stocks') || '';
  const stocks = stocksParam ? stocksParam.split(',').filter(Boolean) : [];

  try {
    // Gold and silver get their own query. They are two of the four things the
    // dashboard follows, and a NIFTY-shaped search returned almost nothing
    // about either — so the commodity half of the brief had no material.
    const [market, commodity, ...perStock] = await Promise.all([
      fetchGoogleNews('NIFTY 50 Sensex India stock market'),
      fetchGoogleNews('gold silver price India MCX', ['GOLD', 'SILVER']),
      ...stocks.slice(0, 5).map((s) => fetchGoogleNews(`${s} share price NSE`, [s])),
    ]);

    let items = [...market.slice(0, 12), ...commodity.slice(0, 6)];
    for (const list of perStock) items.push(...list.slice(0, 3));

    let source = 'google-news';
    if (!items.length) {
      const [yMarket, ...yStock] = await Promise.all([
        fetchYahooNews('NIFTY India stock market'),
        ...stocks.slice(0, 5).map((s) => fetchYahooNews(`${s} NSE India`, [s])),
      ]);
      items = [...yMarket, ...yStock.flatMap((l) => l.slice(0, 3))];
      source = 'yahoo';
    }

    // Dedup by headline but merge stock tags, so a per-stock item keeps its
    // symbol rather than losing it to the market-tagged copy fetched first.
    const byHeadline = new Map();
    for (const n of items) {
      const existing = byHeadline.get(n.headline);
      if (existing) {
        existing.stocks = [...new Set([...existing.stocks, ...n.stocks])];
      } else {
        byHeadline.set(n.headline, { ...n, stocks: [...n.stocks] });
      }
    }

    // Newest first. The old route returned Yahoo's order, which was neither
    // time nor relevance, so a card from yesterday could sit above one from an
    // hour ago with nothing on screen to explain the order.
    const unique = [...byHeadline.values()].map(classify).sort((a, b) => b.ts - a.ts);

    return Response.json(
      { news: unique.slice(0, 24), source },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    console.error('News fetch error:', error);
    return Response.json({ news: [], error: 'Failed to fetch news' }, { status: 502 });
  }
}
