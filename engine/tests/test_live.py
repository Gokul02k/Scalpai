"""Tests for the paper trading loop.

The interesting failures here are not crashes but silent optimism: filling at
the mid instead of the spread, letting a position resolve on a bar that
happened before it was opened, or forgetting charges. Each of those makes
paper results look better than live for reasons that would only surface with
real money, so they get explicit tests.
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta

import pytest

from engine.data.base import Candle, Quote
from engine.data.timeutil import IST
from engine.live.book import PaperBook, Position
from engine.live.runner import (
    PaperConfig, choose_strike, evaluate, manage_open, _cooldown_block, _settle,
)


# ── fixtures ───────────────────────────────────────────────────────────────


def _pos(action="BUY", entry=24000.0, **kw) -> Position:
    """One open position. Levels default to a tight scalp around `entry`;
    override target_index / stop_index to build one the path will not resolve.
    """
    base = dict(
        id="abc123",
        opened_at=datetime(2026, 8, 14, 10, 0, tzinfo=IST).isoformat(),
        action=action,
        entry_index=entry,
        target_index=entry + 100 if action == "BUY" else entry - 100,
        stop_index=entry - 60 if action == "BUY" else entry + 60,
        confidence=85,
        ml_score=0.6,
        vix=13.2,
        symbol="NSE:NIFTY2681424000CE",
        strike=24000,
        option_type="CE" if action == "BUY" else "PE",
        expiry="2026-08-21",
        entry_premium=120.0,
        entry_bid=119.0,
        entry_ask=120.0,
        delta=0.52,
        iv=0.11,
    )
    base.update(kw)
    return Position(**base)


def _bars(start: datetime, closes, high_bump=0.0, low_bump=0.0):
    return [
        {
            "ts": int((start + timedelta(minutes=5 * i)).timestamp() * 1000),
            "o": c, "h": c + high_bump, "l": c - low_bump, "c": c, "v": 1000,
        }
        for i, c in enumerate(closes)
    ]


def _chain(spot=24000.0, vix=13.0, strikes=(23900, 24000, 24100)):
    rows = [{"strike_price": -1, "ltp": spot, "fp": spot + 20}]
    for k in strikes:
        for opt in ("CE", "PE"):
            intrinsic = max(0.0, (spot - k) if opt == "CE" else (k - spot))
            mid = intrinsic + 80
            rows.append({
                "strike_price": k, "option_type": opt,
                "bid": mid - 1.5, "ask": mid + 1.5, "ltp": mid,
                "oi": 500_000, "volume": 20_000, "symbol": f"NSE:NIFTY{k}{opt}",
            })
    expiry = int((datetime.now(IST) + timedelta(days=6)).timestamp())
    return {
        "optionsChain": rows,
        "expiryData": [{"expiry": str(expiry), "date": "21-08-2026"}],
        "indiavixData": {"ltp": vix},
    }


# ── the book ───────────────────────────────────────────────────────────────


def test_book_round_trips_through_disk(tmp_path):
    book = PaperBook.load(tmp_path / "b.json")
    book.open_position(_pos())
    book.save()

    again = PaperBook.load(tmp_path / "b.json")
    assert len(again.open_positions) == 1
    assert again.open_positions[0].symbol == "NSE:NIFTY2681424000CE"


def test_book_survives_a_restart_mid_position(tmp_path):
    """A killed process must not lose the book, or a paper day proves nothing."""
    book = PaperBook.load(tmp_path / "b.json")
    book.open_position(_pos())
    book.note("tick", "still open")
    book.save()

    resumed = PaperBook.load(tmp_path / "b.json")
    resumed.close_position(_settle(
        resumed.open_positions[0], 24100.0, 190.0, "target",
        datetime(2026, 8, 14, 11, 0, tzinfo=IST),
    ))
    resumed.save()

    final = PaperBook.load(tmp_path / "b.json")
    assert final.open_positions == []
    assert len(final.closed) == 1
    assert final.closed[0].net_rupees > 0


def test_summary_is_empty_before_any_trade(tmp_path):
    book = PaperBook.load(tmp_path / "b.json")
    assert book.summary()["trades"] == 0
    assert "no closed trades" in book.summary_lines()[0]


# ── settlement ─────────────────────────────────────────────────────────────


def test_settlement_charges_reduce_a_winner():
    """Gross must exceed net. A paper win that ignores charges is a fiction."""
    trade = _settle(_pos(), 24100.0, 190.0, "target",
                    datetime(2026, 8, 14, 11, 0, tzinfo=IST))
    assert trade.gross_premium == pytest.approx((190.0 - 120.0) * 75)
    assert trade.charges > 0
    assert trade.net_rupees < trade.gross_premium
    assert trade.won


def test_settlement_deepens_a_loser():
    """Charges are paid on losses too, so net must be worse than gross."""
    trade = _settle(_pos(), 23940.0, 85.0, "stop",
                    datetime(2026, 8, 14, 11, 0, tzinfo=IST))
    assert trade.net_rupees < trade.gross_premium < 0
    assert not trade.won


def test_index_points_are_net_per_unit():
    """Reported in index points so a paper day is comparable to the backtest."""
    trade = _settle(_pos(), 24100.0, 190.0, "target",
                    datetime(2026, 8, 14, 11, 0, tzinfo=IST))
    assert trade.index_points == pytest.approx(trade.net_rupees / 75)


def test_hold_hours_measured_from_entry():
    trade = _settle(_pos(), 24100.0, 190.0, "target",
                    datetime(2026, 8, 14, 12, 30, tzinfo=IST))
    assert trade.hold_hours == pytest.approx(2.5)


# ── strike selection ───────────────────────────────────────────────────────


def test_buy_picks_a_call_and_sell_picks_a_put():
    config, now = PaperConfig(), datetime.now(IST)
    assert choose_strike(_chain(), "BUY", config, now)["option_type"] == "CE"
    assert choose_strike(_chain(), "SELL", config, now)["option_type"] == "PE"


def test_entry_is_the_ask_not_the_mid():
    """Crossing the spread is the single easiest cost to accidentally omit."""
    pick = choose_strike(_chain(), "BUY", PaperConfig(), datetime.now(IST))
    assert pick["ask"] > pick["bid"]
    assert pick["ask"] == pytest.approx(pick["bid"] + 3.0)


def test_no_strike_when_the_chain_is_missing():
    assert choose_strike(None, "BUY", PaperConfig(), datetime.now(IST)) is None
    assert choose_strike({}, "BUY", PaperConfig(), datetime.now(IST)) is None


def test_illiquid_strikes_are_refused():
    """A tight quote nobody trades is not a price you can get."""
    chain = _chain()
    for row in chain["optionsChain"]:
        if row.get("strike_price", -1) > 0:
            row["volume"] = 0
    assert choose_strike(chain, "BUY", PaperConfig(), datetime.now(IST)) is None


# ── position management ────────────────────────────────────────────────────


def test_target_closes_the_position(tmp_path):
    opened = datetime(2026, 8, 14, 10, 0, tzinfo=IST)
    book = PaperBook.load(tmp_path / "b.json")
    book.open_position(_pos())

    rows = _bars(opened, [24000, 24050, 24160], high_bump=5)
    closed = manage_open(book, PaperConfig(min_pass_points=0), rows,
                         _chain(spot=24160), 24160.0,
                         opened + timedelta(hours=1))

    assert len(closed) == 1
    assert closed[0].exit_reason == "target"
    assert book.open_positions == []


def test_stop_closes_the_position(tmp_path):
    opened = datetime(2026, 8, 14, 10, 0, tzinfo=IST)
    book = PaperBook.load(tmp_path / "b.json")
    book.open_position(_pos())

    rows = _bars(opened, [24000, 23970, 23930], low_bump=5)
    closed = manage_open(book, PaperConfig(min_pass_points=0), rows,
                         _chain(spot=23930), 23930.0,
                         opened + timedelta(hours=1))

    assert len(closed) == 1
    assert closed[0].exit_reason == "stop"


def test_an_untouched_position_stays_open(tmp_path):
    opened = datetime(2026, 8, 14, 10, 0, tzinfo=IST)
    book = PaperBook.load(tmp_path / "b.json")
    book.open_position(_pos())

    rows = _bars(opened, [24000, 24010, 24005])
    closed = manage_open(book, PaperConfig(), rows, _chain(), 24005.0,
                         opened + timedelta(minutes=30))

    assert closed == []
    assert len(book.open_positions) == 1


def test_square_off_closes_whatever_is_left(tmp_path):
    """Nothing may be carried overnight, resolved or not."""
    opened = datetime(2026, 8, 14, 10, 0, tzinfo=IST)
    book = PaperBook.load(tmp_path / "b.json")
    book.open_position(_pos())

    rows = _bars(opened, [24000, 24010, 24005])
    closed = manage_open(book, PaperConfig(), rows, _chain(), 24005.0,
                         datetime(2026, 8, 14, 15, 21, tzinfo=IST))

    assert len(closed) == 1
    assert closed[0].exit_reason == "squareoff"
    assert book.open_positions == []


def test_bars_before_entry_cannot_resolve_a_trade(tmp_path):
    """Grading against earlier bars would let a position close on price action
    that happened before it existed."""
    opened = datetime(2026, 8, 14, 12, 0, tzinfo=IST)
    book = PaperBook.load(tmp_path / "b.json")
    book.open_position(_pos(opened_at=opened.isoformat()))

    # A big move, but entirely in the morning before the entry.
    rows = _bars(datetime(2026, 8, 14, 9, 15, tzinfo=IST),
                 [24000, 24200, 24300, 23800], high_bump=10, low_bump=10)
    closed = manage_open(book, PaperConfig(), rows, _chain(), 24000.0,
                         opened + timedelta(minutes=10))

    assert closed == []
    assert len(book.open_positions) == 1


def test_exit_uses_the_bid_when_the_strike_is_quoted(tmp_path):
    opened = datetime(2026, 8, 14, 10, 0, tzinfo=IST)
    book = PaperBook.load(tmp_path / "b.json")
    book.open_position(_pos())

    chain = _chain(spot=24160)
    rows = _bars(opened, [24000, 24050, 24160], high_bump=5)
    closed = manage_open(book, PaperConfig(min_pass_points=0), rows, chain,
                         24160.0, opened + timedelta(hours=1))

    quoted = next(r for r in chain["optionsChain"]
                  if r.get("strike_price") == 24000 and r["option_type"] == "CE")
    assert closed[0].exit_premium == pytest.approx(quoted["bid"])


def test_exit_falls_back_to_theory_when_the_strike_is_gone(tmp_path):
    """A strike outside the fetched window still has to be marked, not frozen."""
    opened = datetime(2026, 8, 14, 10, 0, tzinfo=IST)
    book = PaperBook.load(tmp_path / "b.json")
    book.open_position(_pos(strike=21000))

    rows = _bars(opened, [24000, 24050, 24160], high_bump=5)
    closed = manage_open(book, PaperConfig(min_pass_points=0), rows,
                         _chain(spot=24160), 24160.0, opened + timedelta(hours=1))

    assert len(closed) == 1
    # Deep in the money: worth at least its intrinsic value, less the spread.
    assert closed[0].exit_premium > 3000


# ── the full tick ──────────────────────────────────────────────────────────


class FakeSource:
    """A market that trends up hard enough to produce a directional call."""

    def __init__(self, vix=13.0, bars=420, chain=True):
        self.vix, self._chain_on = vix, chain
        start = datetime(2026, 8, 13, 9, 15, tzinfo=IST)
        self._candles = []
        price = 24000.0
        for i in range(bars):
            price += 6.0 if i % 5 else -3.0
            self._candles.append(Candle(
                ts=int((start + timedelta(minutes=5 * i)).timestamp() * 1000),
                o=price - 2, h=price + 8, l=price - 6, c=price, v=100_000,
            ))

    def candles(self, symbol, interval, start, end, segment="INDEX"):
        return self._candles

    def quote(self, symbol, segment="INDEX"):
        last = self._candles[-1].c
        return Quote(symbol=symbol, current=self.vix if "VIX" in symbol else last,
                     previous_close=last - 40, high=last, low=last - 60,
                     ts=self._candles[-1].ts, source="fake")

    def option_chain(self, symbol="NIFTY", strike_count=10):
        if not self._chain_on:
            raise RuntimeError("no chain")
        spot = self._candles[-1].c
        base = int(round(spot / 100) * 100)
        return _chain(spot=spot, vix=self.vix,
                      strikes=(base - 100, base, base + 100))


def test_gate_stands_aside_when_vix_is_high(tmp_path, monkeypatch):
    """The whole finding rests on this: the strategy only pays in calm vol."""
    _force_signal(monkeypatch)
    book = PaperBook.load(tmp_path / "b.json")
    result = evaluate(FakeSource(vix=24.0), book,
                      PaperConfig(gate=16.0, shadow=False),
                      now=datetime(2026, 8, 14, 11, 0, tzinfo=IST))

    assert not result.taken
    assert "above gate" in result.reason
    assert book.open_positions == []


def test_no_new_entries_late_in_the_day(tmp_path):
    book = PaperBook.load(tmp_path / "b.json")
    result = evaluate(FakeSource(), book, PaperConfig(),
                      now=datetime(2026, 8, 14, 15, 5, tzinfo=IST))

    assert not result.taken
    assert "too late" in result.reason


def test_max_open_is_respected(tmp_path, monkeypatch):
    _force_signal(monkeypatch)
    book = PaperBook.load(tmp_path / "b.json")
    # Levels wide enough that the trending fixture resolves neither, so the
    # cap is what stops the next entry rather than the book having emptied.
    book.open_position(_pos(action="BUY", id="p0", entry_index=25700.0,
                            target_index=28000.0, stop_index=22000.0))
    book.open_position(_pos(action="SELL", id="p1", entry_index=25700.0,
                            target_index=22000.0, stop_index=28000.0))

    result = evaluate(FakeSource(), book, PaperConfig(max_open=2, shadow=False),
                      now=datetime(2026, 8, 14, 11, 0, tzinfo=IST))

    assert not result.taken
    assert "already open" in result.reason
    assert len(book.open_positions) == 2


def _force_signal(monkeypatch, action="BUY", confidence=88):
    """Pin the strategy's output so the plumbing downstream of it can be tested
    on its own. Whether the strategy fires on a given fixture is the backtest's
    question, not this one's."""
    import engine.live.runner as runner

    def fake(analysis, price, chg, signals, settings, mode, instrument, flags):
        return {
            "action": action, "confidence": confidence, "entry": price,
            "target": price + 120 if action == "BUY" else price - 120,
            "stopLoss": price - 70 if action == "BUY" else price + 70,
            "reason": "forced", "rr": 1.7, "viable": True,
        }

    monkeypatch.setattr(runner.sug, "build_unified_suggestion", fake)


