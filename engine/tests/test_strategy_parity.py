"""Parity for the decision path: signals -> vote -> levels -> log -> grading.

The indicator tests prove the inputs match. These prove the strategy built on
top of them makes the same calls, which is the property the backtest depends on.
"""
from __future__ import annotations

import pytest

from engine.core import indicators as ind
from engine.core import signal_log as slog
from engine.core import signals as sig
from engine.core import suggestion as sug
from engine.data import CandleStore
from engine.tests.jsbridge import call_js, diff, node_available

pytestmark = pytest.mark.skipif(not node_available(), reason="node not installed")

SETTINGS = {
    "riskLimit": 10000,
    "profitPct": 1.5,
    "slPct": 0.8,
    "ind": {"rsi": True, "macd": True, "bb": True, "ema20": True, "ema50": True, "vol": True},
}


@pytest.fixture(scope="module")
def candles() -> list[dict]:
    rows = CandleStore().read("NIFTY", "INDEX", "5m", limit=600)
    if len(rows) < 200:
        pytest.skip("run `python -m engine.cli sync` first")
    return ind.candles_to_dicts(rows)


@pytest.fixture(scope="module")
def analysis(candles) -> dict:
    return ind.analyze_from_candles(candles)


def _check(js, py):
    problems = diff(js, py)
    assert not problems, "\n".join(problems[:25])


# ── signals.js ─────────────────────────────────────────────────────────────

def test_generate_index_signals(analysis, candles):
    price = candles[-1]["c"]
    _check(
        call_js("signals", "generateIndexSignals", analysis, price, "NIFTY", SETTINGS),
        sig.generate_index_signals(analysis, price, "NIFTY", SETTINGS),
    )


def test_generate_portfolio_signals():
    portfolio = [
        {"id": 1, "name": "RELIANCE", "qty": 10, "buy": 1400, "cur": 1329, "sector": "Energy"},
        {"id": 2, "name": "TCS", "qty": 5, "buy": 3000, "cur": 3100, "sector": "IT"},
        {"id": 3, "name": "INFY", "qty": 8, "buy": 1500, "cur": 1480, "sector": "IT"},
        {"id": 4, "name": "HDFCBANK", "qty": 3, "buy": 1600, "cur": 1400, "sector": "Bank"},
    ]
    _check(
        call_js("signals", "generatePortfolioSignals", portfolio, SETTINGS),
        sig.generate_portfolio_signals(portfolio, SETTINGS),
    )


# ── suggestion.js ──────────────────────────────────────────────────────────

@pytest.mark.parametrize("mode", ["scalp", "swing", "longterm"])
@pytest.mark.parametrize("instrument", ["NIFTY", "BANKNIFTY"])
def test_build_unified_suggestion(analysis, candles, mode, instrument):
    """Covers the nifty_scalp branch, which changes which factors are counted."""
    price = candles[-1]["c"]
    idx_signals = sig.generate_index_signals(analysis, price, instrument, SETTINGS)
    _check(
        call_js(
            "suggestion", "buildUnifiedSuggestion",
            {
                "analysis": analysis, "price": price, "chgPct": 0.42,
                "indexSignals": idx_signals, "settings": SETTINGS,
                "mode": mode, "instrument": instrument,
            },
        ),
        sug.build_unified_suggestion(
            analysis, price, 0.42, idx_signals, SETTINGS, mode, instrument
        ),
    )


@pytest.mark.parametrize("chg", [-2.0, -0.6, -0.4, 0.0, 0.4, 0.6, 2.0])
def test_vote_threshold_edges(analysis, candles, chg):
    """The +/-0.5 change-percent kicker sits right on the vote threshold."""
    price = candles[-1]["c"]
    _check(
        call_js(
            "suggestion", "buildUnifiedSuggestion",
            {"analysis": analysis, "price": price, "chgPct": chg, "indexSignals": [],
             "settings": SETTINGS, "mode": "scalp", "instrument": "NIFTY"},
        ),
        sug.build_unified_suggestion(analysis, price, chg, [], SETTINGS, "scalp", "NIFTY"),
    )


def test_get_overall_suggestion_shape(analysis):
    """Sanity check that the ported vote agrees on direction with v1's simpler
    scorer over a walk of historical states."""
    js = call_js("suggestion", "getOverallSuggestion", analysis, 0.3)
    assert js["action"] in ("BUY", "SELL", "HOLD", "WAIT")


