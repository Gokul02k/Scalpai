"""The EMA-9 / VWAP cross, and the guarantees that keep the measurement honest.

Three kinds of test here. The first pins the definitions: a cross is a change
of side between two closed bars, and a rupee stop becomes index points through
one stated delta rather than a magic constant. The second pins the replay:
nothing it decides may depend on a bar that had not printed yet, one position
means one, and a bar holding both levels is settled at the stop. The third
pins the finding — that the reward:risk gate, not the market, is what refuses
most of these crosses — because that is the whole result and a refactor that
quietly stops refusing them would otherwise look like an improvement.

The designed session below has one cross that is refused and one that is
taken, so a change that stops the engine recognising the setup fails loudly
rather than reporting fewer trades.
"""
from __future__ import annotations

from datetime import datetime, timedelta

import pytest

from engine.backtest.costs import IndexPointCost
from engine.backtest.vwap_cross import (
    LONG,
    SHORT,
    VwapCrossParams,
    VwapTrade,
    _cross,
    _resolve,
    _running_vwap,
    default_grid,
    run_vwap_cross_backtest,
    stop_points,
)
from engine.core.vwap_cross import fully_volumed, session_vwaps
from engine.core.indicators import candles_to_dicts, ema, intraday_session
from engine.data import CandleStore
from engine.data.timeutil import IST, SQUARE_OFF

OPEN = (9, 15)
SQUARE_OFF_MINUTES = SQUARE_OFF[0] * 60 + SQUARE_OFF[1]


def _bars(rows: list[tuple[float, float, float, float]], day: str = "2026-08-17") -> list[dict]:
    """Turn (o, h, l, c) tuples into 5-minute candles from the opening bell."""
    start = datetime.fromisoformat(f"{day}T{OPEN[0]:02d}:{OPEN[1]:02d}").replace(tzinfo=IST)
    out = []
    for i, (o, h, l, c) in enumerate(rows):
        moment = start + timedelta(minutes=5 * i)
        out.append({"ts": int(moment.timestamp() * 1000), "o": o, "h": h, "l": l,
                    "c": c, "vol": 1000, "t": moment.strftime("%H:%M")})
    return out


def _designed_session() -> list[tuple[float, float, float, float]]:
    """A spike, a decline that puts EMA under VWAP, then a rally back through it.

    Produces a short cross at bar 7 whose target is too near to clear the gate,
    and a long cross at bar 21 that is taken and reaches its level.
    """
    rows = [(25_100, 25_200, 25_095, 25_190), (25_190, 25_195, 25_150, 25_160)]
    for k in range(10):
        top = 25_160 - k * 12
        rows.append((top, top + 3, top - 15, top - 12))
    last = rows[-1][3]
    for k in range(28):
        o = last + k * 9
        rows.append((o, o + 11, o - 3, o + 9))
    return rows


DESIGNED = _bars(_designed_session())
TEST_PARAMS = VwapCrossParams(min_session_bars=5, stop_pts=20.0)


# ── the cross itself ───────────────────────────────────────────────────────

def test_cross_is_a_change_of_side_not_a_position():
    """Both series above VWAP for two bars is a trend, not a signal."""
    assert _cross([10, 11], [12, 12], 0, 1) is None      # below, stayed below
    assert _cross([13, 14], [12, 12], 0, 1) is None      # above, stayed above


def test_bullish_cross_is_ema_rising_through_vwap():
    assert _cross([10, 13], [12, 12], 0, 1) == LONG


def test_bearish_cross_is_ema_falling_through_vwap():
    assert _cross([13, 10], [12, 12], 0, 1) == SHORT


def test_touching_vwap_exactly_counts_as_crossing():
    """`>=` rather than `>`: an EMA that has arrived at VWAP has left the side
    it was on, and requiring it to overshoot would silently drop signals."""
    assert _cross([10, 12], [12, 12], 0, 1) == LONG
    assert _cross([14, 12], [12, 12], 0, 1) == SHORT


def test_cross_reads_the_bar_before_not_the_bar_after():
    """Only indices i-1 and i are consulted, so a later bar cannot change a
    signal that has already fired."""
    early = _cross([10, 13, 99], [12, 12, 12], 0, 1)
    assert early == LONG
    assert _cross([10, 13, 1], [12, 12, 12], 0, 1) == early


