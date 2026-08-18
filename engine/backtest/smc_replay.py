"""Does the smart-money setup pay on NIFTY?

The setup, as it is taught: price takes out an obvious high, closes back below
it, breaks the last swing low, and the last up candle before that break becomes
supply. Sell the retest of it, stop above the sweep, target the opposite pool.
Mirror image for longs.

This replays that sequence bar by bar over the archive and prices it. Over
2,228 sessions it produces 1,663 trades at a 31.7% win rate, −0.62 index points
a trade before costs and −6.62 after, with no positive year in ten and no
positive cell in the thirteen-variant grid. `--grid` reproduces that; the
engine README carries the tables.

The mechanics that decide whether such a number means anything:

  * **One session at a time.** The state machine is handed today's bars in
    order and yesterday's high, low and close. It never sees tomorrow, and it
    never sees later bars of today — a setup is built from what had printed at
    the moment it triggered.
  * **Swings must be confirmed.** A high is only a level `span` bars after it
    printed. Marking swings on the finished session and then "detecting" a
    sweep of one is the most common way this strategy backtests well and
    trades badly.
  * **Ambiguous bars resolve against the trade.** When one bar contains both
    the stop and the target, 5-minute data cannot say which came first, so the
    stop is taken. Assuming the target instead would add a few points a trade
    that the tape never gave.
  * **Fills are at the limit price.** Entry is a resting order at the order
    block edge, so a bar merely touching it is treated as filled. This is
    generous — a touch is not a fill — and is part of why the result should be
    read as an upper bound.
  * **Costs come off every trade** through the same `CostModel` the v1 replay
    uses, so the two numbers are comparable.

`--show` prints trades; the summary prints a year-by-year split and what the
mean looks like without its best few trades, because a strategy that fires
roughly once a day for nine years has ample room to hide a handful of outliers
inside an attractive average.
"""
from __future__ import annotations

import statistics
from dataclasses import dataclass, replace
from datetime import datetime
from typing import Any, Sequence

from ..core import smc
from ..core.indicators import candles_to_dicts
from ..core.smc import SHORT, Pool, Sweep, group_sessions, inherited_pools
from ..data.base import Candle
from ..data.timeutil import IST, SQUARE_OFF
from .costs import CostModel, IndexPointCost

CandleDict = dict[str, Any]


@dataclass(frozen=True)
class SmcParams:
    """Everything the setup needs to be stated precisely enough to test.

    Defaults are the textbook reading rather than a fit: two-bar swings, the
    stop just beyond the sweep, and a target at the next pool worth at least
    twice the risk. They were not searched for — a parameter chosen because it
    backtested well on the same data it is then judged on is not a parameter,
    it is a memory of the sample.
    """

    swing_span: int = 2
    #: Points a sweep must clear the pool by. Below this it is indistinguishable
    #: from the bid-ask noise around a round number.
    min_sweep_pts: float = 2.0
    #: Bars a sweep stays live waiting for structure to break, and then bars the
    #: resting entry stays live waiting to be filled. Both are one hour at 5m.
    break_deadline: int = 12
    entry_deadline: int = 12
    ob_lookback: int = 10
    stop_buffer_pts: float = 5.0
    #: Skip setups whose stop is further away than this. A NIFTY scalp risking
    #: 80 points needs a 240-point target to make sense of itself.
    max_risk_pts: float = 60.0
    min_risk_pts: float = 8.0
    min_rr: float = 2.0
    max_trades_per_session: int = 1
    #: Take only one side, to see whether the edge is direction rather than
    #: structure. "both", "long" or "short".
    sides: str = "both"
    #: Require the displacement to have left an imbalance behind it.
    require_fvg: bool = False
    #: No new setups armed after this; there is not enough session left for the
    #: trade to resolve, and it would be closed at square-off regardless.
    entry_cutoff_minutes: int = 14 * 60 + 45
    min_session_bars: int = 40


