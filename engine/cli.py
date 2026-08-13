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

    names = (args.source,) if args.source else available_sources()
    any_working = False

    for name in names:
        print(f"\n=== {name} ===")
        source_ok = True
        try:
            src = get_source(name)
        except DataSourceError as e:
            print(f"  unavailable: {e}")
            source_ok = False
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
                    source_ok = False
            except Exception as e:
                print(f"  FAIL {symbol:10} {segment:7} {interval:4}  {type(e).__name__}: {e}")
                source_ok = False
        if source_ok:
            any_working = True

    if args.source:
        return 0 if any_working else 1
    # Probing all providers: succeed if at least one works (Fyers is optional).
    return 0 if any_working else 1


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


def _load_candles(symbol: str, segment: str, interval: str):
    store = CandleStore()
    candles = store.read(symbol, segment, interval)
    if len(candles) < 200:
        print(
            f"Only {len(candles)} bars archived for {symbol} {interval}. "
            f"Run: python -m engine.cli sync --symbol {symbol} --interval {interval}"
        )
        return None
    return candles


def cmd_ab(args) -> int:
    """Measure strategy variants against v1 over identical bars."""
    from .backtest import BacktestConfig, Variant, format_comparison, get_cost_model, run_variants
    from .core.suggestion import StrategyFlags

    candles = _load_candles(args.symbol, args.segment, args.interval)
    if candles is None:
        return 1

    def cfg(**kw) -> BacktestConfig:
        c = BacktestConfig(
            symbol=args.symbol,
            interval=args.interval,
            instrument=args.symbol,
            mode=args.mode,
            min_confidence=args.min_confidence,
            min_pass_points=args.min_pass_points,
            step=args.step,
        )
        for k, v in kw.items():
            setattr(c, k, v)
        return c

    variants = [
        Variant("v1", cfg()),
        Variant("no-opening-range", cfg(flags=StrategyFlags(use_opening_range=False))),
    ]

    print(f"\n  {len(candles)} bars, {args.symbol} {args.interval}\n")
    results = run_variants(candles, variants, get_cost_model(args.costs))
    for line in format_comparison(results):
        print(line)
    print()
    return 0


