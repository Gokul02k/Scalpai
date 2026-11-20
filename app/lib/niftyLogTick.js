import { fetchYahooCandles, fetchYahooQuote } from './yahooServer';
import { analyzeFromCandles } from './indicators';
import { generateIndexSignals } from './signals';
import { buildUnifiedSuggestion } from './suggestion';
import {
  buildNiftySignalLogEntry,
  isLoggableNiftySignal,
  applyNiftyLogUpdate,
  applyOutcomeToLogs,
} from './signalLog';
import { getMarketStatus } from './marketHours';
import { getNiftyLogs, saveNiftyLogs, isNiftyLogStorageConfigured } from './niftyLogStore';
import { sendTelegramMessage, formatNiftySignalAlert } from './telegram';
import { getAlertsEnabled } from './alertSettings';
import { MIN_SCALP_POINTS, gateScalp } from './scalpGate';

const DEFAULT_SETT = {
  riskLimit: 10000,
  profitPct: 1.5,
  slPct: 0.8,
  ind: { rsi: true, macd: true, bb: true, ema20: true, ema50: true, vol: true },
};

export async function runNiftyLogTick() {
  if (!isNiftyLogStorageConfigured()) {
    return { skipped: true, reason: 'storage_not_configured' };
  }

  const marketStatus = getMarketStatus();
  if (!marketStatus.open) {
    return { skipped: true, reason: 'market_closed', label: marketStatus.label };
  }


  const quote = await fetchYahooQuote('^NSEI');
  if (!quote.ok) {
    return { skipped: true, reason: 'quote_failed', error: quote.error };
  }

  const candles = await fetchYahooCandles('^NSEI', '5m');
  if (!candles.length) {
    return { skipped: true, reason: 'no_candles' };
  }

  // Grade previously logged predictions against the latest price path.
  try {
    const { logs: current } = await getNiftyLogs();
    const graded = applyOutcomeToLogs(current, candles, Date.now());
    if (graded.changed) await saveNiftyLogs(graded.logs);
  } catch { /* grading is best-effort */ }

  const analysis = analyzeFromCandles(candles);
  const price = quote.data.current;
  const prev = quote.data.previousClose;
  const chgPct = prev ? +(((price - prev) / prev) * 100).toFixed(2) : 0;
  const priceData = { cur: price, prev, high: quote.data.high, low: quote.data.low };

  const indexSignals = generateIndexSignals(analysis, price, 'NIFTY', DEFAULT_SETT);
  // Gated as the dashboard's scalp card and log gate it, so a signal too small
  // to scalp is neither logged nor pushed to Telegram.
  const finalCall = gateScalp(buildUnifiedSuggestion({
    analysis,
    price,
    chgPct,
    indexSignals,
    settings: DEFAULT_SETT,
    mode: 'scalp',
    instrument: 'NIFTY',
  }), MIN_SCALP_POINTS.NIFTY);

  if (!isLoggableNiftySignal(finalCall)) {
    return {
      skipped: true,
      reason: 'not_loggable',
      action: finalCall?.action,
      confidence: finalCall?.confidence ?? 0,
    };
  }

  const entry = buildNiftySignalLogEntry({
    finalCall,
    priceData,
    analysis,
    chgPct,
    indexSignals,
    marketStatus,
  });

  const { logs: existing } = await getNiftyLogs();
  const { logs, changed, decision } = applyNiftyLogUpdate(existing, entry);
  if (changed) await saveNiftyLogs(logs);

  // Only an appended row is a new signal. 'update' is the same signal being
  // re-read inside its session window, so alerting on it would spam the chat.
  //
  // The alerts switch is read here, not at the top of the tick: it silences
  // Telegram only. It used to end the tick early, so turning alerts off also
  // stopped the background log and its grading without saying so.
  let alert = { sent: false, reason: `deduped_${decision}` };
  if (decision === 'append') {
    const { enabled } = await getAlertsEnabled();
    alert = enabled
      ? await sendTelegramMessage(formatNiftySignalAlert(logs[0]))
      : { sent: false, reason: 'alerts_disabled' };
  }

  return {
    ok: true,
    changed,
    decision,
    action: entry.action,
    confidence: entry.confidence,
    logCount: logs.length,
    alert,
  };
}
