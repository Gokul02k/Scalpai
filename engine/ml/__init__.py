"""Learned signal filtering.

v1 scores a setup with `42 + agreement * 35 + |margin| * 4`, capped at 90.
Those constants were chosen by hand, and the backtest shows what that costs:
raising the logging threshold from 75 to 90 does not improve the win rate, so
the number is not ranking good setups above bad ones. It measures how loudly
the indicators agree, which is not the same thing.

This package replaces it with a model fit on graded outcomes. The point is not
to predict the market — it is to predict which of *this strategy's own* signals
tend to reach target, and skip the rest. That directly attacks the measured
problem: the edge is real but too thin to survive per-trade costs, so trading
fewer and better is worth more than trading more.
"""
