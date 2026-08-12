"""Hypothesis tests for tradeable structure in NIFTY.

Different in kind from `backtest/`. The backtest asks "does this strategy make
money"; this asks "is there any conditional structure worth building a strategy
around". Measuring the conditional distribution first, and only then writing a
strategy, is the order that avoids fitting rules to noise.

Every test reports sample size, effect size and a confidence interval rather
than just a p-value, because on nineteen years of data a statistically
significant effect can still be far too small to survive costs. Costs are the
bar, not significance.
"""
from __future__ import annotations

from collections import defaultdict
from datetime import datetime
from typing import Sequence

from ..data.base import Candle
from ..data.timeutil import IST
from .stats import Finding, test_mean, test_proportion

WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"]


def _ist(c: Candle) -> datetime:
    return datetime.fromtimestamp(c.ts / 1000, tz=IST)


def _pct(a: float, b: float) -> float:
    return (a - b) / b * 100 if b else 0.0


# ── session decomposition ──────────────────────────────────────────────────

def overnight_vs_intraday(daily: Sequence[Candle]) -> list[Finding]:
    """Split each day's return into the overnight move and the session move.

    Worth isolating because if the index's drift is concentrated overnight,
    then an intraday-only strategy is fighting a headwind that has nothing to
    do with the quality of its signals — the session itself has negative
    expectancy for a long.

    Tested against zero, not against the unconditional mean, since the
    question here is the absolute sign of each component.
    """
    overnight = [_pct(cur.o, prev.c) for prev, cur in zip(daily, daily[1:])]
    intraday = [_pct(cur.c, cur.o) for cur in daily[1:] if cur.o]
    full = [_pct(cur.c, prev.c) for prev, cur in zip(daily, daily[1:])]

    return [
        test_mean("Overnight (prev close -> open)", overnight, 0.0,
                  "the move captured by holding through the night"),
        test_mean("Intraday (open -> close)", intraday, 0.0,
                  "the move available to an intraday-only strategy"),
        test_mean("Full day (close -> close)", full, 0.0),
    ]


def overnight_drift_by_period(daily: Sequence[Candle], years_per_bucket: int = 4) -> list[Finding]:
    """Does the overnight effect persist, or has it been arbitraged away?

    A published anomaly that only exists in the first half of the sample is a
    history lesson, not a strategy. Splitting by period is the cheapest
    version of the walk-forward test, and the one that most often kills an
    otherwise attractive result.
    """
    buckets: dict[str, list[float]] = defaultdict(list)
    for prev, cur in zip(daily, daily[1:]):
        year = _ist(cur).year
        start = year - (year % years_per_bucket)
        buckets[f"{start}-{start + years_per_bucket - 1}"].append(_pct(cur.o, prev.c))

    return [
        test_mean(f"Overnight drift {label}", vals, 0.0)
        for label, vals in sorted(buckets.items())
        if len(vals) >= 30
    ]


def intraday_drift_by_period(daily: Sequence[Candle], years_per_bucket: int = 4) -> list[Finding]:
    buckets: dict[str, list[float]] = defaultdict(list)
    for cur in daily:
        if not cur.o:
            continue
        year = _ist(cur).year
        start = year - (year % years_per_bucket)
        buckets[f"{start}-{start + years_per_bucket - 1}"].append(_pct(cur.c, cur.o))

    return [
        test_mean(f"Intraday drift {label}", vals, 0.0)
        for label, vals in sorted(buckets.items())
        if len(vals) >= 30
    ]


# ── overnight gaps ─────────────────────────────────────────────────────────

def gap_continuation(daily: Sequence[Candle], threshold: float = 0.3) -> list[Finding]:
    """After an overnight gap, does the rest of the session continue in the
    gap's direction or fade it?

    Return measured is open→close, which is what an intraday trade entered at
    the open would actually capture. Measuring close→close instead would
    credit the strategy with the gap itself, which is untradeable.
    """
    up: list[float] = []
    down: list[float] = []
    flat: list[float] = []

    for prev, cur in zip(daily, daily[1:]):
        gap = _pct(cur.o, prev.c)
        intraday = _pct(cur.c, cur.o)
        if gap >= threshold:
            up.append(intraday)
        elif gap <= -threshold:
            down.append(intraday)
        else:
            flat.append(intraday)

    all_intraday = up + down + flat
    base = sum(all_intraday) / len(all_intraday) if all_intraday else 0.0

    return [
        test_mean(f"Gap up >{threshold}% -> open-to-close", up, base,
                  "positive means continuation, negative means fade"),
        test_mean(f"Gap down <-{threshold}% -> open-to-close", down, base,
                  "negative means continuation, positive means fade"),
        test_mean("No significant gap -> open-to-close", flat, base),
    ]


def gap_fill(daily: Sequence[Candle], threshold: float = 0.3) -> list[Finding]:
    """How often does the session trade back through the previous close?"""
    up_filled = up_total = 0
    down_filled = down_total = 0

    for prev, cur in zip(daily, daily[1:]):
        gap = _pct(cur.o, prev.c)
        if gap >= threshold:
            up_total += 1
            if cur.l <= prev.c:
                up_filled += 1
        elif gap <= -threshold:
            down_total += 1
            if cur.h >= prev.c:
                down_filled += 1

    return [
        test_proportion(f"Gap up >{threshold}% fills same day", up_filled, up_total, 0.5),
        test_proportion(f"Gap down <-{threshold}% fills same day", down_filled, down_total, 0.5),
    ]


# ── calendar effects ───────────────────────────────────────────────────────