@dataclass
class SmcTrade:
    date: str
    direction: str
    pool: str
    sweep_pts: float
    break_kind: str
    ob_lo: float
    ob_hi: float
    fvg_pts: float
    entry: float
    stop: float
    target: float
    entry_time: str
    exit_time: str
    exit_price: float
    status: str  # "target" | "stop" | "squareoff"

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
class SmcResult:
    params: SmcParams
    trades: list[SmcTrade]
    sessions: int
    counts: dict[str, int]
    stats: dict
    cost_model: str
    period: tuple[str, str]

    def summary_lines(self) -> list[str]:
        s = self.stats
        c = self.counts
        out = [
            f"sessions          {self.sessions}  ({self.period[0]} .. {self.period[1]})",
            f"sweeps taken      {c['sweeps']}",
            f"  broke structure {c['breaks']}",
            f"  setups armed    {c['armed']}",
            f"    filled        {c['filled']}",
            f"    never filled  {c['unfilled']}",
            f"trades            {len(self.trades)}",
            f"  target          {c['target']}",
            f"  stop            {c['stop']}",
            f"  squared off     {c['squareoff']}",
        ]
        if not self.trades:
            out.append("(no trades — loosen the filters or widen the period)")
            return out
        out += [
            f"win rate          {s['winRate']}%",
            f"avg win           {s['avgWinPts']:+.1f} pts",
            f"avg loss          {s['avgLossPts']:+.1f} pts",
            f"avg risk          {s['avgRiskPts']:.1f} pts   avg R {s['avgR']:+.2f}",
            f"expectancy gross  {s['expectancyGrossPts']:+.2f} pts/trade",
            f"cost per trade    {s['costPerTradePts']:.2f} pts  ({self.cost_model})",
            f"expectancy net    {s['expectancyNetPts']:+.2f} pts/trade",
            f"total net         {s['totalNetPts']:+.1f} pts over {len(self.trades)} trades",
            f"profit factor     {s['profitFactor']}",
            f"max drawdown      {s['maxDrawdownPts']:.1f} pts",
        ]
        return out

    def stress_lines(self) -> list[str]:
        """Is the average the population, or a few lucky days?"""
        s = self.stats
        if not self.trades:
            return []
        out = [
            f"median            {s['medianNetPts']:+.2f} pts/trade",
            f"best 3 contribute {s['bestThreePts']:+.0f} of {s['totalNetPts']:+.0f}",
            f"without best 3    {s['netWithoutBestThree']:+.2f} pts/trade",
        ]
        years = s["byYear"]
        positive = sum(1 for v in years.values() if v["net_per_trade"] > 0)
        out.append(f"positive years    {positive}/{len(years)}")
        return out

    def year_lines(self) -> list[str]:
        out = [f"  {'year':6}{'trades':>8}{'win%':>8}{'net/trade':>12}{'total':>10}"]
        out.append("  " + "-" * 44)
        for year, v in sorted(self.stats["byYear"].items()):
            out.append(
                f"  {year:6}{v['trades']:>8}{v['win_rate']:>8.0f}"
                f"{v['net_per_trade']:>+12.2f}{v['net']:>+10.0f}"
            )
        return out


# ── session state machine ──────────────────────────────────────────────────

@dataclass
class _Pending:
    """A sweep waiting for structure to break, then an entry waiting to fill."""

    sweep: Sweep
    reference: float
    expires: int
    entry: float = 0.0
    stop: float = 0.0
    target: float = 0.0
    ob: smc.Zone | None = None
    fvg: smc.Zone | None = None
    kind: str = ""
    armed: bool = False


