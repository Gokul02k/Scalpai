export const NIFTY_LOG_MIN_CONFIDENCE = 80;
export const NIFTY_LOG_MAX_ENTRIES = 300;
// Within this window, fluctuations are merged into the same entry instead of
// creating a new row. A new row is only added once this much time has passed.
export const NIFTY_LOG_SESSION_MS = 20 * 60 * 1000;
// How long a prediction stays "active" before it's marked expired if it never
// touches its target or stop-loss (~one trading session incl. the next open).
export const NIFTY_EVAL_WINDOW_MS = 24 * 60 * 60 * 1000;

// A NIFTY prediction only counts as "passed" once price has moved at least this
// many points in its favour — so a pass reflects a meaningful, tradeable move.
export const NIFTY_MIN_PASS_POINTS = 120;

export const OUTCOME_LABELS = {
  pending: 'Active',
  target: 'Passed',
  stop: 'Failed',
  expired: 'Expired',
};

export function getSignalStrength(confidence) {
  if (confidence >= 90) return { label: 'Very Strong', tier: 3 };
  if (confidence >= 85) return { label: 'Strong', tier: 2 };
  return { label: 'High', tier: 1 };
}

function scoreFactors(factors = []) {
  let buyW = 0;
  let sellW = 0;
  for (const f of factors) {
    const w = f.weight ?? 1;
    if (f.type === 'BUY') buyW += w;
    if (f.type === 'SELL') sellW += w;
  }
  return { buyW, sellW, margin: buyW - sellW };
}

export function buildNiftySignalLogEntry({
  finalCall,
  priceData,
  analysis,
  chgPct = 0,
  indexSignals = [],
  marketStatus = null,
}) {
  const ts = new Date().toISOString();
  const dt = new Date(ts);
  const { buyW, sellW, margin } = scoreFactors(finalCall.factors);
  const strength = getSignalStrength(finalCall.confidence);
  const time = dt.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  return {
    id: `${dt.getTime()}-${finalCall.action}`,
    ts,
    time,
    date: dt.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }),
    firstTs: ts,
    firstTime: time,
    updates: 1,
    instrument: 'NIFTY',
    mode: 'scalp',
    action: finalCall.action,
    label: finalCall.label,
    confidence: finalCall.confidence,
    peakConfidence: finalCall.confidence,
    strength: strength.label,
    strengthTier: strength.tier,
    price: priceData?.cur ?? finalCall.entry ?? null,
    chgPct,
    entry: finalCall.entry,
    target: finalCall.target,
    stopLoss: finalCall.stopLoss,
    rr: finalCall.rr,
    scores: { buyW, sellW, margin },
    factors: (finalCall.factors || []).map((f) => ({
      type: f.type,
      name: f.name,
      reason: f.reason,
      weight: f.weight ?? 1,
    })),
    indexSignals: (indexSignals || []).map((s) => ({
      type: s.type,
      str: s.str,
      reason: s.reason,
    })),
    technical: analysis ? {
      rsi: analysis.rsi,
      macdHist: analysis.macd?.h,
      ema20: analysis.ema20,
      ema50: analysis.ema50,
      support: analysis.sr?.support,
      resistance: analysis.sr?.resistance,
      liquidity: analysis.liquidity?.label,
      liquidityRatio: analysis.liquidity?.ratio,
    } : null,
    marketStatus: marketStatus ? { label: marketStatus.label, detail: marketStatus.detail } : null,
  };
}

/**
 * Decide what to do with a fresh high-confidence signal:
 *  - 'append': start a new log row
 *  - 'update': merge into the most recent row (same action, within the session window)
 *  - 'skip'  : ignore (nothing meaningful changed yet)
 */
