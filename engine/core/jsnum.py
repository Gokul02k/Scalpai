"""JavaScript numeric semantics.

The v1 engine is JavaScript and rounds constantly — `+(x).toFixed(2)` appears
in nearly every indicator. Python's `round()` uses banker's rounding while
JS `toFixed` rounds ties away from zero, so `0.125` becomes `0.12` in one and
`0.13` in the other.

On a single indicator that is invisible. Compounded across RSI, MACD, band
edges, support/resistance and then a weighted vote with integer thresholds, it
is enough to flip a borderline signal — which means the Python backtest would
be measuring a subtly different strategy than the one that has been running.
Hence this module, and the parity tests that use it.
"""
from __future__ import annotations

import math
from decimal import Decimal, ROUND_HALF_UP
from typing import Any, Iterable, Sequence

_QUANT: dict[int, Decimal] = {d: Decimal(1).scaleb(-d) for d in range(0, 11)}


def to_fixed(x: float | int | None, digits: int = 2) -> float:
    """`+Number(x).toFixed(digits)`.

    Decimal(float) is exact, so this rounds the same binary value V8 sees,
    with ties away from zero to match.
    """
    if x is None:
        return 0.0
    x = float(x)
    if math.isnan(x) or math.isinf(x):
        return x
    q = _QUANT.get(digits) or Decimal(1).scaleb(-digits)
    return float(Decimal(x).quantize(q, rounding=ROUND_HALF_UP))


def fixed_str(x: float | int | None, digits: int = 2) -> str:
    """`Number(x).toFixed(digits)` — the string, for labels the vote reads."""
    if x is None:
        x = 0.0
    x = float(x)
    if math.isnan(x):
        return "NaN"
    if math.isinf(x):
        return "Infinity" if x > 0 else "-Infinity"
    q = _QUANT.get(digits) or Decimal(1).scaleb(-digits)
    return str(Decimal(x).quantize(q, rounding=ROUND_HALF_UP))


def js_round(x: float) -> int:
    """`Math.round(x)` — ties go toward +Infinity, so Math.round(-2.5) is -2
    while Python's round(-2.5) is -2 by a different rule and round(2.5) is 2.

    Used by the confidence vote, where the value is compared against integer
    thresholds and an off-by-one decides whether a signal is logged at all.
    """
    if math.isnan(x) or math.isinf(x):
        return x  # type: ignore[return-value]
    return math.floor(x + 0.5)


def clamp(v: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, v))


def js_str(x: Any) -> str:
    """`String(x)` for numbers embedded in template literals.

    JavaScript has one number type, so an integral value prints without a
    decimal point: `${12.0}` yields "12" where Python's f-string yields "12.0".
    Every indicator value interpolated into a signal reason hits this, and
    those reasons are stored in the log, so the difference is not cosmetic.
    """
    if x is None:
        return "null"
    if isinstance(x, bool):
        return "true" if x else "false"
    if isinstance(x, int):
        return str(x)
    if isinstance(x, float):
        if math.isnan(x):
            return "NaN"
        if math.isinf(x):
            return "Infinity" if x > 0 else "-Infinity"
        if x == int(x) and abs(x) < 1e21:
            return str(int(x))
        return repr(x)
    return str(x)


def locale_en_in(x: float | int | None) -> str:
    """`Number(x).toLocaleString('en-IN')`.

    Indian digit grouping puts the last three digits together and then groups
    by twos, so 1234567.5 renders as "12,34,567.5" rather than "1,234,567.5".
    These strings are embedded in signal reasons that get logged, so a mismatch
    here shows up as a parity failure even though nothing numeric changed.
    """
    if x is None:
        return "0"
    x = float(x)
    if math.isnan(x):
        return "NaN"
    if math.isinf(x):
        return "∞" if x > 0 else "-∞"

    # Intl defaults to at most three fraction digits, ties away from zero.
    d = Decimal(x).quantize(Decimal("0.001"), rounding=ROUND_HALF_UP).normalize()
    sign = "-" if d < 0 else ""
    d = abs(d)

    int_part = int(d)
    frac = str(d - int_part)[2:] if d != int_part else ""
    s = str(int_part)

    if len(s) > 3:
        head, tail = s[:-3], s[-3:]
        groups = []
        while len(head) > 2:
            groups.insert(0, head[-2:])
            head = head[:-2]
        if head:
            groups.insert(0, head)
        s = ",".join(groups + [tail])

    return f"{sign}{s}.{frac}" if frac else f"{sign}{s}"


def js_min(values: Iterable[float]) -> float:
    """`Math.min(...xs)` — Infinity when empty, which callers rely on."""
    vals = list(values)
    return min(vals) if vals else math.inf


def js_max(values: Iterable[float]) -> float:
    """`Math.max(...xs)` — -Infinity when empty."""
    vals = list(values)
    return max(vals) if vals else -math.inf


def mean(values: Sequence[float]) -> float:
    return sum(values) / len(values) if values else 0.0
