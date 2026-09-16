"""The shadow trader must reach the same verdicts the replay did.

It exists to watch a rule the backtest measured at -9.71 index points a trade,
so the thing worth testing is that it stays a shadow and stays comparable:

  * it never opens a second position in one arm, and never acts twice on one
    cross even though a 30-second tick sees that cross ten times
  * it reads the signal off a completed bar and fills at the next bar's open,
    the same relationship the replay uses
  * the gated and ungated arms differ only in the reward:risk floor
  * nothing it does can reach `PaperBook`, the runner, or the dashboard's call

The session below is replayed tick by tick against a stub source that can only
see the bars that had printed at each moment, which is the same discipline the
replay applies.
"""
from __future__ import annotations

import tempfile
from datetime import datetime, time
from pathlib import Path

import pytest

from engine.core.indicators import candles_to_dicts
from engine.core.smc import group_sessions
from engine.data import CandleStore
from engine.data.timeutil import IST
from engine.live.cross_shadow import (
    ARMS, GATED, UNGATED, CrossBook, CrossConfig, evaluate,
)


class _Stub:
    """A source that can only see bars up to `upto`. No lookahead is possible."""

    def __init__(self, candles):
        self.candles_all = candles
        self.upto = 0

    def candles(self, *args, **kwargs):
        return self.candles_all[max(0, self.upto - 400):self.upto]


@pytest.fixture(scope="module")
def volumed_session():
    """The last archived session where every bar traded, plus its offset.

    VWAP needs volume and NIFTY is an index, so most of the archive cannot
    exercise this at all.
    """
    raw = CandleStore().read("NIFTY", "INDEX", "5m", limit=169005)
    if len(raw) < 1000:
        pytest.skip("run `python -m engine.cli sync` first")
    rows = candles_to_dicts(raw)
    good = [(day, bars) for day, bars in group_sessions(rows)
            if len(bars) > 40 and all((c.get("vol") or 0) > 0 for c in bars)]
    if not good:
        pytest.skip("no fully volumed session archived")
    _, bars = good[-1]
    return raw, rows, bars, rows.index(bars[0])


def _replay(volumed_session, config=None, ticks_per_bar=1):
    raw, rows, bars, start = volumed_session
    source = _Stub(raw)
    book = CrossBook(path=Path(tempfile.mkdtemp()) / "book.json", started="")
    config = config or CrossConfig()
    for i in range(len(bars)):
        source.upto = start + i + 1
        when = datetime.fromtimestamp(bars[i]["ts"] / 1000, tz=IST)
        for _ in range(ticks_per_bar):
            evaluate(source, book, config, now=when)
    return book


def test_it_trades_the_archived_session(volumed_session):
    book = _replay(volumed_session)
    assert book.closed or any(book.open_trades.values()), "no arm did anything"


def test_one_cross_opens_at_most_one_trade_per_arm(volumed_session):
    """A 30-second tick sees the same cross for ten consecutive ticks. Without
    the signal-bar check each of them would open a position."""
    once = _replay(volumed_session, ticks_per_bar=1)
    ten = _replay(volumed_session, ticks_per_bar=10)

    assert len(ten.closed) == len(once.closed)
    for a, b in zip(once.closed, ten.closed):
        assert (a.arm, a.signal_bar, a.entry) == (b.arm, b.signal_bar, b.entry)


def test_each_arm_holds_one_position_at_a_time(volumed_session):
    """The rule is one lot, one position. Overlapping trades in one arm would
    double the risk it claims to take."""
    book = _replay(volumed_session)
    for arm in ARMS:
        trades = book.closed_for(arm)
        for earlier, later in zip(trades, trades[1:]):
            assert later.opened_at >= earlier.closed_at, arm


def test_the_fill_is_the_bar_after_the_signal(volumed_session):
    """Same relationship the replay uses: the cross is known only once its bar
    closed, so the fill is the next bar's open."""
    _, rows, bars, _ = volumed_session
    book = _replay(volumed_session)
    by_time = {b.get("t"): i for i, b in enumerate(bars)}

    for trade in book.closed:
        signal_i = by_time[trade.signal_bar]
        assert trade.entry == pytest.approx(bars[signal_i + 1]["o"], abs=0.01)
        assert trade.entry_ts == int(bars[signal_i + 1]["ts"])