export function decideSignalLog(lastEntry, nextEntry) {
  if (!lastEntry) return 'append';
  // Opposite direction is always a brand-new signal worth its own row.
  if (lastEntry.action !== nextEntry.action) return 'append';

  const elapsed = new Date(nextEntry.ts).getTime() - new Date(lastEntry.ts).getTime();
  // Same direction but a real gap in time → treat as a separate signal.
  if (elapsed > NIFTY_LOG_SESSION_MS) return 'append';

  // Same direction within the window: only refresh the row if the read changed
  // (higher peak, or a different confidence reading). Avoids identical re-logs.
  const peak = lastEntry.peakConfidence ?? lastEntry.confidence;
  if (nextEntry.confidence !== lastEntry.confidence || nextEntry.confidence > peak) return 'update';
  return 'skip';
}

/** Fold a new reading into an existing row, keeping the peak and first-seen time. */
export function mergeSignalLogEntry(prev, next) {
  const peakConfidence = Math.max(prev.peakConfidence ?? prev.confidence, next.confidence);
  const strength = getSignalStrength(peakConfidence);
  return {
    ...next,
    id: prev.id,
    firstTs: prev.firstTs ?? prev.ts,
    firstTime: prev.firstTime ?? prev.time,
    updates: (prev.updates ?? 1) + 1,
    peakConfidence,
    strength: strength.label,
    strengthTier: strength.tier,
    outcome: next.outcome ?? prev.outcome,
  };
}

export function isLoggableNiftySignal(finalCall) {
  if (!finalCall) return false;
  if (finalCall.action !== 'BUY' && finalCall.action !== 'SELL') return false;
  return finalCall.confidence >= NIFTY_LOG_MIN_CONFIDENCE;
}

/** Apply merge/append rules to a log list (client + server). */
export function applyNiftyLogUpdate(logs, entry) {
  const last = logs[0] ?? null;
  const decision = decideSignalLog(last, entry);
  if (decision === 'skip') return { logs, changed: false, decision };

  if (decision === 'update') {
    const merged = mergeSignalLogEntry(last, entry);
    return {
      logs: [merged, ...logs.slice(1)].slice(0, NIFTY_LOG_MAX_ENTRIES),
      changed: true,
      decision,
    };
  }

  return {
    logs: [entry, ...logs].slice(0, NIFTY_LOG_MAX_ENTRIES),
    changed: true,
    decision: 'append',
  };
}

const OUTCOME_RANK = { undefined: 0, pending: 1, expired: 2, target: 3, stop: 3 };
const outcomeRank = (e) => OUTCOME_RANK[e?.outcome?.status] ?? 0;

/** Merge server and local logs, keeping the richer version of each row. */
export function mergeNiftyLogLists(serverLogs = [], localLogs = []) {
  const byId = new Map();

  for (const e of [...serverLogs, ...localLogs]) {
    const existing = byId.get(e.id);
    if (!existing) {
      byId.set(e.id, e);
      continue;
    }
    // Prefer the entry with a more advanced (terminal) outcome first.
    const eRank = outcomeRank(e);
    const exRank = outcomeRank(existing);
    if (eRank !== exRank) {
      if (eRank > exRank) byId.set(e.id, e);
      continue;
    }
    const eUpdates = e.updates ?? 1;
    const exUpdates = existing.updates ?? 1;
    const ePeak = e.peakConfidence ?? e.confidence ?? 0;
    const exPeak = existing.peakConfidence ?? existing.confidence ?? 0;
    if (eUpdates > exUpdates || ePeak > exPeak || new Date(e.ts) > new Date(existing.ts)) {
      byId.set(e.id, e);
    }
  }

  return [...byId.values()]
    .sort((a, b) => new Date(b.ts) - new Date(a.ts))
    .slice(0, NIFTY_LOG_MAX_ENTRIES);
}

/**
 * Grade a signal against the actual price path (candles with numeric `ts`).
 * Returns an outcome object, or null if the entry has no tradeable levels.
 * status: 'pending' | 'target' (passed) | 'stop' (failed) | 'expired'.
 */
