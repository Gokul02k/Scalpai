"""The smart-money setup, and the guarantees that keep the measurement honest.

Two kinds of test here. The first kind pins the definitions: a sweep has to
close back inside the pool, a break has to be a close, a swing is not a swing
until it is confirmed. The second kind pins the replay: nothing it decides may
depend on a bar that had not printed yet, because a strategy built on marking
levels on a finished chart backtests beautifully and cannot be traded.

The textbook session below is the sequence as it is taught — equal high swept,
structure broken, order block retested — so a change that stops the engine
recognising the setup at all fails loudly rather than quietly reporting fewer
trades.
"""
from __future__ import annotations

from datetime import datetime, timedelta

import pytest

from engine.backtest.costs import IndexPointCost
from engine.backtest.smc_replay import SmcParams, _Session, run_smc_backtest, summarize
from engine.core import smc
from engine.core.indicators import candles_to_dicts
from engine.core.smc import inherited_pools
from engine.data import CandleStore
from engine.data.timeutil import IST

OPEN = (9, 15)


def _bars(rows: list[tuple[float, float, float, float]], day: str = "2026-08-17") -> list[dict]:
    """Turn (o, h, l, c) tuples into 5-minute candles from the opening bell."""
    start = datetime.fromisoformat(f"{day}T{OPEN[0]:02d}:{OPEN[1]:02d}").replace(tzinfo=IST)
    out = []
    for i, (o, h, l, c) in enumerate(rows):
        ts = int((start + timedelta(minutes=5 * i)).timestamp() * 1000)
        out.append({"ts": ts, "o": o, "h": h, "l": l, "c": c, "vol": 1000,
                    "t": (start + timedelta(minutes=5 * i)).strftime("%H:%M")})
    return out


def _mirror(rows: list[dict], pivot: float = 50_000.0) -> list[dict]:
    """Reflect a session in price. A short setup becomes the identical long."""
    return [
        {**c, "o": pivot - c["o"], "h": pivot - c["l"], "l": pivot - c["h"], "c": pivot - c["c"]}
        for c in rows
    ]


#: Equal high at 25,118 swept to 25,136, structure broken through the 25,080
#: swing low, the last up candle (25,098-25,116) becomes supply, price retests
#: it and then runs to the previous day low.
TEXTBOOK = _bars([
    (25_100, 25_105, 25_090, 25_095),
    (25_095, 25_100, 25_085, 25_090),
    (25_090, 25_118, 25_088, 25_112),   # 2  swing high -> the pool
    (25_112, 25_114, 25_095, 25_100),
    (25_100, 25_106, 25_092, 25_096),
    (25_096, 25_100, 25_080, 25_084),   # 5  swing low -> the reference
    (25_084, 25_092, 25_082, 25_090),
    (25_090, 25_098, 25_088, 25_096),
    (25_096, 25_136, 25_094, 25_100),   # 8  sweep: through 25,118, closes below
    (25_100, 25_116, 25_098, 25_114),   # 9  order block, last up candle
    (25_114, 25_116, 25_040, 25_046),   # 10 displacement -> break of structure
    (25_046, 25_060, 25_024, 25_030),   # 11 leaves a fair value gap
    (25_030, 25_040, 25_020, 25_035),
    (25_035, 25_050, 25_030, 25_045),
    (25_045, 25_099, 25_040, 25_090),   # 14 retests the order block -> fill
    (25_090, 25_092, 25_020, 25_025),
    (25_025, 25_030, 24_980, 24_985),
    (24_985, 24_990, 24_940, 24_945),   # 17 target
    (24_945, 24_960, 24_930, 24_950),
])

#: Yesterday: high 25,200, low 24,950, close 25,150.
YESTERDAY = _bars([
    (25_150, 25_200, 25_100, 25_180),
    (25_180, 25_190, 24_950, 24_990),
    (24_990, 25_160, 24_980, 25_150),
], day="2026-08-14")


def _run(bars, previous=YESTERDAY, params=None, day="2026-08-17"):
    params = params or SmcParams()
    return _Session(day, bars, inherited_pools(previous), params).run()


# ── definitions ────────────────────────────────────────────────────────────