class _Session:
    def __init__(
        self, date: str, bars: Sequence[CandleDict], inherited: Sequence[Pool], params: SmcParams
    ) -> None:
        self.date = date
        self.bars = bars
        self.inherited = list(inherited)
        self.p = params
        self.trades: list[SmcTrade] = []
        self.counts = dict.fromkeys(("sweeps", "breaks", "armed", "filled", "unfilled"), 0)

    # -- helpers ------------------------------------------------------------

    def _minutes(self, i: int) -> int:
        dt = datetime.fromtimestamp(self.bars[i]["ts"] / 1000, tz=IST)
        return dt.hour * 60 + dt.minute

    def _time(self, i: int) -> str:
        return datetime.fromtimestamp(self.bars[i]["ts"] / 1000, tz=IST).strftime("%H:%M")

    def _wants(self, direction: str) -> bool:
        return self.p.sides == "both" or self.p.sides == direction

    def _target_pool(self, i: int, direction: str, entry: float, risk: float) -> float:
        """Nearest opposing pool at least `min_rr` risk away, else that multiple.

        Aiming at a pool rather than a fixed multiple is the point of the
        method — the claim is that price is drawn to resting liquidity — so the
        multiple is only the fallback when nothing is left to reach for.
        """
        floor = self.p.min_rr * risk
        pools = smc.session_pools(self.bars, i, self.p.swing_span, self.inherited)
        wanted = smc.SELLSIDE if direction == SHORT else smc.BUYSIDE
        distances = [
            abs(entry - pool.price)
            for pool in pools
            if pool.side == wanted
            and (pool.price < entry if direction == SHORT else pool.price > entry)
            and abs(entry - pool.price) >= floor
        ]
        reach = min(distances) if distances else floor
        return entry - reach if direction == SHORT else entry + reach

    def _resolve(self, i: int, direction: str, stop: float, target: float) -> tuple[str, float] | None:
        """What this bar does to an open position, worst case first."""
        bar = self.bars[i]
        if direction == SHORT:
            if bar["h"] >= stop:
                return "stop", stop
            if bar["l"] <= target:
                return "target", target
        else:
            if bar["l"] <= stop:
                return "stop", stop
            if bar["h"] >= target:
                return "target", target
        if self._minutes(i) >= SQUARE_OFF[0] * 60 + SQUARE_OFF[1] or i == len(self.bars) - 1:
            return "squareoff", bar["c"]
        return None

    # -- the walk -----------------------------------------------------------

    def run(self) -> list[SmcTrade]:
        pending: _Pending | None = None
        position: dict | None = None
        i = 0

        while i < len(self.bars):
            if position is not None:
                done = self._resolve(i, position["direction"], position["stop"], position["target"])
                if done:
                    status, price = done
                    self.trades.append(replace(position["trade"], exit_time=self._time(i),
                                               exit_price=price, status=status))
                    position = None
                    pending = None
                i += 1
                continue

            if pending is not None and pending.armed:
                outcome = self._try_fill(i, pending)
                if outcome == "filled":
                    position = self._open(i, pending)
                    self.counts["filled"] += 1
                    # The fill bar can also resolve the trade.
                    done = self._resolve(i, position["direction"], position["stop"], position["target"])
                    if done:
                        status, price = done
                        self.trades.append(replace(position["trade"], exit_time=self._time(i),
                                                   exit_price=price, status=status))
                        position = None
                        pending = None
                elif outcome == "dead":
                    self.counts["unfilled"] += 1
                    pending = None
                i += 1
                continue

            if pending is not None:
                if smc.broke(self.bars[i], pending.reference, pending.sweep.direction):
                    self.counts["breaks"] += 1
                    pending = self._arm(i, pending)
                elif i >= pending.expires:
                    pending = None
                if pending is None or not pending.armed:
                    # A dead or still-waiting sweep can be replaced by a fresh one.
                    fresh = self._look_for_sweep(i)
                    if fresh is not None and (
                        pending is None or fresh.sweep.idx > pending.sweep.idx
                    ):
                        pending = fresh
                i += 1
                continue

            if len(self.trades) < self.p.max_trades_per_session:
                pending = self._look_for_sweep(i)
            i += 1

        return self.trades

    def _look_for_sweep(self, i: int) -> _Pending | None:
        if self._minutes(i) > self.p.entry_cutoff_minutes:
            return None
        pools = smc.session_pools(self.bars, i - 1, self.p.swing_span, self.inherited)
        sweep = smc.sweep_at(self.bars, i, pools, self.p.min_sweep_pts)
        if sweep is None or not self._wants(sweep.direction):
            return None
        reference = smc.reference_swing(self.bars, i, sweep.direction, self.p.swing_span)
        if reference is None:
            return None
        self.counts["sweeps"] += 1
        return _Pending(sweep, reference, expires=i + self.p.break_deadline)

    def _arm(self, i: int, pending: _Pending) -> _Pending | None:
        """Turn a confirmed break into a resting order, or throw it away."""
        p = self.p
        direction = pending.sweep.direction
        seen = self.bars[: i + 1]

        lookback = min(p.ob_lookback, i - pending.sweep.idx + 2)
        ob = smc.order_block(seen, i, direction, lookback)
        if ob is None:
            return None
        fvg = smc.fair_value_gap(seen, ob.idx, i - 1, direction)
        if p.require_fvg and fvg is None:
            return None

        entry = ob.proximal(direction)
        close = self.bars[i]["c"]
        # The retest has to still be ahead of us. If price is already back
        # inside the block there is nothing to wait for, and taking it here
        # would be chasing the break rather than trading the retest.
        if (entry <= close) if direction == SHORT else (entry >= close):
            return None

        extreme = smc.protective_extreme(seen, ob.idx, direction, p.swing_span)
        stop = extreme + p.stop_buffer_pts if direction == SHORT else extreme - p.stop_buffer_pts
        risk = abs(entry - stop)
        if not (p.min_risk_pts <= risk <= p.max_risk_pts):
            return None

        self.counts["armed"] += 1
        return replace(
            pending,
            armed=True,
            entry=entry,
            stop=stop,
            target=self._target_pool(i, direction, entry, risk),
            ob=ob,
            fvg=fvg,
            kind=smc.break_kind(seen, i, direction, p.swing_span),
            expires=i + p.entry_deadline,
        )

    def _try_fill(self, i: int, pending: _Pending) -> str:
        bar = self.bars[i]
        direction = pending.sweep.direction
        if direction == SHORT:
            if bar["h"] >= pending.entry:
                return "filled"
            if bar["l"] <= pending.target or bar["c"] > pending.stop:
                return "dead"
        else:
            if bar["l"] <= pending.entry:
                return "filled"
            if bar["h"] >= pending.target or bar["c"] < pending.stop:
                return "dead"
        if i >= pending.expires or self._minutes(i) >= SQUARE_OFF[0] * 60 + SQUARE_OFF[1]:
            return "dead"
        return "waiting"

    def _open(self, i: int, pending: _Pending) -> dict:
        ob = pending.ob
        trade = SmcTrade(
            date=self.date,
            direction=pending.sweep.direction,
            pool=pending.sweep.pool.label,
            sweep_pts=round(pending.sweep.depth, 2),
            break_kind=pending.kind,
            ob_lo=round(ob.lo, 2) if ob else 0.0,
            ob_hi=round(ob.hi, 2) if ob else 0.0,
            fvg_pts=round(pending.fvg.height, 2) if pending.fvg else 0.0,
            entry=round(pending.entry, 2),
            stop=round(pending.stop, 2),
            target=round(pending.target, 2),
            entry_time=self._time(i),
            exit_time="",
            exit_price=0.0,
            status="open",
        )
        return {
            "direction": pending.sweep.direction,
            "stop": pending.stop,
            "target": pending.target,
            "trade": trade,
        }