export function evaluateSignalOutcome(entry, candles = [], nowMs = Date.now()) {
  if (!entry || (entry.action !== 'BUY' && entry.action !== 'SELL')) return null;
  const E = entry.entry;
  const T = entry.target;
  const S = entry.stopLoss;
  if (E == null || T == null || S == null) return null;

  const isBuy = entry.action === 'BUY';
  // Require a minimum favourable move for a pass so it reflects a real move.
  const minPts = entry.instrument === 'NIFTY' ? NIFTY_MIN_PASS_POINTS : 0;
  const effTarget = isBuy ? Math.max(T, E + minPts) : Math.min(T, E - minPts);
  const startMs = new Date(entry.firstTs || entry.ts).getTime();
  // Only grade against the signal's own window so stale signals aren't judged
  // by unrelated later price action (or missing candle history).
  const endMs = startMs + NIFTY_EVAL_WINDOW_MS;
  const path = (candles || []).filter((c) => c && c.ts != null && c.ts >= startMs && c.ts <= endMs);

  let status = 'pending';
  let resolvedTs = null;
  let resolvedPrice = null;
  let mfe = 0; // max favorable excursion (points, >= 0)
  let mae = 0; // max adverse excursion (points, <= 0)
  let lastPrice = entry.price ?? E;

  for (const c of path) {
    if (c.c != null) lastPrice = c.c;
    if (isBuy) {
      mfe = Math.max(mfe, c.h - E);
      mae = Math.min(mae, c.l - E);
    } else {
      mfe = Math.max(mfe, E - c.l);
      mae = Math.min(mae, E - c.h);
    }
    const hitTarget = isBuy ? c.h >= effTarget : c.l <= effTarget;
    const hitStop = isBuy ? c.l <= S : c.h >= S;
    if (hitTarget && hitStop) { status = 'stop'; resolvedTs = c.ts; resolvedPrice = S; break; }
    if (hitTarget) { status = 'target'; resolvedTs = c.ts; resolvedPrice = effTarget; break; }
    if (hitStop) { status = 'stop'; resolvedTs = c.ts; resolvedPrice = S; break; }
  }

  if (status === 'pending' && nowMs - startMs > NIFTY_EVAL_WINDOW_MS) {
    status = 'expired';
    resolvedPrice = lastPrice;
    resolvedTs = path.length ? path[path.length - 1].ts : startMs;
  }

  const ref = resolvedPrice ?? lastPrice;
  const dir = isBuy ? 1 : -1;
  const resultPct = E ? +(((ref - E) / E) * 100 * dir).toFixed(2) : 0;
  const mfePct = E ? +((mfe / E) * 100).toFixed(2) : 0;
  const maePct = E ? +((mae / E) * 100).toFixed(2) : 0;

  return {
    status,
    resolvedTs: resolvedTs ? new Date(resolvedTs).toISOString() : null,
    resolvedPrice: resolvedPrice != null ? +resolvedPrice.toFixed(2) : null,
    resultPct,
    mfePct,
    maePct,
    evaluatedAt: new Date(nowMs).toISOString(),
  };
}

/** Re-grade all non-terminal entries against the latest candles. */
export function applyOutcomeToLogs(logs = [], candles = [], nowMs = Date.now()) {
  let changed = false;
  const next = logs.map((e) => {
    if (e.outcome && e.outcome.status !== 'pending') return e; // freeze terminal results
    const outcome = evaluateSignalOutcome(e, candles, nowMs);
    if (!outcome) return e;
    const prev = e.outcome;
    if (!prev
      || prev.status !== outcome.status
      || prev.resultPct !== outcome.resultPct
      || prev.mfePct !== outcome.mfePct
      || prev.maePct !== outcome.maePct) {
      changed = true;
      return { ...e, outcome };
    }
    return e;
  });
  return { logs: changed ? next : logs, changed };
}

/** Aggregate outcome stats for a set of logged signals. */
export function summarizeOutcomes(logs = []) {
  let passed = 0;
  let failed = 0;
  let active = 0;
  let expired = 0;
  for (const e of logs) {
    const s = e.outcome?.status;
    if (s === 'target') passed += 1;
    else if (s === 'stop') failed += 1;
    else if (s === 'expired') expired += 1;
    else active += 1;
  }
  const resolved = passed + failed;
  const winRate = resolved ? Math.round((passed / resolved) * 100) : null;
  return { passed, failed, active, expired, resolved, winRate };
}
