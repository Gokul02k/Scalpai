export const NIFTY_LOG_MIN_CONFIDENCE = 80;
export const NIFTY_LOG_MAX_ENTRIES = 300;
// Within this window, fluctuations are merged into the same entry instead of
// creating a new row. A new row is only added once this much time has passed.
export const NIFTY_LOG_SESSION_MS = 20 * 60 * 1000;

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

/** Merge server and local logs, keeping the richer version of each row. */
export function mergeNiftyLogLists(serverLogs = [], localLogs = []) {
  const byId = new Map();

  for (const e of [...serverLogs, ...localLogs]) {
    const existing = byId.get(e.id);
    if (!existing) {
      byId.set(e.id, e);
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
