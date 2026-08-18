"""Smart-money context as features for the signal filter.

Replaying the setup as a strategy of its own loses money — 1,663 trades at
−6.62 index points after costs, negative in every year and every variant
(`engine/backtest/smc_replay.py`). That result rules out trading it directly.
It does not rule out the weaker and more plausible claim: that *where price sits
in the structure* says something about whether a v1 signal is about to work.

A signal fired just after a liquidity sweep in the same direction is a different
proposition from the same signal fired into an untouched pool, even if every
indicator reads identically. These features let the filter decide whether that
distinction is worth anything. It is a question for walk-forward validation, not
for an opinion — run `python -m engine.cli ml` and compare against `--no-smc`.

Everything here is computed from the trailing window the engine already had, and
the structure functions it calls are causal by construction, so a feature can
never describe a swing the market had not finished forming.
"""
from __future__ import annotations

from typing import Any, Sequence

from ..core import smc

CandleDict = dict[str, Any]

#: Appended to `FEATURE_NAMES` in that order. Never reorder — the list is the
#: model's column layout and a saved model is refused if it moves.
SMC_FEATURE_NAMES: list[str] = [
    "smc_sweep_agrees",
    "smc_sweep_age",
    "smc_sweep_depth_pct",
    "smc_break_agrees",
    "smc_break_age",
    "smc_break_choch",
    "smc_ob_state",
    "smc_pdh_dist_pct",
    "smc_pdl_dist_pct",
]

#: Age when the event has not happened this session. A real age of zero means
#: "this bar", so absence needs its own value rather than sharing it.
NEVER = -1.0

_SPAN = 2
_MIN_SWEEP_PTS = 2.0
_OB_LOOKBACK = 10


def _blank() -> dict[str, float]:
    return dict.fromkeys(SMC_FEATURE_NAMES, 0.0) | {
        "smc_sweep_age": NEVER,
        "smc_break_age": NEVER,
    }


def _agrees(direction: str, action: str) -> float:
    """+1 when the structure points the same way as the signal, -1 against."""
    wanted = "SELL" if direction == smc.SHORT else "BUY"
    return 1.0 if action == wanted else -1.0


def _last_sweep(session: Sequence[CandleDict], pools: Sequence[smc.Pool]) -> smc.Sweep | None:
    """Most recent pool taken and closed back inside, searching backwards."""
    for i in range(len(session) - 1, 0, -1):
        visible = smc.session_pools(session, i - 1, _SPAN, pools)
        found = smc.sweep_at(session, i, visible, _MIN_SWEEP_PTS)
        if found is not None:
            return found
    return None


def _last_break(session: Sequence[CandleDict]) -> tuple[int, str] | None:
    """Most recent close through a swing that had already been confirmed.

    Swings are found once over the session and then filtered per candidate bar,
    rather than recomputed inside the loop: the filter `i + span < j` is what
    keeps it causal, since a swing at `i` is not known until `i + span`.
    """
    highs = smc.swing_highs(session, _SPAN)
    lows = smc.swing_lows(session, _SPAN)
    for j in range(len(session) - 1, 0, -1):
        close = session[j]["c"]
        prior_lows = [i for i in lows if i + _SPAN < j]
        if prior_lows and close < session[prior_lows[-1]]["l"]:
            return j, smc.SHORT
        prior_highs = [i for i in highs if i + _SPAN < j]
        if prior_highs and close > session[prior_highs[-1]]["h"]:
            return j, smc.LONG
    return None


def smc_context(window: Sequence[CandleDict], action: str, price: float) -> dict[str, float]:
    """Where this signal sits in the session's structure.

    `window` is the trailing bars the engine saw, newest last. Only today's
    session is read for structure; the session before it supplies the previous
    day's levels.
    """
    out = _blank()
    if not window or not price:
        return out

    sessions = smc.group_sessions(window)
    if not sessions:
        return out
    session = sessions[-1][1]
    pools = smc.inherited_pools(sessions[-2][1]) if len(sessions) > 1 else []
    now = len(session) - 1

    for pool in pools:
        if pool.label == "previous day high":
            out["smc_pdh_dist_pct"] = (pool.price - price) / price * 100
        elif pool.label == "previous day low":
            out["smc_pdl_dist_pct"] = (price - pool.price) / price * 100

    sweep = _last_sweep(session, pools)
    if sweep is not None:
        out["smc_sweep_agrees"] = _agrees(sweep.direction, action)
        out["smc_sweep_age"] = float(now - sweep.idx)
        out["smc_sweep_depth_pct"] = sweep.depth / price * 100

    found = _last_break(session)
    if found is not None:
        idx, direction = found
        out["smc_break_agrees"] = _agrees(direction, action)
        out["smc_break_age"] = float(now - idx)
        out["smc_break_choch"] = (
            1.0 if smc.break_kind(session, idx, direction, _SPAN) == "CHoCH" else 0.0
        )

        block = smc.order_block(session[: idx + 1], idx, direction, _OB_LOOKBACK)
        if block is not None and block.lo <= price <= block.hi:
            out["smc_ob_state"] = _agrees(direction, action)

    return out