def test_a_swing_is_not_a_level_until_it_is_confirmed():
    """The last bars of any slice cannot be swings, however extreme. Marking
    them anyway is what makes this strategy backtest better than it trades."""
    highs = smc.swing_highs(TEXTBOOK, span=2)
    assert 2 in highs
    assert all(i <= len(TEXTBOOK) - 3 for i in highs)
    # The sweep bar prints the highest high of the session and is never a pool
    # while it is still the most recent bar.
    assert 8 not in smc.swing_highs(TEXTBOOK[:9], span=2)


def test_a_sweep_must_close_back_inside_the_pool():
    pool = smc.Pool(25_118, smc.BUYSIDE, "equal high", 2)
    assert smc.sweep_at(TEXTBOOK, 8, [pool]) is not None

    through = list(TEXTBOOK)
    through[8] = {**through[8], "c": 25_130}  # closed beyond it: a break, not a sweep
    assert smc.sweep_at(through, 8, [pool]) is None


def test_a_pool_cannot_be_swept_before_it_exists():
    later = smc.Pool(25_118, smc.BUYSIDE, "equal high", idx=9)
    assert smc.sweep_at(TEXTBOOK, 8, [later]) is None


def test_the_deepest_pool_wins_when_several_go_at_once():
    """Both are taken by the same bar; the deeper one is what the move was
    reaching for, the other was collateral."""
    shallow = smc.Pool(25_120, smc.BUYSIDE, "shallow", 2)
    deep = smc.Pool(25_105, smc.BUYSIDE, "deep", 2)
    assert smc.sweep_at(TEXTBOOK, 8, [shallow, deep]).pool is deep


def test_a_wick_through_the_reference_is_not_a_break():
    assert smc.broke({"c": 25_046}, 25_080, smc.SHORT)
    assert not smc.broke({"c": 25_084}, 25_080, smc.SHORT)


def test_the_order_block_is_the_last_opposing_candle():
    ob = smc.order_block(TEXTBOOK[:11], break_idx=10, direction=smc.SHORT, lookback=4)
    assert (ob.idx, ob.lo, ob.hi) == (9, 25_098, 25_116)


def test_the_fair_value_gap_is_a_real_void():
    gap = smc.fair_value_gap(TEXTBOOK[:12], 9, 10, smc.SHORT)
    assert (gap.lo, gap.hi) == (TEXTBOOK[11]["h"], TEXTBOOK[9]["l"])
    assert gap.height > 0


def test_the_stop_sits_beyond_the_sweep_not_just_the_block():
    """A stop tucked under the order block but inside the sweep's wick is
    parked exactly where the last lot of stops was just taken."""
    extreme = smc.protective_extreme(TEXTBOOK[:11], ob_idx=9, direction=smc.SHORT, span=2)
    assert extreme == 25_136


#: Higher high at 25,100 then 25,150, then a break down: the first break
#: against a rising market, which is a change of character rather than a
#: continuation of it.
RISING = _bars([
    (25_000, 25_010, 24_990, 25_005),
    (25_005, 25_020, 25_000, 25_015),
    (25_015, 25_100, 25_010, 25_090),   # 2  first peak
    (25_090, 25_095, 25_050, 25_055),
    (25_055, 25_060, 25_040, 25_050),
    (25_050, 25_070, 25_045, 25_065),
    (25_065, 25_150, 25_060, 25_140),   # 6  higher peak
    (25_140, 25_145, 25_100, 25_105),
    (25_105, 25_110, 25_080, 25_085),
    (25_085, 25_090, 25_020, 25_025),   # 9  breaks down
])


def test_break_kind_separates_continuation_from_reversal():
    assert smc.break_kind(RISING, 9, smc.SHORT) == "CHoCH"
    # Falling into the same break is the trend continuing, not turning.
    assert smc.break_kind(_mirror(RISING), 9, smc.SHORT) == "BOS"


# ── the setup, end to end ──────────────────────────────────────────────────

