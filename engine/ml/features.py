"""Feature extraction for the signal filter.

Every feature here is computable at the moment the signal fires, from the same
trailing window the engine saw. Nothing reads a later bar. That constraint is
the whole ballgame: a single leaked future value produces a model that looks
excellent in backtest and loses money live.

Percentages are used in preference to raw prices throughout. NIFTY ran from
~9,000 to ~25,000 over the sample, so an absolute distance means something
different in 2017 than in 2026, and a model fit on raw levels would partly be
learning the calendar.
"""
from __future__ import annotations

import math
import statistics
from datetime import datetime
from typing import Any, Sequence

from ..data.timeutil import IST

#: Stable ordering. The model is trained and scored through this list, so a
#: column can be added at the end but never reordered without retraining.
FEATURE_NAMES: list[str] = [
    "action_buy",
    "confidence",
    "rr",
    "target_dist_pct",
    "stop_dist_pct",
    "buy_weight",
    "sell_weight",
    "hold_weight",
    "weight_margin",
    "n_factors",
    "rsi",
    "macd_h_pct",
    "macd_v_pct",
    "stoch",
    "bb_pct",
    "bb_width_pct",
    "ema20_dist_pct",
    "ema50_dist_pct",
    "ema_spread_pct",
    "atr_pct",
    "vol_ratio",
    "vwap_dist_pct",
    "or_pos",
    "or_ready",
    "res_dist_pct",
    "sup_dist_pct",
    "fvg_inside",
    "fvg_bull",
    "chg_pct",
    "minutes_from_open",
    "dow",
    "session_bars",
    "ret_5_pct",
    "ret_20_pct",
    "realized_vol_pct",
    "bar_range_pct",
    "streak",
    # Volatility regime. Appended rather than inserted, because the list is the
    # model's column order and reordering it silently invalidates saved models.
    # Zero when no VIX history is joined, which is what an unenriched dataset
    # produces and is harmless: a constant column carries no information.
    "vix_level",
    "vix_vs_20d",
    "vix_pctile_1y",
]

_OPEN_MINUTES = 9 * 60 + 15


def _pct(numer: float | None, denom: float | None) -> float:
    """Percentage of `denom`, or 0 when undefined. Returning 0 rather than NaN
    keeps a missing indicator from being read as an extreme value."""
    if not denom or numer is None:
        return 0.0
    return numer / denom * 100.0


def _safe(x: Any, default: float = 0.0) -> float:
    if x is None:
        return default
    try:
        v = float(x)
    except (TypeError, ValueError):
        return default
    return v if math.isfinite(v) else default


def _factor_weights(factors: Sequence[dict]) -> tuple[float, float, float]:
    buy = sell = hold = 0.0
    for f in factors or ():
        w = _safe(f.get("weight"), 1.0)
        kind = f.get("type")
        if kind == "BUY":
            buy += w
        elif kind == "SELL":
            sell += w
        else:
            hold += w
    return buy, sell, hold


def _streak(closes: Sequence[float]) -> float:
    """Signed count of consecutive same-direction closes ending at the last
    bar. Positive for up, negative for down."""
    if len(closes) < 2:
        return 0.0
    up = closes[-1] > closes[-2]
    n = 0
    for i in range(len(closes) - 1, 0, -1):
        if (closes[i] > closes[i - 1]) != up:
            break
        n += 1
        if n >= 20:
            break
    return float(n if up else -n)


