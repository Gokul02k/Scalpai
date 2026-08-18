"""Backtesting: replay the live decision path over archived candles."""
from .compare import Variant, format_comparison, run_variants
from .costs import CostBreakdown, CostModel, get_cost_model
from .replay import BacktestConfig, BacktestResult, run_backtest, summarize
from .smc_replay import SmcParams, SmcResult, SmcTrade, run_smc_backtest

__all__ = [
    "BacktestConfig",
    "BacktestResult",
    "CostBreakdown",
    "CostModel",
    "SmcParams",
    "SmcResult",
    "SmcTrade",
    "Variant",
    "format_comparison",
    "get_cost_model",
    "run_backtest",
    "run_smc_backtest",
    "run_variants",
    "summarize",
]
