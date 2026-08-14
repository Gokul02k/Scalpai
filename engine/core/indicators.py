"""Port of `app/lib/indicators.js`.

Faithful rather than idiomatic: rounding points, seeding choices and averaging
methods are reproduced exactly, including the ones that differ from textbook
definitions. Two worth flagging, since they look like bugs and are not:

  * `ema()` seeds from the first value rather than an SMA, so early output is
    biased. Harmless here because callers only read the last value of a long
    series, but it means results differ from most charting packages.
  * `rsi()` uses a simple mean of gains and losses over the window rather than
    Wilder's smoothing, so it reacts faster than a standard RSI(14).

Changing either would be an improvement and also a different strategy from the
one whose track record is being evaluated. Any such change belongs in its own
commit, measured against the backtest.

Candles are dicts shaped like the JS side — {ts, o, h, l, c, vol, t} — so the
parity tests can feed byte-identical JSON to both implementations.
"""
from __future__ import annotations

import math
from datetime import datetime
from typing import Any, Sequence

from ..data.base import Candle
from ..data.timeutil import IST, from_epoch_ms
from .jsnum import fixed_str, js_max, js_min, js_sum, to_fixed

CandleDict = dict[str, Any]


def candles_to_dicts(candles: Sequence[Candle]) -> list[CandleDict]:
    """Bridge the typed store representation to the JS-shaped dicts. Note the
    volume key is `vol`, not `v`, matching the JS."""
    out = []
    for c in candles:
        out.append(
            {
                "ts": c.ts,
                "o": c.o,
                "h": c.h,
                "l": c.l,
                "c": c.c,
                "vol": c.v,
                "t": from_epoch_ms(c.ts).astimezone(IST).strftime("%H:%M"),
            }
        )
    return out


# ── primitives ─────────────────────────────────────────────────────────────

def ema(values: Sequence[float], period: int) -> list[float]:
    if not values:
        return []
    k = 2 / (period + 1)
    out = [values[0]]
    for v in values[1:]:
        out.append(v * k + out[-1] * (1 - k))
    return out


def rsi(closes: Sequence[float], period: int = 14) -> float:
    if len(closes) < period + 1:
        return 50
    avg_gain = 0.0
    avg_loss = 0.0
    for i in range(len(closes) - period, len(closes)):
        d = closes[i] - closes[i - 1]
        if d >= 0:
            avg_gain += d
        else:
            avg_loss -= d
    avg_gain /= period
    avg_loss /= period
    if avg_loss == 0:
        return 100
    return to_fixed(100 - 100 / (1 + avg_gain / avg_loss), 1)


def rsi_history(closes: Sequence[float], period: int = 14) -> list[dict]:
    out: list[dict] = []
    for i in range(period + 1, len(closes) + 1):
        out.append({"i": len(out), "rsi": rsi(closes[:i], period)})
    return out[-40:]


def macd(closes: Sequence[float]) -> dict:
    if len(closes) < 26:
        return {"v": 0, "s": 0, "h": 0}
    ema12 = ema(closes, 12)
    ema26 = ema(closes, 26)
    # The MACD line is rounded to 4dp *before* the signal EMA runs over it.
    macd_line = [to_fixed(a - b, 4) for a, b in zip(ema12, ema26)]
    signal_line = ema(macd_line, 9)
    v = macd_line[-1]
    s = signal_line[-1]
    return {"v": to_fixed(v, 3), "s": to_fixed(s, 3), "h": to_fixed(v - s, 3)}


def macd_history(closes: Sequence[float]) -> list[dict]:
    if len(closes) < 26:
        return []
    ema12 = ema(closes, 12)
    ema26 = ema(closes, 26)
    macd_line = [a - b for a, b in zip(ema12, ema26)]
    signal_line = ema(macd_line, 9)
    rows = [{"i": i, "h": to_fixed(m - s, 3)} for i, (m, s) in enumerate(zip(macd_line, signal_line))]
    return [{"i": i, "h": d["h"]} for i, d in enumerate(rows[-40:])]