def test_score_fundamentals():
    for f in [
        None,
        {},
        {"trailingPE": 12.4, "priceToBook": 1.1, "returnOnEquity": 18.2,
         "profitMargins": 16.0, "debtToEquity": 22.0, "earningsGrowth": 14.0,
         "revenueGrowth": 11.0, "pegRatio": 0.8, "targetMeanPrice": 1600.0,
         "recommendationKey": "buy"},
        {"trailingPE": 55.0, "priceToBook": 12.0, "returnOnEquity": 3.0,
         "profitMargins": -4.0, "debtToEquity": 210.0, "earningsGrowth": -15.0,
         "revenueGrowth": -8.0, "targetMeanPrice": 1100.0,
         "recommendationKey": "underperform"},
    ]:
        _check(
            call_js("suggestion", "scoreFundamentals", f, 1329.0),
            sug.score_fundamentals(f, 1329.0),
        )


@pytest.mark.parametrize("mode", ["swing", "longterm"])
def test_get_portfolio_suggestion(analysis, mode):
    """The equity swing track's decision function."""
    stock = {"name": "RELIANCE", "qty": 10, "buy": 1400, "cur": 1329, "prev": 1340}
    quote = {"current": 1329.0, "changePercent": -0.82}
    news = [
        {"headline": "Refining margins improve", "sentiment": "positive"},
        {"headline": "Retail arm sees slower growth", "sentiment": "negative"},
        {"headline": "Telecom ARPU rises", "sentiment": "positive"},
    ]
    fundamentals = {
        "trailingPE": 22.4, "priceToBook": 1.9, "returnOnEquity": 12.0,
        "profitMargins": 8.5, "debtToEquity": 65.0, "earningsGrowth": 6.0,
        "revenueGrowth": 12.0, "targetMeanPrice": 1550.0, "recommendationKey": "buy",
    }
    _check(
        call_js(
            "suggestion", "getPortfolioSuggestion",
            {"stock": stock, "analysis": analysis, "newsItems": news, "quote": quote,
             "fundamentals": fundamentals, "settings": SETTINGS, "mode": mode},
        ),
        sug.get_portfolio_suggestion(
            stock, analysis, news, quote, fundamentals, SETTINGS, mode
        ),
    )


# ── signalLog.js ───────────────────────────────────────────────────────────

def _entry(action="BUY", ts="2026-08-12T04:15:00.000Z", conf=84, entry=24400.0,
           target=24560.0, stop=24300.0, price=24400.0):
    return {
        "id": f"x-{action}-{ts}", "ts": ts, "firstTs": ts, "action": action,
        "confidence": conf, "peakConfidence": conf, "instrument": "NIFTY",
        "entry": entry, "target": target, "stopLoss": stop, "price": price,
        "time": "09:45:00 am", "updates": 1,
    }


def test_decide_signal_log():
    base = _entry()
    cases = [
        (None, _entry()),
        (base, _entry(action="SELL")),
        (base, _entry(ts="2026-08-12T04:50:00.000Z")),           # outside session window
        (base, _entry(ts="2026-08-12T04:25:00.000Z", conf=84)),  # identical -> skip
        (base, _entry(ts="2026-08-12T04:25:00.000Z", conf=88)),  # higher -> update
        (base, _entry(ts="2026-08-12T04:25:00.000Z", conf=81)),  # changed -> update
    ]
    for last, nxt in cases:
        _check(call_js("signalLog", "decideSignalLog", last, nxt),
               slog.decide_signal_log(last, nxt))


def test_is_loggable():
    for conf in (0, 65, 79, 80, 81, 95):
        for action in ("BUY", "SELL", "HOLD", "WAIT"):
            call = {"action": action, "confidence": conf}
            _check(call_js("signalLog", "isLoggableNiftySignal", call),
                   slog.is_loggable_nifty_signal(call))


def test_apply_nifty_log_update():
    logs = [_entry()]
    for nxt in (_entry(action="SELL", ts="2026-08-12T04:20:00.000Z"),
                _entry(ts="2026-08-12T04:25:00.000Z", conf=88),
                _entry(ts="2026-08-12T04:25:00.000Z", conf=84)):
        _check(call_js("signalLog", "applyNiftyLogUpdate", logs, nxt),
               slog.apply_nifty_log_update(logs, nxt))


