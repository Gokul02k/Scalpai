"""Engine CLI.

    python -m engine.cli probe                     # which providers work today
    python -m engine.cli sync                      # pull + archive the default set
    python -m engine.cli sync --symbol NIFTY --interval 5m
    python -m engine.cli inventory                 # what history is banked
    python -m engine.cli status                    # market open/closed
"""
from __future__ import annotations

import argparse
import logging
import sys

from .data import CandleStore, get_source, market_status, now_ist
from .data.base import DataSourceError
from .data.timeutil import HolidayCalendarMissing

# Symbols archived by a bare `sync`. The 5m series is the scalp signal's input;
# the daily series is for the equity swing track and for long-horizon context.
DEFAULT_SYNC: list[tuple[str, str, str]] = [
    ("NIFTY", "INDEX", "5m"),
    ("NIFTY", "INDEX", "15m"),
    ("NIFTY", "INDEX", "1h"),
    ("NIFTY", "INDEX", "1d"),
    ("BANKNIFTY", "INDEX", "5m"),
    ("BANKNIFTY", "INDEX", "1d"),
]


def cmd_probe(args) -> int:
    from datetime import timedelta

    ok = True
    for name in (args.source,) if args.source else ("yfinance",):
        print(f"\n=== {name} ===")
        try:
            src = get_source(name)
        except DataSourceError as e:
            print(f"  unavailable: {e}")
            ok = False
            continue

        end = now_ist()
        for symbol, segment, interval in [
            ("NIFTY", "INDEX", "5m"),
            ("NIFTY", "INDEX", "1d"),
            ("RELIANCE", "EQUITY", "1d"),
        ]:
            try:
                bars = src.candles(symbol, interval, end - timedelta(days=30), end, segment)
                if bars:
                    print(
                        f"  OK   {symbol:10} {segment:7} {interval:4} "
                        f"{len(bars):5} bars  last={bars[-1].c:.2f} @ {bars[-1].dt:%Y-%m-%d %H:%M}"
                    )
                else:
                    print(f"  EMPTY {symbol:10} {segment:7} {interval:4}")
                    ok = False
            except Exception as e:
                print(f"  FAIL {symbol:10} {segment:7} {interval:4}  {type(e).__name__}: {e}")
                ok = False
    return 0 if ok else 1


def cmd_sync(args) -> int:
    src = get_source(args.source)
    store = CandleStore()

    if args.symbol:
        targets = [(args.symbol, args.segment, args.interval)]
    else:
        targets = DEFAULT_SYNC

    total_new = 0
    for symbol, segment, interval in targets:
        try:
            res = store.sync(src, symbol, interval, segment, days=args.days)
        except Exception as e:
            print(f"FAIL {symbol:10} {interval:4}  {type(e).__name__}: {e}")
            continue
        total_new += res["new"]
        print(
            f"{symbol:10} {interval:4} fetched={res['fetched']:6} new={res['new']:6} "
            f"banked={res['count']:7}  {res['first'][:10] if res['first'] else '-'} "
            f".. {res['last'][:10] if res['last'] else '-'}"
        )
    print(f"\n{total_new} new bars archived.")
    return 0


def cmd_inventory(args) -> int:
    rows = CandleStore().inventory()
    if not rows:
        print("Store is empty. Run: python -m engine.cli sync")
        return 0
    print(f"{'symbol':12} {'seg':8} {'tf':5} {'bars':>8}  {'from':10} .. {'to':10}")
    print("-" * 62)
    for r in rows:
        print(
            f"{r['symbol']:12} {r['segment']:8} {r['interval']:5} "
            f"{r['count']:8}  {r['first']} .. {r['last']}"
        )
    return 0


def cmd_status(args) -> int:
    try:
        st = market_status()
    except HolidayCalendarMissing as e:
        print(f"holiday calendar: {e}")
        return 1
    print(f"{now_ist():%Y-%m-%d %H:%M:%S %Z}  ->  {st['label']}  ({st['reason']})")
    if st.get("past_square_off"):
        print("  past intraday square-off time (15:20)")
    return 0


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="engine.cli", description="ScalpAI v2 engine")
    p.add_argument("-v", "--verbose", action="store_true")
    sub = p.add_subparsers(dest="cmd", required=True)

    pr = sub.add_parser("probe", help="check which data providers work right now")
    pr.add_argument("--source")
    pr.set_defaults(fn=cmd_probe)

    sy = sub.add_parser("sync", help="fetch and archive candles into the local store")
    sy.add_argument("--source", default="yfinance")
    sy.add_argument("--symbol")
    sy.add_argument("--segment", default="INDEX")
    sy.add_argument("--interval", default="5m")
    sy.add_argument("--days", type=int, help="override the lookback window")
    sy.set_defaults(fn=cmd_sync)

    inv = sub.add_parser("inventory", help="show archived history")
    inv.set_defaults(fn=cmd_inventory)

    st = sub.add_parser("status", help="market open/closed right now")
    st.set_defaults(fn=cmd_status)

    args = p.parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.WARNING,
        format="%(levelname)s %(name)s: %(message)s",
    )
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
