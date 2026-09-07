"""The EMA/VWAP cross must read identically in both languages.

The panel renders this from `app/lib/vwapCross.js` and the backtest measures it
from `engine/core/vwap_cross.py`. If they drift, the screen shows a cross the
replay never priced, and the expectancy printed under the panel stops applying
to the signal above it.

The zero-volume case is tested as carefully as the signal itself. Both sides
have to refuse rather than average closes into something VWAP-shaped, and both
have to refuse for the same reason string — that text is what the UI shows the
user instead of a direction.
"""
from __future__ import annotations

import pytest

from engine.core import vwap_cross as vc
from engine.core.indicators import candles_to_dicts
from engine.core.smc import group_sessions
from engine.data import CandleStore
from engine.tests.jsbridge import call_js, diff, node_available

pytestmark = pytest.mark.skipif(not node_available(), reason="node not installed")


def _check(js, py):
    problems = diff(js, py, tol=0.0)
    assert not problems, "\n".join(problems[:25])


@pytest.fixture(scope="module")
def volumed() -> list[dict]:
    """5-minute bars ending inside a session that actually carries volume.

    Not simply "the most recent 400 bars": the feed supplies volume only for
    2025-07 to 2026-07, so a naive tail lands on zero-volume bars and both
    languages agree on `available: false` — parity holds while testing none of
    the arithmetic. This truncates to the last fully volumed session so the
    signal path is the one being diffed.
    """
    rows = candles_to_dicts(CandleStore().read("NIFTY", "INDEX", "5m", limit=8000))
    if len(rows) < 1000:
        pytest.skip("run `python -m engine.cli sync` first")

    sessions = group_sessions(rows)
    good = [bars for _, bars in sessions
            if len(bars) > 40 and all((c.get("vol") or 0) > 0 for c in bars)]
    if not good:
        pytest.skip("no volumed session archived — run `python -m engine.cli sync`")

    end = rows.index(good[-1][-1]) + 1
    return rows[max(0, end - 400):end]


@pytest.fixture(scope="module")
def volumeless(volumed) -> list[dict]:
    return [{**c, "vol": 0} for c in volumed]


def test_stop_points_conversion():
    for delta in (0.40, 0.52, 0.60):
        _check(call_js("vwapCross", "stopPoints", 800, 75, delta),
               vc.stop_points(800, 75, delta))


@pytest.mark.parametrize(
    "prev_ema,prev_vwap,now_ema,now_vwap",
    [
        (10, 12, 13, 12),      # bullish cross
        (13, 12, 10, 12),      # bearish cross
        (10, 12, 11, 12),      # stayed below
        (13, 12, 14, 12),      # stayed above
        (10, 12, 12, 12),      # touched exactly from below
        (14, 12, 12, 12),      # touched exactly from above
    ],
)
def test_cross_direction(prev_ema, prev_vwap, now_ema, now_vwap):
    _check(call_js("vwapCross", "crossDirection", prev_ema, prev_vwap, now_ema, now_vwap),
           vc.cross_direction(prev_ema, prev_vwap, now_ema, now_vwap))


def test_session_vwaps(volumed):
    _check(call_js("vwapCross", "sessionVwaps", volumed[-40:]),
           vc.session_vwaps(volumed[-40:]))


def test_session_vwaps_refuses_a_volumeless_session(volumeless):
    """Every entry must be the null value, not a number. A JS `null` and a
    Python `None` diff as equal; a fabricated average would not."""
    py = vc.session_vwaps(volumeless[-40:])
    assert all(v is None for v in py)
    _check(call_js("vwapCross", "sessionVwaps", volumeless[-40:]), py)


def test_fully_volumed_agrees_across_languages(volumed, volumeless):
    """The backtest's data-quality filter, which is separate from the
    definition of VWAP and must not drift from it."""
    for session in (volumed[-40:], volumeless[-40:],
                    volumeless[-4:] + volumed[-4:]):
        _check(call_js("vwapCross", "fullyVolumed", session),
               vc.fully_volumed(session))


def test_a_padded_tail_does_not_blank_the_reading(volumed):
    """A zero-volume bar appended to a traded session leaves VWAP where it was,
    in both languages. Live feeds pad the tail this way."""
    padded = list(volumed) + [{**volumed[-1], "vol": 0}]
    py = vc.vwap_cross_signal(padded)
    assert py["available"] is True
    assert py["vwap"] == vc.vwap_cross_signal(volumed)["vwap"]
    _check(call_js("vwapCross", "vwapCrossSignal", padded), py)


def test_signal_on_real_bars(volumed):
    py = vc.vwap_cross_signal(volumed)
    # Guards the fixture as much as the code: if this series stopped carrying
    # volume, every assertion below would pass against the refusal branch and
    # the arithmetic would go untested.
    assert py["available"] is True, py.get("reason")
    _check(call_js("vwapCross", "vwapCrossSignal", volumed), py)


def test_signal_refuses_without_volume(volumeless):
    """Including the reason string, which is what the panel displays."""
    py = vc.vwap_cross_signal(volumeless)
    assert py["available"] is False
    assert py["label"] == "NO VWAP"
    _check(call_js("vwapCross", "vwapCrossSignal", volumeless), py)


def test_signal_with_a_custom_stop(volumed):
    js = call_js("vwapCross", "vwapCrossSignal", volumed, {"stopPts": 40, "minRr": 2.0})
    _check(js, vc.vwap_cross_signal(volumed, stop_pts=40, min_rr=2.0))


def test_signal_on_a_short_series(volumed):
    _check(call_js("vwapCross", "vwapCrossSignal", volumed[:4]),
           vc.vwap_cross_signal(volumed[:4]))


def test_cross_indices_point_into_the_callers_array(volumed):
    """The chart draws markers at `index`, so it must count undated bars that
    were skipped. Both languages have to agree on the offset, or the panel and
    the chart disagree about which bar crossed."""
    padded = [{**volumed[0], "ts": None}] * 3 + list(volumed)
    py = vc.vwap_cross_signal(padded)
    plain = vc.vwap_cross_signal(volumed)
    assert py["crossesToday"] == plain["crossesToday"]
    for shifted, original in zip(py["crosses"], plain["crosses"]):
        assert shifted["index"] == original["index"] + 3

    _check(call_js("vwapCross", "vwapCrossSignal", padded), py)
