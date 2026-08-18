"""Smart-money structure: liquidity pools, sweeps, breaks, order blocks.

The retail "SMC/ICT" reading of a chart says price moves between pools of
resting orders. Stops sit above an obvious high and below an obvious low, so
those levels get taken out, and the claim is that the taking-out is the point:
liquidity is collected, the move reverses, and the reversal leaves a signature
you can trade — a break of structure, an order block, an imbalance.

This module only *finds* those objects. It takes no view on whether they
predict anything.

**They do not, on NIFTY, by themselves.** `engine/backtest/smc_replay.py`
replays the full setup over 2,228 sessions: 1,663 trades, 31.7% win rate,
−0.62 index points a trade before costs and −6.62 after, negative in all ten
years, and negative in all thirteen parameter variants tried. That is why
nothing here is wired into signal generation, and why `test_smc.py` fails if
something starts importing it into the decision path.

Every function is causal by construction: it reads the slice it is handed and
never an index beyond it, so a caller replaying bar by bar cannot accidentally
consult the future. Swings are the place that is easy to get wrong — a swing
high is only *known* `span` bars after it printed, and `swing_highs` returns
confirmed ones only, so a sweep can never be detected against a level the
market had not yet formed.

Definitions used here, stated plainly because the retail literature is loose:

  * **Pool** — a price where stops plausibly rest: yesterday's high, low or
    close, or a confirmed swing in today's session.
  * **Sweep** — one bar trades *through* a pool and closes back on the
    originating side. A close beyond it is a break, not a sweep; the
    distinction is the whole idea and is enforced in `sweep_at`.
  * **BOS / CHoCH** — a *close* beyond the reference swing. Continuation of
    the prevailing leg is a BOS; the first break against it is a CHoCH. Wicks
    do not count.
  * **Order block** — the last opposing candle before the displacement leg
    that broke structure, taken as its full high-low range.
  * **FVG** — a three-candle imbalance where candle 1 and candle 3 do not
    overlap. `indicators.detect_fvg` already finds these for the dashboard,
    but it scans a trailing window and reports zones by percentage size; here
    the gap wanted is the specific one inside a known displacement leg, so it
    is measured directly rather than filtered out of that list.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any, Sequence

from ..data.timeutil import IST
from .jsnum import to_fixed

CandleDict = dict[str, Any]

BUYSIDE = "buyside"
SELLSIDE = "sellside"
SHORT = "short"
LONG = "long"

#: A sweep of a buy-side pool sets up a short, and vice versa.
DIRECTION_AFTER_SWEEP = {BUYSIDE: SHORT, SELLSIDE: LONG}


@dataclass(frozen=True)
class Pool:
    """A price where stops plausibly rest."""

    price: float
    side: str  # BUYSIDE or SELLSIDE
    label: str
    #: Index of the bar that formed it, or None for a level inherited from a
    #: previous session. Used to refuse sweeps of levels that did not exist yet.
    idx: int | None = None


@dataclass(frozen=True)
class Sweep:
    idx: int
    pool: Pool
    extreme: float

    @property
    def depth(self) -> float:
        return abs(self.extreme - self.pool.price)

    @property
    def direction(self) -> str:
        return DIRECTION_AFTER_SWEEP[self.pool.side]


@dataclass(frozen=True)
class Break:
    idx: int
    level: float
    close: float
    kind: str  # "BOS" or "CHoCH"
    direction: str


@dataclass(frozen=True)
class Zone:
    lo: float
    hi: float
    idx: int
    kind: str  # "OB" or "FVG"

    @property
    def height(self) -> float:
        return self.hi - self.lo

    @property
    def mid(self) -> float:
        return (self.lo + self.hi) / 2

    def proximal(self, direction: str) -> float:
        """The edge price reaches first on the way back into the zone."""
        return self.lo if direction == SHORT else self.hi

    def distal(self, direction: str) -> float:
        return self.hi if direction == SHORT else self.lo


def group_sessions(rows: Sequence[CandleDict]) -> list[tuple[str, list[CandleDict]]]:
    """Split a candle series into IST trading days, oldest first."""
    days: dict[str, list[CandleDict]] = {}
    for row in rows:
        key = datetime.fromtimestamp(row["ts"] / 1000, tz=IST).strftime("%Y-%m-%d")
        days.setdefault(key, []).append(row)
    return [(day, days[day]) for day in sorted(days)]


def inherited_pools(previous: Sequence[CandleDict]) -> list[Pool]:
    """Yesterday's high, low and close: the levels every desk has marked.

    The close appears on both sides because it is not a high or a low — stops
    rest above and below it, and which side gets taken is the question.
    """
    return [
        Pool(max(c["h"] for c in previous), BUYSIDE, "previous day high"),
        Pool(min(c["l"] for c in previous), SELLSIDE, "previous day low"),
        Pool(previous[-1]["c"], BUYSIDE, "previous day close"),
        Pool(previous[-1]["c"], SELLSIDE, "previous day close"),
    ]


def swing_highs(candles: Sequence[CandleDict], span: int = 2) -> list[int]:
    """Indices of confirmed swing highs.

    Confirmed means `span` bars have since printed without exceeding it, so the
    last `span` bars can never appear here however high they are. That lag is
    not a limitation to work around — it is what the trader actually knew.
    """
    out = []
    for i in range(span, len(candles) - span):
        h = candles[i]["h"]
        if all(candles[j]["h"] <= h for j in range(i - span, i)) and all(
            candles[j]["h"] < h for j in range(i + 1, i + span + 1)
        ):
            out.append(i)
    return out


def swing_lows(candles: Sequence[CandleDict], span: int = 2) -> list[int]:
    out = []
    for i in range(span, len(candles) - span):
        low = candles[i]["l"]
        if all(candles[j]["l"] >= low for j in range(i - span, i)) and all(
            candles[j]["l"] > low for j in range(i + 1, i + span + 1)
        ):
            out.append(i)
    return out


def session_pools(
    candles: Sequence[CandleDict], upto: int, span: int = 2, inherited: Sequence[Pool] = ()
) -> list[Pool]:
    """Pools visible to a trader standing at bar `upto`.

    Inherited levels (yesterday's high, low, close) are always visible. Today's
    swings are only visible once confirmed, which is why the slice stops at
    `upto` rather than running to the end of the session.
    """
    seen = candles[: upto + 1]
    pools = list(inherited)
    for i in swing_highs(seen, span):
        pools.append(Pool(seen[i]["h"], BUYSIDE, "session high", i))
    for i in swing_lows(seen, span):
        pools.append(Pool(seen[i]["l"], SELLSIDE, "session low", i))
    return pools


def sweep_at(
    candles: Sequence[CandleDict], i: int, pools: Sequence[Pool], min_depth: float = 0.0
) -> Sweep | None:
    """Does bar `i` take a pool and close back inside?

    When several pools are taken at once the deepest one is returned: that is
    the level the move was reaching for, and the shallower ones were collateral.
    """
    bar = candles[i]
    best: Sweep | None = None
    for pool in pools:
        if pool.idx is not None and pool.idx >= i:
            continue
        if pool.side == BUYSIDE and bar["h"] > pool.price and bar["c"] < pool.price:
            candidate = Sweep(i, pool, bar["h"])
        elif pool.side == SELLSIDE and bar["l"] < pool.price and bar["c"] > pool.price:
            candidate = Sweep(i, pool, bar["l"])
        else:
            continue
        if candidate.depth < min_depth:
            continue
        if best is None or candidate.depth > best.depth:
            best = candidate
    return best


def reference_swing(
    candles: Sequence[CandleDict], upto: int, direction: str, span: int = 2
) -> float | None:
    """The level whose breach would confirm the reversal the sweep implied.

    For a short that is the most recent confirmed swing low before the sweep;
    if the session has not printed one yet, the session low stands in, since a
    move below the day's low is a break of structure by any reading.
    """
    seen = candles[: upto + 1]
    if not seen:
        return None
    if direction == SHORT:
        lows = swing_lows(seen, span)
        return seen[lows[-1]]["l"] if lows else min(c["l"] for c in seen)
    highs = swing_highs(seen, span)
    return seen[highs[-1]]["h"] if highs else max(c["h"] for c in seen)


def break_kind(candles: Sequence[CandleDict], upto: int, direction: str, span: int = 2) -> str:
    """BOS or CHoCH, decided by what the leg before the break was doing.

    A break that continues the prevailing direction is a break of structure; the
    first one against it is a change of character. Naming it correctly matters
    only for reading the results — the backtest records it so the two can be
    measured separately, and neither is filtered on.
    """
    seen = candles[: upto + 1]
    if direction == SHORT:
        highs = swing_highs(seen, span)
        if len(highs) < 2:
            return "BOS"
        rising = seen[highs[-1]]["h"] > seen[highs[-2]]["h"]
        return "CHoCH" if rising else "BOS"
    lows = swing_lows(seen, span)
    if len(lows) < 2:
        return "BOS"
    falling = seen[lows[-1]]["l"] < seen[lows[-2]]["l"]
    return "CHoCH" if falling else "BOS"


def broke(candle: CandleDict, level: float, direction: str) -> bool:
    return candle["c"] < level if direction == SHORT else candle["c"] > level


def order_block(
    candles: Sequence[CandleDict], break_idx: int, direction: str, lookback: int = 10
) -> Zone | None:
    """Last opposing candle before the displacement that broke structure."""
    floor = max(break_idx - lookback, 0)
    for i in range(break_idx - 1, floor - 1, -1):
        bullish = candles[i]["c"] >= candles[i]["o"]
        if bullish == (direction == SHORT):
            return Zone(candles[i]["l"], candles[i]["h"], i, "OB")
    return None


def fair_value_gap(
    candles: Sequence[CandleDict], i0: int, i1: int, direction: str
) -> Zone | None:
    """Largest three-candle imbalance in the displacement leg, if any."""
    best: Zone | None = None
    for i in range(max(i0, 1), min(i1, len(candles) - 2) + 1):
        prev, nxt = candles[i - 1], candles[i + 1]
        if direction == SHORT and prev["l"] > nxt["h"]:
            gap = Zone(nxt["h"], prev["l"], i, "FVG")
        elif direction == LONG and prev["h"] < nxt["l"]:
            gap = Zone(prev["h"], nxt["l"], i, "FVG")
        else:
            continue
        if best is None or gap.height > best.height:
            best = gap
    return best


def annotate(
    candles: Sequence[CandleDict],
    span: int = 2,
    min_sweep_pts: float = 0.0,
    ob_lookback: int = 10,
    max_marks: int = 6,
) -> dict:
    """Mark up a finished series for a chart: pools, sweeps, breaks, blocks.

    Unlike the rest of this module, which is called bar by bar by the replay,
    this describes history — what a chart should draw *now* about what already
    happened. It is mirrored in `app/lib/smc.js` under a parity test, so the
    dashboard and the engine cannot drift into disagreeing about where the
    structure is.

    A pool that was traded through and closed back inside is a sweep. A pool
    traded through and closed beyond is simply gone, and shows as taken rather
    than swept, because the two mean opposite things.
    """
    empty = {"pools": [], "sweeps": [], "breaks": [], "blocks": []}
    n = len(candles)
    if n < span * 2 + 2:
        return empty

    highs = swing_highs(candles, span)
    lows = swing_lows(candles, span)

    pools: list[dict] = []
    sweeps: list[dict] = []
    marked = [(i, BUYSIDE) for i in highs] + [(i, SELLSIDE) for i in lows]
    for idx, side in sorted(marked):
        buyside = side == BUYSIDE
        price = candles[idx]["h"] if buyside else candles[idx]["l"]
        taken = None
        for j in range(idx + span + 1, n):
            bar = candles[j]
            if not (bar["h"] > price if buyside else bar["l"] < price):
                continue
            taken = j
            extreme = bar["h"] if buyside else bar["l"]
            closed_back = bar["c"] < price if buyside else bar["c"] > price
            if closed_back and abs(extreme - price) >= min_sweep_pts:
                sweeps.append({
                    "index": j,
                    "poolIndex": idx,
                    "side": side,
                    "price": to_fixed(price, 2),
                    "extreme": to_fixed(extreme, 2),
                    "depth": to_fixed(abs(extreme - price), 2),
                })
            break
        pools.append({
            "index": idx,
            "side": side,
            "price": to_fixed(price, 2),
            "takenAt": taken,
            "resting": taken is None,
        })

    breaks: list[dict] = []
    used: set[int] = set()
    for j in range(span * 2 + 1, n):
        close = candles[j]["c"]
        for indices, key, direction in ((lows, "l", SHORT), (highs, "h", LONG)):
            prior = [i for i in indices if i + span < j and i not in used]
            if not prior:
                continue
            ref = prior[-1]
            level = candles[ref][key]
            if (close < level) if direction == SHORT else (close > level):
                used.add(ref)
                breaks.append({
                    "index": j,
                    "fromIndex": ref,
                    "level": to_fixed(level, 2),
                    "direction": direction,
                    "kind": break_kind(candles[: j + 1], j, direction, span),
                })

    blocks: list[dict] = []
    for brk in breaks:
        zone = order_block(candles[: brk["index"] + 1], brk["index"], brk["direction"], ob_lookback)
        if zone is None or any(b["index"] == zone.idx for b in blocks):
            continue
        proximal = zone.proximal(brk["direction"])
        mitigated = any(
            (c["h"] >= proximal) if brk["direction"] == SHORT else (c["l"] <= proximal)
            for c in candles[brk["index"] + 1 :]
        )
        blocks.append({
            "index": zone.idx,
            "lo": to_fixed(zone.lo, 2),
            "hi": to_fixed(zone.hi, 2),
            "direction": brk["direction"],
            "breakIndex": brk["index"],
            "mitigated": mitigated,
        })

    return {
        "pools": pools[-max_marks * 2 :],
        "sweeps": sweeps[-max_marks:],
        "breaks": breaks[-max_marks:],
        "blocks": blocks[-max_marks:],
    }


def protective_extreme(
    candles: Sequence[CandleDict], ob_idx: int, direction: str, span: int = 2
) -> float:
    """Extreme of the swing that produced the order block — the invalidation.

    Wider than the order block alone on purpose: in the textbook sequence the
    sweep prints one or two bars before the block, and a stop tucked under the
    block but inside the sweep's wick is sitting exactly where the last lot of
    stops just got taken.
    """
    window = candles[max(ob_idx - span, 0) : ob_idx + 1]
    return max(c["h"] for c in window) if direction == SHORT else min(c["l"] for c in window)
