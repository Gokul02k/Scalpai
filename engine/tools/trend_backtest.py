"""Does the trend call predict anything, or is it decoration?

Two questions, tested separately because they have different answers:

  pre-open   does yesterday's information predict today's open -> close?
  post-open  does the tape at 9:30 predict 9:30 -> close?

The second is the one the user actually wants, because a 9:15-9:30 scalp needs
a call that is right about the next few minutes. Both are scored against the
only benchmark that matters -- what you would have got by always going long,
which is not zero, and for the intraday session is negative.

    .venv/bin/python -m engine.tools.trend_backtest
"""
from __future__ import annotations

from collections import defaultdict
from datetime import datetime
from zoneinfo import ZoneInfo

from engine.core import trend as tr
from engine.core.indicators import candles_to_dicts
from engine.data import CandleStore

IST = ZoneInfo("Asia/Kolkata")


def day_of(ts: int) -> str:
    return datetime.fromtimestamp(ts / 1000, IST).strftime("%Y-%m-%d")


def load():
    store = CandleStore()
    daily = candles_to_dicts(store.read("NIFTY", "INDEX", "1d"))
    vix = candles_to_dicts(store.read("INDIAVIX", "INDEX", "1d"))
    intraday = candles_to_dicts(store.read("NIFTY", "INDEX", "5m"))

    sessions: dict[str, list] = defaultdict(list)
    for c in intraday:
        sessions[day_of(c["ts"])].append(c)
    return daily, vix, sessions


def summarise(title: str, rows: list[tuple[str, float]], benchmark: list[float]) -> None:
    """rows are (call, forward return %). Benchmark is the same days held long."""
    print(f"\n  {title}")
    if not rows:
        print("    no samples")
        return

    by_call: dict[str, list[float]] = defaultdict(list)
    for call, ret in rows:
        by_call[call].append(ret)

    bench = sum(benchmark) / len(benchmark) if benchmark else 0.0
    print(f"    {'call':>6}{'days':>8}{'mean %':>10}{'hit rate':>11}{'vs long':>10}")
    for call in ("UP", "DOWN", "FLAT"):
        v = by_call.get(call, [])
        if not v:
            continue
        mean = sum(v) / len(v)
        # A DOWN call is right when the market falls, so score it short.
        wins = sum(1 for r in v if (r > 0) == (call == "UP"))
        hit = wins / len(v) * 100 if call in ("UP", "DOWN") else 0.0
        print(f"    {call:>6}{len(v):>8}{mean:>+10.3f}"
              + (f"{hit:>10.1f}%" if call != "FLAT" else f"{'-':>11}")
              + f"{mean - bench:>+10.3f}")
    print(f"    {'long':>6}{len(benchmark):>8}{bench:>+10.3f}{'-':>11}{'-':>10}")

    # The only number that matters: acting on the call, long on UP and short on
    # DOWN, standing aside on FLAT.
    traded = [r for c, r in rows if c == "UP"] + [-r for c, r in rows if c == "DOWN"]
    if traded:
        mean = sum(traded) / len(traded)
        print(f"    trading the call: {len(traded)} days, {mean:+.3f}% per day, "
              f"{sum(1 for t in traded if t > 0) / len(traded) * 100:.1f}% hit")