def weekday_effect(daily: Sequence[Candle]) -> list[Finding]:
    buckets: dict[int, list[float]] = defaultdict(list)
    for prev, cur in zip(daily, daily[1:]):
        buckets[_ist(cur).weekday()].append(_pct(cur.c, prev.c))

    every = [v for vals in buckets.values() for v in vals]
    base = sum(every) / len(every) if every else 0.0
    return [
        test_mean(f"{WEEKDAYS[d]} close-to-close", buckets[d], base)
        for d in sorted(buckets)
        if d < 5
    ]


def month_effect(daily: Sequence[Candle]) -> list[Finding]:
    buckets: dict[int, list[float]] = defaultdict(list)
    for prev, cur in zip(daily, daily[1:]):
        buckets[_ist(cur).month].append(_pct(cur.c, prev.c))

    every = [v for vals in buckets.values() for v in vals]
    base = sum(every) / len(every) if every else 0.0
    names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
             "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
    return [
        test_mean(f"{names[m - 1]} close-to-close", buckets[m], base)
        for m in sorted(buckets)
    ]


def time_of_day(intraday: Sequence[Candle]) -> list[Finding]:
    """Intraday seasonality. The open and the close behave differently from
    the middle of the session in most markets; the question is whether the
    difference is large enough to trade."""
    buckets: dict[str, list[float]] = defaultdict(list)
    for c in intraday:
        if c.o <= 0:
            continue
        t = _ist(c)
        buckets[f"{t.hour:02d}:{t.minute:02d}"].append(_pct(c.c, c.o))

    every = [v for vals in buckets.values() for v in vals]
    base = sum(every) / len(every) if every else 0.0
    return [
        test_mean(f"Bar at {slot} (open-to-close)", vals, base)
        for slot, vals in sorted(buckets.items())
        if len(vals) >= 30
    ]


# ── mean reversion and momentum ────────────────────────────────────────────

def reversion_after_move(daily: Sequence[Candle], threshold: float = 1.0) -> list[Finding]:
    """After an outsized day, does the next day revert or continue?"""
    after_down: list[float] = []
    after_up: list[float] = []

    for prev, cur, nxt in zip(daily, daily[1:], daily[2:]):
        move = _pct(cur.c, prev.c)
        nxt_ret = _pct(nxt.c, cur.c)
        if move <= -threshold:
            after_down.append(nxt_ret)
        elif move >= threshold:
            after_up.append(nxt_ret)

    every = [_pct(b.c, a.c) for a, b in zip(daily, daily[1:])]
    base = sum(every) / len(every) if every else 0.0
    return [
        test_mean(f"Day after a <-{threshold}% day", after_down, base,
                  "positive means mean reversion"),
        test_mean(f"Day after a >+{threshold}% day", after_up, base,
                  "positive means momentum"),
    ]


def streak_effect(daily: Sequence[Candle], length: int = 3) -> list[Finding]:
    """Does a run of consecutive up or down days predict the next one?"""
    rets = [_pct(b.c, a.c) for a, b in zip(daily, daily[1:])]
    after_down: list[float] = []
    after_up: list[float] = []

    for i in range(length, len(rets)):
        window = rets[i - length: i]
        if all(r < 0 for r in window):
            after_down.append(rets[i])
        elif all(r > 0 for r in window):
            after_up.append(rets[i])

    base = sum(rets) / len(rets) if rets else 0.0
    return [
        test_mean(f"Day after {length} down days", after_down, base),
        test_mean(f"Day after {length} up days", after_up, base),
    ]


def opening_range_breakout(
    intraday: Sequence[Candle], open_bars: int = 3
) -> list[Finding]:
    """Does breaking the opening range predict where the session closes?

    This one is directly relevant: `indicators.py` already computes the
    opening range and `suggestion.py` votes on breaks of it, so a null result
    here means that factor is contributing noise to every signal.
    """
    by_day: dict[str, list[Candle]] = defaultdict(list)
    for c in intraday:
        by_day[_ist(c).strftime("%Y-%m-%d")].append(c)

    up_break: list[float] = []
    down_break: list[float] = []
    no_break: list[float] = []

    for _, bars in sorted(by_day.items()):
        if len(bars) < open_bars + 5:
            continue
        opening = bars[:open_bars]
        rest = bars[open_bars:]
        hi = max(c.h for c in opening)
        lo = min(c.l for c in opening)
        close = rest[-1].c

        broke_up = next((c for c in rest if c.h > hi), None)
        broke_down = next((c for c in rest if c.l < lo), None)

        if broke_up and (not broke_down or broke_up.ts <= broke_down.ts):
            up_break.append(_pct(close, hi))
        elif broke_down:
            down_break.append(_pct(lo, close))
        else:
            no_break.append(abs(_pct(close, rest[0].o)))

    return [
        test_mean("Upside OR break -> break level to close", up_break, 0.0,
                  "positive means the breakout followed through"),
        test_mean("Downside OR break -> break level to close", down_break, 0.0,
                  "positive means the breakdown followed through"),
    ]


# ── runner ─────────────────────────────────────────────────────────────────

def run_all(
    daily: Sequence[Candle],
    hourly: Sequence[Candle] = (),
    intraday: Sequence[Candle] = (),
) -> list[Finding]:
    findings: list[Finding] = []
    if daily:
        findings += overnight_vs_intraday(daily)
        findings += overnight_drift_by_period(daily)
        findings += intraday_drift_by_period(daily)
        findings += gap_continuation(daily)
        findings += gap_fill(daily)
        findings += reversion_after_move(daily)
        findings += streak_effect(daily)
        findings += weekday_effect(daily)
        findings += month_effect(daily)
    if hourly:
        findings += time_of_day(hourly)
    if intraday:
        findings += opening_range_breakout(intraday)
    return findings
