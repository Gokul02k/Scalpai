// The index-scalp vote, split into the strategies it is actually made of.
//
// Mirror of engine/core/strategies.py, held identical by a parity test. Any
// change here needs the same change there, or
// engine/tests/test_strategies_parity.py fails.
//
// `suggestion.js` blends every factor into one number, which hides the thing a
// reader most wants to know: *which* kind of edge is talking. A BUY at 78% built
// from "price bounced off support and RSI is oversold" is a different claim from
// the same BUY built from "price broke the opening range and holds above VWAP" —
// the first is a bet on the range holding, the second a bet on it breaking. When
// they disagree the blend reports their difference as low confidence, which reads
// like uncertainty about direction rather than a conflict between two views.
//
// Each strategy is scored by the same `voteFromFactors` over its own subset of
// factors, deliberately with no re-tuned weights or thresholds. Re-tuning per
// strategy would make the numbers incomparable to the blended call and to each
// other, and would be four unmeasured parameter choices on top of an unmeasured
// split.
//
// Two consequences worth knowing before reading anything into these numbers:
//
//   * The subsets are not balanced, because v1's weights are not. Reversion can
//     reach a margin of 6 (support zone alone is weight 4), momentum only 2. So
//     reversion produces louder calls than momentum by construction, and the
//     blended vote is dominated by reversion and session. That is a fact about
//     v1's hand-chosen weights, not a finding about markets.
//   * Confidence rises as a subset shrinks. The vote derives it from
//     `agreement = |margin| / total`, and two factors that agree score a perfect
//     1.0 as easily as eight do — momentum with MACD and EMA both bearish reads
//     85%, which is the same number the blended vote needs eight factors to
//     reach. So the count is reported alongside it and the UI shows both.
//     Damping it per strategy would be a fifth unmeasured parameter and would
//     stop the numbers being comparable to the blended call.
//   * None of these has been backtested on its own. Only the blended call has a
//     measured cost model, a VIX gate and a learned filter behind it. These are
//     for reading the tape, and the UI says so.

import { collectFactors, voteFromFactors } from './suggestion';

// Ordered for display: the two directional families first, then the two that
// describe where price sits rather than where it is going.
export const STRATEGIES = [
  {
    key: 'momentum',
    name: 'Momentum',
    blurb: 'Trend continuation — MACD, EMA 20/50 and the day\'s drift',
  },
  {
    key: 'reversion',
    name: 'Mean reversion',
    blurb: 'Range holding — RSI, Bollinger bands and support/resistance',
  },
  {
    key: 'session',
    name: 'Session',
    blurb: 'Today\'s anchors — VWAP, the 15-min opening range and volume',
  },
  {
    key: 'imbalance',
    name: 'Imbalance',
    blurb: 'Unfilled fair-value gaps left by earlier moves',
  },
];

export const STRATEGY_KEYS = STRATEGIES.map((s) => s.key);

/** The registry as data. The parity harness can only reach functions. */
export function registrySnapshot() {
  return STRATEGIES;
}

// Matched against the factor name produced by `collectFactors`. Ordered, and the
// first match wins, so a more specific pattern must come before a looser one.
//
// The day's change is not in this table: it is added inside the vote rather than
// as a named factor, and it is routed to momentum only. Counting it four times
// would give a trending day a vote in every strategy.
const CLASSIFIERS = [
  [/^macd\b/i, 'momentum'],
  [/^ema\b/i, 'momentum'],
  [/^supertrend\b/i, 'momentum'],
  [/^rsi\b/i, 'reversion'],
  [/^bollinger\b/i, 'reversion'],
  [/^stochastic\b/i, 'reversion'],
  [/^(support|resistance) zone$/i, 'reversion'],
  [/^s\/r mid-range$/i, 'reversion'],
  [/^vwap\b/i, 'session'],
  [/^opening range$/i, 'session'],
  [/^liquidity$/i, 'session'],
  [/^fair value gap$/i, 'imbalance'],
];

/**
 * Which strategy a factor belongs to, or null if it belongs to none.
 *
 * Null is a real answer, not a fallback. The discrete `"STRONG setup"` factors
 * that `collectFactors` adds for non-NIFTY instruments are composites of RSI,
 * MACD and Bollinger together, so assigning them to one strategy would
 * misattribute the others' evidence. ATR is unassigned for the same reason in
 * reverse: it measures volatility, never direction.
 */
export function classifyFactor(name) {
  for (const [pattern, key] of CLASSIFIERS) {
    if (pattern.test(name || '')) return key;
  }
  return null;
}

/** Partition a factor list by strategy. Unassigned factors are kept, not dropped. */
export function splitFactors(factors = []) {
  const out = { unassigned: [] };
  for (const key of STRATEGY_KEYS) out[key] = [];
  for (const f of factors) {
    const key = classifyFactor(f?.name);
    out[key || 'unassigned'].push(f);
  }
  return out;
}

/**
 * Run each strategy over its own factors and return one call per strategy.
 *
 * `unassigned` is reported rather than hidden: when it is non-empty the
 * strategies do not account for the whole blended vote, and a caller comparing
 * them to it needs to know that.
 */
export function runStrategies({
  analysis,
  price,
  chgPct = 0,
  indexSignals = [],
  mode = 'scalp',
  instrument = '',
} = {}) {
  if (!analysis || !price) {
    return { strategies: [], unassigned: 0 };
  }

  const niftyScalp = mode === 'scalp' && instrument === 'NIFTY';
  const split = splitFactors(collectFactors(analysis, indexSignals, { niftyScalp }));

  const strategies = STRATEGIES.map((meta) => {
    const factors = split[meta.key];
    if (!factors.length) {
      // An empty subset is not a HOLD. The vote would report 38% for it, which
      // would read as a weak opinion rather than the absence of one — the
      // session strategy has no factors at all before the market opens.
      return {
        key: meta.key,
        name: meta.name,
        blurb: meta.blurb,
        available: false,
        action: 'NONE',
        confidence: 0,
        buyWeight: 0,
        sellWeight: 0,
        margin: 0,
        factors: [],
      };
    }

    const drift = meta.key === 'momentum' ? chgPct : 0;
    const vote = voteFromFactors(factors, drift, mode);
    return {
      key: meta.key,
      name: meta.name,
      blurb: meta.blurb,
      available: true,
      action: vote.action,
      confidence: vote.confidence,
      buyWeight: vote.buyW,
      sellWeight: vote.sellW,
      margin: +(vote.buyW - vote.sellW).toFixed(2),
      factors,
    };
  });

  return { strategies, unassigned: split.unassigned.length };
}

/**
 * How much the strategies agree, for a one-line summary above the list.
 *
 * Counted over strategies that have factors, and reported as a count rather
 * than a percentage. Four strategies cannot support a percentage that means
 * anything, and the blended call already carries the only confidence number
 * here with a measurement behind it.
 */
export function strategyConsensus(strategies = []) {
  const live = strategies.filter((s) => s.available);
  const buy = live.filter((s) => s.action === 'BUY').length;
  const sell = live.filter((s) => s.action === 'SELL').length;
  const hold = live.filter((s) => s.action === 'HOLD').length;

  let lean = 'MIXED';
  if (live.length === 0) lean = 'NONE';
  else if (buy && !sell) lean = 'BUY';
  else if (sell && !buy) lean = 'SELL';
  else if (!buy && !sell) lean = 'HOLD';

  return { total: live.length, buy, sell, hold, lean, conflict: buy > 0 && sell > 0 };
}
