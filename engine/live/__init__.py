"""Live paper trading.

Runs the same decision path as the backtest against live data, picks a real
option strike from the live chain, and records what it would have paid at the
quoted ask and received at the quoted bid. No orders are placed anywhere.

The point is to find the gap between the backtest and reality before money is
involved. Three things routinely differ and none of them show up in a replay:
the fill you get is not the mid, the strike you wanted is not always liquid,
and signals arrive at moments the archive smoothed over.
"""
