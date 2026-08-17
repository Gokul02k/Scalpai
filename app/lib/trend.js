// Directional bias for the day, before the open and again after it.
//
// Mirror of engine/core/trend.py, held identical by a parity test. Any change
// here needs the same change there, or engine/tests/test_trend_parity.py fails.
//
// Neither call predicts direction, and both were measured before shipping.
// Over 2,676 sessions, acting on the pre-open call returns -0.032% a day at a
// 47.6% hit rate, worse than holding long. The post-open call over the next 30
// minutes returns -0.005% at 51.6%, against a round trip costing about 0.025%.
// Its confidence does not sort outcomes either. This describes the tape; it is
// not a trade signal, and nothing here feeds signal generation.

import { calcEMA } from "./indicators";

export const TREND_LABELS = {
  UP: "Upward bias",
  DOWN: "Downward bias",
  FLAT: "No clear bias",
};

// A call needs this share of the total weight before it is allowed a
// direction. Above a bare majority because the daily series has almost no
// drift, so a 51/49 split is noise wearing a direction.
export const DECISION_MARGIN = 0.2;

function pct(a, b) {
  return b ? ((a - b) / b) * 100 : 0;
}

function fixed(n, d) {
  return +n.toFixed(d);
}

function factor(n, t, w, v) {
  return { n, t, w, v };
}

function sum(xs) {
  let total = 0;
  for (const x of xs) total += x;
  return total;
}

// ── pre-open ───────────────────────────────────────────────────────────────

export function preOpenFactors(daily, vix) {
  const out = [];
  if (!daily || daily.length < 21) return out;

  const closes = daily.map((c) => c.c);
  const prev = daily[daily.length - 1];
  const before = daily[daily.length - 2];
  const last = closes[closes.length - 1];

  const e20 = calcEMA(closes, 20).slice(-1)[0];
  out.push(factor("Daily trend", last > e20 ? "UP" : "DOWN", 2,
    `close ${pct(last, e20) >= 0 ? "+" : ""}${pct(last, e20).toFixed(2)}% vs 20-day EMA`));

  if (closes.length >= 4) {
    const chg3 = pct(last, closes[closes.length - 4]);
    const view = chg3 > 0.5 ? "UP" : chg3 < -0.5 ? "DOWN" : "FLAT";
    out.push(factor("3-day momentum", view, 1,
      `${chg3 >= 0 ? "+" : ""}${chg3.toFixed(2)}% over 3 sessions`));
  }

  // Momentum after a large up day: the strongest lead in the research table
  // (+0.238% next day, n=698, p=0.0029). Below the corrected bar, so weighted
  // like a hint rather than a finding.
  const dayChg = pct(prev.c, before.c);
  if (dayChg >= 1.0) {
    out.push(factor("Large up day", "UP", 2, `yesterday +${dayChg.toFixed(2)}%`));
  } else if (dayChg <= -1.0) {
    out.push(factor("Large down day", "DOWN", 1, `yesterday ${dayChg.toFixed(2)}%`));
  }

  const span = prev.h - prev.l;
  if (span > 0) {
    const pos = (prev.c - prev.l) / span;
    if (pos >= 0.7) {
      out.push(factor("Closed strong", "UP", 1,
        `${(pos * 100).toFixed(0)}% of yesterday's range`));
    } else if (pos <= 0.3) {
      out.push(factor("Closed weak", "DOWN", 1,
        `${(pos * 100).toFixed(0)}% of yesterday's range`));
    }
  }

  // Calm favours whatever the trend already is; a spike is the market pricing
  // a move it cannot direct, so it argues for standing aside, not for a side.
  if (vix && vix.length >= 20) {
    const level = vix[vix.length - 1];
    const mean20 = sum(vix.slice(-20)) / 20;
    const ratio = mean20 ? level / mean20 : 1;
    if (ratio >= 1.15) {
      out.push(factor("Volatility spike", "FLAT", 2,
        `VIX ${level.toFixed(2)}, ${((ratio - 1) * 100) >= 0 ? "+" : ""}${((ratio - 1) * 100).toFixed(0)}% vs 20-day`));
    } else if (level <= 16) {
      out.push(factor("Calm volatility", "FLAT", 0, `VIX ${level.toFixed(2)}`));
    }
  }

  return out;
}