def test_a_signal_opens_a_position_with_a_real_strike(tmp_path, monkeypatch):
    _force_signal(monkeypatch)
    book = PaperBook.load(tmp_path / "b.json")
    result = evaluate(FakeSource(vix=12.0), book, PaperConfig(gate=16.0),
                      now=datetime(2026, 8, 14, 11, 0, tzinfo=IST))

    assert result.taken, result.reason
    assert len(book.open_positions) == 1

    pos = book.open_positions[0]
    assert pos.option_type == "CE"
    assert pos.entry_premium == pos.entry_ask > pos.entry_bid
    assert pos.strike > 0 and pos.vix == 12.0
    assert pos.target_index > pos.entry_index > pos.stop_index


def test_a_sell_signal_buys_a_put(tmp_path, monkeypatch):
    _force_signal(monkeypatch, action="SELL")
    book = PaperBook.load(tmp_path / "b.json")
    result = evaluate(FakeSource(vix=12.0), book, PaperConfig(gate=16.0),
                      now=datetime(2026, 8, 14, 11, 0, tzinfo=IST))

    assert result.taken, result.reason
    pos = book.open_positions[0]
    assert pos.option_type == "PE"
    assert pos.target_index < pos.entry_index < pos.stop_index


def test_the_filter_can_veto_a_signal(tmp_path, monkeypatch):
    """A threshold above every possible score must block everything, which is
    what proves the filter is wired in rather than merely computed."""
    _force_signal(monkeypatch)

    class AlwaysLow:
        def predict(self, rows):
            return [0.01]

    book = PaperBook.load(tmp_path / "b.json")
    result = evaluate(FakeSource(vix=12.0), book,
                      PaperConfig(gate=16.0, min_score=0.99), AlwaysLow(),
                      now=datetime(2026, 8, 14, 11, 0, tzinfo=IST))

    assert not result.taken
    assert result.score == pytest.approx(0.01)
    assert "score 0.010 below 0.990" in result.reason
    assert book.open_positions == []


