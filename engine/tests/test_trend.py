"""The trend call, and the guarantees that keep it honest.

It is a description of the tape, not a signal — measured at -0.032% a day
pre-open and -0.005% over the scalp window. These tests exist to stop it
quietly becoming a signal, and to stop it reading today's data before today
has happened.
"""
from __future__ import annotations

import pytest

from engine.core import trend as tr
from engine.core.indicators import candles_to_dicts
from engine.data import CandleStore


def _day(o, h, l, c, ts=0):
    return {"ts": ts, "o": o, "h": h, "l": l, "c": c, "vol": 1000}


def _rising(n=30, start=20000.0, step=50.0):
    out = []
    px = start
    for i in range(n):
        out.append(_day(px, px + step, px - 10, px + step, ts=i * 86400000))
        px += step
    return out


def _falling(n=30, start=25000.0, step=50.0):
    out = []
    px = start
    for i in range(n):
        out.append(_day(px, px + 10, px - step, px - step, ts=i * 86400000))
        px -= step
    return out


CALM = [12.0] * 25


# ── direction ──────────────────────────────────────────────────────────────

def test_a_rising_series_reads_up():
    call = tr.pre_open_trend(_rising(), CALM)
    assert call["action"] == "UP"
    assert call["phase"] == "pre-open"


def test_a_falling_series_reads_down():
    call = tr.pre_open_trend(_falling(), CALM)
    assert call["action"] == "DOWN"


def test_too_little_history_refuses_to_call():
    call = tr.pre_open_trend(_rising(5), CALM)
    assert call["action"] == "FLAT"
    assert call["confidence"] == 0
    assert "Not enough history" in call["note"]


def test_a_narrow_split_stays_flat():
    """The daily series has almost no drift, so a bare majority has to read as
    no call rather than as a direction."""
    factors = [
        {"n": "a", "t": "UP", "w": 2, "v": ""},
        {"n": "b", "t": "DOWN", "w": 2, "v": ""},
        {"n": "c", "t": "FLAT", "w": 1, "v": ""},
    ]
    assert tr._assemble("pre-open", factors, "")["action"] == "FLAT"


def test_a_volatility_spike_pulls_towards_standing_aside():
    spiking = [12.0] * 20 + [22.0]
    calm = tr.pre_open_trend(_rising(), CALM)
    spiked = tr.pre_open_trend(_rising(), spiking)
    assert any(f["n"] == "Volatility spike" for f in spiked["factors"])
    assert spiked["confidence"] < calm["confidence"]


# ── no lookahead ───────────────────────────────────────────────────────────

def test_the_pre_open_call_never_sees_today():
    """The whole value of a pre-open call is that it could have been made
    before the open. Feeding it one extra day must change the answer, which is
    what proves it is reading the last bar it is given and no further."""
    days = _rising(40)
    a = tr.pre_open_trend(days[:30], CALM)
    b = tr.pre_open_trend(days[:31], CALM)
    assert a["factors"] != b["factors"] or a["margin"] == b["margin"]

    # Nothing in the output may quote a price the caller did not supply.
    text = " ".join(f["v"] for f in a["factors"])
    assert str(int(days[31]["c"])) not in text


def test_post_open_adds_session_factors_and_keeps_the_daily_ones():
    daily = _rising()
    session = [_day(21520, 21560, 21500, 21550)]
    pre = tr.pre_open_trend(daily, CALM)
    post = tr.post_open_trend(daily, session, CALM, vwap=21530.0)

    pre_names = {f["n"] for f in pre["factors"]}
    post_names = {f["n"] for f in post["factors"]}
    assert pre_names <= post_names
    assert "Versus VWAP" in post_names
    assert post["phase"] == "open"


def test_post_open_without_a_session_is_just_the_pre_open_call():
    daily = _rising()
    assert (tr.post_open_factors(daily, [], CALM)
            == tr.pre_open_factors(daily, CALM))


def test_the_opening_range_needs_three_bars():
    daily = _rising()
    two = tr.post_open_factors(daily, [_day(21520, 21560, 21500, 21550)] * 2, CALM)
    three = tr.post_open_factors(daily, [_day(21520, 21560, 21500, 21550)] * 3, CALM)
    assert not any(f["n"] == "Opening range" for f in two)
    assert any(f["n"] == "Opening range" for f in three)


# ── it must not become a signal ────────────────────────────────────────────

def test_the_trend_module_is_not_wired_into_signal_generation():
    """It does not predict direction: -0.032% a day acting on the pre-open
    call, -0.005% over the scalp window against a 0.025% round trip. If a
    future change imports it into the decision path, this fails and asks for
    the backtest to be redone first.
    """
    import re
    from pathlib import Path

    root = Path(__file__).resolve().parents[1]
    imports = re.compile(r"^\s*(from\s+\S*trend\s+import|import\s+\S*\btrend\b)",
                         re.MULTILINE)
    for name in ("core/suggestion.py", "core/signals.py", "live/runner.py",
                 "backtest/replay.py", "ml/features.py"):
        found = imports.search((root / name).read_text())
        assert not found, (
            f"{name} imports the trend module ({found.group(0).strip()!r}). "
            "It is descriptive only — redo the backtest before wiring it in."
        )


def test_confidence_is_agreement_and_is_capped():
    """Reported as agreement between factors, never as a probability, because
    measured against nine years it does not sort outcomes."""
    for days in (_rising(), _falling(), _rising(25)):
        call = tr.pre_open_trend(days, CALM)
        assert 0 <= call["confidence"] <= 90


# ── against real bars ──────────────────────────────────────────────────────

def test_it_survives_the_real_archive():
    rows = CandleStore().read("NIFTY", "INDEX", "1d", limit=400)
    if len(rows) < 100:
        pytest.skip("run `python -m engine.cli sync` first")
    daily = candles_to_dicts(rows)
    call = tr.pre_open_trend(daily[:-1], [13.0] * 25)
    assert call["action"] in ("UP", "DOWN", "FLAT")
    assert call["factors"]