def extract_features(
    final_call: dict,
    analysis: dict,
    window: Sequence[dict],
    chg_pct: float = 0.0,
) -> dict[str, float]:
    """Feature row for one signal, using only information available at the
    close of the last bar in `window`."""
    price = _safe(analysis.get("price")) or _safe(final_call.get("entry"))
    if not price:
        return {name: 0.0 for name in FEATURE_NAMES}

    entry = _safe(final_call.get("entry"), price)
    target = _safe(final_call.get("target"), entry)
    stop = _safe(final_call.get("stopLoss"), entry)
    buy_w, sell_w, hold_w = _factor_weights(final_call.get("factors") or [])

    bb = analysis.get("bb") or {}
    upper, lower = _safe(bb.get("upper")), _safe(bb.get("lower"))
    band = upper - lower
    macd_ = analysis.get("macd") or {}
    sr = analysis.get("sr") or {}
    liq = analysis.get("liquidity") or {}
    session = analysis.get("session") or {}
    fvg_sig = ((analysis.get("fvg") or {}).get("signal")) or {}

    or_high, or_low = _safe(session.get("orHigh")), _safe(session.get("orLow"))
    or_span = or_high - or_low
    # 0 at the opening low, 1 at the opening high, outside that on a break.
    or_pos = (price - or_low) / or_span if or_span > 0 else 0.5

    closes = [_safe(c.get("c")) for c in window]
    rets = [
        (closes[i] - closes[i - 1]) / closes[i - 1]
        for i in range(1, len(closes))
        if closes[i - 1]
    ]
    last = window[-1] if window else {}
    ts = last.get("ts")
    when = datetime.fromtimestamp(ts / 1000, tz=IST) if ts else None

    return {
        "action_buy": 1.0 if final_call.get("action") == "BUY" else 0.0,
        "confidence": _safe(final_call.get("confidence")),
        "rr": _safe(final_call.get("rr")),
        "target_dist_pct": abs(_pct(target - entry, entry)),
        "stop_dist_pct": abs(_pct(entry - stop, entry)),
        "buy_weight": buy_w,
        "sell_weight": sell_w,
        "hold_weight": hold_w,
        "weight_margin": (buy_w - sell_w) / (buy_w + sell_w) if (buy_w + sell_w) else 0.0,
        "n_factors": float(len(final_call.get("factors") or [])),
        "rsi": _safe(analysis.get("rsi"), 50.0),
        "macd_h_pct": _pct(_safe(macd_.get("h")), price),
        "macd_v_pct": _pct(_safe(macd_.get("v")), price),
        "stoch": _safe(analysis.get("stoch"), 50.0),
        "bb_pct": (price - lower) / band if band > 0 else 0.5,
        "bb_width_pct": _pct(band, price),
        "ema20_dist_pct": _pct(price - _safe(analysis.get("ema20"), price), price),
        "ema50_dist_pct": _pct(price - _safe(analysis.get("ema50"), price), price),
        "ema_spread_pct": _pct(
            _safe(analysis.get("ema20"), price) - _safe(analysis.get("ema50"), price), price
        ),
        "atr_pct": _pct(_safe(analysis.get("atr")), price),
        "vol_ratio": _safe(liq.get("ratio"), 1.0),
        "vwap_dist_pct": _pct(price - _safe(session.get("vwap"), price), price),
        "or_pos": or_pos,
        "or_ready": 1.0 if session.get("orReady") else 0.0,
        "res_dist_pct": _pct(_safe(sr.get("resistance"), price) - price, price),
        "sup_dist_pct": _pct(price - _safe(sr.get("support"), price), price),
        "fvg_inside": 1.0 if fvg_sig.get("status") == "inside" else 0.0,
        "fvg_bull": 1.0 if fvg_sig.get("type") == "BUY" else -1.0 if fvg_sig.get("type") == "SELL" else 0.0,
        "chg_pct": _safe(chg_pct),
        "minutes_from_open": float(when.hour * 60 + when.minute - _OPEN_MINUTES) if when else 0.0,
        "dow": float(when.weekday()) if when else 0.0,
        "session_bars": _safe(session.get("bars")),
        "ret_5_pct": _pct(closes[-1] - closes[-6], closes[-6]) if len(closes) > 5 else 0.0,
        "ret_20_pct": _pct(closes[-1] - closes[-21], closes[-21]) if len(closes) > 20 else 0.0,
        "realized_vol_pct": statistics.pstdev(rets[-20:]) * 100 if len(rets) >= 20 else 0.0,
        "bar_range_pct": _pct(_safe(last.get("h")) - _safe(last.get("l")), price),
        "streak": _streak(closes),
        # Placeholders. VIX is a separate daily series joined afterwards by
        # `enrich_with_vix`; emitting the keys here keeps every row shaped like
        # FEATURE_NAMES, so a missing join shows up as a constant column rather
        # than as a differently shaped dict much later.
        "vix_level": 0.0,
        "vix_vs_20d": 0.0,
        "vix_pctile_1y": 0.0,
    }


def to_row(features: dict[str, float]) -> list[float]:
    """Feature dict to model input vector, in `FEATURE_NAMES` order."""
    return [_safe(features.get(name)) for name in FEATURE_NAMES]