def test_the_filter_lets_a_strong_signal_through(tmp_path, monkeypatch):
    _force_signal(monkeypatch)

    class AlwaysHigh:
        def predict(self, rows):
            return [0.95]

    book = PaperBook.load(tmp_path / "b.json")
    result = evaluate(FakeSource(vix=12.0), book,
                      PaperConfig(gate=16.0, min_score=0.5), AlwaysHigh(),
                      now=datetime(2026, 8, 14, 11, 0, tzinfo=IST))

    assert result.taken, result.reason
    assert book.open_positions[0].ml_score == pytest.approx(0.95)


def test_the_model_is_scored_with_the_vix_columns_filled(tmp_path, monkeypatch):
    """Train/serve skew guard. The filter is fitted with volatility-regime
    columns joined from the daily series; scoring it with those at zero would
    produce confident nonsense rather than an error."""
    from engine.ml.features import FEATURE_NAMES

    _force_signal(monkeypatch)
    seen = {}

    class Recording:
        def predict(self, rows):
            seen["row"] = list(rows[0])
            return [0.9]

    book = PaperBook.load(tmp_path / "b.json")
    evaluate(FakeSource(vix=12.0), book, PaperConfig(gate=16.0, min_score=0.1),
             Recording(), now=datetime(2026, 8, 14, 11, 0, tzinfo=IST))

    row = seen["row"]
    assert row[FEATURE_NAMES.index("vix_level")] == pytest.approx(12.0)
    assert row[FEATURE_NAMES.index("vix_vs_20d")] > 0
    assert row[FEATURE_NAMES.index("vix_pctile_1y")] >= 0


