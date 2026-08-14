"""The paper trading journal: open positions, closed trades, and the tape.

Everything is written to a JSON file after each tick rather than held in
memory, so the process can be killed and restarted mid-session without losing
the book. A paper run that loses its own history proves nothing.

Fills are deliberately pessimistic. Entry is at the quoted **ask** and exit at
the quoted **bid**, never the mid, because that is what crossing the spread
actually costs. A paper record that fills at mid will beat live trading by
roughly half a spread per leg and will do it invisibly.
"""
from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any

from ..data.timeutil import IST


@dataclass
class Position:
    """One open paper trade, in both index and option terms."""

    id: str
    opened_at: str
    action: str                 # BUY or SELL on the index
    #: Index levels the signal was built on. Exits are decided on these, so
    #: the paper run and the backtest are answering the same question.
    entry_index: float
    target_index: float
    stop_index: float
    confidence: int
    ml_score: float
    vix: float
    #: The option actually chosen from the live chain.
    symbol: str
    strike: int
    option_type: str
    expiry: str
    entry_premium: float        # paid at the ask
    entry_bid: float
    entry_ask: float
    delta: float
    iv: float
    lots: int = 1
    lot_size: int = 75
    reason: str = ""
    #: "live" for trades the configured strategy took, "shadow" for ones it
    #: declined. Shadows are tracked identically and never counted as results.
    #: Without them a filter that fires roughly twenty times a year cannot be
    #: judged for months, because the evidence that it is right lives entirely
    #: in the trades it refused.
    kind: str = "live"
    #: Which gate turned it down. Empty for live positions.
    declined: str = ""

    @property
    def cost(self) -> float:
        return self.entry_premium * self.lots * self.lot_size


@dataclass
class ClosedTrade:
    position: dict
    closed_at: str
    exit_index: float
    exit_premium: float         # received at the bid
    exit_reason: str            # target | stop | expired | squareoff
    hold_hours: float
    gross_premium: float
    charges: float
    net_rupees: float
    index_points: float

    @property
    def won(self) -> bool:
        return self.net_rupees > 0


