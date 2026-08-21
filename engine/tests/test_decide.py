"""The filters between a call and a trade.

This module exists because the dashboard and the paper trader used to answer
the same question differently. So what is worth testing is not that each filter
works — the backtest argues that — but the properties that keep two callers in
agreement: the order the filters run in, and the difference between a signal
that was never eligible and one the filters turned down.

The reason strings are load-bearing too. They are written into the paper book
as the record of why a trade was declined, and the shadow accounting is read
back out of them.
"""
from __future__ import annotations

from engine.live.decide import Policy, Verdict, decide

BUY = {"action": "BUY", "confidence": 88}


def test_a_clean_signal_is_taken():
    verdict = decide(BUY, Policy(gate=16.0), vix=12.0)
    assert verdict.taken
    assert verdict.reason == ""


def test_no_direction_is_rejected_not_declined():
    """A HOLD is not a refused trade, it is the absence of one. Counting it as
    declined would fill the shadow book with non-signals and make the filter
    look like it was turning down hundreds of trades a day."""
    verdict = decide({"action": "HOLD", "confidence": 90})
    assert verdict.rejected == "no directional call"
    assert verdict.declined == ""
    assert not verdict.taken


def test_low_confidence_is_rejected_not_declined():
    verdict = decide({"action": "BUY", "confidence": 62}, Policy(min_confidence=80))
    assert verdict.rejected == "confidence 62 below 80"
    assert verdict.declined == ""


def test_the_gate_declines_rather_than_rejects():
    """A gated signal is a real signal, which is why it can be shadowed: the
    whole point of following it is to find out whether standing aside was
    right."""
    verdict = decide(BUY, Policy(gate=16.0), vix=19.4)
    assert verdict.declined == "vix 19.40 above gate 16.0"
    assert verdict.rejected == ""
    assert not verdict.taken


def test_the_filter_declines_a_weak_score():
    verdict = decide(BUY, Policy(gate=16.0, min_score=0.5), vix=12.0,
                     score_fn=lambda: 0.01)
    assert verdict.declined == "score 0.010 below 0.500"
    assert verdict.score == 0.01


def test_a_signal_is_scored_before_the_gate_is_applied():
    """Scored first, so a gated tick still carries a score and can be followed
    as a shadow. Without it the refused trades are unmeasurable, which is where
    the evidence about the gate lives."""
    verdict = decide(BUY, Policy(gate=16.0, min_score=0.5), vix=25.0,
                     score_fn=lambda: 0.9)
    assert verdict.score == 0.9
    assert "above gate" in verdict.declined


def test_an_ineligible_signal_is_never_scored():
    """The converse: a call that fails on direction or confidence must not
    reach the model at all. Scoring it would spend a model call on something
    unactionable and put a meaningless number in the log."""
    calls = []

    def score():
        calls.append(1)
        return 0.9

    decide({"action": "HOLD", "confidence": 99}, score_fn=score)
    decide({"action": "BUY", "confidence": 10}, Policy(min_confidence=80), score_fn=score)
    assert calls == []


def test_the_gate_outranks_the_filter():
    """Both refuse it; the reported reason has to be the volatility one. The
    gate is a regime judgement and the filter was fitted inside that regime, so
    naming the filter here would credit it with a call it did not make."""
    verdict = decide(BUY, Policy(gate=16.0, min_score=0.99), vix=25.0,
                     score_fn=lambda: 0.01)
    assert "above gate" in verdict.declined
    assert "score" not in verdict.declined


def test_an_unknown_vix_does_not_stand_the_signal_down():
    """A missing print is a data outage, not a volatile market. Declining on it
    would turn a dead token into a silent strategy change, and the caller that
    needs to know reports the gap instead."""
    verdict = decide(BUY, Policy(gate=16.0), vix=None)
    assert verdict.taken
    assert verdict.vix is None


def test_an_unfiltered_call_is_taken_rather_than_guessed_at():
    """With no model there is no score, and no score cannot mean "refuse
    everything" or a machine without a fitted filter would show a dead
    dashboard."""
    verdict = decide(BUY, Policy(gate=16.0, min_score=0.5), vix=12.0)
    assert verdict.score is None
    assert verdict.taken


def test_the_verdict_travels_as_json_with_taken_already_decided():
    """The dashboard renders this. Deriving `taken` in the browser is how the
    two ends of the wire start disagreeing about what the verdict was."""
    blob = decide(BUY, Policy(gate=16.0), vix=19.4).as_dict()
    assert blob["taken"] is False
    assert blob["reason"] == blob["declined"] == "vix 19.40 above gate 16.0"
    assert blob["action"] == "BUY"
    assert set(blob) == {"action", "confidence", "score", "vix", "taken",
                         "rejected", "declined", "reason"}


def test_reason_prefers_the_rejection_it_stopped_at():
    assert Verdict(action="BUY", rejected="a", declined="b").reason == "a"
    assert Verdict(action="BUY", declined="b").reason == "b"