def test_the_gate_refuses_however_good_the_signal_looks(tmp_path, monkeypatch):
    _force_signal(monkeypatch)

    class AlwaysHigh:
        def predict(self, rows):
            return [0.99]

    book = PaperBook.load(tmp_path / "b.json")
    result = evaluate(FakeSource(vix=25.0), book,
                      PaperConfig(gate=16.0, min_score=0.1), AlwaysHigh(),
                      now=datetime(2026, 8, 14, 11, 0, tzinfo=IST))

    assert not result.taken
    assert book.open_positions == []
    assert "above gate" in result.reason


# ── the shadow book ────────────────────────────────────────────────────────


def test_a_gated_signal_is_followed_as_a_shadow(tmp_path, monkeypatch):
    """A filter taking twenty trades a year cannot be judged from the trades it
    takes. The refused ones are where the evidence is."""
    _force_signal(monkeypatch)
    book = PaperBook.load(tmp_path / "b.json")
    result = evaluate(FakeSource(vix=25.0), book, PaperConfig(gate=16.0),
                      now=datetime(2026, 8, 14, 11, 0, tzinfo=IST))

    assert not result.taken
    assert book.open_positions == []
    assert len(book.shadow_open) == 1
    assert book.shadow_open[0].kind == "shadow"
    assert "above gate" in book.shadow_open[0].declined


