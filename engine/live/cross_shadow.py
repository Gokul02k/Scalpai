"""Paper-trade the EMA 9 / VWAP cross against the live market, in the shadows.

This exists because the replay in `engine/backtest/vwap_cross.py` returned
-9.71 index points a trade after costs, and a losing rule may still be watched.
Nothing here can reach a real decision: no order is placed, no position is
opened in `PaperBook`, and `live/runner.py` does not import this module. It
keeps its own journal so the two can never be summed by accident.

Two arms run side by side on the same bars, because the backtest's central
finding was about the difference between them:

  * **gated** applies the reward:risk floor the app uses for scalps. Over the
    measured sample it refused 66% of crosses, on the grounds that a
    ~20-point stop against a target at the nearest level is often under 1:1.
  * **ungated** takes every cross, which is the rule as it is usually stated.
    In the replay this won 60.2% of the time and still lost money, because a
    target that close cannot pay for the round trip.

Reported in index points, not rupees, for the same reason the replay is: there
are no option bars behind the rupee stop, so quoting a rupee P&L would dress
an assumed delta up as a measurement. `stop_pts` carries the conversion.

Where this is deliberately stricter than the replay:

  * **The cross is read on a completed bar.** The last bar from a live feed is
    still printing, so it is excluded from cross detection and used only for
    the fill price — which is its open, exactly as the replay fills at the next
    bar's open. A cross read on the forming bar can un-fire.
  * **One position per arm, and the signal bar is remembered.** Ticking every
    30 seconds means the same cross is visible for ten consecutive ticks, and
    without the timestamp check each of them would open a trade.
  * **Ambiguous bars resolve against the trade.** A bar holding both stop and
    target books as a stop, because intraday bars cannot order two touches.
"""
from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from datetime import datetime, time, timedelta
from pathlib import Path

from ..core import indicators as ind
from ..core.vwap_cross import (
    LONG, SHORT, cross_direction, session_vwaps, stop_points,
)
from ..data.base import DataSource
from ..data.timeutil import IST

GATED = "gated"
UNGATED = "ungated"
ARMS = (GATED, UNGATED)


@dataclass
class CrossConfig:
    symbol: str = "NIFTY"
    interval: str = "5m"
    ema_period: int = 9
    #: Adverse move that ends the trade. Rs 800 on one lot of 75 at an
    #: at-the-money delta of 0.52; see `core.vwap_cross.stop_points`.
    stop_pts: float = field(default_factory=stop_points)
    sr_lookback: int = 20
    #: The floor the gated arm applies. The ungated arm ignores it.
    min_rr: float = 1.5
    #: Bars of session that must print before a cross counts. VWAP over three
    #: 5-minute bars is barely an average.
    warmup_bars: int = 3
    window: int = 375
    no_entry_after: time = time(15, 0)
    squareoff_at: time = time(15, 20)
    #: Round-trip cost in index points, the same figure the replay deducts, so
    #: today's number is comparable to -9.71 rather than to a gross figure.
    cost_pts: float = 6.0


@dataclass
class CrossTrade:
    """One hypothetical trade, in index points only."""

    id: str
    arm: str
    direction: str
    opened_at: str
    signal_bar: str
    entry: float
    stop: float
    target: float
    rr: float | None
    closed_at: str = ""
    exit_price: float = 0.0
    status: str = "open"        # target | stop | squareoff
    #: Index of the bar the trade was filled on, so exits only ever scan bars
    #: at or after the fill.
    entry_ts: int = 0

    @property
    def gross_pts(self) -> float:
        if self.status == "open":
            return 0.0
        sign = -1 if self.direction == SHORT else 1
        return round((self.exit_price - self.entry) * sign, 2)