def test_the_textbook_session_produces_the_textbook_trade():
    trades = _run(TEXTBOOK)
    assert len(trades) == 1
    t = trades[0]
    assert t.direction == smc.SHORT
    assert t.entry == 25_098          # order block proximal edge
    assert t.stop == 25_141           # 5 pts beyond the 25,136 sweep high
    assert t.target == 24_950         # previous day low, the opposing pool
    assert t.status == "target"
    assert t.break_kind == "CHoCH"    # the session was making higher highs
    assert t.entry_time == "10:25"
    assert t.gross_pts == pytest.approx(148.0)
    assert t.r_multiple > 3


def test_the_same_session_mirrored_produces_the_mirrored_long():
    """Nothing in the rules should prefer a side. If the long path disagrees
    with the short path, one of them has a bug rather than an edge."""
    short = _run(TEXTBOOK)[0]
    long = _run(_mirror(TEXTBOOK), _mirror(YESTERDAY))[0]
    assert long.direction == smc.LONG
    assert long.entry == 50_000 - short.entry
    assert long.stop == 50_000 - short.stop
    assert long.target == 50_000 - short.target
    assert long.status == short.status


def test_a_stop_that_never_gets_hit_still_closes_at_square_off():
    flat = TEXTBOOK[:15] + _bars([(25_060, 25_070, 25_050, 25_060)] * 60)[15:]
    trades = _run(flat)
    assert trades and trades[0].status == "squareoff"
    assert trades[0].exit_time <= "15:20"


def test_an_ambiguous_bar_resolves_against_the_trade():
    """One 5-minute bar holding both the stop and the target cannot say which
    came first, so the loss is taken. The alternative quietly pays the strategy
    for bars the tape never gave it."""
    both = list(TEXTBOOK)
    both[15] = {**both[15], "h": 25_200, "l": 24_900}
    trades = _run(both)
    assert trades[0].status == "stop"


def test_a_setup_that_is_never_retested_is_never_traded():
    away = TEXTBOOK[:11] + _bars([(24_900, 24_910, 24_880, 24_890)] * 30)[11:]
    trades = _run(away)
    assert trades == []


# ── no lookahead ───────────────────────────────────────────────────────────

def test_the_trade_is_fixed_by_the_bars_that_had_printed():
    """Truncating the session after entry must not move entry, stop or target.
    If it does, the levels were being read off bars the trader had not seen."""
    full = _run(TEXTBOOK)[0]
    for cut in range(15, len(TEXTBOOK)):
        partial = _run(TEXTBOOK[:cut])
        assert partial, f"no trade when truncated at {cut}"
        assert (partial[0].entry, partial[0].stop, partial[0].target) == (
            full.entry, full.stop, full.target
        )


def test_a_session_cannot_trade_before_its_setup_exists():
    for cut in range(1, 15):
        assert _run(TEXTBOOK[:cut]) == []


def test_extending_the_session_never_rewrites_a_closed_trade():
    closed = _run(TEXTBOOK)[0]
    extended = _run(TEXTBOOK + _bars([(24_950, 25_400, 24_900, 25_380)] * 5)[19:])[0]
    assert (extended.exit_price, extended.status) == (closed.exit_price, closed.status)


# ── it must not become a signal ────────────────────────────────────────────

def test_the_smc_modules_are_not_wired_into_signal_generation():
    """Over 2,228 sessions the setup returns −0.62 index points a trade before
    costs and −6.62 after, in none of ten years positive and in none of thirteen
    variants. If a future change writes it into the rules, this fails and asks
    for the backtest to be redone first.

    `ml/features.py` is deliberately not on this list. Handing the structure to
    a model as a column is a different act from hand-writing it into the
    decision: the model is scored out of sample against a run with those columns
    zeroed, and if they add nothing they come back out. A rule in
    `signals.py` gets no such audit, which is why it is forbidden here.
    """
    import re
    from pathlib import Path

    root = Path(__file__).resolve().parents[1]
    imports = re.compile(r"^\s*(from\s+\S*smc\S*\s+import|import\s+\S*\bsmc\w*\b)", re.MULTILINE)
    for name in ("core/suggestion.py", "core/signals.py", "core/indicators.py",
                 "live/runner.py", "backtest/replay.py"):
        found = imports.search((root / name).read_text())
        assert not found, (
            f"{name} imports the smc module ({found.group(0).strip()!r}). "
            "It does not pay after costs — redo the backtest before wiring it in."
        )


