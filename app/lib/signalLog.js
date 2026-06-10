export const NIFTY_LOG_MIN_CONFIDENCE = 50;
export const NIFTY_LOG_MAX_ENTRIES = 300;

export function getSignalStrength(confidence) {
  if (confidence >= 75) return { label: 'Strong', tier: 3 };
  if (confidence >= 62) return { label: 'Moderate', tier: 2 };
  return { label: 'Developing', tier: 1 };
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

  return {
    id: `${dt.getTime()}-${finalCall.action}-${finalCall.confidence}`,
    ts,
    time: dt.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    date: dt.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }),
    instrument: 'NIFTY',
    mode: 'scalp',
    action: finalCall.action,
    label: finalCall.label,
    confidence: finalCall.confidence,
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

/** Avoid duplicate rows on every refresh tick. */
export function shouldAppendSignalLog(lastEntry, nextEntry) {
  if (!lastEntry) return true;
  if (lastEntry.action !== nextEntry.action) return true;
  if (nextEntry.confidence >= lastEntry.confidence + 5) return true;
  const elapsed = Date.now() - new Date(lastEntry.ts).getTime();
  if (elapsed > 5 * 60 * 1000 && nextEntry.confidence > lastEntry.confidence) return true;
  return false;
}

export function isLoggableNiftySignal(finalCall) {
  if (!finalCall) return false;
  if (finalCall.action !== 'BUY' && finalCall.action !== 'SELL') return false;
  return finalCall.confidence >= NIFTY_LOG_MIN_CONFIDENCE;
}