# ── the rupee stop, translated ─────────────────────────────────────────────

def test_rupee_stop_becomes_index_points_through_delta():
    """800 rupees on a lot of 75 is 10.67 premium points; at delta 0.52 the
    index has to move about 20.5 points to lose it."""
    assert stop_points(800.0, 75, 0.52) == pytest.approx(20.51, abs=0.01)


def test_a_lower_delta_needs_a_larger_move_to_lose_the_same_money():
    """The conversion is the assumption in this backtest, so its direction is
    worth pinning: a cheaper, further option moves less per index point."""
    assert stop_points(delta=0.40) > stop_points(delta=0.52) > stop_points(delta=0.60)


def test_doubling_the_lot_halves_the_move_that_loses_the_stop():
    assert stop_points(800.0, 150, 0.52) == pytest.approx(stop_points(800.0, 75, 0.52) / 2)


# ── resolving a trade ──────────────────────────────────────────────────────

def _open_trade(direction: str = LONG) -> VwapTrade:
    sign = 1 if direction == LONG else -1
    return VwapTrade(
        date="2026-08-17", direction=direction, entry=25_000.0,
        stop=25_000.0 - 20 * sign, target=25_000.0 + 60 * sign,
        entry_time="10:00", exit_time="", exit_price=0.0, status="open",
        ema_at_signal=25_000.0, vwap_at_signal=25_000.0,
    )


def _bar(h: float, l: float, c: float, hhmm: str = "10:05") -> dict:
    moment = datetime.fromisoformat(f"2026-08-17T{hhmm}").replace(tzinfo=IST)
    return {"ts": int(moment.timestamp() * 1000), "o": c, "h": h, "l": l, "c": c, "vol": 1}


def test_a_bar_reaching_the_target_fills_at_the_target():
    status, price = _resolve(_open_trade(), _bar(25_070, 24_990, 25_065), SQUARE_OFF_MINUTES)
    assert (status, price) == ("target", 25_060.0)


def test_a_bar_reaching_the_stop_fills_at_the_stop():
    status, price = _resolve(_open_trade(), _bar(25_010, 24_975, 24_980), SQUARE_OFF_MINUTES)
    assert (status, price) == ("stop", 24_980.0)


def test_a_bar_holding_both_levels_is_settled_at_the_stop():
    """5-minute data cannot order two touches inside one bar. Assuming the
    target would pay the strategy for information the tape never gave."""
    both = _bar(25_070, 24_970, 25_000)
    assert _resolve(_open_trade(), both, SQUARE_OFF_MINUTES)[0] == "stop"
    assert _resolve(_open_trade(SHORT), both, SQUARE_OFF_MINUTES)[0] == "stop"


def test_an_untouched_bar_leaves_the_trade_open():
    assert _resolve(_open_trade(), _bar(25_010, 24_990, 25_005), SQUARE_OFF_MINUTES)[0] is None


def test_an_unresolved_trade_is_squared_off_at_the_close():
    status, price = _resolve(
        _open_trade(), _bar(25_010, 24_990, 25_005, "15:20"), SQUARE_OFF_MINUTES
    )
    assert (status, price) == ("squareoff", 25_005.0)


def test_the_stop_is_taken_even_after_square_off_time():
    """Order matters: a bar that both breaks the stop and ends the session is
    a loss, not a flat exit at the close."""
    late = _bar(25_010, 24_975, 25_005, "15:20")
    assert _resolve(_open_trade(), late, SQUARE_OFF_MINUTES)[0] == "stop"


# ── VWAP and EMA, as the chart draws them ──────────────────────────────────

def test_running_vwap_matches_the_indicator_the_app_uses():
    """The replay recomputes VWAP incrementally for speed. If it drifts from
    `intraday_session`, the backtest is measuring a line the app never shows."""
    for i in range(1, len(DESIGNED)):
        expected = intraday_session(DESIGNED[: i + 1])["vwap"]
        assert _running_vwap(DESIGNED[: i + 1])[-1] == pytest.approx(expected, abs=0.01)