def bollinger(closes: Sequence[float], period: int = 20) -> dict:
    if len(closes) < period:
        return {"upper": 0, "mid": 0, "lower": 0}
    window = closes[-period:]
    mid = js_sum(window) / period
    std = math.sqrt(js_sum((v - mid) ** 2 for v in window) / period)
    return {
        "upper": to_fixed(mid + 2 * std, 2),
        "mid": to_fixed(mid, 2),
        "lower": to_fixed(mid - 2 * std, 2),
    }


def atr(candles: Sequence[CandleDict], period: int = 14) -> float:
    if len(candles) < 2:
        return 0
    trs = []
    for i in range(1, len(candles)):
        c, prev = candles[i], candles[i - 1]
        trs.append(max(c["h"] - c["l"], abs(c["h"] - prev["c"]), abs(c["l"] - prev["c"])))
    window = trs[-period:]
    return to_fixed(js_sum(window) / len(window), 2)


def stochastic(candles: Sequence[CandleDict], period: int = 14) -> float:
    if len(candles) < period:
        return 50
    window = candles[-period:]
    low = js_min(c["l"] for c in window)
    high = js_max(c["h"] for c in window)
    close = window[-1]["c"]
    if high == low:
        return 50
    return to_fixed((close - low) / (high - low) * 100, 1)


def support_resistance(candles: Sequence[CandleDict], lookback: int = 20) -> dict:
    if not candles:
        return {"support": 0, "resistance": 0}
    window = candles[-lookback:]
    return {
        "support": to_fixed(js_min(c["l"] for c in window), 2),
        "resistance": to_fixed(js_max(c["h"] for c in window), 2),
    }


def liquidity(candles: Sequence[CandleDict]) -> dict:
    vols = [c.get("vol", 0) for c in candles if (c.get("vol") or 0) > 0]
    if len(vols) < 5:
        return {"ratio": 1, "label": "Unknown", "high": False, "low": False}
    avg = js_sum(vols) / len(vols)
    recent = vols[-5:]
    recent_avg = js_sum(recent) / len(recent)
    ratio = to_fixed(recent_avg / avg, 2)
    return {
        "ratio": ratio,
        "label": "High" if ratio >= 1.25 else "Low" if ratio <= 0.75 else "Normal",
        "high": ratio >= 1.25,
        "low": ratio <= 0.75,
    }


def _ist_day_key(ts_ms: int) -> str:
    return datetime.fromtimestamp(ts_ms / 1000, tz=IST).strftime("%Y-%m-%d")


def intraday_session(
    candles: Sequence[CandleDict], open_minutes: int = 15, bar_minutes: int = 5
) -> dict | None:
    """VWAP and opening range for the last candle's IST trading day. Returns
    None for candle sets without timestamps, e.g. daily bars."""
    if not candles:
        return None
    last = candles[-1]
    if last.get("ts") is None:
        return None

    today = _ist_day_key(last["ts"])
    session = [c for c in candles if c.get("ts") is not None and _ist_day_key(c["ts"]) == today]
    if not session:
        return None

    pv = 0.0
    vol = 0.0
    for c in session:
        tp = (c["h"] + c["l"] + c["c"]) / 3
        v = c.get("vol") or 0
        pv += tp * v
        vol += v
    vwap = (
        to_fixed(pv / vol, 2)
        if vol > 0
        else to_fixed(js_sum(c["c"] for c in session) / len(session), 2)
    )

    or_bars = max(1, round(open_minutes / bar_minutes))
    or_candles = session[:or_bars]
    return {
        "vwap": vwap,
        "orHigh": to_fixed(js_max(c["h"] for c in or_candles), 2),
        "orLow": to_fixed(js_min(c["l"] for c in or_candles), 2),
        "orReady": len(session) > or_bars,
        "bars": len(session),
    }