def test_a_filtered_signal_is_followed_as_a_shadow(tmp_path, monkeypatch):
    _force_signal(monkeypatch)

    class AlwaysLow:
        def predict(self, rows):
            return [0.01]

    book = PaperBook.load(tmp_path / "b.json")
    evaluate(FakeSource(vix=12.0), book, PaperConfig(gate=16.0, min_score=0.9),
             AlwaysLow(), now=datetime(2026, 8, 14, 11, 0, tzinfo=IST))

    assert book.open_positions == []
    assert len(book.shadow_open) == 1
    assert "score" in book.shadow_open[0].declined


def test_shadows_never_reach_the_headline_result(tmp_path, monkeypatch):
    """The one property that must not break: a declined trade cannot show up
    as a result, however it resolved."""
    _force_signal(monkeypatch)
    source = FakeSource(vix=25.0)
    book = PaperBook.load(tmp_path / "b.json")
    config = PaperConfig(gate=16.0)

    evaluate(source, book, config, now=datetime(2026, 8, 14, 11, 0, tzinfo=IST))
    evaluate(source, book, config, now=datetime(2026, 8, 14, 15, 25, tzinfo=IST))

    assert book.summary()["trades"] == 0
    assert book.summary(shadow=True)["trades"] == 1
    assert book.closed == []
    assert len(book.shadow_closed) == 1


