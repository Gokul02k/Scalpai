/** Dashboard symbols → Yahoo symbols. The one copy; routes import it. */
export const YAHOO_INDEX = {
  '^NSEI': '^NSEI',
  '^BSESN': '^BSESN',
  '^NSEBANK': '^NSEBANK',
  '^NSEFI': '^CNXFIN',
  '^NSMIDCP': 'NIFTY_MID_SELECT.NS',
  'GOLDBEES.NS': 'GOLDBEES.NS',
  'SILVERBEES.NS': 'SILVERBEES.NS',
};

export const TF_MAP = {
  '1m': { interval: '1m', range: '1d' },
  '5m': { interval: '5m', range: '5d' },
  '15m': { interval: '15m', range: '5d' },
  '1h': { interval: '60m', range: '1mo' },
  '1d': { interval: '1d', range: '3mo' },
};

const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; ScalpAI/1.0)' };

// ── Yahoo auth (cookie + crumb) for the quoteSummary endpoint ──
let cachedAuth = { cookie: null, crumb: null, ts: 0 };
const AUTH_TTL = 25 * 60 * 1000;

async function getYahooAuth(force = false) {
  const fresh = Date.now() - cachedAuth.ts < AUTH_TTL;
  if (!force && fresh && cachedAuth.crumb) return cachedAuth;

  let cookie = null;
  try {
    const res = await fetch('https://fc.yahoo.com/', { headers: UA, redirect: 'manual', cache: 'no-store' });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
  } catch { /* cookie is best-effort */ }

  let crumb = null;
  try {
    const res = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', {
      headers: { ...UA, ...(cookie ? { Cookie: cookie } : {}) },
      cache: 'no-store',
    });
    const text = (await res.text()).trim();
    if (text && !text.includes('<') && text.length < 40) crumb = text;
  } catch { /* crumb unavailable → fundamentals will be skipped */ }

  cachedAuth = { cookie, crumb, ts: Date.now() };
  return cachedAuth;
}

const num = (o) => (o && typeof o === 'object' ? (o.raw ?? null) : (typeof o === 'number' ? o : null));
const str = (o) => (typeof o === 'string' ? o : null);
const pct = (o) => { const v = num(o); return v == null ? null : +(v * 100).toFixed(2); };

async function fetchQuoteSummary(yahooSymbol) {
  const modules = 'summaryDetail,defaultKeyStatistics,financialData,assetProfile,price';
  for (let attempt = 0; attempt < 2; attempt++) {
    const auth = await getYahooAuth(attempt > 0);
    if (!auth.crumb) return null;
    try {
      const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(yahooSymbol)}?modules=${modules}&crumb=${encodeURIComponent(auth.crumb)}`;
      const res = await fetch(url, {
        headers: { ...UA, ...(auth.cookie ? { Cookie: auth.cookie } : {}) },
        cache: 'no-store',
      });
      if (res.status === 401 || res.status === 403) continue; // stale crumb → refresh & retry
      if (!res.ok) return null;
      const body = await res.json();
      return body?.quoteSummary?.result?.[0] ?? null;
    } catch {
      return null;
    }
  }
  return null;
}

export async function fetchYahooFundamentals(symbol) {
  const yahooSymbol = symbol.includes('.') || symbol.startsWith('^') ? symbol : `${symbol}.NS`;

  // 1) Chart meta + 1y daily closes → guaranteed key stats + moving averages.
  let keyStats = {};
  let name = symbol;
  let currency = 'INR';
  let exchange = null;
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?interval=1d&range=1y`;
    const res = await fetch(url, { headers: UA, cache: 'no-store' });
    if (res.ok) {
      const body = await res.json();
      const result = body?.chart?.result?.[0];
      const meta = result?.meta || {};
      const closes = (result?.indicators?.quote?.[0]?.close || []).filter((c) => c != null && c > 0);
      const ma = (n) => (closes.length >= n ? +(closes.slice(-n).reduce((a, b) => a + b, 0) / n).toFixed(2) : null);
      name = meta.longName || meta.shortName || symbol;
      currency = meta.currency || 'INR';
      exchange = meta.fullExchangeName || meta.exchangeName || null;
      keyStats = {
        price: meta.regularMarketPrice ?? null,
        previousClose: meta.chartPreviousClose ?? meta.previousClose ?? null,
        dayHigh: meta.regularMarketDayHigh ?? null,
        dayLow: meta.regularMarketDayLow ?? null,
        volume: meta.regularMarketVolume ?? null,
        fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh ?? (closes.length ? +Math.max(...closes).toFixed(2) : null),
        fiftyTwoWeekLow: meta.fiftyTwoWeekLow ?? (closes.length ? +Math.min(...closes).toFixed(2) : null),
        fiftyDayAverage: ma(50),
        twoHundredDayAverage: ma(200),
      };
    }
  } catch { /* keyStats stays partial */ }

  // 2) quoteSummary (best-effort) → real fundamentals.
  let fundamentals = null;
  try {
    const qs = await fetchQuoteSummary(yahooSymbol);
    if (qs) {
      const sd = qs.summaryDetail || {};
      const ks = qs.defaultKeyStatistics || {};
      const fd = qs.financialData || {};
      const ap = qs.assetProfile || {};
      const pr = qs.price || {};
      name = str(pr.longName) || str(pr.shortName) || name;
      fundamentals = {
        marketCap: num(sd.marketCap) ?? num(pr.marketCap),
        trailingPE: num(sd.trailingPE) ?? num(ks.trailingPE),
        forwardPE: num(sd.forwardPE) ?? num(ks.forwardPE),
        trailingEps: num(ks.trailingEps),
        priceToBook: num(ks.priceToBook),
        bookValue: num(ks.bookValue),
        beta: num(sd.beta) ?? num(ks.beta),
        dividendYield: pct(sd.dividendYield),
        pegRatio: num(ks.pegRatio),
        returnOnEquity: pct(fd.returnOnEquity),
        profitMargins: pct(fd.profitMargins) ?? pct(ks.profitMargins),
        revenueGrowth: pct(fd.revenueGrowth),
        earningsGrowth: pct(fd.earningsGrowth),
        debtToEquity: num(fd.debtToEquity),
        currentRatio: num(fd.currentRatio),
        targetMeanPrice: num(fd.targetMeanPrice),
        recommendationKey: str(fd.recommendationKey),
        numberOfAnalystOpinions: num(fd.numberOfAnalystOpinions),
        sector: str(ap.sector),
        industry: str(ap.industry),
        summary: str(ap.longBusinessSummary),
      };
      const hasAny = Object.values(fundamentals).some((v) => v != null && v !== '');
      if (!hasAny) fundamentals = null;
    }
  } catch { /* fundamentals unavailable */ }

  return {
    ok: true,
    symbol: yahooSymbol,
    name,
    currency,
    exchange,
    keyStats,
    fundamentals,
    hasFundamentals: Boolean(fundamentals),
  };
}

