/**
 * The EMA / VWAP cross, as a live reading.
 *
 * Mirrors `engine/core/vwap_cross.py` line for line and is diffed against it
 * in `test_vwap_cross_parity.py`, so the panel on the screen and the number in
 * the engine README describe the same rule.
 *
 * What the backtest found, because it decides how this may be presented: over
 * the 246 archived sessions that carry volume the rule returns **-3.71 index
 * points a trade before costs and -9.71 after**, at a 25.4% win rate, with
 * neither year positive. So `vwapCrossSignal` reports two things rather than
 * one — what the rule says, and whether the rule's own reward:risk test would
 * have allowed it. On the measured sample that test refuses 66% of crosses,
 * and a panel showing only the first half would be advertising the losing
 * version of the strategy.
 *
 * Two things this has to carry that a chart does not:
 *
 *  - **VWAP needs volume, and NIFTY is an index.** Only 269 of 2,260 archived
 *    sessions carry any. Where volume is absent this returns
 *    `available: false` rather than a direction, because averaging closes and
 *    calling it VWAP produces a line identical to price and a signal that
 *    fires on nearly every bar. Note this is stricter than
 *    `calcIntradaySession`, which falls back for its other callers.
 *  - **The last bar may still be printing.** A cross read on an unfinished bar
 *    can un-fire, so `lastBarTime` is reported for the caller to say so.
 */
import { calcEMA, calcSupportResistance } from './indicators';

export const LONG = 'long';
export const SHORT = 'short';

/** The stop the strategy is stated with, and the contract it applies to. */
export const DEFAULT_RUPEE_STOP = 800;
export const NIFTY_LOT_SIZE = 75;
/** At-the-money delta on a NIFTY weekly, from the measured chain in
 *  `engine/backtest/calibrate.py`. The rupee conversion turns on it. */
export const ATM_DELTA = 0.52;

/**
 * Index points of adverse move that costs `rupees` on one long option.
 *
 * Premium moves by `delta` per point of index, so the index distance is
 * (rupees / lot) / delta. Exact only at entry: delta grows into a winning move
 * and shrinks out of a losing one.
 */
export function stopPoints(rupees = DEFAULT_RUPEE_STOP, lot = NIFTY_LOT_SIZE, delta = ATM_DELTA) {
  return rupees / lot / delta;
}

/**
 * Direction if EMA changed sides against VWAP, else null.
 *
 * Touching counts as crossing: an EMA that has arrived at VWAP has left the
 * side it was on, and requiring an overshoot would drop signals silently.
 */
export function crossDirection(prevEma, prevVwap, nowEma, nowVwap) {
  if (prevEma < prevVwap && nowEma >= nowVwap) return LONG;
  if (prevEma > prevVwap && nowEma <= nowVwap) return SHORT;
  return null;
}

/**
 * Running session VWAP after each bar; null until any volume has traded.
 *
 * A zero-volume bar does not corrupt the average, it simply does not
 * participate: it contributes nothing to either side of `sum(tp*v)/sum(v)`, so
 * VWAP after it equals VWAP before it. This matters in practice because live
 * feeds pad the tail of a session with zero-volume bars, and treating those as
 * a hole would blank the reading exactly when it is being watched.
 *
 * The genuinely undefined case is a session where nothing has traded at all —
 * 0/0 — and that is what null marks. NIFTY is an index and carries no volume
 * of its own, so this is the common case on some feeds. Averaging closes
 * instead would produce a line identical to price.
 */
export function sessionVwaps(session = []) {
  const out = [];
  let pv = 0;
  let vol = 0;
  for (const c of session) {
    const v = c.vol || 0;
    if (v > 0) {
      pv += ((c.h + c.l + c.c) / 3) * v;
      vol += v;
    }
    out.push(vol > 0 ? pv / vol : null);
  }
  return out;
}

/**
 * Whether every bar of the session traded.
 *
 * A data-quality test, deliberately separate from the definition of VWAP
 * above. `engine/backtest/vwap_cross.py` requires it because a session where
 * volume appears sporadically produces a VWAP that lurches as the weighting
 * arrives. Live readings do not apply it — a padded tail is not a broken
 * session.
 */
export function fullyVolumed(session = []) {
  return session.length > 0 && session.every((c) => (c.vol || 0) > 0);
}

const istDay = (ts) => new Date(ts).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

const round2 = (v) => Math.round(v * 100) / 100;

/**
 * Where the EMA/VWAP cross stands right now, and whether it is tradeable.
 *
 * `action` is the rule's own answer. `gate` is whether the reward:risk test
 * the backtest applied would have taken it. They disagree often, and the
 * caller is expected to show both.
 */
