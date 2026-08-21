"""Fair value for an exchange-traded fund, and the premium it trades at.

An ETF should change hands near the value of what it holds. When it does not,
the gap is worth seeing before placing an order: buying a fund at a premium
means paying for something the fund does not own, and the premium can close
against you while the index goes nowhere.

**This is not the premium to NAV, and it must not be described as one.** The
exchange publishes iNAV every fifteen seconds and serves it from no API; Fyers
does not carry it either -- its ETF quote returns bid, ask, spread, atp, volume
and OHLC, and nothing about the underlying basket. So fair value here is derived
from the index the fund tracks:

    ratio   = median(etf_close / index_close) over a recent window
    fair    = index_price * ratio
    premium = price / fair - 1

Two consequences bound what the number can be used for, and both are the reason
it starts life as a column rather than as a signal:

* It measures **dislocation from the fund's own recent tracking relationship**,
  not distance from NAV. A fund that sat thirty basis points rich all month
  reads as fair, because the median absorbed it. What it catches is today's
  departure from its own habit.
* A ratio is only a tracking ratio if it holds still. Dispersion is measured
  alongside it, and a relationship too loose to be tracking reports no fair
  value at all -- so a wrong entry in `TRACKED_INDEX` produces silence instead
  of a confident fiction.

Funds on foreign indices are deliberately absent. MON100 and HNGSNGBEES are
exactly where premium matters most, because the underlying market is shut while
they trade, and that is also precisely why a ratio against a stale index level
would be measuring the time difference rather than the dislocation.
"""
from __future__ import annotations

from typing import Sequence

from .jsnum import to_fixed

#: ETF -> the index whose level prices it, by the engine's own symbol name.
#:
#: Every pair here was checked against the live quote endpoint; an entry whose
#: index the archive cannot serve is worse than a missing one, because the
#: dashboard would show a blank column with no way to tell whether the fund is
#: fairly priced or simply unmapped.
TRACKED_INDEX: dict[str, str] = {
    "NIFTYBEES": "NIFTY",
    "SETFNIF50": "NIFTY",
    "NIFTYIETF": "NIFTY",
    "BANKBEES": "BANKNIFTY",
    "SETFNIFBK": "BANKNIFTY",
    "ITBEES": "NIFTYIT",
    "PSUBNKBEES": "NIFTYPSUBANK",
    "INFRABEES": "NIFTYINFRA",
    "ALPHA": "NIFTYALPHA50",
    "DIVOPPBEES": "NIFTYDIVOPPS50",
}

#: Daily bars used to estimate the ratio. Long enough to average out a single
#: bad print, short enough that an expense drag or a dividend does not bend it.
RATIO_WINDOW = 20

#: Fewest aligned bars worth an estimate at all.
MIN_RATIO_SAMPLES = 8

#: Relative dispersion above which the pair is not behaving like a fund and its
#: index. A fund tracking its index keeps this in single basis points; a wrong
#: mapping runs percent. The gap between those is wide, so the threshold does
#: not need to be finely judged -- it needs only to sit inside the gap.
MAX_RATIO_DISPERSION = 0.01


def median(values: Sequence[float]) -> float | None:
    """Middle value, averaging the pair when the count is even.

    Written out rather than taken from a library so the JavaScript mirror can
    be the same three lines. A median is used throughout instead of a mean
    because one stale or mispriced bar should not move fair value.
    """
    clean = sorted(v for v in values if v is not None)
    n = len(clean)
    if not n:
        return None
    mid = n // 2
    if n % 2:
        return clean[mid]
    return (clean[mid - 1] + clean[mid]) / 2


def align_closes(
    etf_rows: Sequence[dict], index_rows: Sequence[dict]
) -> list[tuple[int, float, float]]:
    """Closes for the bars both series actually have, matched on timestamp.

    Positional pairing would be the obvious shortcut and is wrong: the two
    series are synced independently, so one missing session silently shifts
    every earlier bar against a different day's index level and the ratio comes
    out of a comparison nobody made.
    """
    by_ts = {
        row["ts"]: row["c"]
        for row in index_rows
        if row.get("ts") is not None and row.get("c")
    }
    out: list[tuple[int, float, float]] = []
    for row in etf_rows:
        ts, close = row.get("ts"), row.get("c")
        level = by_ts.get(ts)
        if ts is None or not close or not level:
            continue
        out.append((ts, float(close), float(level)))
    return out


def tracking(
    aligned: Sequence[tuple[int, float, float]], window: int = RATIO_WINDOW
) -> dict | None:
    """The fund's ratio to its index, and how steadily it has held.

    Returns None when there is too little history to estimate, and reports
    `stable: False` when there is enough but the relationship is too loose to
    be tracking. Those are different answers and the caller renders them
    differently: one is "not yet known", the other is "not what we thought".
    """
    recent = list(aligned)[-window:]
    if len(recent) < MIN_RATIO_SAMPLES:
        return None

    ratios = [etf / level for _, etf, level in recent if level]
    mid = median(ratios)
    if not mid:
        return None

    # Median absolute deviation, relative to the ratio itself. Robust to the
    # step a dividend puts in the series, which a standard deviation would read
    # as the pair having come apart.
    spread = median([abs(r - mid) for r in ratios]) or 0.0
    dispersion = spread / mid
    return {
        "ratio": mid,
        "dispersion": dispersion,
        "samples": len(recent),
        "stable": dispersion <= MAX_RATIO_DISPERSION,
    }


def fair_value(index_price: float | None, ratio: float | None) -> float | None:
    if not index_price or not ratio:
        return None
    return index_price * ratio


def premium_pct(price: float | None, fair: float | None) -> float | None:
    """How far above its tracked value the fund is trading, in percent.

    Positive is a premium and negative a discount, which is the direction a
    buyer cares about: a premium is the part of the price backed by nothing the
    fund holds.
    """
    if not price or not fair:
        return None
    return to_fixed((price / fair - 1) * 100, 2)


def basis(
    symbol: str,
    price: float | None,
    index_price: float | None,
    etf_rows: Sequence[dict],
    index_rows: Sequence[dict],
    window: int = RATIO_WINDOW,
) -> dict:
    """Everything the dashboard needs for one fund's premium column.

    Always returns a dict with a `status`, because "we cannot price this one"
    has to be displayable. A column that silently blanks is indistinguishable
    from a fund trading exactly at fair value, and those mean opposite things.
    """
    tracked = TRACKED_INDEX.get(symbol.upper())
    if not tracked:
        return {"symbol": symbol, "status": "unmapped", "index": None}

    fit = tracking(align_closes(etf_rows, index_rows), window)
    if fit is None:
        return {"symbol": symbol, "status": "insufficient-history", "index": tracked}
    if not fit["stable"]:
        return {
            "symbol": symbol,
            "status": "unstable",
            "index": tracked,
            "dispersion": fit["dispersion"],
            "samples": fit["samples"],
        }

    fair = fair_value(index_price, fit["ratio"])
    premium = premium_pct(price, fair)
    if premium is None:
        return {"symbol": symbol, "status": "no-quote", "index": tracked}

    return {
        "symbol": symbol,
        "status": "ok",
        "index": tracked,
        "price": price,
        "fair": fair,
        "premiumPct": premium,
        "ratio": fit["ratio"],
        "dispersion": fit["dispersion"],
        "samples": fit["samples"],
    }
