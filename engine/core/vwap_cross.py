"""The EMA / VWAP cross, as a live reading rather than a replay.

`engine/backtest/vwap_cross.py` measures this setup over history; this module
states the rule once so the panel on the screen and the number in the README
cannot drift apart. Both import `cross_direction` from here.

What the backtest found, because it decides how this may be presented: over the
246 archived sessions that carry volume the rule returns **-3.71 index points a
trade before costs and -9.71 after**, at a 25.4% win rate, with neither year
positive. So `vwap_cross_signal` deliberately reports two things rather than
one — what the rule says, and whether the rule's own reward:risk test would
have allowed it. On the measured sample that test refuses 66% of crosses, and a
panel that showed only the first half would be advertising the losing version.

The honesty this module has to carry that a chart does not:

  * **VWAP needs volume, and NIFTY is an index.** Only 269 of 2,260 archived
    sessions carry any. Where volume is absent this returns `available: False`
    rather than a direction, because the alternative — averaging closes and
    calling it VWAP — produces a line identical to price and a signal that
    fires on nearly every bar. `indicators.intraday_session` still falls back
    for its other callers, so its `volumed` flag is what gets checked here.
  * **The last bar may still be printing.** A cross read on an unfinished bar
    can un-fire. `fresh` means the cross is on the most recent bar in the
    series, and the caller is told which bar that is so it can say so.
"""
from __future__ import annotations

from typing import Any, Sequence

from .indicators import ema, intraday_session, support_resistance

CandleDict = dict[str, Any]

LONG = "long"
SHORT = "short"

#: The stop the strategy is stated with, and the contract it applies to.
DEFAULT_RUPEE_STOP = 800.0
NIFTY_LOT_SIZE = 75
#: At-the-money delta on a NIFTY weekly, from the measured chain in
#: `backtest/calibrate.py`. The rupee-to-points conversion turns on it.
ATM_DELTA = 0.52


def stop_points(rupees: float = DEFAULT_RUPEE_STOP,
                lot: int = NIFTY_LOT_SIZE,
                delta: float = ATM_DELTA) -> float:
    """Index points of adverse move that costs `rupees` on one long option.

    Premium moves by `delta` per point of index, so the index distance is
    (rupees / lot) / delta. Exact only at entry: delta grows into a winning
    move and shrinks out of a losing one.
    """
    return (rupees / lot) / delta


def cross_direction(prev_ema: float, prev_vwap: float,
                    now_ema: float, now_vwap: float) -> str | None:
    """Direction if EMA changed sides against VWAP, else None.

    Touching counts as crossing: an EMA that has arrived at VWAP has left the
    side it was on, and requiring an overshoot would drop signals silently.
    """
    if prev_ema < prev_vwap and now_ema >= now_vwap:
        return LONG
    if prev_ema > prev_vwap and now_ema <= now_vwap:
        return SHORT
    return None


def session_vwaps(session: Sequence[CandleDict]) -> list[float | None]:
    """Running session VWAP after each bar; None until any volume has traded.

    A zero-volume bar does not corrupt the average, it simply does not
    participate: it contributes nothing to either side of `sum(tp*v)/sum(v)`,
    so VWAP after it equals VWAP before it. This matters in practice because
    live feeds pad the tail of a session with zero-volume bars, and treating
    those as a hole would blank the reading exactly when it is being watched.

    The genuinely undefined case is a session where nothing has traded at all —
    0/0 — and that is what None marks. Most of this archive's 5-minute NIFTY
    history is that case, because NIFTY is an index and carries no volume of
    its own. Averaging closes instead would produce a line identical to price;
    see `fully_volumed` for the stricter test the backtest applies on top.
    """
    out: list[float | None] = []
    pv = 0.0
    vol = 0.0
    for c in session:
        v = c.get("vol") or 0
        if v > 0:
            pv += ((c["h"] + c["l"] + c["c"]) / 3) * v
            vol += v
        out.append(pv / vol if vol > 0 else None)
    return out


def fully_volumed(session: Sequence[CandleDict]) -> bool:
    """Whether every bar of the session traded.

    A data-quality test, deliberately separate from the definition of VWAP
    above. The backtest requires it because a session where volume appears
    sporadically produces a VWAP that lurches as the weighting arrives, and
    measuring a strategy against a line like that says more about the feed than
    the rule. It only ever shrinks the sample, so it cannot flatter the result.
    Live readings do not apply it — a padded tail is not a broken session.
    """
    return bool(session) and all((c.get("vol") or 0) > 0 for c in session)


def _ist_day(ts: int) -> str:
    from datetime import datetime

    from ..data.timeutil import IST

    return datetime.fromtimestamp(ts / 1000, tz=IST).strftime("%Y-%m-%d")


