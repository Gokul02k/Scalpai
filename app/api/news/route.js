import { newsMarketImpact } from '../../lib/suggestion.js';

export const dynamic = 'force-dynamic';

function timeAgo(ts) {
  const diff = Math.floor((Date.now() - ts) / 60000);
  if (diff < 60) return `${diff}m ago`;
  if (diff < 1440) return `${Math.floor(diff / 60)}h ago`;
  return `${Math.floor(diff / 1440)}d ago`;
}

function mapNewsItem(item, stocks = []) {
  const title = item.title || '';
  const lower = title.toLowerCase();
  let cat = 'Market';
  if (/earn|quarter|revenue|profit/.test(lower)) cat = 'Earnings';
  else if (/bank|auto|it |pharma|sector/.test(lower)) cat = 'Sector';
  else if (/rbi|gdp|inflation|fed|crude|oil/.test(lower)) cat = 'Global';
  else if (/break|support|resist|technical/.test(lower)) cat = 'Technical';
  else if (/deal|jv|merger|ipo/.test(lower)) cat = 'Corporate';

  let sentiment = 'neutral';
  if (/surge|rally|gain|beat|buy|inflow|up /.test(lower)) sentiment = 'positive';
  if (/fall|drop|miss|cut|down |loss|outflow/.test(lower)) sentiment = 'negative';

  return {
    id: item.uuid || item.link || title,
    headline: title,
    detail: item.summary || title,
    time: item.providerPublishTime ? timeAgo(item.providerPublishTime * 1000) : 'Recent',
    cat,
    impact: title.length > 80 ? 'HIGH' : 'MEDIUM',
    sentiment,
    stocks: stocks.length ? stocks : ['NIFTY'],
    link: item.link,
    source: item.publisher || 'Yahoo Finance',
  };
}

async function fetchYahooNews(query) {
  const url = `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=0&newsCount=12`;
  const res = await fetch(url, {
    cache: 'no-store',
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ScalpAI/1.0)' },
  });
  if (!res.ok) return [];
  const data = await res.json();
  return data?.news || [];
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const stocksParam = searchParams.get('stocks') || '';
  const stocks = stocksParam ? stocksParam.split(',').filter(Boolean) : [];

  try {
    const [marketNews, ...stockNewsLists] = await Promise.all([
      fetchYahooNews('NIFTY India stock market'),
      ...stocks.slice(0, 5).map(s => fetchYahooNews(`${s} NSE India`)),
    ]);

    const items = marketNews.map(n => mapNewsItem(n));
    for (let i = 0; i < stocks.length && i < stockNewsLists.length; i++) {
      items.push(...stockNewsLists[i].slice(0, 3).map(n => mapNewsItem(n, [stocks[i]])));
    }

    const seen = new Set();
    const unique = items.filter(n => {
      if (seen.has(n.headline)) return false;
      seen.add(n.headline);
      return true;
    }).map(n => ({ ...n, marketImpact: newsMarketImpact(n) }));

    const pos = unique.filter(n => n.sentiment === 'positive').length;
    const neg = unique.filter(n => n.sentiment === 'negative').length;
    let overview = 'Markets mixed with no dominant trend in recent headlines.';
    if (pos > neg + 2) overview = `Markets biased positive — ${pos} bullish headlines vs ${neg} bearish. FII flows and sector strength cited in recent news.`;
    else if (neg > pos + 2) overview = `Markets under pressure — ${neg} negative headlines. Global cues and earnings misses weighing on sentiment.`;

    return Response.json(
      { news: unique.slice(0, 20), overview, source: 'yahoo' },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    console.error('News fetch error:', error);
    return Response.json({ news: [], overview: '', error: 'Failed to fetch news' }, { status: 502 });
  }
}