def test_the_smart_money_columns_are_off_by_default():
    """They left out-of-sample AUC unchanged and made the most recent fold
    worse, so the production layout must not carry them — the saved filter is
    fit on the v1 columns and `load_model` refuses anything else."""
    from engine.ml import features as ft

    assert ft.FEATURE_NAMES == ft._V1_FEATURE_NAMES
    assert not any(name.startswith("smc_") for name in ft.FEATURE_NAMES)


def test_the_research_flag_appends_and_restores_the_columns():
    """Appending is safe; inserting anywhere else silently invalidates every
    saved model, so the splice has to land at the end and come back out."""
    from engine.ml import features as ft
    from engine.ml.smc_features import SMC_FEATURE_NAMES

    baseline = list(ft.FEATURE_NAMES)
    try:
        spliced = ft.use_smc_columns(True)
        assert spliced[: len(baseline)] == baseline
        assert spliced[len(baseline):] == SMC_FEATURE_NAMES
        assert len(set(spliced)) == len(spliced)
    finally:
        ft.use_smc_columns(False)
    assert ft.FEATURE_NAMES == baseline


def test_smc_features_are_causal_and_shaped_like_the_column_list():
    from engine.ml.smc_features import SMC_FEATURE_NAMES, smc_context

    # Cut three bars after the sweep, before the drop sweeps lows of its own:
    # the features describe the latest structure, not the most memorable.
    window = YESTERDAY + TEXTBOOK[:12]
    context = smc_context(window, "SELL", 25_050.0)
    assert set(context) == set(SMC_FEATURE_NAMES)

    # The buy-side sweep agrees with a short and opposes a long.
    assert (context["smc_sweep_agrees"], context["smc_sweep_age"]) == (1.0, 3.0)
    assert smc_context(window, "BUY", 25_050.0)["smc_sweep_agrees"] == -1.0
    assert context["smc_break_agrees"] == 1.0

    # Nothing may be reported from a session that has not printed the sweep yet.
    early = smc_context(YESTERDAY + TEXTBOOK[:6], "SELL", 25_090.0)
    assert early["smc_sweep_age"] == -1.0
    assert early["smc_break_agrees"] == 0.0


def test_smc_features_read_the_previous_day_from_the_window():
    from engine.ml.smc_features import smc_context

    context = smc_context(YESTERDAY + TEXTBOOK, "SELL", 25_000.0)
    assert context["smc_pdh_dist_pct"] == pytest.approx((25_200 - 25_000) / 25_000 * 100)
    assert context["smc_pdl_dist_pct"] == pytest.approx((25_000 - 24_950) / 25_000 * 100)
    # With no previous session in the window there is nothing to inherit.
    assert smc_context(TEXTBOOK, "SELL", 25_000.0)["smc_pdh_dist_pct"] == 0.0


# ── accounting ─────────────────────────────────────────────────────────────

def test_costs_come_off_every_trade():
    trades = _run(TEXTBOOK)
    stats = summarize(trades, IndexPointCost(points_per_round_trip=6.0))
    assert stats["expectancyNetPts"] == pytest.approx(stats["expectancyGrossPts"] - 6.0)


def test_a_rupee_cost_model_is_refused():
    from engine.backtest.costs import OptionBuyCost

    with pytest.raises(ValueError, match="index points"):
        summarize(_run(TEXTBOOK), OptionBuyCost())


# ── against real bars ──────────────────────────────────────────────────────

def test_it_survives_the_real_archive():
    rows = CandleStore().read("NIFTY", "INDEX", "5m", limit=4000)
    if len(rows) < 1000:
        pytest.skip("run `python -m engine.cli sync` first")

    result = run_smc_backtest(candles_to_dicts(rows), SmcParams(), IndexPointCost())
    assert result.sessions > 5
    for t in result.trades:
        if t.direction == smc.SHORT:
            assert t.stop > t.entry > t.target
        else:
            assert t.stop < t.entry < t.target
        assert t.status in ("target", "stop", "squareoff")
        if t.status in ("target", "stop"):
            assert t.exit_price == pytest.approx(
                t.target if t.status == "target" else t.stop
            )
        assert t.entry_time <= t.exit_time
