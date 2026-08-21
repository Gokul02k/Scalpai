/**
 * Server-side client for the Python engine's read-only JSON API.
 *
 * Phase 4's architecture: the engine owns market data, the dashboard renders
 * it. This is the adapter that lets the existing `/api/candles` and
 * `/api/market` routes serve engine data — Fyers-sourced, the same archive the
 * backtest runs on — without the browser learning anything new.
 *
 * Two rules keep it safe to switch on:
 *
 *   - **Opt-in.** Nothing changes unless `ENGINE_URL` is set. On Vercel it is
 *     not, so the dashboard keeps working exactly as it does today.
 *   - **Never fatal.** Any failure — engine down, dead Fyers token, symbol not
 *     archived — returns null and the caller falls through to Yahoo. A view
 *     that goes blank because a background process died is worse than a view
 *     showing a second-best number.
 *
 * Import only from route handlers. It reads server-side env and must never be
 * bundled into the client.
 */

/** Dashboard symbols the engine keeps an archive for. Everything else is Yahoo. */
export const ENGINE_SYMBOLS = {
  '^NSEI': { symbol: 'NIFTY', segment: 'INDEX' },
  '^BSESN': { symbol: 'SENSEX', segment: 'INDEX' },
  '^NSEBANK': { symbol: 'BANKNIFTY', segment: 'INDEX' },
};

const TIMEOUT_MS = 1500;

// The decision endpoint computes an indicator bundle over 375 bars and scores a
// model, so it is slower than a quote and worth waiting longer for: falling
// back here means showing a different call, not a slightly older price.
const DECISION_TIMEOUT_MS = 4000;

export function engineUrl() {
  return process.env.ENGINE_URL || null;
}

export function engineSymbol(dashboardSymbol) {
  return ENGINE_SYMBOLS[dashboardSymbol] || null;
}

async function engineGet(path, params, timeoutMs = TIMEOUT_MS) {
  const base = engineUrl();
  if (!base) return null;

  const url = new URL(path, base);
  for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, v);

  try {
    const res = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    // Deliberately quiet: with the engine stopped this fires on every poll, and
    // a log line per poll would bury anything worth reading.
    return null;
  }
}

/** Candles in the shape the chart already expects, or null to fall back. */
export async function engineCandles(dashboardSymbol, tf) {
  const target = engineSymbol(dashboardSymbol);
  if (!target) return null;

  const body = await engineGet('/candles', { ...target, interval: tf });
  if (!body?.candles?.length) return null;
  // Knowingly behind the tape during market hours — usually a Fyers token that
  // expired overnight. Yahoo's live bars beat the engine's correct-but-old
  // ones, and the engine log says what to re-run.
  if (body.stale) return null;
  return {
    candles: body.candles,
    source: 'engine',
    symbol: dashboardSymbol,
    tf,
    stale: !!body.stale,
    refresh: body.refresh,
  };
}

/**
 * The engine's call for a symbol, with the verdict the paper trader would
 * reach on it — production levels, the VIX gate and the learned filter.
 *
 * Null when the engine is unreachable or has no archive for the symbol, which
 * leaves the caller on its own v1 call. That fallback is a genuinely different
 * decision, not a staler one, so it is worth saying so in the UI.
 */
export async function engineDecision(dashboardSymbol, interval = '5m') {
  const target = engineSymbol(dashboardSymbol);
  if (!target) return null;

  const body = await engineGet(
    '/analysis', { ...target, interval }, DECISION_TIMEOUT_MS
  );
  if (!body?.suggestion || !body?.verdict) return null;
  return {
    symbol: target.symbol,
    price: body.price,
    suggestion: body.suggestion,
    verdict: body.verdict,
    policy: body.policy,
  };
}

/** Quote in the shape `/api/market` already returns, or null to fall back. */
export async function engineQuote(dashboardSymbol) {
  const target = engineSymbol(dashboardSymbol);
  if (!target) return null;

  const q = await engineGet('/quote', target);
  if (!q || q.current == null) return null;
  // The provider did not answer and the last stored bar stood in. That is the
  // right answer with the market shut and the wrong one while it is open, when
  // a live second-best price is worth more than a stale first-best.
  if (q.source === 'engine-archive' && q.marketOpen) return null;
  return {
    current: q.current,
    high: q.high ?? q.current,
    low: q.low ?? q.current,
    open: q.open ?? q.previousClose ?? q.current,
    previousClose: q.previousClose ?? q.current,
    change: +(q.change ?? 0).toFixed(2),
    changePercent: +(q.changePercent ?? 0).toFixed(2),
    timestamp: Date.now(),
    // "fyers" when the provider answered, "engine-archive" when it did not and
    // the last stored bar stood in. The dashboard treats only the former as
    // live, so a dead token shows up as stale rather than as a fresh price.
    source: q.source === 'engine-archive' ? 'engine-archive' : 'fyers',
  };
}