def vwap_cross_signal(
    candles: Sequence[CandleDict],
    ema_period: int = 9,
    stop_pts: float | None = None,
    min_rr: float = 1.5,
    sr_lookback: int = 20,
) -> dict:
    """Where the EMA/VWAP cross stands right now, and whether it is tradeable.

    `action` is the rule's own answer. `gate` is whether the reward:risk test
    the backtest applied would have taken it. They disagree often, and the
    caller is expected to show both.
    """
    stop_pts = stop_points() if stop_pts is None else stop_pts
    # Positions in the caller's array are kept alongside the usable bars, so a
    # reported cross index still points at the right candle after undated bars
    # are dropped. The chart draws markers from these, and an index into a
    # filtered copy would silently place them on the wrong bar.
    dated = [(i, c) for i, c in enumerate(candles) if c.get("ts") is not None]
    rows = [c for _, c in dated]
    positions = [i for i, _ in dated]
    unavailable = {
        "available": False,
        "volumed": False,
        "action": "HOLD",
        "label": "NO DATA",
        "fresh": False,
        "bias": None,
        "crosses": [],
        "lastCross": None,
        "levels": None,
        "gate": None,
    }

    if len(rows) < ema_period + 2:
        return {**unavailable, "reason": "not enough bars"}

    today = _ist_day(rows[-1]["ts"])
    session = [c for c in rows if _ist_day(c["ts"]) == today]
    if len(session) < 2:
        return {**unavailable, "reason": "session has not started"}

    vwaps = session_vwaps(session)
    if vwaps[-1] is None:
        # The important branch. An index feed where nothing has traded has no
        # VWAP, and saying so is the whole point of this module.
        return {
            **unavailable,
            "reason": "no volume on this feed — VWAP is undefined",
            "label": "NO VWAP",
        }

    # EMA runs continuously across sessions, which is what the chart draws, so
    # it is computed on the full series and indexed into for today.
    emas = ema([c["c"] for c in rows], ema_period)
    base = len(rows) - len(session)

    crosses = []
    for i in range(1, len(session)):
        # Bars before the session's first trade have no VWAP to be either side
        # of, so they cannot produce a cross.
        if vwaps[i - 1] is None or vwaps[i] is None:
            continue
        direction = cross_direction(
            emas[base + i - 1], vwaps[i - 1], emas[base + i], vwaps[i]
        )
        if direction:
            crosses.append({
                "index": positions[base + i],
                "direction": direction,
                "time": session[i].get("t") or "",
                "price": round(session[i]["c"], 2),
                "barsAgo": len(session) - 1 - i,
            })

    last_ema = emas[-1]
    last_vwap = vwaps[-1]
    last = crosses[-1] if crosses else None
    fresh = bool(last and last["barsAgo"] == 0)
    bias = LONG if last_ema >= last_vwap else SHORT

    if fresh:
        action = "BUY" if last["direction"] == LONG else "SELL"
        label = "BUY CE" if last["direction"] == LONG else "SELL PE"
    else:
        action = "HOLD"
        label = "NO CROSS"

    # Levels for the cross that would be acted on, priced from the last close
    # and the levels visible now. Reported even when the gate refuses, because
    # the refusal is only legible next to the numbers that caused it.
    entry = round(rows[-1]["c"], 2)
    sr = support_resistance(rows[-sr_lookback:], sr_lookback)
    direction = last["direction"] if fresh else bias
    target = sr["resistance"] if direction == LONG else sr["support"]
    reward = abs(target - entry)
    rr = round(reward / stop_pts, 2) if stop_pts else None

    if (direction == LONG and target <= entry) or (direction == SHORT and target >= entry):
        gate = {"passes": False,
                "reason": f"price is already past the nearest level ({target:g})"}
    elif rr is not None and rr < min_rr:
        # `:g` rather than the default repr, because JavaScript prints 2.0 as
        # "2" and this string is diffed against it character for character.
        gate = {"passes": False,
                "reason": f"{reward:.0f}-pt target against a {stop_pts:.0f}-pt stop "
                          f"is {rr:.2f}:1, under the {min_rr:g}:1 floor"}
    else:
        gate = {"passes": True, "reason": f"{rr:.2f}:1 clears the {min_rr:g}:1 floor"}

    return {
        "available": True,
        "reason": None,
        "volumed": True,
        "ema": round(last_ema, 2),
        "vwap": round(last_vwap, 2),
        "gapPts": round(last_ema - last_vwap, 2),
        "bias": bias,
        "action": action,
        "label": label,
        "fresh": fresh,
        "lastCross": last,
        "crosses": crosses,
        "crossesToday": len(crosses),
        "lastBarTime": rows[-1].get("t") or "",
        "levels": {
            "entry": entry,
            "stop": round(entry - stop_pts if direction == LONG else entry + stop_pts, 2),
            "target": round(target, 2),
            "stopPts": round(stop_pts, 2),
            "rr": rr,
        },
        "gate": gate,
    }