def test_shadows_survive_a_restart(tmp_path, monkeypatch):
    _force_signal(monkeypatch)
    book = PaperBook.load(tmp_path / "b.json")
    evaluate(FakeSource(vix=25.0), book, PaperConfig(gate=16.0),
             now=datetime(2026, 8, 14, 11, 0, tzinfo=IST))
    book.save()

    again = PaperBook.load(tmp_path / "b.json")
    assert len(again.shadow_open) == 1
    assert again.shadow_open[0].kind == "shadow"


def test_a_shadow_does_not_block_a_later_live_trade(tmp_path, monkeypatch):
    """The books are independent, or the comparison would be between different
    trade sets rather than two verdicts on the same ones."""
    _force_signal(monkeypatch)
    book = PaperBook.load(tmp_path / "b.json")

    evaluate(FakeSource(vix=25.0), book, PaperConfig(gate=16.0),
             now=datetime(2026, 8, 14, 11, 0, tzinfo=IST))
    assert len(book.shadow_open) == 1

    taken = evaluate(FakeSource(vix=12.0), book, PaperConfig(gate=16.0),
                     now=datetime(2026, 8, 14, 11, 4, tzinfo=IST))
    assert taken.taken, taken.reason
    assert len(book.open_positions) == 1


def test_shadowing_can_be_switched_off(tmp_path, monkeypatch):
    _force_signal(monkeypatch)
    book = PaperBook.load(tmp_path / "b.json")
    evaluate(FakeSource(vix=25.0), book, PaperConfig(gate=16.0, shadow=False),
             now=datetime(2026, 8, 14, 11, 0, tzinfo=IST))

    assert book.shadow_open == []
    assert book.open_positions == []


def test_the_scorecard_stays_quiet_on_a_thin_sample(tmp_path, monkeypatch):
    _force_signal(monkeypatch)
    book = PaperBook.load(tmp_path / "b.json")
    evaluate(FakeSource(vix=25.0), book, PaperConfig(gate=16.0),
             now=datetime(2026, 8, 14, 11, 0, tzinfo=IST))
    evaluate(FakeSource(vix=25.0), book, PaperConfig(gate=16.0),
             now=datetime(2026, 8, 14, 15, 25, tzinfo=IST))

    text = " ".join(book.verdict_lines())
    assert "declined" in text
    assert "too few trades" in text


def test_a_full_round_trip_nets_out(tmp_path, monkeypatch):
    """Open on one tick, close on a later one, and land in the summary."""
    _force_signal(monkeypatch)
    source = FakeSource(vix=12.0)
    book = PaperBook.load(tmp_path / "b.json")
    config = PaperConfig(gate=16.0)

    evaluate(source, book, config, now=datetime(2026, 8, 14, 11, 0, tzinfo=IST))
    assert len(book.open_positions) == 1

    evaluate(source, book, config, now=datetime(2026, 8, 14, 15, 25, tzinfo=IST))
    assert book.open_positions == []

    summary = book.summary()
    assert summary["trades"] == 1
    assert summary["open"] == 0
    assert "net_rupees" in summary