@dataclass
class PaperBook:
    path: Path
    open_positions: list[Position] = field(default_factory=list)
    closed: list[ClosedTrade] = field(default_factory=list)
    #: Signals the strategy declined, tracked to the same standard but kept out
    #: of the results. Deliberately separate lists rather than a flag on one
    #: list, so no reporting path can accidentally sum the two together.
    shadow_open: list[Position] = field(default_factory=list)
    shadow_closed: list[ClosedTrade] = field(default_factory=list)
    #: Every decision, including the ones that declined to trade. The skipped
    #: ticks are the useful part when the gate is being evaluated.
    log: list[dict] = field(default_factory=list)
    started: str = ""

    # ── persistence ────────────────────────────────────────────────────────

    @classmethod
    def load(cls, path: Path) -> "PaperBook":
        if not path.exists():
            return cls(path=path, started=_now_iso())
        blob = json.loads(path.read_text())
        return cls(
            path=path,
            open_positions=[Position(**p) for p in blob.get("open", [])],
            closed=[ClosedTrade(**t) for t in blob.get("closed", [])],
            shadow_open=[Position(**p) for p in blob.get("shadowOpen", [])],
            shadow_closed=[ClosedTrade(**t) for t in blob.get("shadowClosed", [])],
            log=blob.get("log", []),
            started=blob.get("started", _now_iso()),
        )

    def save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps({
            "started": self.started,
            "updated": _now_iso(),
            "open": [asdict(p) for p in self.open_positions],
            "closed": [asdict(t) for t in self.closed],
            "shadowOpen": [asdict(p) for p in self.shadow_open],
            "shadowClosed": [asdict(t) for t in self.shadow_closed],
            "log": self.log[-2000:],
        }, indent=1))

    # ── mutation ───────────────────────────────────────────────────────────

    def note(self, kind: str, message: str, **extra: Any) -> None:
        self.log.append({"ts": _now_iso(), "kind": kind, "msg": message, **extra})

    def open_position(self, pos: Position) -> None:
        if pos.kind == "shadow":
            self.shadow_open.append(pos)
            self.note("shadow", f"declined {pos.action} {pos.symbol}: {pos.declined}",
                      id=pos.id, vix=pos.vix, score=pos.ml_score)
            return
        self.open_positions.append(pos)
        self.note("open", f"{pos.action} {pos.symbol} @ {pos.entry_premium:.2f}",
                  id=pos.id, index=pos.entry_index, vix=pos.vix, score=pos.ml_score)

    def close_position(self, trade: ClosedTrade) -> None:
        if trade.position.get("kind") == "shadow":
            self.shadow_open = [
                p for p in self.shadow_open if p.id != trade.position["id"]
            ]
            self.shadow_closed.append(trade)
            return
        self.open_positions = [
            p for p in self.open_positions if p.id != trade.position["id"]
        ]
        self.closed.append(trade)
        self.note("close", f"{trade.exit_reason} {trade.net_rupees:+.0f}",
                  id=trade.position["id"], premium=trade.exit_premium)

    def has_open(self, action: str | None = None) -> bool:
        if action is None:
            return bool(self.open_positions)
        return any(p.action == action for p in self.open_positions)

    def last_entry_time(self) -> datetime | None:
        if not self.open_positions and not self.closed:
            return None
        stamps = [p.opened_at for p in self.open_positions]
        stamps += [t.position["opened_at"] for t in self.closed]
        return max(_parse(s) for s in stamps) if stamps else None

    # ── reporting ──────────────────────────────────────────────────────────

    def summary(self, shadow: bool = False) -> dict:
        closed = self.shadow_closed if shadow else self.closed
        still_open = self.shadow_open if shadow else self.open_positions
        n = len(closed)
        if not n:
            return {"trades": 0, "open": len(still_open)}
        wins = [t for t in closed if t.won]
        net = sum(t.net_rupees for t in closed)
        return {
            "trades": n,
            "open": len(still_open),
            "wins": len(wins),
            "win_rate": len(wins) / n * 100,
            "net_rupees": net,
            "avg_rupees": net / n,
            "best": max(t.net_rupees for t in closed),
            "worst": min(t.net_rupees for t in closed),
            "avg_index_pts": sum(t.index_points for t in closed) / n,
        }

    def summary_lines(self, shadow: bool = False) -> list[str]:
        s = self.summary(shadow)
        if not s["trades"]:
            return [f"  no closed trades yet ({s['open']} open)"]
        return [
            f"  closed trades     {s['trades']}   ({s['open']} still open)",
            f"  win rate          {s['win_rate']:.1f}%  ({s['wins']}/{s['trades']})",
            f"  net               Rs {s['net_rupees']:+,.0f}",
            f"  average           Rs {s['avg_rupees']:+,.0f} per trade "
            f"({s['avg_index_pts']:+.1f} index pts)",
            f"  best / worst      Rs {s['best']:+,.0f} / Rs {s['worst']:+,.0f}",
        ]

    def verdict_lines(self) -> list[str]:
        """Did declining those signals help or hurt?

        The comparison only becomes meaningful after a few dozen trades on both
        sides, so it says so rather than pronouncing on three.
        """
        taken, passed = self.summary(), self.summary(shadow=True)
        if not taken["trades"] and not passed["trades"]:
            return []

        out = ["", "  filter scorecard"]
        out.append(f"    took     {taken['trades']:3d} trades  "
                   f"Rs {taken.get('net_rupees', 0):+,.0f}")
        out.append(f"    declined {passed['trades']:3d} trades  "
                   f"Rs {passed.get('net_rupees', 0):+,.0f}")

        if taken["trades"] and passed["trades"]:
            delta = taken.get("avg_rupees", 0) - passed.get("avg_rupees", 0)
            better = "better" if delta > 0 else "worse"
            out.append(f"    the trades it took ran Rs {abs(delta):,.0f} {better} "
                       f"each than the ones it refused")
        if taken["trades"] + passed["trades"] < 30:
            out.append("    (far too few trades to mean anything yet)")
        return out


def _now_iso() -> str:
    return datetime.now(IST).isoformat(timespec="seconds")


def _parse(value: str) -> datetime:
    return datetime.fromisoformat(value)
