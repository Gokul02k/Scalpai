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

from .config import load_env
from .data import CandleStore, available_sources, get_source, market_status, now_ist
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
    for name in (args.source,) if args.source else available_sources():
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


def cmd_backtest(args) -> int:
    from .backtest import BacktestConfig, get_cost_model, run_backtest

    store = CandleStore()
    candles = store.read(args.symbol, args.segment, args.interval)
    if len(candles) < 200:
        print(
            f"Only {len(candles)} bars archived for {args.symbol} {args.interval}. "
            f"Run: python -m engine.cli sync --symbol {args.symbol} --interval {args.interval}"
        )
        return 1

    config = BacktestConfig(
        symbol=args.symbol,
        interval=args.interval,
        instrument=args.symbol,
        mode=args.mode,
        window=args.window,
        min_confidence=args.min_confidence,
        min_pass_points=args.min_pass_points,
        step=args.step,
        eval_window_ms=int(args.eval_hours * 3600 * 1000),
    )
    if args.profit_pct is not None:
        config.settings["profitPct"] = args.profit_pct
    if args.sl_pct is not None:
        config.settings["slPct"] = args.sl_pct

    result = run_backtest(candles, config, get_cost_model(args.costs))

    print()
    for line in result.summary_lines():
        print("  " + line)
    print()

    if args.show and result.logs:
        print(f"  {'date':12} {'time':11} {'act':4} {'conf':>4} "
              f"{'entry':>9} {'target':>9} {'stop':>9} {'outcome':8} {'pts':>7}")
        print("  " + "-" * 84)
        for e in result.logs[: args.show]:
            o = e.get("outcome") or {}
            pts = ""
            if o.get("resolvedPrice") is not None and e.get("entry") is not None:
                d = 1 if e["action"] == "BUY" else -1
                pts = f"{(o['resolvedPrice'] - e['entry']) * d:+.1f}"
            print(
                f"  {e['date']:12} {e['time']:11} {e['action']:4} {e['confidence']:4} "
                f"{e.get('entry') or 0:9.2f} {e.get('target') or 0:9.2f} "
                f"{e.get('stopLoss') or 0:9.2f} "
                f"{slog_label(o.get('status')):8} {pts:>7}"
            )
        print()

    stats = result.stats
    if stats["resolved"] and stats["expectancyNetPts"] <= 0:
        print("  Negative expectancy after costs. Automating this loses money faster.")
    return 0


def slog_label(status: str | None) -> str:
    from .core.signal_log import OUTCOME_LABELS

    return OUTCOME_LABELS.get(status or "pending", "Active")


def cmd_research(args) -> int:
    from .research import bonferroni_threshold, run_all

    store = CandleStore()
    daily = store.read(args.symbol, "INDEX", "1d")
    hourly = store.read(args.symbol, "INDEX", "1h")
    intraday = store.read(args.symbol, "INDEX", "5m")

    if not daily:
        print(f"No daily history for {args.symbol}. Run: python -m engine.cli sync")
        return 1

    print(f"\n  {args.symbol}: {len(daily)} daily, {len(hourly)} hourly, "
          f"{len(intraday)} 5m bars")

    findings = run_all(daily, hourly, intraday)
    threshold = bonferroni_threshold(len(findings))

    print(f"  {len(findings)} hypotheses tested — significance bar after "
          f"multiple-testing correction: p < {threshold:.4f}\n")
    print(f"  {'hypothesis':46} {'n':>6} {'mean%':>8} {'95% CI':>19} {'p':>8}")
    print("  " + "-" * 92)

    survivors = []
    for f in findings:
        lo, hi = f.ci95
        mark = "  <-- survives" if (f.p_value < threshold and f.n >= 30) else ""
        if mark:
            survivors.append(f)
        print(
            f"  {f.name[:46]:46} {f.n:6} {f.mean:+8.4f} "
            f"[{lo:+7.4f},{hi:+7.4f}] {f.p_value:8.4f}{mark}"
        )

    print()
    if not survivors:
        print("  Nothing survives correction. No conditional structure large enough")
        print("  to build on was found in this data.")
    else:
        print(f"  {len(survivors)} effect(s) survive. Before trusting any of them, check")
        print("  the effect size against round-trip costs — significance is not edge:")
        for f in survivors:
            print(f"    {f.name}: {f.mean:+.4f}% per occurrence, n={f.n}")
            if f.note:
                print(f"      {f.note}")
    print()
    return 0


def cmd_fyers_auth(args) -> int:
    """Fyers tokens last one trading day, so this runs every morning."""
    from .data.fyers_source import build_auth_url, exchange_auth_code

    if args.auth_code:
        exchange_auth_code(args.auth_code)
        print("Token saved. Verify with: python -m engine.cli probe --source fyers")
        return 0

    try:
        url = build_auth_url()
    except Exception as e:
        print(f"Cannot build auth URL: {e}")
        return 1

    print("1. Open this URL in a browser and log in:\n")
    print(f"   {url}\n")
    print("2. You land on your redirect URI with ?auth_code=... in the address bar.")
    print("3. Copy that value and run:\n")
    print("   python -m engine.cli fyers-auth --auth-code <PASTE>\n")
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

    bt = sub.add_parser("backtest", help="replay the live decision path over archived candles")
    bt.add_argument("--symbol", default="NIFTY")
    bt.add_argument("--segment", default="INDEX")
    bt.add_argument("--interval", default="5m")
    bt.add_argument("--mode", default="scalp", choices=["scalp", "swing", "longterm"])
    bt.add_argument("--window", type=int, default=375,
                    help="bars fed to the engine per evaluation (default matches production)")
    bt.add_argument("--min-confidence", type=int, default=80)
    bt.add_argument("--min-pass-points", type=float, default=50,
                    help="favourable move required to count as a pass")
    bt.add_argument("--eval-hours", type=float, default=24,
                    help="how long a signal stays live before expiring; scale this "
                         "with the timeframe or every daily-bar signal expires unresolved")
    bt.add_argument("--profit-pct", type=float, help="override settings.profitPct")
    bt.add_argument("--sl-pct", type=float, help="override settings.slPct")
    bt.add_argument("--step", type=int, default=1, help="evaluate every Nth bar")
    bt.add_argument("--costs", default="index_points",
                    choices=["index_points", "option_buy", "equity_intraday", "equity_delivery"])
    bt.add_argument("--show", type=int, default=0, help="print the N most recent signals")
    bt.set_defaults(fn=cmd_backtest)

    rs = sub.add_parser("research", help="test for conditional structure worth trading")
    rs.add_argument("--symbol", default="NIFTY")
    rs.set_defaults(fn=cmd_research)

    fa = sub.add_parser("fyers-auth", help="daily Fyers login (tokens expire each day)")
    fa.add_argument("--auth-code", help="the code from the redirect URL")
    fa.set_defaults(fn=cmd_fyers_auth)

    args = p.parse_args(argv)
    logging.basicConfig(
        level=logging.INFO if args.verbose else logging.WARNING,
        format="%(levelname)s %(name)s: %(message)s",
    )
    load_env()
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
