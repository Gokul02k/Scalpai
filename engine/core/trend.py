"""Directional bias for the day, before the open and again after it.

Two calls, deliberately separate because they answer different questions from
different information:

`pre_open_trend` runs on yesterday's daily candles and yesterday's VIX close.
Nothing about today is knowable yet, so it is a forecast.

`post_open_trend` adds today's session: the gap, the opening range, where price
sits against VWAP. It is a read of what actually happened rather than a guess
about what will.

Both return the same shape as `build_unified_suggestion` so the v1 dashboard can
render them with the existing card, and both are mirrored in
`app/lib/trend.js` under a parity test.

**Neither call predicts direction, and both were measured before shipping.**
Over 2,676 sessions, acting on the pre-open call returns -0.032% a day at a
47.6% hit rate, worse than simply holding long. The post-open call over the
following 30 minutes -- the scalp window -- returns -0.005% a day at 51.6%,
against a round-trip cost of about 0.025%. Its own confidence does not sort
outcomes either: the 70+ bucket hits 51.1% while 50-59 hits 52.9%.

This is consistent with what was already known. NIFTY's intraday drift is
negative (-0.049% per session, p=0.004) while all of its return is overnight,
and gap continuation and opening-range breakout each failed a 19-year
significance test.

So this module exists to describe the tape, not to trade it. Nothing here is
wired into signal generation, and the "confidence" it reports measures how much
the factors agree, not how likely they are to be right.
"""
from __future__ import annotations

from typing import Any, Sequence

from .indicators import ema
from .jsnum import js_round, js_sum, to_fixed

CandleDict = dict[str, Any]

TREND_LABELS = {
    "UP": "Upward bias",
    "DOWN": "Downward bias",
    "FLAT": "No clear bias",
}

#: A factor has to clear this share of the total weight cast before the call is
#: allowed a direction. Set above a bare majority because the underlying daily
#: series has almost no drift, so a 51/49 split is noise wearing a direction.
DECISION_MARGIN = 0.20


def _pct(a: float, b: float) -> float:
    return (a - b) / b * 100 if b else 0.0


def _factor(name: str, view: str, weight: int, detail: str) -> dict:
    return {"n": name, "t": view, "w": weight, "v": detail}


# ── pre-open ───────────────────────────────────────────────────────────────

def pre_open_factors(daily: Sequence[CandleDict], vix: Sequence[float]) -> list[dict]:
    """Everything knowable about today's direction before today exists.

    `daily` must end with yesterday's candle; `vix` with yesterday's close.
    Passing today's own bar would make every result here a lie.
    """
    out: list[dict] = []
    if len(daily) < 21:
        return out

    closes = [c["c"] for c in daily]
    prev, before = daily[-1], daily[-2]
    last = closes[-1]

    # 1. Where price sits against its own trend.
    e20 = ema(closes, 20)[-1]
    out.append(_factor(
        "Daily trend", "UP" if last > e20 else "DOWN", 2,
        f"close {_pct(last, e20):+.2f}% vs 20-day EMA",
    ))

    # 2. Three-day momentum.
    if len(closes) >= 4:
        chg3 = _pct(last, closes[-4])
        view = "UP" if chg3 > 0.5 else "DOWN" if chg3 < -0.5 else "FLAT"
        out.append(_factor("3-day momentum", view, 1, f"{chg3:+.2f}% over 3 sessions"))

    # 3. Momentum after a large up day. The strongest lead in the research
    #    table: following a close of +1% or more the next day averages +0.238%
    #    (n=698, p=0.0029). Below the corrected bar, so weighted like a hint.
    day_chg = _pct(prev["c"], before["c"])
    if day_chg >= 1.0:
        out.append(_factor("Large up day", "UP", 2, f"yesterday {day_chg:+.2f}%"))
    elif day_chg <= -1.0:
        out.append(_factor("Large down day", "DOWN", 1, f"yesterday {day_chg:+.2f}%"))

    # 4. Close position within yesterday's range. Closing on the high is the
    #    classic tell that buyers still had work left at the bell.
    span = prev["h"] - prev["l"]
    if span > 0:
        pos = (prev["c"] - prev["l"]) / span
        if pos >= 0.7:
            out.append(_factor("Closed strong", "UP", 1, f"{pos * 100:.0f}% of yesterday's range"))
        elif pos <= 0.3:
            out.append(_factor("Closed weak", "DOWN", 1, f"{pos * 100:.0f}% of yesterday's range"))

    # 5. Volatility regime. Calm tape favours whatever the trend already is;
    #    a VIX spike is the market pricing a move it cannot direct, so it
    #    argues for standing aside rather than for a side.
    if len(vix) >= 20:
        level = vix[-1]
        mean20 = js_sum(vix[-20:]) / 20
        ratio = level / mean20 if mean20 else 1.0
        if ratio >= 1.15:
            out.append(_factor("Volatility spike", "FLAT", 2,
                               f"VIX {level:.2f}, {(ratio - 1) * 100:+.0f}% vs 20-day"))
        elif level <= 16:
            out.append(_factor("Calm volatility", "FLAT", 0, f"VIX {level:.2f}"))

    return out


