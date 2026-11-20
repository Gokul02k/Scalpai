/**
 * The smallest projected move worth scalping, and the gate that applies it.
 *
 * Shared by the dashboard's scalp cards, its NIFTY log and the server cron, so
 * all three agree on what a scalp is. The log used to record the raw call while
 * the card showed the gated one, and its win rate then counted trades the card
 * had said "No scalp trade" to.
 *
 * NIFTY's 50 points is the number the engine and the signal log already grade
 * against; SENSEX is the same 0.2% of price at its own level, which is what
 * makes the two calls comparable. The engine's own verdict, when it is
 * reachable, is layered on top of this by the page and is not part of it.
 */

export const MIN_SCALP_POINTS = { NIFTY: 50, SENSEX: 165 };

/** The call unchanged, or a HOLD when its projected move is under `floor`. */
export function gateScalp(call, floor) {
  if (!call) return call;
  const moveDist = call.target != null ? Math.abs(call.target - call.entry) : 0;
  if ((call.action === 'BUY' || call.action === 'SELL') && moveDist < floor) {
    return {
      ...call,
      action: 'HOLD',
      label: 'No scalp trade',
      target: null,
      stopLoss: null,
      rr: null,
      gatedReason: `Projected move ~${Math.round(moveDist)} pts — under ${floor} pts, not worth scalping.`,
    };
  }
  return call;
}
