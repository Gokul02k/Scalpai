"""The filters between a directional call and a trade, in one place.

The paper trader and the dashboard both answer the same question — would we
take this signal? — and answering it twice is how they came to disagree. The
dashboard applied v1's stop floor and a 50-point minimum move; the runner
applied production levels, the VIX gate and the learned filter. Same bars, two
verdicts, and nothing to say which of them the backtest supported.

So the sequence lives here and both callers import it. What is deliberately
*not* here is anything needing a book or a broker — position caps, cooldowns,
strike selection — because those belong to the runner alone and a read-only
view cannot answer them.

The order is the runner's original one:

    direction -> confidence -> score -> VIX gate -> filter threshold

Scoring happens before the gate rather than after it, so a signal the gate
refuses still carries a score and can be followed as a shadow. The cost is one
model call on a signal that will not be taken.

Rejected and declined are different outcomes, and collapsing them would lose
the shadow book's whole population. A *rejected* signal is not a signal: no
direction, or not confident enough. A *declined* one is a real signal the
filters turned down, which is exactly what the shadow book exists to measure.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Sequence

from ..core import signal_log as slog

#: Stand aside above this India VIX print. The backtested range 13-18 all
#: worked, so 16 sits in the middle of a plateau rather than on an edge.
DEFAULT_VIX_GATE = 16.0


@dataclass(frozen=True)
class Policy:
    """What a signal has to clear to be worth trading.

    One object rather than three loose numbers, so a second caller cannot
    quietly run a looser policy than the one being traded and still describe
    its output as the strategy's call.
    """

    min_confidence: int = slog.NIFTY_LOG_MIN_CONFIDENCE
    gate: float = DEFAULT_VIX_GATE
    #: Learned-filter cutoff. None runs the strategy unfiltered.
    min_score: float | None = None


@dataclass
class Verdict:
    """What the filters made of one signal."""

    action: str = "HOLD"
    confidence: int = 0
    score: float | None = None
    vix: float | None = None
    #: Not a signal: no direction, or below the confidence bar.
    rejected: str = ""
    #: A real signal the filters turned down. Shadowable.
    declined: str = ""

    @property
    def directional(self) -> bool:
        return self.action in ("BUY", "SELL")

    @property
    def taken(self) -> bool:
        return self.directional and not self.rejected and not self.declined

    @property
    def reason(self) -> str:
        return self.rejected or self.declined

    def as_dict(self) -> dict[str, Any]:
        """JSON for the dashboard. `taken` is derived here rather than in the
        browser, so the two cannot disagree about what the verdict was."""
        return {
            "action": self.action,
            "confidence": self.confidence,
            "score": self.score,
            "vix": self.vix,
            "taken": self.taken,
            "rejected": self.rejected,
            "declined": self.declined,
            "reason": self.reason,
        }


def decide(
    final_call: dict,
    policy: Policy | None = None,
    vix: float | None = None,
    score_fn: Callable[[], float | None] | None = None,
) -> Verdict:
    """Apply the policy to one strategy call.

    `score_fn` is a callback rather than a value so that the ordering rule
    above is enforced here instead of trusted to each caller: a signal that
    fails on direction or confidence is never scored at all.

    An unknown VIX does not decline the signal, because standing aside on a
    missing number would silently turn a data outage into a strategy change.
    Callers that need to know report the gap instead.
    """
    policy = policy or Policy()
    action = final_call.get("action", "HOLD") or "HOLD"
    confidence = int(final_call.get("confidence", 0) or 0)
    verdict = Verdict(action=action, confidence=confidence, vix=vix)

    if not verdict.directional:
        verdict.rejected = "no directional call"
        return verdict
    if confidence < policy.min_confidence:
        verdict.rejected = f"confidence {confidence} below {policy.min_confidence}"
        return verdict

    if score_fn is not None:
        verdict.score = score_fn()

    if vix is not None and vix > policy.gate:
        verdict.declined = f"vix {vix:.2f} above gate {policy.gate:.1f}"
    elif (policy.min_score is not None and verdict.score is not None
            and verdict.score < policy.min_score):
        verdict.declined = f"score {verdict.score:.3f} below {policy.min_score:.3f}"
    return verdict


def score_signal(
    model: Any,
    final_call: dict,
    analysis: dict,
    window: Sequence[dict],
    chg_pct: float = 0.0,
    vix: float | None = None,
) -> float | None:
    """The filter's probability that this signal reaches target before stop.

    The volatility-regime columns are filled from the live print, because the
    model was fitted with them joined from the daily series. Scoring with them
    at zero would leave three of its most important features blank — a
    train/serve skew that produces confident nonsense rather than an error.
    """
    if model is None:
        return None

    from ..ml.features import extract_features
    from ..ml.model import score_one

    features = extract_features(final_call, analysis, window, chg_pct)
    if vix is not None:
        features.update(vix_context(vix))
    return score_one(model, features)


#: Loaded once. The archive is static during a session, and re-reading it every
#: two minutes would be pointless work.
_VIX_SERIES: Any | None = None


def vix_context(level: float) -> dict[str, float]:
    """Regime features for a VIX print that is not in the archive yet."""
    global _VIX_SERIES
    if _VIX_SERIES is None:
        from ..backtest.regime import load_vix

        _VIX_SERIES = load_vix()
    return _VIX_SERIES.live_context(level) if len(_VIX_SERIES) else {}
