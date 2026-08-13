"""Volatility regime: join India VIX to trades and slice results by it.

The option re-pricing showed the edge breaking even near 14% implied vol, which
turns "does this strategy work" into "does it work *now*". Answering that needs
the implied vol that actually prevailed on each trade date rather than one
snapshot, and India VIX is the available proxy.

Two caveats on the proxy, neither fatal but both worth stating. VIX is a
30-day measure while the strategy trades weeklies, and weekly implied vol runs
below VIX in calm tape and above it in stress — so this understates the spread
between regimes rather than inventing one. And VIX is read from the daily
close, while the signal fires intraday; the day's close is known only after
the fact, so `vix_at` deliberately uses the *previous* close, which is what a
live system would have.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Sequence

from ..data.timeutil import IST


class VixSeries:
    """Daily India VIX, looked up by trade timestamp.

    Lookups return the last close strictly *before* the given moment. Using
    the same day's close would leak information the live system cannot have,
    and on a volatile day that is exactly the information that would matter.
    """

    def __init__(self, closes: dict[str, float]) -> None:
        self._by_day = dict(closes)
        self._days = sorted(self._by_day)
        # Previous trading day's close, which is what is knowable intraday.
        self._prev = {
            day: self._by_day[self._days[i - 1]]
            for i, day in enumerate(self._days)
            if i > 0
        }

    def __len__(self) -> int:
        return len(self._by_day)

    @property
    def span(self) -> tuple[str, str]:
        return (self._days[0], self._days[-1]) if self._days else ("", "")

    def vix_at(self, ts_ms: int) -> float | None:
        if not ts_ms:
            return None
        day = datetime.fromtimestamp(ts_ms / 1000, tz=IST).strftime("%Y-%m-%d")
        return self._prev.get(day)

    def close_on(self, day: str) -> float | None:
        return self._by_day.get(day)


def load_vix(store=None, symbol: str = "INDIAVIX") -> VixSeries:
    from ..data import CandleStore

    store = store or CandleStore()
    rows = store.read(symbol, "INDEX", "1d")
    return VixSeries({
        datetime.fromtimestamp(c.ts / 1000, tz=IST).strftime("%Y-%m-%d"): c.c
        for c in rows
    })


#: Buckets chosen around the 14% break-even the option re-pricing found, with
#: a wide top bucket because stressed tape is rare and does not need detail.
DEFAULT_BUCKETS: tuple[tuple[str, float, float], ...] = (
    ("calm    <12", 0.0, 12.0),
    ("low   12-14", 12.0, 14.0),
    ("mid   14-18", 14.0, 18.0),
    ("high  18-25", 18.0, 25.0),
    ("stress  >25", 25.0, 1e9),
)


@dataclass
class RegimeStats:
    label: str
    lo: float
    hi: float
    trades: int
    win_rate: float
    index_pts: float
    option_pts: float | None
    share: float

    def line(self) -> str:
        opt = f"{self.option_pts:+8.2f}" if self.option_pts is not None else f"{'-':>8}"
        return (
            f"  {self.label:12} {self.trades:6d} {self.share:5.1f}%  "
            f"win {self.win_rate:5.1f}%   index {self.index_pts:+7.2f}   option {opt}"
        )


def split_by_regime(
    samples: Sequence,
    vix: VixSeries,
    buckets: Sequence[tuple[str, float, float]] = DEFAULT_BUCKETS,
    option_net: Sequence[float] | None = None,
) -> tuple[list[RegimeStats], int]:
    """Bucket trades by the VIX that prevailed. Returns stats and the count of
    trades that could not be matched to a VIX reading."""
    import statistics as st

    tagged: list[tuple[float, object, float | None]] = []
    unmatched = 0
    for i, s in enumerate(samples):
        v = vix.vix_at(s.ts_ms)
        if v is None:
            unmatched += 1
            continue
        tagged.append((v, s, option_net[i] if option_net else None))

    total = len(tagged)
    out: list[RegimeStats] = []
    for label, lo, hi in buckets:
        rows = [(v, s, o) for v, s, o in tagged if lo <= v < hi]
        if not rows:
            out.append(RegimeStats(label, lo, hi, 0, 0.0, 0.0, None, 0.0))
            continue
        opts = [o for _, _, o in rows if o is not None]
        out.append(
            RegimeStats(
                label=label,
                lo=lo,
                hi=hi,
                trades=len(rows),
                win_rate=sum(s.label for _, s, _ in rows) / len(rows) * 100,
                index_pts=st.mean(s.points for _, s, _ in rows),
                option_pts=st.mean(opts) if opts else None,
                share=len(rows) / total * 100 if total else 0.0,
            )
        )
    return out, unmatched
