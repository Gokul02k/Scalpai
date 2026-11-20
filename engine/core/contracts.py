"""Exchange contract specifications the engine prices against.

Kept apart from any strategy module so execution code can read them without
importing a strategy (the paper runner is forbidden from importing the
VWAP-cross replay, and should be).
"""

#: NIFTY contract size from 30 Dec 2025 (NSE/FAOP/70616; 75 before that).
#: Mirrored as `NIFTY_LOT_SIZE` in `app/lib/vwapCross.js`.
NIFTY_LOT_SIZE = 65
