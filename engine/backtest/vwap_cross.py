"""Does the EMA-9 / VWAP cross pay on NIFTY?

The setup, as it is traded: on the 5-minute chart, EMA 9 crosses session VWAP
from below and the index is treated as bullish — buy a call. Crosses back down
and it is bearish — buy a put. Target the nearest support or resistance, stop
at a fixed rupee loss, one lot, one position at a time.

This replays that sequence bar by bar over the archive and prices it. Over the
246 sessions that carry volume it produces 118 trades at a 25.4% win rate,
-3.71 index points a trade before costs and -9.71 after, with neither year
positive and no variant surviving the loss of its best three trades. `--grid`
reproduces that; the engine README carries the tables.

Before any of that, the constraint that decides what this can measure at all:
**NIFTY is an index, so it has no volume of its own**, and only 269 of 2,260
archived sessions carry any. VWAP is undefined without volume, so the rest are
skipped. Filling them from the close — the obvious fallback, and what the first
version of this module did — yields a "VWAP" identical to price, turns the
strategy into "EMA 9 crosses price", and reports a confident nine-year number
for a strategy nobody described. `_running_vwap` returns None instead.

Two further translations were needed, and both are assumptions rather than
measurements:

  * **The rupee stop becomes an index-point stop.** There are no option bars in
    the archive — only index series — so a stop denominated in premium cannot
    be graded against the tape. 800 rupees on one lot of 75 is 10.67 premium
    points, and at an at-the-money delta near 0.52 that is about 20 index
    points of adverse move. `stop_pts` carries that number so it can be varied:
    the same 800 rupees is 26.7 points at delta 0.40 and 17.8 at 0.60, and the
    result should be read across that range rather than at one point in it.
  * **Direction is traded as the index, not as an option.** Gross is measured
    in index points, which ignores theta and gamma. Both matter to a premium
    buyer and neither can be recovered from index bars. `engine.cli option-pnl`
    exists to re-price a set of trades as options; this replay deliberately
    stops short of pretending it already has.

The mechanics that decide whether the number means anything:

  * **EMA runs continuously, VWAP resets at the bell.** That is what the chart
    shows: a fast average carried across sessions against an anchor that starts
    fresh each morning. Resetting the EMA too would measure a different cross.
  * **The cross is read on a completed bar and filled at the next open.** A
    decision made on the bar that is still printing is the most common way a
    crossover strategy backtests well and trades badly.
  * **Support and resistance are computed from bars up to the signal only.**
    The target is a level that had already formed when the trade was taken.
  * **Ambiguous bars resolve against the trade.** When one bar contains both
    the stop and the target, 5-minute data cannot say which came first, so the
    stop is taken.
  * **Reward:risk is gated at `min_rr`.** This is the app's own scalp gate, and
    it is the binding constraint here rather than a formality: a 20-point stop
    against a target at the nearest level is frequently under 1:1, so the gate
    refuses 335 of 510 crosses. `skipped_rr` reports how many.
  * **Costs come off every trade** through the same `CostModel` the v1 replay
    uses, so the numbers sit alongside the existing tables.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any, Sequence

from ..core.indicators import candles_to_dicts, ema, support_resistance
from ..core.smc import group_sessions
from ..core.vwap_cross import (
    ATM_DELTA, DEFAULT_RUPEE_STOP, LONG, NIFTY_LOT_SIZE, SHORT,
    cross_direction, fully_volumed, session_vwaps, stop_points,
)
from ..data.base import Candle
from ..data.timeutil import IST, SQUARE_OFF
from .costs import CostModel, IndexPointCost
from .smc_replay import summarize

CandleDict = dict[str, Any]

__all__ = [
    "ATM_DELTA", "DEFAULT_RUPEE_STOP", "LONG", "NIFTY_LOT_SIZE", "SHORT",
    "GridRow", "VwapCrossParams", "VwapCrossResult", "VwapTrade",
    "default_grid", "run_grid", "run_vwap_cross_backtest", "stop_points",
]


@dataclass(frozen=True)
class VwapCrossParams:
    """Everything the setup needs to be stated precisely enough to test.

    Defaults are the strategy as described, not a fit. `stop_pts` is the one
    number with no basis in the rules -- it is the rupee stop translated
    through a delta -- so it is the first thing to vary.
    """

    ema_period: int = 9
    #: Adverse index move that ends the trade. Defaults to the 800-rupee stop
    #: at at-the-money delta; see `stop_points`.
    stop_pts: float = stop_points()
    #: Bars behind the swing high/low that becomes the target. 20 is what the
    #: app's own support/resistance uses, so the target is the level the
    #: dashboard would have drawn.
    sr_lookback: int = 20
    #: Refuse a trade whose target is nearer than this multiple of the stop.
    #: 1.5 is the app's scalp gate. Set to 0 to measure the rule unfiltered.
    min_rr: float = 1.5
    #: Bars of session that must print before a cross is read. VWAP over three
    #: 5-minute bars is barely an average, and the first crosses of the day are
    #: against a line that has not settled.
    warmup_bars: int = 3
    #: No new entries after this. A trade taken at 15:15 is a square-off, not a
    #: test of the setup.
    entry_cutoff_minutes: int = 15 * 60
    #: "both", "long" or "short".
    sides: str = "both"
    min_session_bars: int = 40


@dataclass
class VwapTrade:
    date: str
    direction: str
    entry: float
    stop: float
    target: float
    entry_time: str
    exit_time: str
    exit_price: float
    status: str  # "target" | "stop" | "squareoff"
    ema_at_signal: float
    vwap_at_signal: float

    @property
    def risk(self) -> float:
        return abs(self.entry - self.stop)

    @property
    def gross_pts(self) -> float:
        sign = -1 if self.direction == SHORT else 1
        return (self.exit_price - self.entry) * sign

    @property
    def r_multiple(self) -> float:
        return self.gross_pts / self.risk if self.risk else 0.0

    @property
    def year(self) -> str:
        return self.date[:4]


@dataclass
class VwapCrossResult:
    params: VwapCrossParams
    trades: list[VwapTrade]
    sessions: int
    sessions_without_volume: int
    counts: dict
    stats: dict
    cost_model: str
    period: tuple[str, str]

    def summary_lines(self) -> list[str]:
        c = self.counts
        s = self.stats
        out = [
            f"period            {self.period[0]} .. {self.period[1]}",
            f"sessions          {self.sessions}",
        ]
        if self.sessions_without_volume:
            out.append(
                f"  skipped, no vol {self.sessions_without_volume}"
                "   (VWAP is undefined without volume)"
            )
        out += [
            f"stop              {self.params.stop_pts:.1f} index pts"
            f"  (min R:R {self.params.min_rr})",
            "",
            f"crosses seen      {c['crosses']}",
            f"  in a trade      {c['skipped_open']}   (one position at a time)",
            f"  wrong-side S/R  {c['skipped_level']}",
            f"  R:R too low     {c['skipped_rr']}",
            f"  after cutoff    {c['skipped_time']}",
            f"  wrong side      {c['skipped_side']}",
            f"trades taken      {len(self.trades)}",
        ]
        if not self.trades:
            out.append("")
            out.append("(no trades -- every cross was refused; see the counts above)")
            return out
        out += [
            f"  hit target      {c['target']}",
            f"  hit stop        {c['stop']}",
            f"  squared off     {c['squareoff']}",
            "",
            f"win rate          {s['winRate']}%",
            f"avg risk          {s['avgRiskPts']:.1f} pts",
            f"avg R             {s['avgR']:+.2f}",
            f"expectancy gross  {s['expectancyGrossPts']:+.2f} pts/trade",
            f"cost per trade    {s['costPerTradePts']:.2f} pts  ({self.cost_model})",
            f"expectancy net    {s['expectancyNetPts']:+.2f} pts/trade",
            f"total net         {s['totalNetPts']:+.0f} pts",
            f"profit factor     {s['profitFactor']}",
            f"max drawdown      {s['maxDrawdownPts']:.0f} pts",
            f"net ex-best-3     {s['netWithoutBestThree']:+.2f} pts/trade",
        ]
        years = s["byYear"]
        positive = sum(1 for v in years.values() if v["net_per_trade"] > 0)
        out.append(f"positive years    {positive} of {len(years)}")
        return out

    def stress_lines(self) -> list[str]:
        """Is the average the population, or a few lucky days?"""
        s = self.stats
        if not self.trades:
            return []
        return [
            f"median            {s['medianNetPts']:+.2f} pts/trade",
            f"best 3 contribute {s['bestThreePts']:+.0f} of {s['totalNetPts']:+.0f}",
            f"without best 3    {s['netWithoutBestThree']:+.2f} pts/trade",
            f"avg win           {s['avgWinPts']:+.1f} pts",
            f"avg loss          {s['avgLossPts']:+.1f} pts",
        ]

    def year_lines(self) -> list[str]:
        out = [f"  {'year':6}{'trades':>8}{'win%':>8}{'net/trade':>12}{'total':>10}",
               "  " + "-" * 44]
        for year, v in sorted(self.stats["byYear"].items()):
            out.append(
                f"  {year:6}{v['trades']:>8}{v['win_rate']:>8.0f}"
                f"{v['net_per_trade']:>+12.2f}{v['net']:>+10.0f}"
            )
        return out


def _running_vwap(session: Sequence[CandleDict]) -> list[float] | None:
    """Session VWAP for a session clean enough to measure against, else None.

    VWAP itself is defined in `core.vwap_cross`, so the panel on the screen and
    this replay cannot disagree about what the line is. The extra `fully_volumed`
    test is this replay's own, and is a data-quality filter rather than part of
    the definition: a session where volume arrives sporadically produces a VWAP
    that lurches as the weighting appears, and a strategy measured against that
    is being measured against the feed. It only shrinks the sample.
    """
    if not fully_volumed(session):
        return None
    return session_vwaps(session)


def _minutes(row: CandleDict) -> int:
    t = datetime.fromtimestamp(row["ts"] / 1000, tz=IST)
    return t.hour * 60 + t.minute


def _time_str(row: CandleDict) -> str:
    return datetime.fromtimestamp(row["ts"] / 1000, tz=IST).strftime("%H:%M")


def run_vwap_cross_backtest(
    candles: Sequence[Candle] | Sequence[CandleDict],
    params: VwapCrossParams | None = None,
    cost_model: CostModel | None = None,
) -> VwapCrossResult:
    params = params or VwapCrossParams()
    cost_model = cost_model or IndexPointCost()
    rows = list(candles) if candles and isinstance(candles[0], dict) else candles_to_dicts(candles)

    # Continuous across sessions, because that is what the chart draws. The
    # index into this list is the index into `rows`, so each session reads its
    # own slice rather than recomputing a per-day EMA.
    ema_series = ema([r["c"] for r in rows], params.ema_period)
    sessions = group_sessions(rows)

    # Offset of each session's first bar within `rows`, so the EMA and the
    # support/resistance window can be indexed without searching for the day.
    offsets: list[int] = []
    running = 0
    for _, bars in sessions:
        offsets.append(running)
        running += len(bars)

    trades: list[VwapTrade] = []
    counts = dict.fromkeys(
        ("crosses", "skipped_open", "skipped_side", "skipped_level", "skipped_rr",
         "skipped_time", "target", "stop", "squareoff"),
        0,
    )
    traded_sessions = 0
    sessions_without_volume = 0
    square_off = SQUARE_OFF[0] * 60 + SQUARE_OFF[1]

    for (day, bars), base in zip(sessions, offsets):
        if len(bars) < params.min_session_bars:
            continue

        vwaps = _running_vwap(bars)
        if vwaps is None:
            sessions_without_volume += 1
            continue
        traded_sessions += 1

        open_trade: VwapTrade | None = None

        for i in range(1, len(bars)):
            bar = bars[i]

            direction = (
                _cross(ema_series, vwaps, base, i)
                if i >= params.warmup_bars else None
            )
            if direction is not None:
                counts["crosses"] += 1

            # An open position is managed before anything else, and a cross
            # that fires while it is live is dropped rather than queued. One
            # slot means one slot; the alternative is a second trade whose
            # entry depends on when the first happened to exit.
            if open_trade is not None:
                status, price = _resolve(open_trade, bar, square_off)
                if status:
                    open_trade.status = status
                    open_trade.exit_price = round(price, 2)
                    open_trade.exit_time = _time_str(bar)
                    counts[status] += 1
                    trades.append(open_trade)
                    open_trade = None
                if direction is not None:
                    counts["skipped_open"] += 1
                continue

            if direction is None:
                continue
            if params.sides != "both" and params.sides != direction:
                counts["skipped_side"] += 1
                continue
            if _minutes(bar) >= params.entry_cutoff_minutes or i + 1 >= len(bars):
                counts["skipped_time"] += 1
                continue

            # Filled at the next bar's open: the cross was only known once this
            # bar closed.
            fill = bars[i + 1]
            entry = fill["o"]

            # Levels from the bars up to and including the signal, never
            # beyond. Sliced to the lookback rather than the whole prefix --
            # `support_resistance` only reads the tail, and copying 169k rows
            # per bar would make this quadratic.
            end = base + i + 1
            sr = support_resistance(
                rows[max(0, end - params.sr_lookback): end], params.sr_lookback
            )
            target = sr["resistance"] if direction == LONG else sr["support"]
            if (direction == LONG and target <= entry) or (
                direction == SHORT and target >= entry
            ):
                counts["skipped_level"] += 1
                continue

            reward = abs(target - entry)
            if params.min_rr and reward < params.stop_pts * params.min_rr:
                counts["skipped_rr"] += 1
                continue

            open_trade = VwapTrade(
                date=day,
                direction=direction,
                entry=round(entry, 2),
                stop=round(
                    entry - params.stop_pts if direction == LONG
                    else entry + params.stop_pts, 2,
                ),
                target=round(target, 2),
                entry_time=_time_str(fill),
                exit_time="",
                exit_price=0.0,
                status="open",
                ema_at_signal=round(ema_series[base + i], 2),
                vwap_at_signal=round(vwaps[i], 2),
            )

        # A position still open at the last bar of the day is squared off there
        # rather than carried: this is an intraday strategy, and letting it run
        # into tomorrow would grade a trade the rules never allowed.
        if open_trade is not None:
            last = bars[-1]
            open_trade.status = "squareoff"
            open_trade.exit_price = round(last["c"], 2)
            open_trade.exit_time = _time_str(last)
            counts["squareoff"] += 1
            trades.append(open_trade)

    # The period is the span actually replayed, not the span of the archive.
    # Reporting the archive's range next to a count of volumed sessions would
    # imply nine years of evidence behind one year of it.
    replayed = [day for day, bars in sessions
                if len(bars) >= params.min_session_bars and _running_vwap(bars)]
    period = (replayed[0], replayed[-1]) if replayed else ("-", "-")
    return VwapCrossResult(
        params=params,
        trades=trades,
        sessions=traded_sessions,
        sessions_without_volume=sessions_without_volume,
        counts=counts,
        stats=summarize(trades, cost_model),
        cost_model=cost_model.name,
        period=period,
    )


# ── variants ───────────────────────────────────────────────────────────────

#: Set before forking so workers inherit the bars instead of pickling them.
_ROWS: list[CandleDict] = []


@dataclass(frozen=True)
class GridRow:
    name: str
    trades: int
    crosses: int
    stats: dict

    def line(self) -> str:
        s = self.stats
        if not self.trades:
            return f"  {self.name:26}{self.crosses:>8}{0:>8}" + "".join(
                f"{'-':>12}" for _ in range(4)
            )
        years = s["byYear"]
        positive = sum(1 for v in years.values() if v["net_per_trade"] > 0)
        return (
            f"  {self.name:26}{self.crosses:>8}{self.trades:>8}{s['winRate']:>8.1f}"
            f"{s['expectancyGrossPts']:>+12.2f}{s['expectancyNetPts']:>+12.2f}"
            f"{s['netWithoutBestThree']:>+12.2f}{positive:>6}/{len(years)}"
        )

    @staticmethod
    def header() -> str:
        return (
            f"  {'variant':26}{'crosses':>8}{'trades':>8}{'win%':>8}{'gross':>12}"
            f"{'net':>12}{'ex-best3':>12}{'yrs +':>8}"
        )


def default_grid(base: VwapCrossParams) -> list[tuple[str, VwapCrossParams]]:
    """The degrees of freedom that matter, and the one that is an assumption.

    The stop rows are the same 800 rupees read through different deltas, which
    is the only honest way to present a rupee stop with no option bars behind
    it. The `no R:R gate` row matters because the gate refuses roughly half the
    crosses: without it the strategy is being measured, with it the gate is.
    """
    from dataclasses import replace

    grid = [("baseline (delta 0.52)", base)]
    for delta in (0.40, 0.60):
        grid.append((
            f"stop @ delta {delta:.2f}",
            replace(base, stop_pts=stop_points(delta=delta)),
        ))
    grid += [
        ("no R:R gate", replace(base, min_rr=0.0)),
        ("R:R gate 2.0", replace(base, min_rr=2.0)),
        ("longs only", replace(base, sides=LONG)),
        ("shorts only", replace(base, sides=SHORT)),
        ("stop 40 pts", replace(base, stop_pts=40.0)),
        ("stop 60 pts", replace(base, stop_pts=60.0)),
        ("S/R lookback 40", replace(base, sr_lookback=40)),
        ("no warmup", replace(base, warmup_bars=1)),
    ]
    return grid


def _run_variant(payload: tuple[str, VwapCrossParams, str]) -> GridRow:
    name, params, costs = payload
    from .costs import get_cost_model

    result = run_vwap_cross_backtest(_ROWS, params, get_cost_model(costs))
    return GridRow(name, len(result.trades), result.counts["crosses"], result.stats)


def run_grid(
    rows: Sequence[CandleDict],
    variants: Sequence[tuple[str, VwapCrossParams]],
    costs: str = "index_points",
    jobs: int = 8,
) -> list[GridRow]:
    global _ROWS
    _ROWS = list(rows)
    payloads = [(name, params, costs) for name, params in variants]
    if jobs <= 1 or len(payloads) == 1:
        return [_run_variant(p) for p in payloads]

    import multiprocessing as mp

    with mp.get_context("fork").Pool(min(jobs, len(payloads))) as pool:
        return pool.map(_run_variant, payloads)


def _cross(ema_series: Sequence[float], vwaps: Sequence[float],
           base: int, i: int) -> str | None:
    """Direction if EMA crossed VWAP on this bar, else None.

    Read on closed bars only: both sides use index `i` and `i - 1`, and the
    caller fills at `i + 1`. The rule itself lives in `core.vwap_cross` so the
    live panel and this replay cannot drift apart.
    """
    return cross_direction(
        ema_series[base + i - 1], vwaps[i - 1],
        ema_series[base + i], vwaps[i],
    )


def _resolve(trade: VwapTrade, bar: CandleDict, square_off: int) -> tuple[str | None, float]:
    """Whether this bar ended the trade, and at what price.

    A bar holding both levels is settled at the stop. 5-minute data cannot
    order two touches inside one bar, and assuming the target would pay the
    strategy for information the tape never gave.
    """
    if trade.direction == LONG:
        hit_stop = bar["l"] <= trade.stop
        hit_target = bar["h"] >= trade.target
    else:
        hit_stop = bar["h"] >= trade.stop
        hit_target = bar["l"] <= trade.target

    if hit_stop:
        return "stop", trade.stop
    if hit_target:
        return "target", trade.target
    if _minutes(bar) >= square_off:
        return "squareoff", bar["c"]
    return None, 0.0