def test_a_padded_tail_still_reports_a_live_signal():
    """The case that made the strict rule untenable: the engine pads a
    finished session with zero-volume bars, and the panel has to keep reading
    rather than announce that VWAP has vanished."""
    from engine.core.vwap_cross import vwap_cross_signal

    padded = list(DESIGNED) + [{**DESIGNED[-1], "vol": 0}]
    live = vwap_cross_signal(padded)
    assert live["available"] is True
    assert live["vwap"] == vwap_cross_signal(DESIGNED)["vwap"]


def test_a_session_without_volume_has_no_vwap():
    """The bug this module shipped with, pinned. Index feeds often carry no
    volume, and a volume-weighted average of nothing has no value."""
    assert _running_vwap([{**c, "vol": 0} for c in DESIGNED]) is None


def test_a_zero_volume_bar_does_not_move_vwap():
    """The definition, not a convention. A bar with no volume contributes
    nothing to either side of sum(tp*v)/sum(v), so VWAP after it equals VWAP
    before it — which is why live feeds padding a session's tail with
    zero-volume bars must not blank the reading."""
    padded = [dict(c) for c in DESIGNED] + [{**DESIGNED[-1], "vol": 0}]
    full = session_vwaps(DESIGNED)
    with_pad = session_vwaps(padded)
    assert with_pad[: len(full)] == full
    assert with_pad[-1] == full[-1]


def test_vwap_is_undefined_only_until_the_first_trade():
    """Leading zero-volume bars have no VWAP; once anything trades, there is
    one. Marking the whole session undefined would throw away the part that
    is perfectly well defined."""
    late = [{**c, "vol": 0} for c in DESIGNED[:3]] + [dict(c) for c in DESIGNED[3:]]
    vwaps = session_vwaps(late)
    assert vwaps[:3] == [None, None, None]
    assert all(v is not None for v in vwaps[3:])


def test_the_replay_refuses_a_partially_volumed_session():
    """Separate from the definition of VWAP: the replay wants sessions whose
    weighting is trustworthy end to end, because a VWAP that lurches as volume
    arrives measures the feed rather than the rule."""
    holed = [dict(c) for c in DESIGNED]
    holed[10]["vol"] = 0
    assert not fully_volumed(holed)
    assert _running_vwap(holed) is None

    result = run_vwap_cross_backtest(holed, TEST_PARAMS, IndexPointCost())
    assert result.sessions == 0
    assert result.sessions_without_volume == 1


def test_vwap_is_never_filled_in_from_the_close():
    """The specific wrong answer that made a nine-year backtest look valid.
    Falling back to the close produces a "VWAP" identical to price, which makes
    EMA 9 cross it on almost every bar and reports a plausible-looking result
    for a strategy nobody described. It must refuse instead."""
    dead = [{**c, "vol": 0} for c in DESIGNED]
    assert _running_vwap(dead) is None, "VWAP was fabricated from closes"
    assert all(v is None for v in session_vwaps(dead))

    result = run_vwap_cross_backtest(
        [{**c, "vol": 0} for c in DESIGNED], TEST_PARAMS, IndexPointCost()
    )
    assert result.trades == []
    assert result.counts["crosses"] == 0
    assert result.sessions == 0
    assert result.sessions_without_volume == 1


def test_volumeless_sessions_are_reported_not_hidden():
    """A skipped session that is not counted is indistinguishable from a
    session that produced no signal, and the difference is the whole result."""
    mixed = DESIGNED + [{**c, "vol": 0} for c in _bars(_designed_session(), day="2026-08-18")]
    result = run_vwap_cross_backtest(mixed, TEST_PARAMS, IndexPointCost())
    assert result.sessions == 1
    assert result.sessions_without_volume == 1


def test_the_period_reports_what_was_replayed_not_what_was_loaded():
    """Naming the archive's span next to a count of volumed sessions would
    imply years of evidence behind however much of it was usable."""
    mixed = [{**c, "vol": 0} for c in _bars(_designed_session(), day="2026-08-14")] + DESIGNED
    result = run_vwap_cross_backtest(mixed, TEST_PARAMS, IndexPointCost())
    assert result.period == ("2026-08-17", "2026-08-17")