def test_low_confidence_is_rejected(tmp_path):
    """Raising the bar above any achievable score must stop every trade."""
    book = PaperBook.load(tmp_path / "b.json")
    result = evaluate(FakeSource(), book, PaperConfig(min_confidence=101),
                      now=datetime(2026, 8, 14, 11, 0, tzinfo=IST))

    assert not result.taken
    assert book.open_positions == []


def test_a_tick_reads_vix_and_price_even_when_standing_aside(tmp_path):
    """The skipped ticks still have to be observable, or the gate cannot be
    reviewed after the fact."""
    book = PaperBook.load(tmp_path / "b.json")
    result = evaluate(FakeSource(vix=22.0), book, PaperConfig(gate=16.0),
                      now=datetime(2026, 8, 14, 11, 0, tzinfo=IST))

    assert result.vix == 22.0
    assert result.index and result.index > 0
    assert "vix" in result.line()


def test_a_missing_chain_blocks_entry_rather_than_guessing(tmp_path):
    """Without quotes there is no honest entry price, so no trade."""
    book = PaperBook.load(tmp_path / "b.json")
    result = evaluate(FakeSource(chain=False), book, PaperConfig(gate=99.0),
                      now=datetime(2026, 8, 14, 11, 0, tzinfo=IST))

    assert not result.taken
    assert book.open_positions == []


def test_too_little_history_is_refused(tmp_path):
    book = PaperBook.load(tmp_path / "b.json")
    result = evaluate(FakeSource(bars=10), book, PaperConfig(),
                      now=datetime(2026, 8, 14, 11, 0, tzinfo=IST))

    assert not result.taken
    assert "history" in result.reason


def test_cooldown_blocks_a_repeat_in_the_same_direction(tmp_path):
    now = datetime(2026, 8, 14, 11, 0, tzinfo=IST)
    book = PaperBook.load(tmp_path / "b.json")
    book.closed.append(_settle(_pos(action="BUY"), 24100.0, 190.0, "target",
                               now - timedelta(minutes=5)))

    blocked = _cooldown_block(book, "BUY", now, PaperConfig(cooldown_min=20))
    assert blocked and "cooldown" in blocked
    assert _cooldown_block(book, "SELL", now, PaperConfig(cooldown_min=20)) is None


def test_cooldown_expires(tmp_path):
    now = datetime(2026, 8, 14, 11, 0, tzinfo=IST)
    book = PaperBook.load(tmp_path / "b.json")
    book.closed.append(_settle(_pos(action="BUY"), 24100.0, 190.0, "target",
                               now - timedelta(minutes=45)))

    assert _cooldown_block(book, "BUY", now, PaperConfig(cooldown_min=20)) is None


def test_market_status_reports_openness_under_the_key_paper_reads():
    """`paper` refuses to start a loop when the market is shut, so it has to
    read the right key. A `.get()` on a misspelled one is silently falsy and
    makes the runner claim a live market is closed."""
    from engine.data.timeutil import market_status

    status = market_status(datetime(2026, 8, 14, 10, 48, tzinfo=IST))
    assert status["open"] is True

    assert market_status(datetime(2026, 8, 14, 8, 0, tzinfo=IST))["open"] is False
    assert market_status(datetime(2026, 8, 14, 16, 0, tzinfo=IST))["open"] is False
    assert market_status(datetime(2026, 8, 15, 11, 0, tzinfo=IST))["open"] is False


def test_log_records_skipped_ticks_too(tmp_path):
    """The declined ticks are the evidence for whether the gate is right."""
    book = PaperBook.load(tmp_path / "b.json")
    book.note("skip", "vix 19.40 above gate 16.0", vix=19.4)
    book.save()

    blob = json.loads((tmp_path / "b.json").read_text())
    assert blob["log"][0]["kind"] == "skip"
    assert blob["log"][0]["vix"] == 19.4
