"""Port of `app/lib/strategies.js` — the index-scalp vote split into the
strategies it is made of.

`suggestion.py` blends every factor into one call, which hides which kind of
edge is talking. A BUY built from "bounced off support, RSI oversold" is a bet
that the range holds; the same BUY built from "broke the opening range, holds
above VWAP" is a bet that it breaks. Blended, a disagreement between the two
comes out as low confidence, which reads as uncertainty about direction rather
than a conflict between two views.

Each strategy is scored by the same `vote_from_factors` over its own subset,
with no re-tuned weights or thresholds. Re-tuning per strategy would make the
numbers incomparable to the blended call and to each other, and would stack
four unmeasured parameter choices on top of an unmeasured split.

Two properties to know before reading anything into the numbers:

  * The subsets are not balanced, because v1's weights are not. Reversion can
    reach a margin of 6 (a support zone alone is weight 4) where momentum tops
    out at 2, so reversion produces louder calls by construction and the
    blended vote is dominated by reversion and session. That is a fact about
    v1's hand-chosen weights, not a finding about markets.
  * Confidence rises as a subset shrinks. The vote derives it from
    `agreement = |margin| / total`, and two factors that agree score a perfect
    1.0 as easily as eight do -- momentum with MACD and EMA both bearish reads
    85, the same number the blended vote needs eight factors to reach. So the
    factor count travels with it and the UI shows both. Damping it per strategy
    would be a fifth unmeasured parameter and would stop the numbers being
    comparable to the blended call.
  * None of these has been backtested on its own. Only the blended call has a
    measured cost model, a VIX gate and a learned filter behind it.
"""
from __future__ import annotations

import re
from typing import Any, Sequence

from .jsnum import to_fixed
from .suggestion import collect_factors, vote_from_factors

#: Ordered for display: the two directional families first, then the two that
#: describe where price sits rather than where it is going.
STRATEGIES: list[dict[str, str]] = [
    {
        "key": "momentum",
        "name": "Momentum",
        "blurb": "Trend continuation — MACD, EMA 20/50 and the day's drift",
    },
    {
        "key": "reversion",
        "name": "Mean reversion",
        "blurb": "Range holding — RSI, Bollinger bands and support/resistance",
    },
    {
        "key": "session",
        "name": "Session",
        "blurb": "Today's anchors — VWAP, the 15-min opening range and volume",
    },
    {
        "key": "imbalance",
        "name": "Imbalance",
        "blurb": "Unfilled fair-value gaps left by earlier moves",
    },
]

STRATEGY_KEYS = [s["key"] for s in STRATEGIES]

#: Which strategy the day's change votes in. The vote adds it as a bare weight
#: rather than a named factor, so it cannot be routed by the classifier below,
#: and counting it in all four would make them agree on a trending day for a
#: reason none of them measures. `build_unified_suggestion` reads this too, so a
#: replay of one strategy sees the same drift the panel showed.
DRIFT_STRATEGY = "momentum"

#: Matched against the factor name `collect_factors` produces. Ordered, first
#: match wins, so a specific pattern must precede a looser one.
#:
#: The day's change is absent because it is added inside the vote rather than as
#: a named factor, and it is routed to momentum only. Counting it four times
#: would give a trending day a vote in every strategy.
_CLASSIFIERS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"^macd\b", re.I), "momentum"),
    (re.compile(r"^ema\b", re.I), "momentum"),
    (re.compile(r"^supertrend\b", re.I), "momentum"),
    (re.compile(r"^rsi\b", re.I), "reversion"),
    (re.compile(r"^bollinger\b", re.I), "reversion"),
    (re.compile(r"^stochastic\b", re.I), "reversion"),
    (re.compile(r"^(support|resistance) zone$", re.I), "reversion"),
    (re.compile(r"^s/r mid-range$", re.I), "reversion"),
    (re.compile(r"^vwap\b", re.I), "session"),
    (re.compile(r"^opening range$", re.I), "session"),
    (re.compile(r"^liquidity$", re.I), "session"),
    (re.compile(r"^fair value gap$", re.I), "imbalance"),
]


