/**
 * Smart-money structure for the chart: liquidity pools, sweeps, breaks, blocks.
 *
 * The SMC/ICT reading of a chart says price moves between pools of resting
 * orders. Stops sit above an obvious high and below an obvious low; taking them
 * out is the point, and the reversal that follows leaves a signature — a break
 * of structure and the candle that caused it.
 *
 * This is an overlay, not a signal. The engine replayed the full setup over
 * nine years of NIFTY 5-minute bars and it loses money after costs (see
 * `engine/backtest/smc_replay.py`), so nothing here feeds `signals.js` or
 * `suggestion.js`. It is here to show where the structure is.
 *
 * Mirrored by `engine/core/smc.py`. `engine/tests/test_smc_parity.py` diffs the
 * two on real candles with zero tolerance, so edit both or neither.
 */

export const BUYSIDE = "buyside";
export const SELLSIDE = "sellside";
export const SHORT = "short";
export const LONG = "long";

const fix2 = (v) => +(+v).toFixed(2);

/**
 * Indices of confirmed swing highs. A high is only a level once `span` bars
 * have printed without exceeding it, so the last `span` bars never appear here
 * however high they are.
 */
export function swingHighs(candles = [], span = 2) {
  const out = [];
  for (let i = span; i < candles.length - span; i++) {
    const h = candles[i].h;
    let ok = true;
    for (let j = i - span; j < i && ok; j++) if (!(candles[j].h <= h)) ok = false;
    for (let j = i + 1; j <= i + span && ok; j++) if (!(candles[j].h < h)) ok = false;
    if (ok) out.push(i);
  }
  return out;
}

export function swingLows(candles = [], span = 2) {
  const out = [];
  for (let i = span; i < candles.length - span; i++) {
    const l = candles[i].l;
    let ok = true;
    for (let j = i - span; j < i && ok; j++) if (!(candles[j].l >= l)) ok = false;
    for (let j = i + 1; j <= i + span && ok; j++) if (!(candles[j].l > l)) ok = false;
    if (ok) out.push(i);
  }
  return out;
}

/**
 * BOS or CHoCH, decided by what the leg before the break was doing. A break
 * continuing the prevailing direction is a break of structure; the first one
 * against it is a change of character.
 */
export function breakKind(candles = [], upto = 0, direction = SHORT, span = 2) {
  const seen = candles.slice(0, upto + 1);
  if (direction === SHORT) {
    const highs = swingHighs(seen, span);
    if (highs.length < 2) return "BOS";
    return seen[highs[highs.length - 1]].h > seen[highs[highs.length - 2]].h ? "CHoCH" : "BOS";
  }
  const lows = swingLows(seen, span);
  if (lows.length < 2) return "BOS";
  return seen[lows[lows.length - 1]].l < seen[lows[lows.length - 2]].l ? "CHoCH" : "BOS";
}

/** Last opposing candle before the displacement that broke structure. */
export function orderBlock(candles = [], breakIndex = 0, direction = SHORT, lookback = 10) {
  const floor = Math.max(breakIndex - lookback, 0);
  for (let i = breakIndex - 1; i >= floor; i--) {
    const bullish = candles[i].c >= candles[i].o;
    if (bullish === (direction === SHORT)) {
      return { index: i, lo: candles[i].l, hi: candles[i].h };
    }
  }
  return null;
}

/**
 * Mark up a series for a chart.
 *
 * A pool traded through and closed back inside is a sweep. A pool traded
 * through and closed beyond is simply gone, and shows as taken rather than
 * swept, because the two mean opposite things.
 */
export function annotateStructure(
  candles = [],
  { span = 2, minSweepPts = 0, obLookback = 10, maxMarks = 6 } = {}
) {
  const empty = { pools: [], sweeps: [], breaks: [], blocks: [] };
  const n = candles.length;
  if (n < span * 2 + 2) return empty;

  const highs = swingHighs(candles, span);
  const lows = swingLows(candles, span);

  const pools = [];
  const sweeps = [];
  const marked = [
    ...highs.map((i) => [i, BUYSIDE]),
    ...lows.map((i) => [i, SELLSIDE]),
  ].sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));

  for (const [idx, side] of marked) {
    const buyside = side === BUYSIDE;
    const price = buyside ? candles[idx].h : candles[idx].l;
    let taken = null;
    for (let j = idx + span + 1; j < n; j++) {
      const bar = candles[j];
      if (!(buyside ? bar.h > price : bar.l < price)) continue;
      taken = j;
      const extreme = buyside ? bar.h : bar.l;
      const closedBack = buyside ? bar.c < price : bar.c > price;
      if (closedBack && Math.abs(extreme - price) >= minSweepPts) {
        sweeps.push({
          index: j,
          poolIndex: idx,
          side,
          price: fix2(price),
          extreme: fix2(extreme),
          depth: fix2(Math.abs(extreme - price)),
        });
      }
      break;
    }
    pools.push({ index: idx, side, price: fix2(price), takenAt: taken, resting: taken === null });
  }

  const breaks = [];
  const used = new Set();
  for (let j = span * 2 + 1; j < n; j++) {
    const close = candles[j].c;
    for (const [indices, key, direction] of [[lows, "l", SHORT], [highs, "h", LONG]]) {
      const prior = indices.filter((i) => i + span < j && !used.has(i));
      if (!prior.length) continue;
      const ref = prior[prior.length - 1];
      const level = candles[ref][key];
      if (direction === SHORT ? close < level : close > level) {
        used.add(ref);
        breaks.push({
          index: j,
          fromIndex: ref,
          level: fix2(level),
          direction,
          kind: breakKind(candles, j, direction, span),
        });
      }
    }
  }

  const blocks = [];
  for (const brk of breaks) {
    const zone = orderBlock(candles.slice(0, brk.index + 1), brk.index, brk.direction, obLookback);
    if (!zone || blocks.some((b) => b.index === zone.index)) continue;
    const proximal = brk.direction === SHORT ? zone.lo : zone.hi;
    let mitigated = false;
    for (let j = brk.index + 1; j < n; j++) {
      if (brk.direction === SHORT ? candles[j].h >= proximal : candles[j].l <= proximal) {
        mitigated = true;
        break;
      }
    }
    blocks.push({
      index: zone.index,
      lo: fix2(zone.lo),
      hi: fix2(zone.hi),
      direction: brk.direction,
      breakIndex: brk.index,
      mitigated,
    });
  }

  return {
    pools: pools.slice(-maxMarks * 2),
    sweeps: sweeps.slice(-maxMarks),
    breaks: breaks.slice(-maxMarks),
    blocks: blocks.slice(-maxMarks),
  };
}