# ── fair value gaps ────────────────────────────────────────────────────────

def detect_fvg(
    candles: Sequence[CandleDict],
    lookback: int = 80,
    min_gap_pct: float = 0.03,
    max_zones: int = 8,
) -> list[dict]:
    """Three-candle price imbalance. Bullish when candle[i-1].high sits below
    candle[i+1].low, leaving untouched space that acts as demand; bearish is
    the mirror. A zone is filled once later price trades back through its far
    edge."""
    n = len(candles)
    if n < 3:
        return []

    start_scan = max(1, n - lookback)
    zones: list[dict] = []

    for i in range(start_scan, n - 1):
        prev, mid_c, nxt = candles[i - 1], candles[i], candles[i + 1]
        ref = mid_c.get("c") or mid_c.get("o") or 1

        if prev["h"] < nxt["l"]:
            bottom, top = prev["h"], nxt["l"]
            kind = "bullish"
        elif prev["l"] > nxt["h"]:
            top, bottom = prev["l"], nxt["h"]
            kind = "bearish"
        else:
            continue

        gap = top - bottom
        gap_pct = gap / ref * 100
        if gap_pct < min_gap_pct:
            continue
        zones.append(
            {
                "type": kind,
                "top": to_fixed(top, 2),
                "bottom": to_fixed(bottom, 2),
                "mid": to_fixed(ref, 2),
                "index": i,
                "gap": to_fixed(gap, 2),
                "gapPct": to_fixed(gap_pct, 3),
                "ts": mid_c.get("ts"),
                "t": mid_c.get("t"),
            }
        )

    for z in zones:
        filled = False
        touched = False
        for j in range(z["index"] + 2, n):
            cc = candles[j]
            if cc["l"] <= z["top"] and cc["h"] >= z["bottom"]:
                touched = True
            if z["type"] == "bullish" and cc["l"] <= z["bottom"]:
                filled = True
                break
            if z["type"] == "bearish" and cc["h"] >= z["top"]:
                filled = True
                break
        z["filled"] = filled
        z["touched"] = touched

    return zones[-max_zones:]


def fvg_signal(zones: Sequence[dict], price: float | None) -> dict | None:
    if not zones or not price:
        return None
    fresh = [z for z in zones if not z.get("filled")]
    if not fresh:
        return None

    def newest_inside(kind: str):
        for z in reversed(fresh):
            if z["type"] == kind and z["bottom"] <= price <= z["top"]:
                return z
        return None

    in_bull = newest_inside("bullish")
    if in_bull:
        return {
            "type": "BUY",
            "status": "inside",
            "zone": in_bull,
            "reason": f"Price trading inside bullish FVG {in_bull['bottom']}–{in_bull['top']} "
                      f"(demand imbalance) — long bias",
        }
    in_bear = newest_inside("bearish")
    if in_bear:
        return {
            "type": "SELL",
            "status": "inside",
            "zone": in_bear,
            "reason": f"Price trading inside bearish FVG {in_bear['bottom']}–{in_bear['top']} "
                      f"(supply imbalance) — short bias",
        }

    newest = fresh[-1]
    if newest["type"] == "bullish":
        return {
            "type": "BUY",
            "status": "formed",
            "zone": newest,
            "reason": f"Bullish FVG formed {newest['bottom']}–{newest['top']} — "
                      f"buy on retest of the gap",
        }
    return {
        "type": "SELL",
        "status": "formed",
        "zone": newest,
        "reason": f"Bearish FVG formed {newest['bottom']}–{newest['top']} — "
                  f"sell on retest of the gap",
    }


# ── aggregate ──────────────────────────────────────────────────────────────

