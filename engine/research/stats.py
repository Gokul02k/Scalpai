"""Minimal statistics for edge hunting.

Deliberately hand-rolled rather than pulling in scipy: the engine will
eventually run unattended with money at stake, and every dependency is
something that can break at 09:16.

The normal approximation to the t-distribution is used for p-values, which is
accurate enough above n≈30 and is flagged below that.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Sequence


@dataclass
class Finding:
    """One hypothesis test on a set of returns."""

    name: str
    n: int
    mean: float
    std: float
    t_stat: float
    p_value: float
    #: What the sample is compared against — usually the unconditional mean.
    baseline: float = 0.0
    note: str = ""

    @property
    def ci95(self) -> tuple[float, float]:
        if self.n < 2:
            return (self.mean, self.mean)
        se = self.std / math.sqrt(self.n)
        return (self.mean - 1.96 * se, self.mean + 1.96 * se)

    @property
    def significant(self) -> bool:
        return self.p_value < 0.05 and self.n >= 30

    @property
    def crosses_zero(self) -> bool:
        lo, hi = self.ci95
        return lo <= 0 <= hi


def norm_sf(z: float) -> float:
    """Upper-tail probability of the standard normal."""
    return 0.5 * math.erfc(z / math.sqrt(2))


def test_mean(name: str, values: Sequence[float], baseline: float = 0.0, note: str = "") -> Finding:
    """Two-sided test that the mean of `values` differs from `baseline`."""
    n = len(values)
    if n < 2:
        return Finding(name, n, values[0] if values else 0.0, 0.0, 0.0, 1.0, baseline,
                       note or "sample too small")

    mean = sum(values) / n
    var = sum((v - mean) ** 2 for v in values) / (n - 1)
    std = math.sqrt(var)
    if std == 0:
        return Finding(name, n, mean, 0.0, 0.0, 1.0, baseline, note or "zero variance")

    t = (mean - baseline) / (std / math.sqrt(n))
    p = 2 * norm_sf(abs(t))
    if n < 30 and not note:
        note = "n<30, p-value approximate"
    return Finding(name, n, mean, std, t, p, baseline, note)


def test_proportion(name: str, successes: int, n: int, baseline: float = 0.5,
                    note: str = "") -> Finding:
    """Two-sided test that a hit rate differs from `baseline`."""
    if n == 0:
        return Finding(name, 0, 0.0, 0.0, 0.0, 1.0, baseline, "empty sample")
    p_hat = successes / n
    se = math.sqrt(baseline * (1 - baseline) / n)
    if se == 0:
        return Finding(name, n, p_hat, 0.0, 0.0, 1.0, baseline, note)
    z = (p_hat - baseline) / se
    return Finding(
        name, n, p_hat, math.sqrt(p_hat * (1 - p_hat)), z, 2 * norm_sf(abs(z)), baseline, note
    )


def bonferroni_threshold(num_tests: int, alpha: float = 0.05) -> float:
    """Testing many hypotheses on one dataset guarantees some will look
    significant by chance. At twenty tests and alpha 0.05 you expect one false
    positive, so the bar has to move."""
    return alpha / max(1, num_tests)
