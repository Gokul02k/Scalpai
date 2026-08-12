"""Port of `app/lib/signals.js` — the discrete BUY/SELL setups.

These feed the weighted vote in `suggestion.py`; they are not the final call.
"""
from __future__ import annotations

from typing import Any, Sequence

from .jsnum import fixed_str, js_str, to_fixed

Settings = dict[str, Any]


def generate_index_signals(
    analysis: dict, price: float, instrument: str, settings: Settings
) -> list[dict]:
    rsi = analysis["rsi"]
    macd = analysis["macd"]
    bb = analysis["bb"]
    sr = analysis["sr"]
    stoch = analysis["stoch"]
    atr = analysis["atr"]
    fvg = analysis.get("fvg")

    pt = settings["profitPct"] / 100
    sl = settings["slPct"] / 100
    signals: list[dict] = []

    def add(kind: str, strength: str, reason: str, prob: int, **opts) -> None:
        buy = kind == "BUY"
        target = to_fixed(price * (1 + pt if buy else 1 - pt), 2)
        stop_loss = to_fixed(price * (1 - sl if buy else 1 + sl), 2)
        rr = fixed_str(abs(target - price) / abs(price - stop_loss), 1)
        signals.append(
            {
                "type": kind,
                "str": strength,
                "reason": reason,
                "prob": prob,
                "instrument": instrument,
                "target": target,
                "stopLoss": stop_loss,
                "rr": rr,
                "scope": "index",
                **opts,
            }
        )

    # An FVG retest fires independently of the momentum ladder below, so it can
    # stand on its own rather than being masked by an if/else chain.
    fvg_sig = (fvg or {}).get("signal")
    if fvg_sig:
        z = fvg_sig["zone"]
        inside = fvg_sig["status"] == "inside"
        add(
            fvg_sig["type"],
            "STRONG" if inside else "MODERATE",
            fvg_sig["reason"],
            68 if inside else 60,
            tag="FVG",
            fvgZone={"type": z["type"], "top": z["top"], "bottom": z["bottom"]},
        )

    if rsi < 30 and macd["h"] > 0:
        add("BUY", "STRONG",
            f"RSI oversold ({js_str(rsi)}) + MACD turning bullish + "
            f"near support ₹{js_str(sr['support'])}", 72)
    elif rsi < 35:
        add("BUY", "MODERATE",
            f"RSI {js_str(rsi)} approaching oversold + price near support", 62)
    elif rsi > 70 and macd["h"] < 0:
        add("SELL", "STRONG",
            f"RSI overbought ({js_str(rsi)}) + MACD bearish + "
            f"near resistance ₹{js_str(sr['resistance'])}", 70)
    elif rsi > 65:
        add("SELL", "MODERATE", f"RSI {js_str(rsi)} elevated + stochastic {js_str(stoch)}", 58)
    elif price <= bb["lower"] * 1.002:
        add("BUY", "MODERATE",
            f"Price at lower Bollinger band (₹{js_str(bb['lower'])}) + ATR {js_str(atr)}", 64)
    elif price >= bb["upper"] * 0.998:
        add("SELL", "MODERATE", f"Price at upper Bollinger band (₹{js_str(bb['upper'])})", 63)
    elif macd["h"] > 0 and 40 <= rsi <= 60:
        add("BUY", "WEAK",
            f"MACD bullish ({js_str(macd['h'])}) with neutral RSI — scalp long bias", 54)

    return signals[:3]


def generate_portfolio_signals(portfolio: Sequence[dict], settings: Settings) -> list[dict]:
    signals: list[dict] = []
    pt = settings["profitPct"] / 100
    sl = settings["slPct"] / 100

    for s in portfolio:
        chg_pct = (s["cur"] - s["buy"]) / s["buy"] * 100
        buy = s["cur"] <= s["buy"] * 0.97
        sell = s["cur"] >= s["buy"] * (1 + pt) or chg_pct <= -settings["slPct"]

        if buy:
            signals.append(
                {
                    "type": "BUY",
                    "str": "ACCUMULATE",
                    "reason": f"{s['name']} down {fixed_str(abs(chg_pct), 1)}% from avg — "
                              f"add on dip near ₹{js_str(s['cur'])}",
                    "prob": 61,
                    "instrument": s["name"],
                    "target": to_fixed(s["cur"] * (1 + pt), 2),
                    "stopLoss": to_fixed(s["cur"] * (1 - sl), 2),
                    "scope": "portfolio",
                }
            )
        if sell and chg_pct > 0:
            signals.append(
                {
                    "type": "SELL",
                    "str": "TAKE PROFIT",
                    "reason": f"{s['name']} up {fixed_str(chg_pct, 1)}% — near your "
                              f"{js_str(settings['profitPct'])}% target",
                    "prob": 68,
                    "instrument": s["name"],
                    "target": s["cur"],
                    "stopLoss": to_fixed(s["cur"] * (1 - sl), 2),
                    "scope": "portfolio",
                }
            )
        elif chg_pct <= -settings["slPct"]:
            signals.append(
                {
                    "type": "SELL",
                    "str": "STOP LOSS",
                    "reason": f"{s['name']} down {fixed_str(abs(chg_pct), 1)}% — exceeds "
                              f"{js_str(settings['slPct'])}% stop",
                    "prob": 75,
                    "instrument": s["name"],
                    "target": s["cur"],
                    "stopLoss": s["cur"],
                    "scope": "portfolio",
                }
            )
    return signals
