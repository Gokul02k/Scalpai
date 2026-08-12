"""Market data layer.

One contract (`DataSource`), several providers. Pick with `get_source(name)` so
that moving from yfinance to a free broker API to Groww is a config change.
"""
from __future__ import annotations

from .base import Candle, DataSource, DataSourceError, Interval, Quote, Segment
from .store import CandleStore
from .timeutil import IST, is_trading_day, market_status, now_ist

_REGISTRY: dict[str, str] = {
    # name -> "module:class", imported lazily so an unconfigured provider's
    # missing dependency never breaks the ones that are configured.
    "yfinance": "engine.data.yfinance_source:YFinanceSource",
}


def available_sources() -> list[str]:
    return sorted(_REGISTRY)


def register_source(name: str, target: str) -> None:
    _REGISTRY[name] = target


def get_source(name: str = "yfinance") -> DataSource:
    try:
        target = _REGISTRY[name]
    except KeyError:
        raise DataSourceError(
            f"unknown data source {name!r}; available: {available_sources()}"
        ) from None
    module_path, _, cls_name = target.partition(":")
    import importlib

    module = importlib.import_module(module_path)
    return getattr(module, cls_name)()


__all__ = [
    "Candle",
    "CandleStore",
    "DataSource",
    "DataSourceError",
    "IST",
    "Interval",
    "Quote",
    "Segment",
    "available_sources",
    "get_source",
    "is_trading_day",
    "market_status",
    "now_ist",
    "register_source",
]