export function vwapCrossSignal(candles = [], opts = {}) {
  const { emaPeriod = 9, minRr = 1.5, srLookback = 20 } = opts;
  const stopPts = opts.stopPts == null ? stopPoints() : opts.stopPts;
  // Positions in the caller's array are kept alongside the usable bars, so a
  // reported cross index still points at the right candle after undated bars
  // are dropped. The chart draws markers from these, and an index into a
  // filtered copy would silently place them on the wrong bar.
  const rows = [];
  const positions = [];
  candles.forEach((c, i) => {
    if (c && c.ts != null) {
      rows.push(c);
      positions.push(i);
    }
  });
  const unavailable = {
    available: false,
    volumed: false,
    action: 'HOLD',
    label: 'NO DATA',
    fresh: false,
    bias: null,
    crosses: [],
    lastCross: null,
    levels: null,
    gate: null,
  };

  if (rows.length < emaPeriod + 2) return { ...unavailable, reason: 'not enough bars' };

  const today = istDay(rows[rows.length - 1].ts);
  const session = rows.filter((c) => istDay(c.ts) === today);
  if (session.length < 2) return { ...unavailable, reason: 'session has not started' };

  const vwaps = sessionVwaps(session);
  if (vwaps[vwaps.length - 1] === null) {
    // The important branch. An index feed where nothing has traded has no
    // VWAP, and saying so is the whole point of this module.
    return {
      ...unavailable,
      reason: 'no volume on this feed — VWAP is undefined',
      label: 'NO VWAP',
    };
  }

  // EMA runs continuously across sessions, which is what the chart draws, so
  // it is computed on the full series and indexed into for today.
  const emas = calcEMA(rows.map((c) => c.c), emaPeriod);
  const base = rows.length - session.length;

  const crosses = [];
  for (let i = 1; i < session.length; i++) {
    // Bars before the session's first trade have no VWAP to be either side of,
    // so they cannot produce a cross.
    if (vwaps[i - 1] === null || vwaps[i] === null) continue;
    const direction = crossDirection(emas[base + i - 1], vwaps[i - 1], emas[base + i], vwaps[i]);
    if (direction) {
      crosses.push({
        index: positions[base + i],
        direction,
        time: session[i].t || '',
        price: round2(session[i].c),
        barsAgo: session.length - 1 - i,
      });
    }
  }

  const lastEma = emas[emas.length - 1];
  const lastVwap = vwaps[vwaps.length - 1];
  const last = crosses.length ? crosses[crosses.length - 1] : null;
  const fresh = Boolean(last && last.barsAgo === 0);
  const bias = lastEma >= lastVwap ? LONG : SHORT;

  const action = fresh ? (last.direction === LONG ? 'BUY' : 'SELL') : 'HOLD';
  const label = fresh ? (last.direction === LONG ? 'BUY CE' : 'SELL PE') : 'NO CROSS';

  // Levels for the cross that would be acted on, priced from the last close
  // and the levels visible now. Reported even when the gate refuses, because
  // the refusal is only legible next to the numbers that caused it.
  const entry = round2(rows[rows.length - 1].c);
  const sr = calcSupportResistance(rows.slice(-srLookback), srLookback);
  const direction = fresh ? last.direction : bias;
  const target = direction === LONG ? sr.resistance : sr.support;
  const reward = Math.abs(target - entry);
  const rr = stopPts ? round2(reward / stopPts) : null;

  let gate;
  if ((direction === LONG && target <= entry) || (direction === SHORT && target >= entry)) {
    gate = { passes: false, reason: `price is already past the nearest level (${target})` };
  } else if (rr !== null && rr < minRr) {
    gate = {
      passes: false,
      reason: `${reward.toFixed(0)}-pt target against a ${stopPts.toFixed(0)}-pt stop `
        + `is ${rr.toFixed(2)}:1, under the ${minRr}:1 floor`,
    };
  } else {
    gate = { passes: true, reason: `${rr.toFixed(2)}:1 clears the ${minRr}:1 floor` };
  }

  return {
    available: true,
    reason: null,
    volumed: true,
    ema: round2(lastEma),
    vwap: round2(lastVwap),
    gapPts: round2(lastEma - lastVwap),
    bias,
    action,
    label,
    fresh,
    lastCross: last,
    crosses,
    crossesToday: crosses.length,
    lastBarTime: rows[rows.length - 1].t || '',
    levels: {
      entry,
      stop: round2(direction === LONG ? entry - stopPts : entry + stopPts),
      target: round2(target),
      stopPts: round2(stopPts),
      rr,
    },
    gate,
  };
}