def test_vwap_restarts_each_session_but_ema_does_not():
    """VWAP is anchored to the bell and EMA is carried across it. Resetting
    both would measure a different cross than the one on the screen."""
    day_one = _bars([(100, 101, 99, 100)] * 40, day="2026-08-17")
    day_two = _bars([(200, 201, 199, 200)] * 40, day="2026-08-18")

    assert _running_vwap(day_two)[0] == pytest.approx(200, abs=0.5)

    both = ema([r["c"] for r in day_one + day_two], 9)
    assert both[39] == pytest.approx(100, abs=0.01)   # settled through day one
    # First bar of day two: pulled a fifth of the way at k = 2/(9+1), not
    # restarted at the new price. A per-session EMA would read 200 here.
    assert both[40] == pytest.approx(120, abs=0.01)
    assert both[-1] == pytest.approx(200, abs=1)      # and converged after


# ── the replay ─────────────────────────────────────────────────────────────

def test_the_designed_session_produces_the_expected_crosses():
    result = run_vwap_cross_backtest(DESIGNED, TEST_PARAMS, IndexPointCost())
    assert result.counts["crosses"] == 2
    assert len(result.trades) == 1
    assert result.trades[0].direction == LONG


def test_entry_is_the_open_of_the_bar_after_the_cross():
    """The cross is only known once its bar has closed, so the fill cannot be
    on that bar. This is the difference between a testable rule and a
    backtest that buys at a price it could not have known."""
    result = run_vwap_cross_backtest(DESIGNED, TEST_PARAMS, IndexPointCost())
    trade = result.trades[0]
    fills = {b["t"]: b["o"] for b in DESIGNED}
    assert trade.entry == fills[trade.entry_time]

    signal_bar = next(i for i, b in enumerate(DESIGNED) if b["t"] == trade.entry_time) - 1
    assert trade.ema_at_signal == pytest.approx(
        ema([r["c"] for r in DESIGNED], 9)[signal_bar], abs=0.01
    )


def test_the_target_never_uses_a_high_that_had_not_printed():
    """The level is drawn from the lookback window ending at the signal. A
    target taken from the finished session is the classic way this strategy
    backtests well and trades badly."""
    result = run_vwap_cross_backtest(DESIGNED, TEST_PARAMS, IndexPointCost())
    trade = result.trades[0]
    signal_bar = next(i for i, b in enumerate(DESIGNED) if b["t"] == trade.entry_time) - 1
    window = DESIGNED[max(0, signal_bar + 1 - TEST_PARAMS.sr_lookback): signal_bar + 1]
    assert trade.target == pytest.approx(max(b["h"] for b in window), abs=0.01)


def test_the_stop_sits_one_stop_width_from_entry_on_the_losing_side():
    result = run_vwap_cross_backtest(DESIGNED, TEST_PARAMS, IndexPointCost())
    trade = result.trades[0]
    assert trade.stop == pytest.approx(trade.entry - TEST_PARAMS.stop_pts)
    assert trade.stop < trade.entry < trade.target


def test_the_reward_risk_gate_is_what_refuses_the_other_cross():
    """The finding this whole replay exists to report. Dropping the gate takes
    the trade the gate refused, so the count moves for a stated reason."""
    gated = run_vwap_cross_backtest(DESIGNED, TEST_PARAMS, IndexPointCost())
    assert gated.counts["skipped_rr"] == 1

    ungated = run_vwap_cross_backtest(
        DESIGNED, VwapCrossParams(min_session_bars=5, stop_pts=20.0, min_rr=0.0),
        IndexPointCost(),
    )
    assert ungated.counts["skipped_rr"] == 0
    assert len(ungated.trades) == 2
    assert {t.direction for t in ungated.trades} == {LONG, SHORT}


def test_every_taken_trade_clears_the_gate_it_was_measured_under():
    result = run_vwap_cross_backtest(DESIGNED, TEST_PARAMS, IndexPointCost())
    for trade in result.trades:
        reward = abs(trade.target - trade.entry)
        assert reward >= TEST_PARAMS.stop_pts * TEST_PARAMS.min_rr