@dataclass
class CrossBook:
    path: Path
    open_trades: dict[str, CrossTrade | None] = field(
        default_factory=lambda: {arm: None for arm in ARMS}
    )
    closed: list[CrossTrade] = field(default_factory=list)
    #: Every cross seen and what each arm did with it. The refusals are the
    #: point when the gate is what is being evaluated.
    log: list[dict] = field(default_factory=list)
    #: Bar timestamp of the last cross acted on, per arm, so one cross cannot
    #: open a trade on every tick that can still see it.
    last_signal: dict[str, int] = field(default_factory=dict)
    started: str = ""
    #: Set by `evaluate` from the config, so `summary` can report net without
    #: being handed the config on every call.
    cost_pts: float = 6.0

    @classmethod
    def load(cls, path: Path) -> "CrossBook":
        if not path.exists():
            return cls(path=path, started=_now_iso())
        blob = json.loads(path.read_text())
        opens = {arm: None for arm in ARMS}
        for arm, raw in (blob.get("open") or {}).items():
            if raw and arm in opens:
                opens[arm] = CrossTrade(**raw)
        return cls(
            path=path,
            open_trades=opens,
            closed=[CrossTrade(**t) for t in blob.get("closed", [])],
            log=blob.get("log", []),
            last_signal={k: int(v) for k, v in (blob.get("lastSignal") or {}).items()},
            started=blob.get("started", _now_iso()),
        )

    def save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps({
            "started": self.started,
            "updated": _now_iso(),
            "note": "EMA 9 / VWAP cross, shadow only. Never a real decision.",
            "open": {arm: (asdict(t) if t else None)
                     for arm, t in self.open_trades.items()},
            "closed": [asdict(t) for t in self.closed],
            "lastSignal": self.last_signal,
            "log": self.log[-2000:],
        }, indent=1))

    def note(self, kind: str, message: str, **extra) -> None:
        self.log.append({"ts": _now_iso(), "kind": kind, "msg": message, **extra})

    def closed_for(self, arm: str) -> list[CrossTrade]:
        return [t for t in self.closed if t.arm == arm]

    def summary(self, arm: str) -> dict:
        trades = self.closed_for(arm)
        if not trades:
            return {"trades": 0, "open": 1 if self.open_trades.get(arm) else 0}
        gross = [t.gross_pts for t in trades]
        net = [g - self.cost_pts for g in gross]
        wins = [g for g in gross if g > 0]
        return {
            "trades": len(trades),
            "open": 1 if self.open_trades.get(arm) else 0,
            "wins": len(wins),
            "win_rate": len(wins) / len(trades) * 100,
            "gross_pts": sum(gross) / len(gross),
            "net_pts": sum(net) / len(net),
            "total_net": sum(net),
            "targets": sum(1 for t in trades if t.status == "target"),
            "stops": sum(1 for t in trades if t.status == "stop"),
            "squareoffs": sum(1 for t in trades if t.status == "squareoff"),
        }

    def summary_lines(self) -> list[str]:
        out = []
        for arm in ARMS:
            s = self.summary(arm)
            label = "with R:R gate" if arm == GATED else "every cross"
            if not s["trades"]:
                out.append(f"  {arm:8} ({label:14})  no closed trades yet "
                           f"({s['open']} open)")
                continue
            out.append(
                f"  {arm:8} ({label:14})  {s['trades']:3d} trades  "
                f"{s['win_rate']:5.1f}% win  "
                f"gross {s['gross_pts']:+6.2f}  net {s['net_pts']:+6.2f} pts/trade  "
                f"total {s['total_net']:+7.1f}"
            )
        return out


@dataclass
class CrossTick:
    """What this tick saw. Rendered straight to stdout."""

    ts: datetime
    index: float | None = None
    ema: float | None = None
    vwap: float | None = None
    signal: str = ""
    reason: str = ""
    opened: list[CrossTrade] = field(default_factory=list)
    closed: list[CrossTrade] = field(default_factory=list)

    def line(self) -> str:
        clock = self.ts.strftime("%H:%M:%S")
        index = f"{self.index:,.1f}" if self.index else "        -"
        ema = f"{self.ema:,.1f}" if self.ema else "     -"
        vwap = f"{self.vwap:,.1f}" if self.vwap else "     -"
        marks = []
        for t in self.closed:
            marks.append(f"CLOSE[{t.arm}] {t.status} {t.gross_pts:+.1f}")
        for t in self.opened:
            marks.append(f"OPEN[{t.arm}] {t.direction} @{t.entry:.1f}")
        mark = "  ".join(marks) or self.reason
        return (f"{clock}  nifty {index}  ema {ema}  vwap {vwap}  "
                f"{self.signal:9}  {mark}")


