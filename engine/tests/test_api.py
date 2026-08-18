"""The read-only JSON service the dashboard renders.

Two things are worth testing here and one thing is not. Worth testing: that it
cannot be made to write, and that the shapes it returns are the shapes the
existing Next.js routes already hand the browser — a mismatch there shows up as
a blank chart rather than an error. Not worth testing: the indicator values,
which `test_indicators_parity.py` already pins.
"""
from __future__ import annotations

import json
import threading
from http.server import ThreadingHTTPServer
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import pytest

from engine.api import ApiConfig, Engine, make_handler
from engine.data import CandleStore


@pytest.fixture(scope="module")
def api():
    """The service on an ephemeral port, with the provider switched off.

    `live=False` matters: a test that phones a broker is a test that fails when
    a token expires, and it would place real load on an API rate limit.
    """
    if len(CandleStore().read("NIFTY", "INDEX", "5m", limit=200)) < 200:
        pytest.skip("run `python -m engine.cli sync` first")

    engine = Engine(ApiConfig(port=0, live=False, ttl=0.0))
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(engine))
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{httpd.server_address[1]}"
    finally:
        httpd.shutdown()
        httpd.server_close()
        thread.join(timeout=5)


def get(base: str, path: str) -> dict:
    with urlopen(f"{base}{path}", timeout=10) as res:
        return json.loads(res.read())


def test_health_reports_how_it_was_configured(api):
    assert get(api, "/health") == {"ok": True, "source": "fyers", "live": False}


def test_status_says_whether_the_holiday_calendar_covers_this_year(api):
    body = get(api, "/status")
    assert body["reason"] in ("open", "pre_open", "post_close", "weekend", "holiday")
    assert body["holidayCalendarKnown"] is True


def test_candles_come_back_in_the_shape_the_chart_already_reads(api):
    body = get(api, "/candles?symbol=NIFTY&interval=5m&limit=10")
    assert body["source"] == "engine"
    assert len(body["candles"]) == 10
    for candle in body["candles"]:
        assert set(candle) == {"ts", "o", "h", "l", "c", "vol", "t"}
        assert candle["h"] >= candle["c"] >= 0
    assert [c["ts"] for c in body["candles"]] == sorted(c["ts"] for c in body["candles"])


def test_daily_bars_are_labelled_by_date_not_by_time(api):
    body = get(api, "/candles?symbol=NIFTY&interval=1d&limit=3")
    assert all(":" not in c["t"] for c in body["candles"])


def test_prices_are_not_rounded_on_the_way_out(api):
    """The engine computes indicators from the store and the dashboard computes
    them from this response. Rounding here would make the two disagree by a
    hair, for no benefit, and the parity tests would not catch it."""
    stored = CandleStore().read("NIFTY", "INDEX", "5m", limit=5)
    served = get(api, "/candles?symbol=NIFTY&interval=5m&limit=5")["candles"]
    assert [c["c"] for c in served] == [c.c for c in stored]


def test_a_quote_falls_back_to_the_archive_when_the_provider_is_off(api):
    body = get(api, "/quote?symbol=NIFTY")
    assert body["source"] == "engine-archive"
    assert body["current"] > 0
    assert set(body) >= {"current", "open", "high", "low", "previousClose", "change",
                         "changePercent", "source"}


def test_analysis_serves_the_decision_path(api):
    body = get(api, "/analysis?symbol=NIFTY&interval=5m")
    assert body["suggestion"]["action"] in ("BUY", "SELL", "HOLD", "WAIT", "AVOID")
    assert 0 <= body["suggestion"]["confidence"] <= 100
    assert {"rsi", "macd", "bb", "atr"} <= set(body["analysis"])
    assert set(body["structure"]) == {"pools", "sweeps", "breaks", "blocks"}


def test_the_structure_is_reported_beside_the_call_never_inside_it(api):
    """It loses money as a strategy and adds nothing to the filter. It may be
    drawn; it may not quietly become part of the suggestion."""
    body = get(api, "/analysis?symbol=NIFTY&interval=5m")
    blob = json.dumps(body["suggestion"]).lower()
    for word in ("sweep", "order block", "choch", "smc"):
        assert word not in blob


def test_staleness_is_measured_against_the_tape_not_the_clock(api):
    """Outside market hours the newest bar is hours old and entirely correct;
    at 11:00 with a dead token the same bar is useless. The flag has to tell
    those apart, because the dashboard falls back to Yahoo on it."""
    engine = Engine(ApiConfig(live=False))
    now_ms = int(__import__("time").time() * 1000)

    engine._is_open = lambda: False
    assert engine.is_stale(now_ms - 3 * 24 * 3600_000, "5m") is False

    engine._is_open = lambda: True
    assert engine.is_stale(now_ms - 60_000, "5m") is False       # inside one bar
    assert engine.is_stale(now_ms - 3600_000, "5m") is True      # an hour behind


def test_an_unarchived_symbol_says_what_to_run(api):
    with pytest.raises(HTTPError) as e:
        get(api, "/candles?symbol=NOTREAL&interval=5m")
    assert e.value.code == 404
    assert "engine.cli sync" in json.loads(e.value.read())["error"]


def test_an_unknown_route_lists_the_real_ones(api):
    with pytest.raises(HTTPError) as e:
        get(api, "/orders")
    assert e.value.code == 404
    assert "/candles" in json.loads(e.value.read())["routes"]


@pytest.mark.parametrize("method", ["POST", "PUT", "DELETE", "PATCH"])
def test_the_service_refuses_to_be_written_to(api, method):
    """Positions and orders arrive in a later phase. Until they do — and until
    there is something to authenticate against — this must stay unwritable."""
    request = Request(f"{api}/candles", method=method, data=b"{}")
    with pytest.raises(HTTPError) as e:
        urlopen(request, timeout=10)
    assert e.value.code == 405
    assert "read-only" in json.loads(e.value.read())["error"]


def test_the_archive_is_not_touched_when_the_provider_is_off(api):
    """`live=False` has to mean no provider call and no write, or a research
    machine with stale credentials would rewrite the archive under the test."""
    before = CandleStore().coverage("NIFTY", "INDEX", "5m")
    get(api, "/candles?symbol=NIFTY&interval=5m&limit=5")
    assert CandleStore().coverage("NIFTY", "INDEX", "5m") == before