def analyze_from_candles(candles: Sequence[CandleDict], include_history: bool = True) -> dict:
    """`include_history=False` drops `rsiHist` and `macdHist`, which exist only
    to draw sparklines. Nothing in the decision path reads them, and computing
    them is O(n²) — dominating a backtest that re-analyses at every bar."""
    closes = [c["c"] for c in candles]
    r = rsi(closes)
    m = macd(closes)
    bb = bollinger(closes)
    ema20_series = ema(closes, 20)
    ema50_series = ema(closes, 50)
    price = closes[-1] if closes else 0
    a = atr(candles)
    st = stochastic(candles)
    sr = support_resistance(candles)
    liq = liquidity(candles)
    zones = detect_fvg(candles)
    fsig = fvg_signal(zones, price)
    ema20v = ema20_series[-1] if ema20_series else None
    ema50v = ema50_series[-1] if ema50_series else None

    ema_sig, ema_action = "Neutral", "HOLD"
    if ema20v is not None and ema50v is not None:
        if price > ema20v and price > ema50v:
            ema_sig, ema_action = "Price above 20 & 50 EMA", "BUY"
        elif price < ema20v and price < ema50v:
            ema_sig, ema_action = "Price below 20 & 50 EMA", "SELL"

    bb_sig, bb_action = "Mid-band", "HOLD"
    if price <= bb["lower"]:
        bb_sig, bb_action = "At lower band (oversold zone)", "BUY"
    elif price >= bb["upper"]:
        bb_sig, bb_action = "At upper band (overbought zone)", "SELL"

    if fsig:
        fvg_value = f"{fsig['zone']['bottom']}–{fsig['zone']['top']}"
        fvg_state = (
            f"Price inside {fsig['zone']['type']} gap"
            if fsig["status"] == "inside"
            else f"{fsig['zone']['type']} gap formed"
        )
    else:
        fvg_value = f"{len(zones)} zones" if zones else "None"
        fvg_state = "No unfilled imbalance"

    return {
        "rsi": r,
        "rsiHist": rsi_history(closes) if include_history else [],
        "macdHist": macd_history(closes) if include_history else [],
        "macd": m,
        "bb": bb,
        "ema20": ema20v,
        "ema50": ema50v,
        "atr": a,
        "stoch": st,
        "sr": sr,
        "liquidity": liq,
        "fvg": {"zones": zones, "signal": fsig},
        "session": intraday_session(candles),
        "price": price,
        "summary": [
            {
                "n": "RSI (14)",
                "v": fixed_str(r, 1),
                "sig": "Overbought" if r > 70 else "Oversold" if r < 30 else "Neutral",
                "t": "SELL" if r > 70 else "BUY" if r < 30 else "HOLD",
            },
            {
                "n": "MACD",
                "v": fixed_str(m["h"], 2),
                "sig": "Bullish crossover" if m["h"] > 0 else "Bearish crossover",
                "t": "BUY" if m["h"] > 0 else "SELL",
            },
            {
                "n": "EMA 20/50",
                "v": "Above" if ema20v is not None and price > ema20v else "Below",
                "sig": ema_sig,
                "t": ema_action,
            },
            {
                "n": "Bollinger Bands",
                "v": "Upper half" if price > bb["mid"] else "Lower half",
                "sig": bb_sig,
                "t": bb_action,
            },
            {
                "n": "Stochastic",
                "v": fixed_str(st, 0),
                "sig": "Overbought" if st > 80 else "Oversold" if st < 20 else "Neutral momentum",
                "t": "SELL" if st > 80 else "BUY" if st < 20 else "HOLD",
            },
            {"n": "ATR", "v": fixed_str(a, 2), "sig": "Intraday volatility measure", "t": "HOLD"},
            {"n": "Support", "v": fixed_str(sr["support"], 2), "sig": "Recent swing low", "t": "HOLD"},
            {
                "n": "Resistance",
                "v": fixed_str(sr["resistance"], 2),
                "sig": "Recent swing high",
                "t": "HOLD",
            },
            {"n": "Fair Value Gap", "v": fvg_value, "sig": fvg_state, "t": fsig["type"] if fsig else "HOLD"},
        ],
    }