def test_sides_filter_counts_the_cross_it_declines():
    """A one-sided run must still see both crosses, or the denominator moves
    with the variant and the rows stop being comparable."""
    longs = run_vwap_cross_backtest(
        DESIGNED, VwapCrossParams(min_session_bars=5, stop_pts=20.0, min_rr=0.0, sides=LONG),
        IndexPointCost(),
    )
    assert longs.counts["crosses"] == 2
    assert longs.counts["skipped_side"] == 1
    assert [t.direction for t in longs.trades] == [LONG]


def test_warmup_ignores_crosses_against_an_unsettled_vwap():
    """VWAP over two bars is not an average. Whatever the first bars do, they
    do not produce trades."""
    result = run_vwap_cross_backtest(
        DESIGNED,
        VwapCrossParams(min_session_bars=5, stop_pts=20.0, min_rr=0.0, warmup_bars=25),
        IndexPointCost(),
    )
    assert result.counts["crosses"] == 0
    assert result.trades == []


def test_a_short_session_is_not_replayed_at_all():
    """A half-day with 12 bars is not evidence about an intraday strategy."""
    result = run_vwap_cross_backtest(DESIGNED[:12], VwapCrossParams(), IndexPointCost())
    assert result.sessions == 0
    assert result.trades == []


def test_a_mirrored_session_gives_the_mirrored_trade():
    """The rules are symmetric, so the measurement must be. An asymmetry here
    is a bug in one branch, not an edge in one direction."""
    pivot = 50_000.0
    mirrored = [
        {**c, "o": pivot - c["o"], "h": pivot - c["l"],
         "l": pivot - c["h"], "c": pivot - c["c"]}
        for c in DESIGNED
    ]
    original = run_vwap_cross_backtest(DESIGNED, TEST_PARAMS, IndexPointCost())
    flipped = run_vwap_cross_backtest(mirrored, TEST_PARAMS, IndexPointCost())

    assert len(flipped.trades) == len(original.trades)
    for here, there in zip(original.trades, flipped.trades):
        assert there.direction != here.direction
        assert there.entry == pytest.approx(pivot - here.entry)
        assert there.gross_pts == pytest.approx(here.gross_pts)


# ── against real bars ──────────────────────────────────────────────────────

@pytest.fixture(scope="module")
def archive():
    rows = CandleStore().read("NIFTY", "INDEX", "5m", limit=8000)
    if len(rows) < 2000:
        pytest.skip("run `python -m engine.cli sync` first")
    return candles_to_dicts(rows)


def test_it_survives_the_real_archive(archive):
    result = run_vwap_cross_backtest(archive, VwapCrossParams(), IndexPointCost())
    assert result.sessions > 20
    assert result.counts["crosses"] > 0
    for t in result.trades:
        if t.direction == SHORT:
            assert t.stop > t.entry > t.target
        else:
            assert t.stop < t.entry < t.target
        assert t.status in ("target", "stop", "squareoff")
        assert t.exit_time >= t.entry_time
        assert t.risk == pytest.approx(VwapCrossParams().stop_pts, abs=0.01)


def test_only_one_position_is_ever_open(archive):
    """Trades within a session must not overlap. Two open at once would double
    the risk the strategy claims to take and inflate the trade count."""
    result = run_vwap_cross_backtest(archive, VwapCrossParams(), IndexPointCost())
    by_day: dict[str, list] = {}
    for t in result.trades:
        by_day.setdefault(t.date, []).append(t)
    for day, trades in by_day.items():
        for earlier, later in zip(trades, trades[1:]):
            assert later.entry_time >= earlier.exit_time, day


def test_no_trade_is_carried_overnight(archive):
    """The rules are intraday. A position held to the next session would be
    graded against a gap the strategy never agreed to take."""
    result = run_vwap_cross_backtest(archive, VwapCrossParams(), IndexPointCost())
    for t in result.trades:
        assert t.exit_time <= "15:30"