export function preOpenTrend(daily, vix) {
  return assemble("pre-open", preOpenFactors(daily, vix),
    "Bias for the session, from yesterday's close.");
}

// ── after the open ─────────────────────────────────────────────────────────

export function postOpenFactors(daily, session, vix, vwap) {
  const out = preOpenFactors(daily, vix);
  if (!session || !session.length || !daily || daily.length < 2) return out;

  const prevClose = daily[daily.length - 1].c;
  const spot = session[session.length - 1].c;

  // Weighted 1 on purpose: gap continuation failed a 19-year test, so it is
  // description of the tape rather than prediction.
  const gap = pct(session[0].o, prevClose);
  if (Math.abs(gap) >= 0.15) {
    out.push(factor("Opening gap", gap > 0 ? "UP" : "DOWN", 1,
      `${gap >= 0 ? "+" : ""}${gap.toFixed(2)}% at the bell`));
  }

  const sinceOpen = pct(spot, session[0].o);
  if (Math.abs(sinceOpen) >= 0.1) {
    out.push(factor("Since the open", sinceOpen > 0 ? "UP" : "DOWN", 2,
      `${sinceOpen >= 0 ? "+" : ""}${sinceOpen.toFixed(2)}% from the opening print`));
  }

  if (vwap) {
    out.push(factor("Versus VWAP", spot > vwap ? "UP" : "DOWN", 2,
      `${pct(spot, vwap) >= 0 ? "+" : ""}${pct(spot, vwap).toFixed(2)}% vs VWAP`));
  }

  if (session.length >= 3) {
    const opening = session.slice(0, 3);
    const hi = Math.max(...opening.map((c) => c.h));
    const lo = Math.min(...opening.map((c) => c.l));
    if (spot > hi) {
      out.push(factor("Opening range", "UP", 1, "broke above the first 15 minutes"));
    } else if (spot < lo) {
      out.push(factor("Opening range", "DOWN", 1, "broke below the first 15 minutes"));
    } else {
      out.push(factor("Opening range", "FLAT", 1, "still inside the first 15 minutes"));
    }
  }

  return out;
}

export function postOpenTrend(daily, session, vix, vwap) {
  return assemble("open", postOpenFactors(daily, session, vix, vwap),
    "Bias for the rest of the session, from the tape so far.");
}

// ── vote ───────────────────────────────────────────────────────────────────

function assemble(phase, factors, note) {
  const up = sum(factors.filter((f) => f.t === "UP").map((f) => f.w));
  const down = sum(factors.filter((f) => f.t === "DOWN").map((f) => f.w));
  const flat = sum(factors.filter((f) => f.t === "FLAT").map((f) => f.w));
  const total = up + down + flat;

  if (!total) {
    return {
      phase, action: "FLAT", label: TREND_LABELS.FLAT, confidence: 0,
      factors, note: "Not enough history yet.", up: 0, down: 0, flat: 0,
    };
  }

  const margin = (up - down) / total;
  const action = margin >= DECISION_MARGIN ? "UP"
    : margin <= -DECISION_MARGIN ? "DOWN" : "FLAT";

  // How much the factors agree, and nothing more. Measured across nine years
  // it does not sort outcomes -- 70+ hits 51.1%, 50-59 hits 52.9% -- so it is
  // labelled "agreement" in the UI and never shown as a probability.
  const strength = Math.abs(margin);
  const agreement = action !== "FLAT"
    ? 50 + Math.round(strength * 45)
    : 50 - Math.round(strength * 30);

  return {
    phase,
    action,
    label: TREND_LABELS[action],
    confidence: Math.max(20, Math.min(90, Math.trunc(agreement))),
    factors,
    note,
    up,
    down,
    flat,
    margin: fixed(margin, 3),
  };
}
