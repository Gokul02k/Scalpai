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

#: Every fund the app recognises, and whether its value can be derived.
#:
#: `tracks` is the index whose level prices the fund, and None when there is no
#: series to price it against. `why` then says which kind of gap it is, because
#: the answers are not interchangeable: an index we have not archived is a job,
#: while a foreign market shut during NSE hours is a fact about the instrument.
#:
#: Every symbol here was checked against the live Fyers quote endpoint, and
#: every `tracks` against the index quote endpoint. Guessing either would put a
#: fund in the portfolio that silently never prices.
ETFS: dict[str, dict] = {
    # Indian index funds whose underlying the archive can serve.
    "NIFTYBEES": {"kind": "index", "tracks": "NIFTY", "label": "Nifty 50"},
    "SETFNIF50": {"kind": "index", "tracks": "NIFTY", "label": "Nifty 50"},
    "NIFTYIETF": {"kind": "index", "tracks": "NIFTY", "label": "Nifty 50"},
    "BANKBEES": {"kind": "index", "tracks": "BANKNIFTY", "label": "Bank Nifty"},
    "SETFNIFBK": {"kind": "index", "tracks": "BANKNIFTY", "label": "Bank Nifty"},
    "ITBEES": {"kind": "index", "tracks": "NIFTYIT", "label": "Nifty IT"},
    "PSUBNKBEES": {"kind": "index", "tracks": "NIFTYPSUBANK", "label": "Nifty PSU Bank"},
    "INFRABEES": {"kind": "index", "tracks": "NIFTYINFRA", "label": "Nifty Infra"},
    "ALPHA": {"kind": "index", "tracks": "NIFTYALPHA50", "label": "Nifty Alpha 50"},
    "DIVOPPBEES": {"kind": "index", "tracks": "NIFTYDIVOPPS50", "label": "Nifty Div Opps 50"},

    # Indian index funds whose index Fyers does not expose. Priceable in
    # principle, blocked on a series rather than on anything conceptual.
    "JUNIORBEES": {"kind": "index", "tracks": None, "label": "Nifty Next 50",
                   "why": "index-unavailable"},
    "CPSEETF": {"kind": "index", "tracks": None, "label": "Nifty CPSE",
                "why": "index-unavailable"},
    "ICICIB22": {"kind": "index", "tracks": None, "label": "S&P BSE Bharat 22",
                 "why": "index-unavailable"},
    "MOM100": {"kind": "index", "tracks": None, "label": "Nifty Midcap 100",
               "why": "index-unavailable"},
    "MOMENTUM50": {"kind": "index", "tracks": None, "label": "Momentum 50",
                   "why": "index-unavailable"},

    # Commodity funds. There is no index behind these, only a metal price the
    # app does not archive, so fair value needs a spot feed rather than a series.
    "GOLDBEES": {"kind": "commodity", "tracks": None, "label": "Domestic gold",
                 "why": "no-spot-feed"},
    "SILVERBEES": {"kind": "commodity", "tracks": None, "label": "Domestic silver",
                   "why": "no-spot-feed"},

    # Funds on foreign indices. These are where premium matters most, and also
    # where a ratio is least meaningful: the underlying market is closed while
    # they trade here, so the gap measures the time difference.
    "MON100": {"kind": "global", "tracks": None, "label": "Nasdaq 100",
               "why": "underlying-shut"},
    "MAFANG": {"kind": "global", "tracks": None, "label": "NYSE FANG+",
               "why": "underlying-shut"},
    "HNGSNGBEES": {"kind": "global", "tracks": None, "label": "Hang Seng",
                   "why": "underlying-shut"},

    # A cash park that trades at a fixed face value. Premium is not a concept
    # that applies, rather than a number we are missing.
    "LIQUIDBEES": {"kind": "debt", "tracks": None, "label": "Overnight liquid",
                   "why": "not-applicable"},
}

#: ETF -> the index whose level prices it. Derived from `ETFS` rather than
#: written twice, so a fund cannot be priceable in one place and not the other.
TRACKED_INDEX: dict[str, str] = {
    sym: meta["tracks"] for sym, meta in ETFS.items() if meta.get("tracks")
}


def is_etf(symbol: str | None) -> bool:
    """Whether a symbol is a fund rather than a company."""
    return str(symbol or "").upper() in ETFS


def etf_meta(symbol: str | None) -> dict | None:
    return ETFS.get(str(symbol or "").upper())

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