def test_evaluate_signal_outcome(candles):
    """Grading against the real price path, including the both-hit-in-one-bar
    case where the stop must win."""
    now_ms = candles[-1]["ts"] + 60_000
    base_ts = candles[max(0, len(candles) - 120)]["ts"]
    from datetime import datetime, timezone
    iso = datetime.fromtimestamp(base_ts / 1000, tz=timezone.utc).strftime(
        "%Y-%m-%dT%H:%M:%S.000Z"
    )
    ref = candles[max(0, len(candles) - 120)]["c"]

    for action in ("BUY", "SELL"):
        for tgt_off, stop_off in ((120, 80), (30, 300), (500, 40), (60, 60)):
            e = _entry(
                action=action, ts=iso,
                entry=ref,
                target=ref + tgt_off if action == "BUY" else ref - tgt_off,
                stop=ref - stop_off if action == "BUY" else ref + stop_off,
                price=ref,
            )
            _check(
                call_js("signalLog", "evaluateSignalOutcome", e, candles, now_ms, {}),
                slog.evaluate_signal_outcome(e, candles, now_ms),
            )


def test_build_log_entry(analysis, candles):
    """The JS reads `new Date()` internally, so the clock-derived fields can't
    match. Everything else is real mapping logic and must."""
    price = candles[-1]["c"]
    idx_signals = sig.generate_index_signals(analysis, price, "NIFTY", SETTINGS)
    final_call = sug.build_unified_suggestion(
        analysis, price, 0.42, idx_signals, SETTINGS, "scalp", "NIFTY"
    )
    price_data = {"cur": price, "prev": price - 30, "high": price + 40, "low": price - 55}
    market = {"label": "Market Open", "detail": "Closes in 2h 5m"}

    js = call_js(
        "signalLog", "buildNiftySignalLogEntry",
        {"finalCall": final_call, "priceData": price_data, "analysis": analysis,
         "chgPct": 0.42, "indexSignals": idx_signals, "marketStatus": market},
    )
    py = slog.build_nifty_signal_log_entry(
        final_call, price_data, analysis, 0.42, idx_signals, market
    )

    clock_fields = {"id", "ts", "time", "date", "firstTs", "firstTime"}
    _check(
        {k: v for k, v in js.items() if k not in clock_fields},
        {k: v for k, v in py.items() if k not in clock_fields},
    )
    assert set(js) == set(py)
    assert py["id"].endswith(f"-{final_call['action']}")


def test_log_entry_clock_formats():
    """en-IN renders 12-hour with a zero-padded hour and lowercase meridiem."""
    from datetime import datetime, timezone
    dt = datetime(2026, 1, 5, 4, 3, 7, tzinfo=timezone.utc)
    assert slog._fmt_time(dt) == "09:33:07 am"
    assert slog._fmt_time(dt, seconds=False) == "09:33 am"
    assert slog._fmt_date(dt) == "05 Jan 2026"
    assert slog._iso_utc(dt) == "2026-01-05T04:03:07.000Z"


def test_summarize_outcomes():
    logs = [
        {"outcome": {"status": "target"}}, {"outcome": {"status": "target"}},
        {"outcome": {"status": "stop"}}, {"outcome": {"status": "expired"}},
        {"outcome": {"status": "pending"}}, {},
    ]
    _check(call_js("signalLog", "summarizeOutcomes", logs), slog.summarize_outcomes(logs))


def test_apply_outcome_to_logs(candles):
    from datetime import datetime, timezone
    base_ts = candles[max(0, len(candles) - 150)]["ts"]
    iso = datetime.fromtimestamp(base_ts / 1000, tz=timezone.utc).strftime(
        "%Y-%m-%dT%H:%M:%S.000Z"
    )
    ref = candles[max(0, len(candles) - 150)]["c"]
    logs = [
        _entry(action="BUY", ts=iso, entry=ref, target=ref + 100, stop=ref - 70, price=ref),
        _entry(action="SELL", ts=iso, entry=ref, target=ref - 100, stop=ref + 70, price=ref),
    ]
    now_ms = candles[-1]["ts"] + 60_000
    _check(
        call_js("signalLog", "applyOutcomeToLogs", logs, candles, now_ms, {}),
        slog.apply_outcome_to_logs(logs, candles, now_ms),
    )