# ── driving it over the archive ────────────────────────────────────────────

def run_smc_backtest(
    candles: Sequence[Candle] | Sequence[CandleDict],
    params: SmcParams | None = None,
    cost_model: CostModel | None = None,
) -> SmcResult:
    params = params or SmcParams()
    cost_model = cost_model or IndexPointCost()
    rows = list(candles) if candles and isinstance(candles[0], dict) else candles_to_dicts(candles)

    sessions = group_sessions(rows)
    trades: list[SmcTrade] = []
    counts = dict.fromkeys(("sweeps", "breaks", "armed", "filled", "unfilled"), 0)
    traded_sessions = 0

    for (_, previous), (day, bars) in zip(sessions, sessions[1:]):
        if len(bars) < params.min_session_bars or len(previous) < params.min_session_bars:
            continue
        traded_sessions += 1
        runner = _Session(day, bars, inherited_pools(previous), params)
        trades.extend(runner.run())
        for key, value in runner.counts.items():
            counts[key] += value

    for key in ("target", "stop", "squareoff"):
        counts[key] = sum(1 for t in trades if t.status == key)

    period = (sessions[0][0], sessions[-1][0]) if sessions else ("-", "-")
    return SmcResult(
        params=params,
        trades=trades,
        sessions=traded_sessions,
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
    stats: dict

    def line(self) -> str:
        s = self.stats
        if not self.trades:
            return f"  {self.name:24}{0:>8}" + "".join(f"{'-':>12}" for _ in range(4))
        years = s["byYear"]
        positive = sum(1 for v in years.values() if v["net_per_trade"] > 0)
        return (
            f"  {self.name:24}{self.trades:>8}{s['winRate']:>8.1f}"
            f"{s['expectancyGrossPts']:>+12.2f}{s['expectancyNetPts']:>+12.2f}"
            f"{s['netWithoutBestThree']:>+12.2f}{positive:>6}/{len(years)}"
        )

    @staticmethod
    def header() -> str:
        return (
            f"  {'variant':24}{'trades':>8}{'win%':>8}{'gross':>12}{'net':>12}"
            f"{'ex-best3':>12}{'yrs +':>8}"
        )


def default_grid(base: SmcParams) -> list[tuple[str, SmcParams]]:
    """The degrees of freedom the setup is actually taught with.

    Not a search for the best cell — see the warning `cmd_smc` prints. The
    question is whether the result is a property of the setup or of one
    arbitrary parameter choice, and that is answered by whether the cells
    disagree, not by which one wins.
    """
    return [
        ("baseline", base),
        ("target 1.5R", replace(base, min_rr=1.5)),
        ("target 3R", replace(base, min_rr=3.0)),
        ("target 4R", replace(base, min_rr=4.0)),
        ("shorts only", replace(base, sides="short")),
        ("longs only", replace(base, sides="long")),
        ("require FVG", replace(base, require_fvg=True)),
        ("deep sweeps only", replace(base, min_sweep_pts=10.0)),
        ("3-bar swings", replace(base, swing_span=3)),
        ("tight stop buffer", replace(base, stop_buffer_pts=2.0)),
        ("wide stop buffer", replace(base, stop_buffer_pts=12.0)),
        ("risk under 35 pts", replace(base, max_risk_pts=35.0)),
        ("2 trades a session", replace(base, max_trades_per_session=2)),
    ]


def _run_variant(payload: tuple[str, SmcParams, str]) -> GridRow:
    from .costs import get_cost_model

    name, params, cost_name = payload
    result = run_smc_backtest(_ROWS, params, get_cost_model(cost_name))
    return GridRow(name, len(result.trades), result.stats)


def run_grid(
    rows: Sequence[CandleDict],
    variants: Sequence[tuple[str, SmcParams]],
    cost_name: str = "index_points",
    jobs: int = 8,
) -> list[GridRow]:
    global _ROWS
    _ROWS = list(rows)

    payloads = [(name, params, cost_name) for name, params in variants]
    if jobs <= 1 or len(payloads) == 1:
        return [_run_variant(p) for p in payloads]

    import multiprocessing as mp

    with mp.get_context("fork").Pool(min(jobs, len(payloads))) as pool:
        return pool.map(_run_variant, payloads)


def summarize(trades: Sequence[SmcTrade], cost_model: CostModel) -> dict:
    if getattr(cost_model, "unit", "index_points") != "index_points":
        raise ValueError(
            f"cost model {cost_model.name!r} is denominated in {cost_model.unit}, "
            "but this replay measures gross in index points. Price the option "
            "leg separately."
        )
    if not trades:
        return {"byYear": {}}

    gross = [t.gross_pts for t in trades]
    costs = [cost_model.round_trip(t.entry, t.exit_price).total for t in trades]
    net = [g - c for g, c in zip(gross, costs)]
    wins = [g for g in gross if g > 0]
    losses = [g for g in gross if g <= 0]

    equity = peak = max_dd = 0.0
    for pnl in net:
        equity += pnl
        peak = max(peak, equity)
        max_dd = max(max_dd, peak - equity)

    by_year: dict[str, dict] = {}
    for t, n in zip(trades, net):
        row = by_year.setdefault(t.year, {"trades": 0, "net": 0.0, "wins": 0})
        row["trades"] += 1
        row["net"] += n
        row["wins"] += 1 if t.gross_pts > 0 else 0
    for row in by_year.values():
        row["net_per_trade"] = row["net"] / row["trades"]
        row["win_rate"] = row["wins"] / row["trades"] * 100

    ordered = sorted(net, reverse=True)
    best_three = sum(ordered[:3])
    return {
        "winRate": round(len(wins) / len(trades) * 100, 1),
        "avgWinPts": statistics.mean(wins) if wins else 0.0,
        "avgLossPts": statistics.mean(losses) if losses else 0.0,
        "avgRiskPts": statistics.mean([t.risk for t in trades]),
        "avgR": statistics.mean([t.r_multiple for t in trades]),
        "expectancyGrossPts": statistics.mean(gross),
        "costPerTradePts": statistics.mean(costs),
        "expectancyNetPts": statistics.mean(net),
        "totalNetPts": sum(net),
        "medianNetPts": statistics.median(net),
        "bestThreePts": best_three,
        "netWithoutBestThree": statistics.mean(ordered[3:]) if len(ordered) > 3 else 0.0,
        "profitFactor": (round(sum(wins) / abs(sum(losses)), 2) if losses and sum(losses) else None),
        "maxDrawdownPts": max_dd,
        "byYear": by_year,
    }