def cmd_costs(args) -> int:
    """Measure the real round-trip cost from a live option chain."""
    from .backtest.calibrate import (
        StrikeCost, measure_chain, summarize, theta_for_hold, tradeable,
    )
    from .backtest.costs import OptionBuyCost
    from .data import get_source

    try:
        chain = get_source("fyers").option_chain(args.symbol, strike_count=args.strikes)
    except Exception as e:
        print(f"Cannot fetch chain: {e}")
        print("Fyers token expires daily. Refresh: python -m engine.cli fyers-auth")
        return 1

    rows, meta = measure_chain(chain, OptionBuyCost(lot_size=args.lot_size))
    if not rows:
        print("Chain returned no usable quotes.")
        return 1

    status = market_status()
    print(f"\n  {args.symbol}  spot {meta['spot']:.2f}  "
          f"forward {meta['future']:.2f} (parity)  "
          f"expiry {meta['expiry_date']} ({meta['days_to_expiry']:.1f}d)  "
          f"VIX {meta['vix']:.2f}  lot {meta['lot_size']}")
    drift = meta["future"] - meta["reported_future"]
    if abs(drift) > 5:
        print(f"  chain reports fp={meta['reported_future']:.2f}, {drift:+.1f} from the "
              f"parity forward — using parity, fp is a different contract")
    if not status.get("open"):
        print("\n  MARKET CLOSED — these are closing quotes. Spreads at the close are")
        print("  usually wider than during active trading, so read this as an upper")
        print("  bound and re-run between 09:15 and 15:30 before acting on it.")
    print()

    print(StrikeCost.header())
    print("  " + "-" * 112)
    for r in rows:
        print(r.line())

    near = tradeable(rows)
    print(f"\n  tradeable strikes (delta 0.35-0.70, with volume), {len(near)} of them:")
    stats = summarize(near) or summarize(rows)
    if not stats:
        print("  no strike had a solvable delta")
        return 1

    print(f"    median spread          {stats['median_spread_pts']:.2f} premium pts")
    print(f"    median statutory       {stats['median_charges_pts']:.2f} premium pts")
    print(f"    median delta           {stats['median_delta']:.2f}")
    print(f"    MEDIAN INDEX-PT COST   {stats['median_index_pts']:.2f} pts per round trip")
    print(f"    best / worst strike    {stats['best_index_pts']:.2f} / "
          f"{stats['worst_index_pts']:.2f}")

    friction = stats["median_index_pts"]
    theta = theta_for_hold(near, meta["future"], meta["days_to_expiry"] / 365, args.hold_hours)

    print(f"\n  spread + charges       {friction:.2f} index pts")
    if theta:
        print(f"    theta over {args.hold_hours:.1f}h      {theta.index_pts:.2f} index pts  "
              f"({theta.theta_per_day:.1f} premium pts/day at delta {theta.delta:.2f})")
        total = friction + theta.index_pts
        print(f"  TOTAL ROUND TRIP       {total:.2f} index pts")
    else:
        total = friction
        print("  (theta not priced — no strike had a solvable vol)")

    print(f"\n  The backtest assumes 6.00. Measured: {total:.2f}.")
    if total > 6.0:
        print(f"  Understated by {total - 6.0:.2f} pts/trade.")
    else:
        print(f"  Conservative by {6.0 - total:.2f} pts/trade.")
    print(f"    python -m engine.cli ml --cached --cost-pts {total:.2f}")

    print("\n  Not included: slippage beyond the touch on market orders, book depth")
    print("  past one lot, and spread widening in fast conditions. VIX is "
          f"{meta['vix']:.1f} here,")
    print("  which is a calm regime — measure again when it is 20+.")
    print()
    return 0


def cmd_option_pnl(args) -> int:
    """Re-price the strategy's trades as options rather than index points."""
    from pathlib import Path

    from .backtest.option_pnl import OptionMarket, repriced
    from .ml.model import load_dataset

    cache = Path(__file__).parent / "var" / f"mlset_{args.symbol}_{args.interval}.json"
    if not cache.exists():
        print(f"No dataset at {cache.name}. Run: python -m engine.cli ml")
        return 1

    samples, _ = load_dataset(cache)
    if args.resolved_only:
        samples = [s for s in samples if s.status in ("target", "stop")]
    market = OptionMarket(
        days_to_expiry=args.days_to_expiry,
        iv=args.iv / 100,
        spread_pts=args.spread,
        lot_size=args.lot_size,
        strike_offset=args.strike_offset,
    )

    n_expired = sum(1 for s in samples if s.status == "expired")
    print(f"\n  {len(samples)} trades re-priced as long options"
          + (f" ({n_expired} expired, held to the window and closed out)"
             if n_expired else ""))
    print(f"  {market.days_to_expiry:.1f}d to expiry, IV {args.iv:.1f}%, "
          f"spread {market.spread_pts:.2f} premium pts, "
          f"strike {market.strike_offset:+.0f} from spot\n")

    result = repriced(samples, market)
    if result is None:
        print("  Could not price any trade.")
        return 1

    for line in result.lines():
        print(line)

    if args.sweep:
        print("\n  sensitivity — net index pts/trade:\n")
        ivs = [8.0, 10.0, 14.0, 18.0, 25.0]
        spreads = [0.30, 0.60, 1.20, 2.00]
        print("    " + "IV%".ljust(8) + "".join(f"sprd {s:<7.2f}" for s in spreads))
        for iv in ivs:
            cells = []
            for sp in spreads:
                r = repriced(samples, OptionMarket(
                    days_to_expiry=args.days_to_expiry, iv=iv / 100, spread_pts=sp,
                    lot_size=args.lot_size, strike_offset=args.strike_offset,
                ))
                cells.append(f"{r.option_net_per_trade:+11.2f}" if r else f"{'-':>11}")
            print(f"    {iv:<8.0f}" + "".join(cells))
        print("\n  Higher IV cuts both ways: it raises the premium paid and the theta")
        print("  bled, but the same move earns less because delta is spread wider.")

    print()
    if result.option_net_per_trade > 0:
        print("  Survives as an option.")
    else:
        print("  Does not survive as an option. The index-point edge is consumed by")
        print("  the cost of the instrument used to capture it.")
    print()
    return 0


