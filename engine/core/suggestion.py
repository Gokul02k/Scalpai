"""Port of `app/lib/suggestion.js` — the weighted vote that produces the final
BUY/SELL/HOLD call, its confidence, and the trade levels.

This is the decision engine. Two parts deserve attention when the strategy is
eventually tuned:

  * `vote_from_factors` derives confidence from
    `42 + agreement * 35 + |margin| * 4`, capped at 90. Those constants are
    hand-chosen, and the 80-point logging threshold inherits their
    arbitrariness. Replacing this with a calibrated model is the highest-value
    change available, and the reason the backtest exists.

  * `trade_levels` is risk-first and will refuse a trade. When the nearest
    structural level sits too close to allow a volatility-safe stop at the
    minimum reward:risk, it returns `viable: False` and the caller downgrades
    to HOLD. This is a good property; keep it.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Sequence

from .jsnum import clamp, fixed_str, js_round, js_str, locale_en_in, to_fixed

Settings = dict[str, Any]

STRENGTH_W = {"STRONG": 3, "MODERATE": 2, "WEAK": 1}


@dataclass(frozen=True)
class StrategyFlags:
    """Toggles for deviations from v1, so a change can be measured before it
    is adopted.

    Defaults reproduce v1 exactly, which keeps the parity tests meaningful:
    a failing parity test then always means a port bug, never an intentional
    strategy change hiding in the same diff.

    `use_opening_range`: v1 votes weight 2 on opening-range breaks. Research
    over 19 years puts that factor's predictive value at +0.0003% (p=0.99),
    i.e. none, so it is a candidate for removal — but only once the backtest
    has confirmed removing it helps.
    """

    use_opening_range: bool = True


#: v1 behaviour. Anything comparing against the live dashboard uses this.
V1_FLAGS = StrategyFlags()

FINAL_LABELS = {
    "BUY": "BUY NOW",
    "SELL": "SELL NOW",
    "HOLD": "HOLD",
    "WAIT": "ANALYZING…",
}


# ── factor collection ──────────────────────────────────────────────────────

def analyze_sr_factors(price: float | None, analysis: dict) -> list[dict]:
    sr = analysis.get("sr") or {}
    atr = analysis.get("atr") or 0
    if not sr.get("support") or not sr.get("resistance") or not price:
        return []

    rng = (sr["resistance"] - sr["support"]) or 1
    dist_support = price - sr["support"]
    dist_resistance = sr["resistance"] - price
    near_band = max(atr * 0.6, rng * 0.06)

    if dist_support <= near_band:
        return [{
            "type": "BUY", "name": "Support zone",
            "reason": f"Price at/near support ₹{locale_en_in(sr['support'])} — bounce zone",
            "weight": 4,
        }]
    if dist_resistance <= near_band:
        return [{
            "type": "SELL", "name": "Resistance zone",
            "reason": f"Price at/near resistance ₹{locale_en_in(sr['resistance'])} — rejection zone",
            "weight": 4,
        }]

    pos = dist_support / rng
    if pos < 0.35:
        return [{
            "type": "BUY", "name": "Support zone",
            "reason": f"Lower range — support ₹{locale_en_in(sr['support'])}, "
                      f"resistance ₹{locale_en_in(sr['resistance'])}",
            "weight": 2,
        }]
    if pos > 0.65:
        return [{
            "type": "SELL", "name": "Resistance zone",
            "reason": f"Upper range — resistance ₹{locale_en_in(sr['resistance'])}, "
                      f"support ₹{locale_en_in(sr['support'])}",
            "weight": 2,
        }]
    return [{
        "type": "HOLD", "name": "S/R mid-range",
        "reason": f"Mid-range between support ₹{locale_en_in(sr['support'])} and "
                  f"resistance ₹{locale_en_in(sr['resistance'])}",
        "weight": 1,
    }]


def analyze_liquidity_factor(liq: dict | None) -> dict | None:
    if liq is None:
        return None
    pct = js_round(liq["ratio"] * 100)
    if liq.get("high"):
        return {
            "type": "BUY", "name": "Liquidity",
            "reason": f"Volume {pct}% of average — strong participation supports the move",
            "weight": 2,
        }
    if liq.get("low"):
        return {
            "type": "HOLD", "name": "Liquidity",
            "reason": f"Volume only {pct}% of average — thin liquidity, signals less reliable",
            "weight": 2,
        }
    return {
        "type": "HOLD", "name": "Liquidity",
        "reason": f"Normal volume ({pct}% of average) — adequate liquidity",
        "weight": 1,
    }


def analyze_session_factors(
    price: float | None, session: dict | None, flags: StrategyFlags = V1_FLAGS
) -> list[dict]:
    if session is None or not price:
        return []
    out: list[dict] = []

    if session.get("vwap"):
        above = price >= session["vwap"]
        vwap = js_str(session["vwap"])
        out.append({
            "type": "BUY" if above else "SELL",
            "name": "VWAP",
            "reason": (f"Price above VWAP (₹{vwap}) — intraday long bias"
                       if above else
                       f"Price below VWAP (₹{vwap}) — intraday short bias"),
            "weight": 2,
        })

    if flags.use_opening_range and session.get("orReady") and session.get("orHigh") and session.get("orLow"):
        or_high, or_low = js_str(session["orHigh"]), js_str(session["orLow"])
        if price > session["orHigh"]:
            out.append({"type": "BUY", "name": "Opening range",
                        "reason": f"Broke above 15-min opening high ₹{or_high}",
                        "weight": 2})
        elif price < session["orLow"]:
            out.append({"type": "SELL", "name": "Opening range",
                        "reason": f"Broke below 15-min opening low ₹{or_low}",
                        "weight": 2})
        else:
            out.append({"type": "HOLD", "name": "Opening range",
                        "reason": f"Inside opening range ₹{or_low}–₹{or_high}",
                        "weight": 1})
    return out


def analyze_fvg_factor(analysis: dict) -> dict | None:
    sig = ((analysis or {}).get("fvg") or {}).get("signal")
    if not sig:
        return None
    inside = sig["status"] == "inside"
    return {
        "type": sig["type"],
        "name": "Fair Value Gap",
        "reason": sig["reason"],
        "weight": 3 if inside else 2,
    }


def collect_factors(
    analysis: dict,
    index_signals: Sequence[dict] = (),
    nifty_scalp: bool = False,
    flags: StrategyFlags = V1_FLAGS,
) -> list[dict]:
    import re

    factors: list[dict] = []

    fvg = analyze_fvg_factor(analysis)
    if fvg:
        factors.append(fvg)

    if nifty_scalp and analysis:
        factors += analyze_sr_factors(analysis.get("price"), analysis)
        factors += analyze_session_factors(
            analysis.get("price"), analysis.get("session"), flags
        )
        liq = analyze_liquidity_factor(analysis.get("liquidity"))
        if liq:
            factors.append(liq)

    for row in (analysis or {}).get("summary") or []:
        name = row["n"]
        if re.fullmatch(r"support|resistance", name, re.I):
            continue
        # FVG is already a weighted factor above; counting the summary row too
        # would double its influence on the vote.
        if re.fullmatch(r"fair value gap", name, re.I):
            continue
        if not nifty_scalp and row["t"] == "HOLD" and re.search(r"atr", name, re.I):
            continue
        # For a NIFTY scalp, Stochastic overlaps RSI and ATR measures volatility
        # rather than direction; both only dilute the margin.
        if nifty_scalp and re.match(r"(stochastic|atr)\b", name, re.I):
            continue
        factors.append({"type": row["t"], "name": name,
                        "reason": f"{row['sig']} · {row['v']}", "weight": 1})

    if not nifty_scalp:
        for sig in index_signals:
            factors.append({
                "type": sig["type"],
                "name": f"{sig['str']} setup",
                "reason": sig["reason"],
                "weight": STRENGTH_W.get(sig["str"], 1),
            })

    return factors


# ── vote ───────────────────────────────────────────────────────────────────

def vote_from_factors(factors: Sequence[dict], chg_pct: float, mode: str) -> dict:
    buy_w = 0.0
    sell_w = 0.0
    hold_penalty = 0

    for f in factors:
        w = f.get("weight")
        if w is None:
            first_word = (f.get("name") or "").split(" ")[0]
            w = STRENGTH_W.get(first_word, 1)
        if f["type"] == "BUY":
            buy_w += w
        elif f["type"] == "SELL":
            sell_w += w
        elif f["type"] == "HOLD" and f.get("name") == "Liquidity" and "thin" in (f.get("reason") or ""):
            hold_penalty += 1

    chg_w = 0.3 if mode == "longterm" else 1
    if chg_pct >= 0.5:
        buy_w += chg_w
    if chg_pct <= -0.5:
        sell_w += chg_w

    if mode == "longterm" and factors:
        ema = next((f for f in factors if f.get("name") == "EMA 20/50"), None)
        if ema:
            if ema["type"] == "BUY":
                buy_w += 2
            elif ema["type"] == "SELL":
                sell_w += 2

    margin = buy_w - sell_w
    action = "HOLD"
    threshold = 2
    if margin >= threshold:
        action = "BUY"
    elif margin <= -threshold:
        action = "SELL"
    if hold_penalty >= 1 and action != "HOLD":
        action = "HOLD"

    total = (buy_w + sell_w) or 1
    agreement = abs(margin) / total
    confidence = js_round(min(90, 42 + agreement * 35 + abs(margin) * 4))
    if action == "HOLD":
        confidence = max(38, confidence - 12)
    if hold_penalty and action == "HOLD":
        confidence = max(35, confidence - 5)

    return {"action": action, "buyW": buy_w, "sellW": sell_w, "confidence": confidence}


# ── levels ─────────────────────────────────────────────────────────────────

def trade_levels(
    price: float | None,
    action: str,
    mode: str,
    settings: Settings | None = None,
    analysis: dict | None = None,
) -> dict:
    """Risk-first levels with an enforced minimum reward:risk.

    The target is capped at the next structural level so it is achievable, then
    the stop is sized to it: the largest stop that still clears `minRR`, bounded
    below by volatility and above by a percentage cap. If even a
    volatility-safe stop cannot reach `minRR`, the setup is marked not viable
    rather than emitting a lopsided target +33 / stop -193.
    """
    settings = settings or {}
    if not price or action in ("HOLD", "WAIT"):
        return {"entry": price, "target": None, "stopLoss": None, "rr": None, "viable": False}

    buy = action == "BUY"
    entry = to_fixed(price, 2)
    atr = analysis.get("atr") if analysis else 0
    atr = atr if (atr or 0) > 0 else 0
    sr = (analysis or {}).get("sr") or {}

    profit_pct = settings.get("profitPct", 1.5)
    sl_pct = settings.get("slPct", 0.8)
    tgt_pct = 0.10 if mode == "longterm" else (profit_pct * 2.5) / 100 if mode == "swing" else profit_pct / 100
    base_sl_pct = 0.06 if mode == "longterm" else (sl_pct * 2) / 100 if mode == "swing" else sl_pct / 100
    min_rr = settings.get("minRR", 1.2 if mode == "longterm" else 1.5)
    min_stop_pct = 0.01 if mode == "longterm" else 0.005 if mode == "swing" else 0.002

    target = entry * (1 + tgt_pct) if buy else entry * (1 - tgt_pct)
    if buy and (sr.get("resistance") or 0) > entry:
        target = min(target, sr["resistance"] * 0.999)
    elif not buy and (sr.get("support") or 0) > 0 and sr["support"] < entry:
        target = max(target, sr["support"] * 1.001)
    target = to_fixed(target, 2)
    reward = abs(target - entry)

    atr_floor = max(atr * (0.8 if mode == "scalp" else 0.6), entry * min_stop_pct)
    max_risk = max(entry * base_sl_pct, atr_floor)

    if reward <= 0 or reward / min_rr < atr_floor:
        return {"entry": entry, "target": None, "stopLoss": None, "rr": None, "viable": False}

    risk_dist = min(reward / min_rr, max_risk)
    stop_loss = to_fixed(entry - risk_dist if buy else entry + risk_dist, 2)
    return {
        "entry": entry,
        "target": target,
        "stopLoss": stop_loss,
        "rr": to_fixed(reward / risk_dist, 1),
        "viable": True,
    }


# ── final call ─────────────────────────────────────────────────────────────

def build_unified_suggestion(
    analysis: dict | None,
    price: float | None,
    chg_pct: float = 0,
    index_signals: Sequence[dict] = (),
    settings: Settings | None = None,
    mode: str = "scalp",
    instrument: str = "",
    flags: StrategyFlags = V1_FLAGS,
) -> dict:
    settings = settings or {}
    if analysis is None or not price:
        return {
            "action": "WAIT", "label": FINAL_LABELS["WAIT"], "confidence": 0,
            "factors": [], "entry": None, "target": None, "stopLoss": None, "rr": None,
        }

    nifty_scalp = mode == "scalp" and instrument == "NIFTY"
    factors = collect_factors(analysis, index_signals, nifty_scalp, flags)
    vote = vote_from_factors(factors, chg_pct, mode)
    action, confidence = vote["action"], vote["confidence"]
    levels = trade_levels(price, action, mode, settings, analysis)

    final_action = action
    final_confidence = confidence
    gated_reason = None

    if action in ("BUY", "SELL") and not levels["viable"]:
        # The direction may well be right, but there is no room for a sane
        # stop, so don't issue a trade with lopsided risk.
        final_action = "HOLD"
        final_confidence = max(35, confidence - 20)
        gated_reason = (
            "No favourable risk:reward right now — the next resistance/support is too "
            "close to justify the stop. Wait for a pullback or a clean breakout."
        )
    elif levels["viable"] and levels["rr"] >= 2:
        final_confidence = min(94, confidence + 3)

    return {
        "action": final_action,
        "label": FINAL_LABELS.get(final_action, final_action),
        "confidence": final_confidence,
        "factors": factors,
        "gatedReason": gated_reason,
        "entry": levels["entry"] if levels["entry"] is not None else price,
        "target": levels["target"],
        "stopLoss": levels["stopLoss"],
        "rr": levels["rr"],
    }


# ── fundamentals (equity swing track) ──────────────────────────────────────

def score_fundamentals(f: dict | None, price: float | None) -> dict:
    # `if (!f)` in JS is false for {} — an empty object is truthy there and
    # falsy in Python. Testing for None keeps the branch identical.
    if f is None:
        return {"score": 0, "factors": [], "available": False}

    score = 0.0
    factors: list[dict] = []

    def add(kind, name, reason, weight=2):
        factors.append({"type": kind, "name": name, "reason": reason, "weight": weight})

    pe = f.get("trailingPE")
    if pe is not None and pe > 0:
        if pe < 15:
            score += 1
            add("BUY", "Valuation (P/E)", f"Low P/E {fixed_str(pe, 1)} — attractively valued")
        elif pe > 45:
            score -= 1
            add("SELL", "Valuation (P/E)", f"High P/E {fixed_str(pe, 1)} — richly valued")

    pb = f.get("priceToBook")
    if pb is not None and pb > 0:
        if pb < 1.5:
            score += 0.5
            add("BUY", "Price/Book", f"P/B {fixed_str(pb, 2)} — cheap vs book value")
        elif pb > 10:
            score -= 0.5
            add("SELL", "Price/Book", f"P/B {fixed_str(pb, 1)} — expensive vs book value")

    roe = f.get("returnOnEquity")
    if roe is not None:
        if roe >= 15:
            score += 1
            add("BUY", "Quality (ROE)", f"Strong ROE {js_str(roe)}%")
        elif roe < 5:
            score -= 0.5
            add("SELL", "Quality (ROE)", f"Weak ROE {js_str(roe)}%")

    pm = f.get("profitMargins")
    if pm is not None:
        if pm < 0:
            score -= 1
            add("SELL", "Profitability", f"Loss-making — net margin {js_str(pm)}%")
        elif pm >= 15:
            score += 0.5
            add("BUY", "Profitability", f"Healthy net margin {js_str(pm)}%")

    de = f.get("debtToEquity")
    if de is not None:
        if de > 150:
            score -= 1
            add("SELL", "Leverage", f"High debt/equity {fixed_str(de, 0)}")
        elif de < 40:
            score += 0.5
            add("BUY", "Leverage", f"Low debt/equity {fixed_str(de, 0)}")

    eg = f.get("earningsGrowth")
    if eg is not None:
        if eg >= 10:
            score += 0.5
            add("BUY", "Earnings growth", f"Earnings +{js_str(eg)}%")
        elif eg <= -10:
            score -= 0.5
            add("SELL", "Earnings growth", f"Earnings {js_str(eg)}%")

    rg = f.get("revenueGrowth")
    if rg is not None:
        if rg >= 10:
            score += 0.5
            add("BUY", "Revenue growth", f"Revenue +{js_str(rg)}%")
        elif rg <= -5:
            score -= 0.5
            add("SELL", "Revenue growth", f"Revenue {js_str(rg)}%")

    peg = f.get("pegRatio")
    if peg is not None and 0 < peg < 1:
        score += 0.5
        add("BUY", "PEG", f"PEG {fixed_str(peg, 2)} — growth at a fair price")

    tgt = f.get("targetMeanPrice")
    if tgt is not None and price:
        up = (tgt - price) / price * 100
        if up >= 12:
            score += 1
            add("BUY", "Analyst target", f"~{fixed_str(up, 0)}% upside to avg target")
        elif up <= -8:
            score -= 1
            add("SELL", "Analyst target", "Trading above avg analyst target")

    rec = f.get("recommendationKey")
    if rec:
        if "buy" in rec:
            score += 0.5
            add("BUY", "Analyst rating", f"Consensus: {rec.replace('_', ' ')}")
        elif "sell" in rec or "underperform" in rec:
            score -= 0.5
            add("SELL", "Analyst rating", f"Consensus: {rec.replace('_', ' ')}")

    return {"score": to_fixed(score, 2), "factors": factors, "available": True}


def get_portfolio_suggestion(
    stock: dict | None,
    analysis: dict | None,
    news_items: Sequence[dict] = (),
    quote: dict | None = None,
    fundamentals: dict | None = None,
    settings: Settings | None = None,
    mode: str = "swing",
) -> dict:
    """Blends chart technicals, company fundamentals and recent news — never
    the holder's own P&L, which is not information about the stock."""
    settings = settings or {}
    price = (quote or {}).get("current") or (stock or {}).get("cur")
    if analysis is None or not price:
        return {
            "action": "WAIT", "label": "Analyzing…", "confidence": 0,
            "reason": "Loading chart indicators, fundamentals and recent news…",
            "detail": "Suggestion blends technicals, fundamentals and news — not your P&L.",
            "factors": [], "newsCount": 0, "fundamentalScore": None,
        }

    day_pct = (quote or {}).get("changePercent")
    if day_pct is None:
        prev = (stock or {}).get("prev")
        day_pct = to_fixed((price - prev) / prev * 100, 2) if prev else 0

    base = build_unified_suggestion(analysis, price, day_pct, (), settings, mode)
    action = base["action"]
    confidence = base["confidence"]
    tech_factors = list(base["factors"])

    recent = list(news_items)[:8]
    pos = sum(1 for n in recent if n.get("sentiment") == "positive")
    neg = sum(1 for n in recent if n.get("sentiment") == "negative")
    news_score = pos - neg
    news_factors: list[dict] = []

    if recent:
        kind = "BUY" if news_score > 0 else "SELL" if news_score < 0 else "HOLD"
        news_factors.append({
            "type": kind, "name": "Recent news",
            "reason": f"{pos} positive / {neg} negative recent "
                      f"headline{'' if len(recent) == 1 else 's'}",
            "weight": 2,
        })
        if news_score <= -2 and action == "BUY":
            action, confidence = "HOLD", max(40, confidence - 15)
        elif news_score >= 2 and action == "BUY":
            confidence = min(92, confidence + 8)
        elif news_score <= -2 and action == "SELL":
            confidence = min(92, confidence + 8)
        elif news_score >= 2 and action == "SELL":
            action, confidence = "HOLD", max(40, confidence - 12)

    fund = score_fundamentals(fundamentals, price)
    if fund["available"]:
        fw = 7 if mode == "longterm" else 3
        confidence += js_round(clamp(fund["score"], -3, 3) * fw)
        if mode == "longterm":
            if fund["score"] >= 2 and action == "HOLD":
                action = "BUY"
            if fund["score"] >= 1.5 and action == "SELL":
                action = "HOLD"
            if fund["score"] <= -2 and action == "BUY":
                action = "HOLD"
            if fund["score"] <= -3:
                action = "SELL"
        elif fund["score"] <= -2 and action == "BUY":
            action = "HOLD"
        confidence = js_round(clamp(confidence, 30, 95))

    levels = trade_levels(price, action, mode, settings, analysis)
    gated_reason = None
    if action in ("BUY", "SELL") and not levels["viable"]:
        action = "HOLD"
        confidence = js_round(clamp(confidence - 12, 30, 95))
        gated_reason = (
            "Poor risk:reward right now — the next level is too close to justify "
            "the stop. Wait for a better entry."
        )

    label_map = {"BUY": "Add / Buy", "SELL": "Trim / Sell", "HOLD": "Hold", "WAIT": "Analyzing…"}
    ranked_fund = sorted(fund["factors"], key=lambda f: 0 if f["type"] == action else 1)
    factors = ([*ranked_fund[:3], *news_factors, *tech_factors])[:7]

    tech_reason = " · ".join(f["name"] for f in base["factors"][:2]) or "Technical setup"
    fund_reason = (
        ("fundamentals supportive" if fund["score"] >= 1
         else "fundamentals weak" if fund["score"] <= -1
         else "fundamentals neutral")
        if fund["available"] else "fundamentals N/A"
    )
    news_reason = f"news {pos}↑/{neg}↓" if recent else "no recent news"

    return {
        "action": action,
        "label": label_map.get(action, action),
        "confidence": confidence,
        "reason": gated_reason or f"{tech_reason} · {fund_reason} · {news_reason}",
        "detail": "Blends chart technicals, fundamentals (P/E, ROE, debt, growth…) and recent news.",
        "factors": factors,
        "gatedReason": gated_reason,
        "entry": levels["entry"],
        "target": levels["target"],
        "stopLoss": levels["stopLoss"],
        "rr": levels["rr"],
        "dayPct": day_pct,
        "newsCount": len(recent),
        "fundamentalScore": fund["score"] if fund["available"] else None,
    }