def pre_open_trend(daily: Sequence[CandleDict], vix: Sequence[float]) -> dict:
    return _assemble("pre-open", pre_open_factors(daily, vix),
                     "Bias for the session, from yesterday's close.")


# ── after the open ─────────────────────────────────────────────────────────

def post_open_factors(
    daily: Sequence[CandleDict],
    session: Sequence[CandleDict],
    vix: Sequence[float],
    vwap: float | None = None,
) -> list[dict]:
    """The pre-open view, plus what today has actually done so far.

    `session` is today's intraday candles in order, oldest first.
    """
    out = list(pre_open_factors(daily, vix))
    if not session or len(daily) < 2:
        return out

    prev_close = daily[-1]["c"]
    spot = session[-1]["c"]

    # 6. The gap. Weighted 1 rather than 3 on purpose: gap continuation was
    #    tested over 19 years and failed the corrected bar, so it is included
    #    as description of the tape, not as a prediction.
    gap = _pct(session[0]["o"], prev_close)
    if abs(gap) >= 0.15:
        out.append(_factor("Opening gap", "UP" if gap > 0 else "DOWN", 1,
                           f"{gap:+.2f}% at the bell"))

    # 7. Has the gap held? Whether buyers defended the open is worth more than
    #    the gap itself, and unlike the gap it is not a published anomaly.
    since_open = _pct(spot, session[0]["o"])
    if abs(since_open) >= 0.1:
        out.append(_factor("Since the open", "UP" if since_open > 0 else "DOWN", 2,
                           f"{since_open:+.2f}% from the opening print"))

    # 8. VWAP, the intraday line institutions are measured against.
    if vwap:
        out.append(_factor("Versus VWAP", "UP" if spot > vwap else "DOWN", 2,
                           f"{_pct(spot, vwap):+.2f}% vs VWAP"))

    # 9. Opening range, once there is one. Weighted 1 for the same reason as
    #    the gap: the univariate breakout test came up empty.
    if len(session) >= 3:
        opening = session[:3]
        hi = max(c["h"] for c in opening)
        lo = min(c["l"] for c in opening)
        if spot > hi:
            out.append(_factor("Opening range", "UP", 1, "broke above the first 15 minutes"))
        elif spot < lo:
            out.append(_factor("Opening range", "DOWN", 1, "broke below the first 15 minutes"))
        else:
            out.append(_factor("Opening range", "FLAT", 1, "still inside the first 15 minutes"))

    return out


def post_open_trend(
    daily: Sequence[CandleDict],
    session: Sequence[CandleDict],
    vix: Sequence[float],
    vwap: float | None = None,
) -> dict:
    return _assemble("open", post_open_factors(daily, session, vix, vwap),
                     "Bias for the rest of the session, from the tape so far.")


# ── vote ───────────────────────────────────────────────────────────────────

def _assemble(phase: str, factors: Sequence[dict], note: str) -> dict:
    up = js_sum([f["w"] for f in factors if f["t"] == "UP"])
    down = js_sum([f["w"] for f in factors if f["t"] == "DOWN"])
    flat = js_sum([f["w"] for f in factors if f["t"] == "FLAT"])
    total = up + down + flat

    if not total:
        return {
            "phase": phase, "action": "FLAT", "label": TREND_LABELS["FLAT"],
            "confidence": 0, "factors": list(factors), "note": "Not enough history yet.",
            "up": 0, "down": 0, "flat": 0,
        }

    margin = (up - down) / total
    if margin >= DECISION_MARGIN:
        action = "UP"
    elif margin <= -DECISION_MARGIN:
        action = "DOWN"
    else:
        action = "FLAT"

    # How much the factors agree, and nothing more. Measured against nine years
    # of sessions it does not sort outcomes -- the 70+ bucket hits 51.1% and the
    # 50-59 bucket 52.9% -- so it must never be presented as a probability of
    # being right. The UI labels it "agreement" for that reason.
    # js_round, not round: Python rounds halves to even and Math.round takes
    # them upward, which on an exact .5 shows up as a one-point parity break.
    strength = abs(margin)
    agreement = (50 + js_round(strength * 45) if action != "FLAT"
                 else 50 - js_round(strength * 30))

    return {
        "phase": phase,
        "action": action,
        "label": TREND_LABELS[action],
        "confidence": max(20, min(90, int(agreement))),
        "factors": list(factors),
        "note": note,
        "up": up,
        "down": down,
        "flat": flat,
        "margin": to_fixed(margin, 3),
    }