export async function fetchYahooQuote(symbol = '^NSEI') {
  const yahooSymbol = YAHOO_INDEX[symbol] || symbol;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?interval=1m&range=1d`;

  try {
    const res = await fetch(url, { cache: 'no-store', headers: UA });
    if (!res.ok) return { ok: false, error: `Yahoo HTTP ${res.status}` };

    const body = await res.json();
    const meta = body?.chart?.result?.[0]?.meta;
    if (!meta?.regularMarketPrice) {
      return { ok: false, error: `No Yahoo quote for ${yahooSymbol}` };
    }

    const current = meta.regularMarketPrice;
    const previousClose = meta.chartPreviousClose ?? meta.previousClose ?? current;
    const change = current - previousClose;

    return {
      ok: true,
      data: {
        current,
        high: meta.regularMarketDayHigh ?? current,
        low: meta.regularMarketDayLow ?? current,
        open: meta.regularMarketOpen ?? previousClose,
        previousClose,
        change: +change.toFixed(2),
        changePercent: previousClose ? +((change / previousClose) * 100).toFixed(2) : 0,
        timestamp: (meta.regularMarketTime ?? Date.now() / 1000) * 1000,
        name: meta.shortName || meta.longName,
      },
    };
  } catch (error) {
    return { ok: false, error: error.message || 'Yahoo quote fetch failed' };
  }
}

/**
 * Candles from Yahoo's chart endpoint.
 *
 * Bars with any missing price are dropped rather than zero-filled. Yahoo
 * leaves gaps as nulls, and `null ?? 0` used to plot a bar with a zero low (or
 * open) in the middle of a 24,000-point index, which drew a spike to the floor
 * of the chart and dragged every indicator computed over it.
 *
 * Returns `{ candles, error }` so a route can tell "no bars" from "Yahoo
 * refused"; `fetchYahooCandles` keeps the plain-array shape for the cron.
 */
export async function fetchYahooChart(symbol = '^NSEI', tf = '5m') {
  const yahooSymbol = YAHOO_INDEX[symbol] || symbol;
  const { interval, range } = TF_MAP[tf] || TF_MAP['5m'];

  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?interval=${interval}&range=${range}`;
    const res = await fetch(url, { cache: 'no-store', headers: UA });
    if (!res.ok) return { candles: [], yahooSymbol, error: `Yahoo HTTP ${res.status}` };

    const body = await res.json();
    const result = body?.chart?.result?.[0];
    const timestamps = result?.timestamp || [];
    const q = result?.indicators?.quote?.[0] || {};
    const label = {
      timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit',
      ...(tf === '1d' ? { month: 'short', day: 'numeric' } : {}),
    };

    const candles = [];
    timestamps.forEach((t, i) => {
      const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i];
      if (![o, h, l, c].every((v) => Number.isFinite(v) && v > 0)) return;
      candles.push({
        t: new Date(t * 1000).toLocaleTimeString('en-IN', label),
        ts: t * 1000,
        o: +o.toFixed(2),
        h: +h.toFixed(2),
        l: +l.toFixed(2),
        c: +c.toFixed(2),
        vol: Math.floor(q.volume?.[i] ?? 0),
      });
    });
    return { candles, yahooSymbol, error: null };
  } catch (error) {
    return { candles: [], yahooSymbol, error: error.message || 'Yahoo candles fetch failed' };
  }
}

export async function fetchYahooCandles(symbol = '^NSEI', tf = '5m') {
  return (await fetchYahooChart(symbol, tf)).candles;
}