def main() -> int:
    daily, vix, sessions = load()
    print(f"\n  {len(daily)} daily bars, {len(vix)} vix bars, {len(sessions)} sessions")

    vix_by_day = {day_of(c["ts"]): c["c"] for c in vix}
    vix_days = sorted(vix_by_day)

    pre_rows: list[tuple[str, float]] = []
    pre_bench: list[float] = []
    post_rows: list[tuple[str, float]] = []
    post_bench: list[float] = []

    for i in range(21, len(daily)):
        today = daily[i]
        d = day_of(today["ts"])
        hist = daily[:i]                     # strictly before today
        vhist = [vix_by_day[x] for x in vix_days if x < d]
        if len(vhist) < 20:
            continue

        # Pre-open: predict today's open -> close.
        call = tr.pre_open_trend(hist, vhist)
        intraday_ret = (today["c"] - today["o"]) / today["o"] * 100
        pre_rows.append((call["action"], intraday_ret))
        pre_bench.append(intraday_ret)

        # Post-open: at 9:30, predict 9:30 -> close.
        bars = sessions.get(d) or []
        if len(bars) >= 6:
            first15 = bars[:3]
            at930 = bars[2]["c"]
            pv = sum((b["h"] + b["l"] + b["c"]) / 3 * (b.get("vol") or 0) for b in first15)
            vol = sum((b.get("vol") or 0) for b in first15)
            vwap = pv / vol if vol else None
            call2 = tr.post_open_trend(hist, first15, vhist, vwap)
            rest = (bars[-1]["c"] - at930) / at930 * 100
            post_rows.append((call2["action"], rest))
            post_bench.append(rest)

    summarise("PRE-OPEN call vs today's open -> close", pre_rows, pre_bench)
    summarise("POST-OPEN call at 9:30 vs 9:30 -> close", post_rows, post_bench)

    # A scalp closes in minutes, not at the bell. Same call, shorter horizon.
    scalp: list[tuple[str, float]] = []
    scalp_bench: list[float] = []
    for i in range(21, len(daily)):
        d = day_of(daily[i]["ts"])
        bars = sessions.get(d) or []
        if len(bars) < 9:
            continue
        vhist = [vix_by_day[x] for x in vix_days if x < d]
        if len(vhist) < 20:
            continue
        first15 = bars[:3]
        pv = sum((b["h"] + b["l"] + b["c"]) / 3 * (b.get("vol") or 0) for b in first15)
        vol = sum((b.get("vol") or 0) for b in first15)
        call = tr.post_open_trend(daily[:i], first15, vhist, pv / vol if vol else None)
        ret = (bars[8]["c"] - bars[2]["c"]) / bars[2]["c"] * 100   # 9:30 -> 10:00
        scalp.append((call["action"], ret))
        scalp_bench.append(ret)
    summarise("POST-OPEN call at 9:30 vs the next 30 minutes (the scalp)",
              scalp, scalp_bench)

    # If the call is worth anything, its own confidence should sort the days:
    # the ones it feels strongly about should be the ones it gets right. A flat
    # line here means the confidence number is decoration.
    print("\n  Does the call's own confidence sort the outcomes? (scalp horizon)")
    buckets: dict[str, list[float]] = defaultdict(list)
    for i in range(21, len(daily)):
        d = day_of(daily[i]["ts"])
        bars = sessions.get(d) or []
        if len(bars) < 9:
            continue
        vhist = [vix_by_day[x] for x in vix_days if x < d]
        if len(vhist) < 20:
            continue
        first15 = bars[:3]
        pv = sum((b["h"] + b["l"] + b["c"]) / 3 * (b.get("vol") or 0) for b in first15)
        vol = sum((b.get("vol") or 0) for b in first15)
        call = tr.post_open_trend(daily[:i], first15, vhist, pv / vol if vol else None)
        if call["action"] == "FLAT":
            continue
        ret = (bars[8]["c"] - bars[2]["c"]) / bars[2]["c"] * 100
        signed = ret if call["action"] == "UP" else -ret
        conf = call["confidence"]
        key = "50-59" if conf < 60 else "60-69" if conf < 70 else "70+"
        buckets[key].append(signed)

    print(f"    {'confidence':>12}{'days':>8}{'mean %':>10}{'hit rate':>11}")
    for key in ("50-59", "60-69", "70+"):
        v = buckets.get(key, [])
        if not v:
            continue
        hit = sum(1 for x in v if x > 0) / len(v) * 100
        print(f"    {key:>12}{len(v):>8}{sum(v) / len(v):>+10.3f}{hit:>10.1f}%")

    print("\n  NIFTY moves about 0.025% per 6 index points, so a round trip "
          "costs\n  roughly 0.025%. Anything below that is not tradeable.\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