def cmd_ml(args) -> int:
    """Fit the signal filter and report what it is worth out of sample."""
    from pathlib import Path

    from .backtest import BacktestConfig, get_cost_model, run_backtest
    from .core.suggestion import StrategyFlags
    from .ml.model import (
        build_dataset, importances, load_dataset, save_dataset, seed_robustness,
        train, walk_forward,
    )

    cache = Path(__file__).parent / "var" / f"mlset_{args.symbol}_{args.interval}.json"

    if args.cached and cache.exists():
        samples, cost = load_dataset(cache)
        print(f"\n  loaded {len(samples)} cached samples from {cache.name}\n")
        if args.cost_pts is not None:
            cost = args.cost_pts
    else:
        candles = _load_candles(args.symbol, args.segment, args.interval)
        if candles is None:
            return 1

        config = BacktestConfig(
            symbol=args.symbol,
            interval=args.interval,
            instrument=args.symbol,
            mode=args.mode,
            min_confidence=args.min_confidence,
            min_pass_points=args.min_pass_points,
            step=args.step,
            collect_features=True,
            flags=StrategyFlags(use_opening_range=not args.no_opening_range),
        )
        print(f"\n  replaying {len(candles)} bars to collect training data…")
        result = run_backtest(candles, config, get_cost_model(args.costs))
        # Cached with expired trades included so `option-pnl` can price them;
        # training drops them below.
        samples = build_dataset(result.logs, include_expired=True)
        cost = result.stats.get("costPerTradePts") or 6.0
        save_dataset(samples, cache, cost)
        print(f"  {len(samples)} signals with features (cached to {cache.name})\n")
        if args.cost_pts is not None:
            cost = args.cost_pts

    expired = [s for s in samples if s.status == "expired"]
    samples = [s for s in samples if s.status in ("target", "stop")]
    if expired:
        print(f"  {len(expired)} expired signals held back from training "
              f"(no target/stop to learn from)")
    print(f"  {len(samples)} resolved signals, cost assumption {cost:.2f} index pts")
    if len(samples) < 500:
        print("  Too few samples to validate a model honestly. Widen the period.")
        return 1

    report = walk_forward(samples, cost_pts=cost, n_folds=args.folds)
    if report is None:
        print("  Not enough samples to build walk-forward folds.")
        return 1

    for line in report.lines():
        print(line)

    if args.seeds > 1:
        print(f"\n  re-running under {args.seeds} seeds — a result that depends on the")
        print("  draw is not a result:\n")
        spreads, aucs, recent = seed_robustness(
            samples, cost_pts=cost, n_folds=args.folds, seeds=range(args.seeds)
        )
        for s in spreads:
            print(s.line())
        print(f"\n  AUC across seeds  {min(aucs):.3f} .. {max(aucs):.3f}")
        if recent:
            ok = sum(1 for v in recent if v > 0)
            print(f"  most recent fold  net {min(recent):+.2f} .. {max(recent):+.2f} "
                  f"across seeds, {ok}/{len(recent)} positive")
            if ok < len(recent):
                print("  The filter does not hold in the current regime. Older folds")
                print("  carrying the average is not a reason to switch it on.")
        if not any(s.robust for s in spreads):
            print("\n  No keep-fraction holds up across seeds. The apparent gain is")
            print("  sampling noise, not an edge.")

    print("\n  feature importance (model fit on all samples, for reading only):")
    for name, pct in importances(train(samples))[:12]:
        print(f"    {name:22} {pct:5.1f}%")

    print()
    if report.oos_auc < 0.55:
        print("  AUC is close to chance, so the model barely ranks winners above")
        print("  losers. Any economic gain is coming from trade selection by size")
        print("  rather than by direction — check it holds across seeds before")
        print("  trusting it.")
    print()
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

    ab = sub.add_parser("ab", help="compare strategy variants over identical bars")
    ab.add_argument("--symbol", default="NIFTY")
    ab.add_argument("--segment", default="INDEX")
    ab.add_argument("--interval", default="5m")
    ab.add_argument("--mode", default="scalp", choices=["scalp", "swing", "longterm"])
    ab.add_argument("--min-confidence", type=int, default=80)
    ab.add_argument("--min-pass-points", type=float, default=50)
    ab.add_argument("--step", type=int, default=1)
    ab.add_argument("--costs", default="index_points",
                    choices=["index_points", "option_buy", "equity_intraday", "equity_delivery"])
    ab.set_defaults(fn=cmd_ab)

    ml = sub.add_parser("ml", help="fit and validate the learned signal filter")
    ml.add_argument("--symbol", default="NIFTY")
    ml.add_argument("--segment", default="INDEX")
    ml.add_argument("--interval", default="5m")
    ml.add_argument("--mode", default="scalp", choices=["scalp", "swing", "longterm"])
    ml.add_argument("--min-confidence", type=int, default=80)
    ml.add_argument("--min-pass-points", type=float, default=50)
    ml.add_argument("--step", type=int, default=1)
    ml.add_argument("--folds", type=int, default=4)
    ml.add_argument("--cached", action="store_true",
                    help="reuse the last collected dataset instead of replaying")
    ml.add_argument("--seeds", type=int, default=10,
                    help="rerun under N seeds to separate edge from luck (1 to skip)")
    ml.add_argument("--cost-pts", type=float,
                    help="override the round-trip cost, e.g. from `engine.cli costs`")

    ct = sub.add_parser("costs", help="measure real round-trip cost from a live option chain")
    ct.add_argument("--symbol", default="NIFTY")
    ct.add_argument("--strikes", type=int, default=10, help="strikes each side of ATM")
    ct.add_argument("--lot-size", type=int, default=75)
    ct.add_argument("--hold-hours", type=float, default=6.0,
                    help="average holding period, for pricing theta")
    ct.set_defaults(fn=cmd_costs)

    op = sub.add_parser("option-pnl",
                        help="re-price the backtest's trades as options, with theta and gamma")
    op.add_argument("--symbol", default="NIFTY")
    op.add_argument("--interval", default="5m")
    op.add_argument("--days-to-expiry", type=float, default=4.7)
    op.add_argument("--iv", type=float, default=10.0, help="implied vol in percent")
    op.add_argument("--spread", type=float, default=0.60, help="premium points of spread")
    op.add_argument("--lot-size", type=int, default=75)
    op.add_argument("--strike-offset", type=float, default=0.0,
                    help="strike distance from spot in index points; 0 is ATM")
    op.add_argument("--resolved-only", action="store_true",
                    help="exclude expired trades (flatters the result; for comparison only)")
    op.add_argument("--sweep", action="store_true",
                    help="grid the result over implied vol and spread")
    op.set_defaults(fn=cmd_option_pnl)
    ml.add_argument("--no-opening-range", action="store_true",
                    help="collect data from the variant with the opening-range factor removed")
    ml.add_argument("--costs", default="index_points",
                    choices=["index_points", "option_buy", "equity_intraday", "equity_delivery"])
    ml.set_defaults(fn=cmd_ml)

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
