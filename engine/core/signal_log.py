"""Port of `app/lib/signalLog.js` — logging, dedupe and outcome grading.

`evaluate_signal_outcome` is the most important function in the codebase for
present purposes: it is what turns a stream of opinions into a track record,
and it doubles as the backtest's scorer. Grading a signal the same way live and
in backtest is what makes the two numbers comparable.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Sequence

from ..data.timeutil import IST
from .jsnum import js_round, to_fixed

NIFTY_LOG_MIN_CONFIDENCE = 80
NIFTY_LOG_MAX_ENTRIES = 300
#: Inside this window a repeat reading merges into the existing row instead of
#: creating a new one.
NIFTY_LOG_SESSION_MS = 20 * 60 * 1000
#: How long a prediction stays active before expiring unresolved.
NIFTY_EVAL_WINDOW_MS = 24 * 60 * 60 * 1000
#: A NIFTY scalp only counts as passed after a genuinely tradeable move.
NIFTY_MIN_PASS_POINTS = 50

PORTFOLIO_LOG_MIN_CONFIDENCE = 65
PORTFOLIO_LOG_MAX_ENTRIES = 200
PORTFOLIO_EVAL_WINDOW_MS = 60 * 24 * 60 * 60 * 1000

OUTCOME_LABELS = {
    "pending": "Active",
    "target": "Passed",
    "stop": "Failed",
    "expired": "Expired",
}

_OUTCOME_RANK = {None: 0, "pending": 1, "expired": 2, "target": 3, "stop": 3}


# ── formatting helpers (must match Intl 'en-IN' exactly) ───────────────────

def _fmt_time(dt: datetime, seconds: bool = True) -> str:
    """en-IN renders 12-hour with a zero-padded hour and lowercase meridiem,
    e.g. "09:33:07 am"."""
    pattern = "%I:%M:%S %p" if seconds else "%I:%M %p"
    return dt.astimezone(IST).strftime(pattern).lower()


def _fmt_date(dt: datetime) -> str:
    return dt.astimezone(IST).strftime("%d %b %Y")


def _parse_iso(ts: str) -> datetime:
    return datetime.fromisoformat(ts.replace("Z", "+00:00"))


def _iso_utc(dt: datetime) -> str:
    """JS `Date.toISOString()` — always UTC, always milliseconds."""
    ms = dt.astimezone(timezone.utc)
    return ms.strftime("%Y-%m-%dT%H:%M:%S.") + f"{ms.microsecond // 1000:03d}Z"


def get_signal_strength(confidence: float) -> dict:
    if confidence >= 90:
        return {"label": "Very Strong", "tier": 3}
    if confidence >= 85:
        return {"label": "Strong", "tier": 2}
    return {"label": "High", "tier": 1}


def _score_factors(factors: Sequence[dict] = ()) -> dict:
    buy_w = 0.0
    sell_w = 0.0
    for f in factors:
        w = f.get("weight", 1)
        if f["type"] == "BUY":
            buy_w += w
        elif f["type"] == "SELL":
            sell_w += w
    return {"buyW": buy_w, "sellW": sell_w, "margin": buy_w - sell_w}


def build_nifty_signal_log_entry(
    final_call: dict,
    price_data: dict | None,
    analysis: dict | None,
    chg_pct: float = 0,
    index_signals: Sequence[dict] = (),
    market_status: dict | None = None,
    now: datetime | None = None,
) -> dict:
    dt = now or datetime.now(timezone.utc)
    ts = _iso_utc(dt)
    scores = _score_factors(final_call.get("factors") or [])
    strength = get_signal_strength(final_call["confidence"])
    time_str = _fmt_time(dt)

    return {
        "id": f"{int(dt.timestamp() * 1000)}-{final_call['action']}",
        "ts": ts,
        "time": time_str,
        "date": _fmt_date(dt),
        "firstTs": ts,
        "firstTime": time_str,
        "updates": 1,
        "instrument": "NIFTY",
        "mode": "scalp",
        "action": final_call["action"],
        "label": final_call.get("label"),
        "confidence": final_call["confidence"],
        "peakConfidence": final_call["confidence"],
        "strength": strength["label"],
        "strengthTier": strength["tier"],
        "price": (price_data or {}).get("cur") or final_call.get("entry"),
        "chgPct": chg_pct,
        "entry": final_call.get("entry"),
        "target": final_call.get("target"),
        "stopLoss": final_call.get("stopLoss"),
        "rr": final_call.get("rr"),
        "scores": scores,
        "factors": [
            {"type": f["type"], "name": f.get("name"), "reason": f.get("reason"),
             "weight": f.get("weight", 1)}
            for f in (final_call.get("factors") or [])
        ],
        "indexSignals": [
            {"type": s["type"], "str": s["str"], "reason": s["reason"]}
            for s in (index_signals or [])
        ],
        "technical": {
            "rsi": analysis.get("rsi"),
            "macdHist": (analysis.get("macd") or {}).get("h"),
            "ema20": analysis.get("ema20"),
            "ema50": analysis.get("ema50"),
            "support": (analysis.get("sr") or {}).get("support"),
            "resistance": (analysis.get("sr") or {}).get("resistance"),
            "liquidity": (analysis.get("liquidity") or {}).get("label"),
            "liquidityRatio": (analysis.get("liquidity") or {}).get("ratio"),
        } if analysis else None,
        "marketStatus": {
            "label": market_status.get("label"), "detail": market_status.get("detail")
        } if market_status else None,
    }


def decide_signal_log(last_entry: dict | None, next_entry: dict) -> str:
    """'append' a new row, 'update' the most recent one, or 'skip'."""
    if not last_entry:
        return "append"
    if last_entry["action"] != next_entry["action"]:
        return "append"

    elapsed = (
        _parse_iso(next_entry["ts"]).timestamp() - _parse_iso(last_entry["ts"]).timestamp()
    ) * 1000
    if elapsed > NIFTY_LOG_SESSION_MS:
        return "append"

    peak = last_entry.get("peakConfidence", last_entry["confidence"])
    if next_entry["confidence"] != last_entry["confidence"] or next_entry["confidence"] > peak:
        return "update"
    return "skip"


def merge_signal_log_entry(prev: dict, nxt: dict) -> dict:
    peak = max(prev.get("peakConfidence", prev["confidence"]), nxt["confidence"])
    strength = get_signal_strength(peak)
    merged = {**nxt}
    merged.update(
        id=prev["id"],
        firstTs=prev.get("firstTs") or prev["ts"],
        firstTime=prev.get("firstTime") or prev["time"],
        updates=prev.get("updates", 1) + 1,
        peakConfidence=peak,
        strength=strength["label"],
        strengthTier=strength["tier"],
    )
    # JS assigns `next.outcome ?? prev.outcome`, and JSON.stringify drops the
    # key when that is undefined. Emitting an explicit null instead would put a
    # field in the stored log that v1 never wrote.
    outcome = nxt.get("outcome") or prev.get("outcome")
    if outcome is not None:
        merged["outcome"] = outcome
    else:
        merged.pop("outcome", None)
    return merged


def is_loggable_nifty_signal(final_call: dict | None) -> bool:
    if not final_call:
        return False
    if final_call.get("action") not in ("BUY", "SELL"):
        return False
    return final_call.get("confidence", 0) >= NIFTY_LOG_MIN_CONFIDENCE


def apply_nifty_log_update(logs: Sequence[dict], entry: dict) -> dict:
    logs = list(logs)
    last = logs[0] if logs else None
    decision = decide_signal_log(last, entry)

    if decision == "skip":
        return {"logs": logs, "changed": False, "decision": decision}
    if decision == "update":
        merged = merge_signal_log_entry(last, entry)
        return {
            "logs": [merged, *logs[1:]][:NIFTY_LOG_MAX_ENTRIES],
            "changed": True,
            "decision": decision,
        }
    return {
        "logs": [entry, *logs][:NIFTY_LOG_MAX_ENTRIES],
        "changed": True,
        "decision": "append",
    }


# ── grading ────────────────────────────────────────────────────────────────

def evaluate_signal_outcome(
    entry: dict,
    candles: Sequence[dict] = (),
    now_ms: int | None = None,
    window_ms: int | None = None,
    min_favorable_points: float | None = None,
) -> dict | None:
    """Grade a signal against the actual price path.

    Only bars inside the signal's own window are considered, so a stale signal
    is never judged by unrelated later price action. When a single bar contains
    both the target and the stop, the stop wins: intrabar ordering is unknown,
    and assuming the favourable fill is how backtests flatter themselves.
    """
    if entry is None or entry.get("action") not in ("BUY", "SELL"):
        return None
    E, T, S = entry.get("entry"), entry.get("target"), entry.get("stopLoss")
    if E is None or T is None or S is None:
        return None

    now_ms = now_ms if now_ms is not None else int(datetime.now(timezone.utc).timestamp() * 1000)
    window_ms = window_ms if window_ms is not None else NIFTY_EVAL_WINDOW_MS
    is_buy = entry["action"] == "BUY"

    min_pts = min_favorable_points
    if min_pts is None:
        min_pts = NIFTY_MIN_PASS_POINTS if entry.get("instrument") == "NIFTY" else 0
    eff_target = max(T, E + min_pts) if is_buy else min(T, E - min_pts)

    start_ms = _parse_iso(entry.get("firstTs") or entry["ts"]).timestamp() * 1000
    end_ms = start_ms + window_ms
    path = [c for c in candles if c and c.get("ts") is not None and start_ms <= c["ts"] <= end_ms]

    status = "pending"
    resolved_ts = None
    resolved_price = None
    mfe = 0.0
    mae = 0.0
    last_price = entry.get("price") if entry.get("price") is not None else E

    for c in path:
        if c.get("c") is not None:
            last_price = c["c"]
        if is_buy:
            mfe = max(mfe, c["h"] - E)
            mae = min(mae, c["l"] - E)
        else:
            mfe = max(mfe, E - c["l"])
            mae = min(mae, E - c["h"])

        hit_target = c["h"] >= eff_target if is_buy else c["l"] <= eff_target
        hit_stop = c["l"] <= S if is_buy else c["h"] >= S
        if hit_target and hit_stop:
            status, resolved_ts, resolved_price = "stop", c["ts"], S
            break
        if hit_target:
            status, resolved_ts, resolved_price = "target", c["ts"], eff_target
            break
        if hit_stop:
            status, resolved_ts, resolved_price = "stop", c["ts"], S
            break

    if status == "pending" and now_ms - start_ms > window_ms:
        status = "expired"
        resolved_price = last_price
        resolved_ts = path[-1]["ts"] if path else start_ms

    ref = resolved_price if resolved_price is not None else last_price
    direction = 1 if is_buy else -1

    return {
        "status": status,
        "resolvedTs": (
            _iso_utc(datetime.fromtimestamp(resolved_ts / 1000, tz=timezone.utc))
            if resolved_ts else None
        ),
        "resolvedPrice": to_fixed(resolved_price, 2) if resolved_price is not None else None,
        "resultPct": to_fixed((ref - E) / E * 100 * direction, 2) if E else 0,
        "mfePct": to_fixed(mfe / E * 100, 2) if E else 0,
        "maePct": to_fixed(mae / E * 100, 2) if E else 0,
        "evaluatedAt": _iso_utc(datetime.fromtimestamp(now_ms / 1000, tz=timezone.utc)),
    }


def apply_outcome_to_logs(
    logs: Sequence[dict],
    candles: Sequence[dict] = (),
    now_ms: int | None = None,
    **opts,
) -> dict:
    changed = False
    out = []
    for e in logs:
        prev = e.get("outcome")
        if prev and prev.get("status") != "pending":
            out.append(e)  # terminal results are frozen
            continue
        outcome = evaluate_signal_outcome(e, candles, now_ms, **opts)
        if not outcome:
            out.append(e)
            continue
        if (
            not prev
            or prev.get("status") != outcome["status"]
            or prev.get("resultPct") != outcome["resultPct"]
            or prev.get("mfePct") != outcome["mfePct"]
            or prev.get("maePct") != outcome["maePct"]
        ):
            changed = True
            out.append({**e, "outcome": outcome})
        else:
            out.append(e)
    return {"logs": out if changed else list(logs), "changed": changed}


def summarize_outcomes(logs: Sequence[dict] = ()) -> dict:
    passed = failed = active = expired = 0
    for e in logs:
        status = (e.get("outcome") or {}).get("status")
        if status == "target":
            passed += 1
        elif status == "stop":
            failed += 1
        elif status == "expired":
            expired += 1
        else:
            active += 1
    resolved = passed + failed
    return {
        "passed": passed,
        "failed": failed,
        "active": active,
        "expired": expired,
        "resolved": resolved,
        "winRate": js_round(passed / resolved * 100) if resolved else None,
    }


def merge_nifty_log_lists(
    server_logs: Sequence[dict] = (), local_logs: Sequence[dict] = ()
) -> list[dict]:
    by_id: dict[str, dict] = {}

    def rank(e: dict) -> int:
        return _OUTCOME_RANK.get((e.get("outcome") or {}).get("status"), 0)

    for e in [*server_logs, *local_logs]:
        existing = by_id.get(e["id"])
        if not existing:
            by_id[e["id"]] = e
            continue
        er, xr = rank(e), rank(existing)
        if er != xr:
            if er > xr:
                by_id[e["id"]] = e
            continue
        if (
            e.get("updates", 1) > existing.get("updates", 1)
            or (e.get("peakConfidence") or e.get("confidence") or 0)
            > (existing.get("peakConfidence") or existing.get("confidence") or 0)
            or _parse_iso(e["ts"]) > _parse_iso(existing["ts"])
        ):
            by_id[e["id"]] = e

    return sorted(by_id.values(), key=lambda e: _parse_iso(e["ts"]), reverse=True)[
        :NIFTY_LOG_MAX_ENTRIES
    ]