def classify_factor(name: str | None) -> str | None:
    """Which strategy a factor belongs to, or None if it belongs to none.

    None is a real answer rather than a fallback. The discrete `"STRONG setup"`
    factors that `collect_factors` adds for non-NIFTY instruments are composites
    of RSI, MACD and Bollinger together, so filing them under one strategy would
    misattribute the others' evidence. ATR is unassigned for the opposite
    reason: it measures volatility, never direction.
    """
    for pattern, key in _CLASSIFIERS:
        if pattern.search(name or ""):
            return key
    return None


def split_factors(factors: Sequence[dict] = ()) -> dict[str, list[dict]]:
    """Partition a factor list by strategy. Unassigned factors are kept."""
    out: dict[str, list[dict]] = {"unassigned": []}
    for key in STRATEGY_KEYS:
        out[key] = []
    for f in factors or ():
        out[classify_factor(f.get("name")) or "unassigned"].append(f)
    return out


def run_strategies(
    analysis: dict | None,
    price: float | None,
    chg_pct: float = 0.0,
    index_signals: Sequence[dict] = (),
    mode: str = "scalp",
    instrument: str = "",
) -> dict[str, Any]:
    """One call per strategy, plus how many factors no strategy claimed.

    `unassigned` is reported rather than hidden: when it is non-zero the
    strategies do not account for the whole blended vote, and a caller comparing
    them against it needs to know that.
    """
    if not analysis or not price:
        return {"strategies": [], "unassigned": 0}

    nifty_scalp = mode == "scalp" and instrument == "NIFTY"
    split = split_factors(collect_factors(analysis, index_signals, nifty_scalp))

    strategies: list[dict[str, Any]] = []
    for meta in STRATEGIES:
        factors = split[meta["key"]]
        if not factors:
            # An empty subset is not a HOLD. The vote would score it 38, which
            # reads as a weak opinion rather than the absence of one -- the
            # session strategy has no factors at all before the market opens.
            strategies.append({
                "key": meta["key"],
                "name": meta["name"],
                "blurb": meta["blurb"],
                "available": False,
                "action": "NONE",
                "confidence": 0,
                "buyWeight": 0,
                "sellWeight": 0,
                "margin": 0,
                "factors": [],
            })
            continue

        drift = chg_pct if meta["key"] == DRIFT_STRATEGY else 0.0
        vote = vote_from_factors(factors, drift, mode)
        strategies.append({
            "key": meta["key"],
            "name": meta["name"],
            "blurb": meta["blurb"],
            "available": True,
            "action": vote["action"],
            "confidence": vote["confidence"],
            "buyWeight": vote["buyW"],
            "sellWeight": vote["sellW"],
            "margin": to_fixed(vote["buyW"] - vote["sellW"], 2),
            "factors": factors,
        })

    return {"strategies": strategies, "unassigned": len(split["unassigned"])}


def strategy_consensus(strategies: Sequence[dict] = ()) -> dict[str, Any]:
    """How much the strategies agree, for a one-line summary above the list.

    A count rather than a percentage. Four strategies cannot support a
    percentage that means anything, and the blended call already carries the
    only confidence number here with a measurement behind it.
    """
    live = [s for s in (strategies or ()) if s.get("available")]
    buy = len([s for s in live if s["action"] == "BUY"])
    sell = len([s for s in live if s["action"] == "SELL"])
    hold = len([s for s in live if s["action"] == "HOLD"])

    if not live:
        lean = "NONE"
    elif buy and not sell:
        lean = "BUY"
    elif sell and not buy:
        lean = "SELL"
    elif not buy and not sell:
        lean = "HOLD"
    else:
        lean = "MIXED"

    return {
        "total": len(live),
        "buy": buy,
        "sell": sell,
        "hold": hold,
        "lean": lean,
        "conflict": buy > 0 and sell > 0,
    }