def test_the_stop_sits_one_stop_width_away(volumed_session):
    config = CrossConfig()
    book = _replay(volumed_session, config)
    for trade in book.closed:
        gap = abs(trade.entry - trade.stop)
        assert gap == pytest.approx(config.stop_pts, abs=0.02)
        if trade.direction == "long":
            assert trade.stop < trade.entry < trade.target
        else:
            assert trade.stop > trade.entry > trade.target


def test_the_gated_arm_is_a_subset_of_the_ungated_one(volumed_session):
    """The arms differ only in the floor, so the gate can only ever refuse
    trades the ungated arm took — never invent one of its own."""
    book = _replay(volumed_session)
    gated = {(t.signal_bar, t.direction) for t in book.closed_for(GATED)}
    ungated = {(t.signal_bar, t.direction) for t in book.closed_for(UNGATED)}
    assert gated <= ungated


def test_every_gated_trade_clears_the_floor(volumed_session):
    config = CrossConfig()
    book = _replay(volumed_session, config)
    for trade in book.closed_for(GATED):
        assert trade.rr is not None and trade.rr >= config.min_rr


def test_a_lower_floor_cannot_take_fewer_trades(volumed_session):
    """Monotonic in the floor. If dropping it took fewer trades, the gate is
    doing something other than gating."""
    strict = _replay(volumed_session, CrossConfig(min_rr=3.0))
    loose = _replay(volumed_session, CrossConfig(min_rr=0.0))
    assert len(loose.closed_for(GATED)) >= len(strict.closed_for(GATED))


def test_exits_land_on_a_level_or_a_close(volumed_session):
    book = _replay(volumed_session)
    for trade in book.closed:
        if trade.status == "target":
            assert trade.exit_price == pytest.approx(trade.target)
        elif trade.status == "stop":
            assert trade.exit_price == pytest.approx(trade.stop)
        else:
            assert trade.status == "squareoff"


def test_nothing_opens_after_the_entry_cutoff(volumed_session):
    book = _replay(volumed_session)
    cutoff = CrossConfig().no_entry_after
    for trade in book.closed:
        opened = datetime.fromisoformat(trade.opened_at).time()
        assert opened < cutoff


def test_a_volumeless_session_produces_nothing(volumed_session):
    """The constraint that decides whether this can run at all. yfinance
    supplies NIFTY 5-minute bars with zero volume, and VWAP cannot be computed
    from them — so the shadow trader must sit out rather than invent a line."""
    from dataclasses import replace

    raw, rows, bars, start = volumed_session
    stripped = [replace(c, v=0.0) for c in raw]

    source = _Stub(stripped)
    book = CrossBook(path=Path(tempfile.mkdtemp()) / "book.json", started="")
    config = CrossConfig()
    for i in range(len(bars)):
        source.upto = start + i + 1
        when = datetime.fromtimestamp(bars[i]["ts"] / 1000, tz=IST)
        tick = evaluate(source, book, config, now=when)
        assert tick.opened == []
        # The load-bearing part: no VWAP is ever produced, so no cross can be
        # read off one. A number here would mean it had been invented.
        assert tick.vwap is None
    assert book.closed == []
    assert all(v is None for v in book.open_trades.values())


def test_the_book_survives_being_reloaded(volumed_session):
    """Ticking writes after every change, so a process killed mid-session can
    resume. A shadow run that loses its own history proves nothing."""
    book = _replay(volumed_session)
    book.save()
    again = CrossBook.load(book.path)
    assert len(again.closed) == len(book.closed)
    assert again.last_signal == book.last_signal
    for arm in ARMS:
        here, there = book.open_trades.get(arm), again.open_trades.get(arm)
        assert (here is None) == (there is None)


def test_the_shadow_is_not_wired_into_the_paper_book_or_the_call():
    """It watches a rule that loses money. If it ever reaches a real decision,
    this fails and asks for the backtest to be redone first."""
    import re
    from pathlib import Path as P

    root = P(__file__).resolve().parents[1]
    imports = re.compile(
        r"^\s*(from\s+\S*cross_shadow\S*\s+import|import\s+\S*\bcross_shadow\w*\b)",
        re.MULTILINE,
    )
    for name in ("live/runner.py", "live/book.py", "live/decide.py",
                 "core/suggestion.py", "core/signals.py", "backtest/replay.py",
                 "api.py"):
        found = imports.search((root / name).read_text())
        assert not found, (
            f"{name} imports the cross shadow ({found.group(0).strip()!r}). "
            "It is a shadow of a losing rule and must stay one."
        )