def test_exits_land_on_a_level_or_a_close(archive):
    """Every exit is the stop, the target, or a bar's close at square-off.
    Any other price means the replay invented a fill."""
    result = run_vwap_cross_backtest(archive, VwapCrossParams(), IndexPointCost())
    for t in result.trades:
        if t.status == "target":
            assert t.exit_price == pytest.approx(t.target)
        elif t.status == "stop":
            assert t.exit_price == pytest.approx(t.stop)


def test_the_counts_account_for_every_cross(archive):
    """Crosses seen must equal trades plus each stated reason for refusal.
    A cross that vanishes without a reason is a silent filter."""
    result = run_vwap_cross_backtest(archive, VwapCrossParams(), IndexPointCost())
    c = result.counts
    refused = (c["skipped_open"] + c["skipped_side"] + c["skipped_level"]
               + c["skipped_rr"] + c["skipped_time"])
    assert c["crosses"] == len(result.trades) + refused


def test_the_gate_refuses_a_large_share_of_crosses(archive):
    """The headline finding, pinned. A 20-point stop against a target at the
    nearest level is often under 1:1, so the gate does most of the work. If
    this ratio collapses, the reported result no longer means what it says."""
    result = run_vwap_cross_backtest(archive, VwapCrossParams(), IndexPointCost())
    assert result.counts["skipped_rr"] / result.counts["crosses"] > 0.2


def test_widening_the_stop_cannot_reduce_the_share_the_gate_refuses(archive):
    """A wider stop needs a proportionally further target, so the gate must
    bite at least as hard. This is the trap in "just use a wider stop"."""
    def refused(stop: float) -> float:
        r = run_vwap_cross_backtest(
            archive, VwapCrossParams(stop_pts=stop), IndexPointCost()
        )
        return r.counts["skipped_rr"] / r.counts["crosses"]

    assert refused(60.0) >= refused(20.0)


def test_the_replay_is_not_wired_into_signal_generation():
    """Over the 246 sessions that carry volume the cross returns −3.71 index
    points a trade before costs and −9.71 after, positive in neither year and
    in no variant that survives dropping its best three trades. If a future
    change writes it into the rules, this fails and asks for the backtest to be
    redone first.

    The cross is a tempting thing to wire in precisely because it is so widely
    traded and so easy to compute. Being popular is not evidence, and this is
    the test that says so.
    """
    import re
    from pathlib import Path

    root = Path(__file__).resolve().parents[1]
    imports = re.compile(
        r"^\s*(from\s+\S*vwap_cross\S*\s+import|import\s+\S*\bvwap_cross\w*\b)",
        re.MULTILINE,
    )
    for name in ("core/suggestion.py", "core/signals.py", "core/indicators.py",
                 "live/runner.py", "backtest/replay.py"):
        found = imports.search((root / name).read_text())
        assert not found, (
            f"{name} imports the vwap_cross replay ({found.group(0).strip()!r}). "
            "It does not pay after costs — redo the backtest before wiring it in."
        )


def test_the_panel_is_not_wired_into_the_tradeable_call():
    """The browser half of the same guard. `page.js` may import the panel —
    that is the point of it — but the modules that build the BUY/SELL card must
    not, or a rule that loses 9.71 points a trade starts voting on the one call
    the app presents as tradeable.
    """
    import re
    from pathlib import Path

    lib = Path(__file__).resolve().parents[2] / "app" / "lib"
    imports = re.compile(r"""^\s*import\s[^;]*['"]\./vwapCross['"]""", re.MULTILINE)
    for name in ("suggestion.js", "signals.js", "strategies.js", "indicators.js"):
        found = imports.search((lib / name).read_text())
        assert not found, (
            f"app/lib/{name} imports vwapCross. It does not pay after costs — "
            "redo the backtest before wiring it into the call."
        )


def test_the_grid_varies_the_delta_the_stop_rests_on(archive):
    """The rupee stop is only a point stop through an assumed delta, so the
    grid has to show the answer at more than one delta."""
    names = [name for name, _ in default_grid(VwapCrossParams())]
    assert "stop @ delta 0.40" in names
    assert "stop @ delta 0.60" in names
    assert "no R:R gate" in names

    stops = {p.stop_pts for _, p in default_grid(VwapCrossParams())}
    assert len(stops) > 1