def evaluate(
    source: DataSource,
    book: CrossBook,
    config: CrossConfig,
    now: datetime | None = None,
) -> CrossTick:
    """Run one tick: manage what each arm has open, then look for a new cross."""
    now = now or datetime.now(IST)
    tick = CrossTick(ts=now)
    book.cost_pts = config.cost_pts

    candles = _recent(source, config, now)
    rows = ind.candles_to_dicts(candles)
    if len(rows) < config.ema_period + 3:
        tick.reason = f"only {len(rows)} bars, need more history"
        return tick

    tick.index = rows[-1]["c"]
    today = _day(rows[-1]["ts"])
    session = [r for r in rows if _day(r["ts"]) == today]
    if len(session) < 2:
        tick.reason = "session has not started"
        return tick

    vwaps = session_vwaps(session)
    if vwaps[-1] is None:
        tick.reason = "no volume on this feed — VWAP is undefined"
        return tick

    emas = ind.ema([r["c"] for r in rows], config.ema_period)
    tick.ema = round(emas[-1], 2)
    tick.vwap = round(vwaps[-1], 2)

    # Exits first, so a cross arriving on the bar that closed a trade cannot
    # be treated as an addition to a position that is already gone.
    for arm in ARMS:
        closed = _manage(book, config, arm, rows, now)
        if closed:
            tick.closed.append(closed)

    if now.time() >= config.squareoff_at:
        tick.reason = tick.reason or "past square-off"
        return tick

    # The last bar is still printing, so the newest *decidable* bar is the one
    # before it, and that bar's successor supplies the fill.
    signal_i = len(session) - 2
    if signal_i < max(1, config.warmup_bars):
        tick.reason = tick.reason or "inside the opening warmup"
        return tick

    base = len(rows) - len(session)
    if vwaps[signal_i] is None or vwaps[signal_i - 1] is None:
        tick.reason = tick.reason or "no VWAP yet on the signal bar"
        return tick

    direction = cross_direction(
        emas[base + signal_i - 1], vwaps[signal_i - 1],
        emas[base + signal_i], vwaps[signal_i],
    )
    bias = LONG if emas[-1] >= vwaps[-1] else SHORT
    tick.signal = (f"{direction.upper()} X" if direction
                   else f"{'bull' if bias == LONG else 'bear'}")

    if not direction:
        tick.reason = tick.reason or "no cross on the last closed bar"
        return tick

    signal_bar = session[signal_i]
    fill_bar = session[signal_i + 1]
    entry = round(fill_bar["o"], 2)
    sr = ind.support_resistance(rows[-config.sr_lookback:], config.sr_lookback)
    target = sr["resistance"] if direction == LONG else sr["support"]
    reward = abs(target - entry)
    rr = round(reward / config.stop_pts, 2) if config.stop_pts else None

    wrong_side = ((direction == LONG and target <= entry)
                  or (direction == SHORT and target >= entry))

    for arm in ARMS:
        if book.last_signal.get(arm) == signal_bar["ts"]:
            continue    # this cross has already been ruled on
        if book.open_trades.get(arm) is not None:
            book.last_signal[arm] = signal_bar["ts"]
            book.note(arm, f"cross {direction} skipped: already in a trade",
                      bar=signal_bar.get("t"))
            continue
        if now.time() >= config.no_entry_after:
            book.last_signal[arm] = signal_bar["ts"]
            book.note(arm, "cross skipped: too late for a new entry")
            continue
        if wrong_side:
            book.last_signal[arm] = signal_bar["ts"]
            book.note(arm, f"cross {direction} skipped: price already past "
                           f"the nearest level ({target:g})")
            continue
        if arm == GATED and rr is not None and rr < config.min_rr:
            book.last_signal[arm] = signal_bar["ts"]
            book.note(arm, f"cross {direction} refused: {rr:.2f}:1 under the "
                           f"{config.min_rr:g}:1 floor",
                      entry=entry, target=round(target, 2))
            continue

        trade = CrossTrade(
            id=f"{arm}-{signal_bar['ts']}",
            arm=arm,
            direction=direction,
            opened_at=now.isoformat(timespec="seconds"),
            signal_bar=str(signal_bar.get("t") or ""),
            entry=entry,
            stop=round(entry - config.stop_pts if direction == LONG
                       else entry + config.stop_pts, 2),
            target=round(target, 2),
            rr=rr,
            entry_ts=int(fill_bar["ts"]),
        )
        book.open_trades[arm] = trade
        book.last_signal[arm] = signal_bar["ts"]
        book.note(arm, f"open {direction} @ {entry:.1f} "
                       f"target {target:.1f} stop {trade.stop:.1f} ({rr}:1)")
        tick.opened.append(trade)

    book.save()
    return tick


def _manage(book: CrossBook, config: CrossConfig, arm: str,
            rows: list[dict], now: datetime) -> CrossTrade | None:
    """Close this arm's open trade if the tape has resolved it."""
    trade = book.open_trades.get(arm)
    if trade is None:
        return None

    # Only bars at or after the fill can resolve it. Scanning from the entry
    # rather than trusting the last price means a stop touched between ticks
    # is still seen.
    since = [r for r in rows if int(r["ts"]) >= trade.entry_ts]
    if not since:
        return None

    status, price = None, 0.0
    for bar in since:
        if trade.direction == LONG:
            hit_stop, hit_target = bar["l"] <= trade.stop, bar["h"] >= trade.target
        else:
            hit_stop, hit_target = bar["h"] >= trade.stop, bar["l"] <= trade.target
        # Ambiguity resolves against the trade: an intraday bar cannot say
        # which of the two levels it touched first.
        if hit_stop:
            status, price = "stop", trade.stop
            break
        if hit_target:
            status, price = "target", trade.target
            break

    if status is None and now.time() >= config.squareoff_at:
        status, price = "squareoff", since[-1]["c"]
    if status is None:
        return None

    trade.status = status
    trade.exit_price = round(price, 2)
    trade.closed_at = now.isoformat(timespec="seconds")
    book.open_trades[arm] = None
    book.closed.append(trade)
    book.note(arm, f"close {status} @ {trade.exit_price:.1f} "
                   f"({trade.gross_pts:+.1f} pts)")
    book.save()
    return trade


def _recent(source: DataSource, config: CrossConfig, now: datetime) -> list:
    per_day = 75 if config.interval == "5m" else 375
    days = max(7, int(config.window / per_day * 2) + 5)
    return source.candles(
        config.symbol, config.interval, now - timedelta(days=days), now, "INDEX"
    )


def _day(ts: int) -> str:
    return datetime.fromtimestamp(ts / 1000, tz=IST).strftime("%Y-%m-%d")


def _now_iso() -> str:
    return datetime.now(IST).isoformat(timespec="seconds")
