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


def cmd_regime(args) -> int:
    """Slice results by volatility regime, pricing each trade at its own VIX."""
    from pathlib import Path

    from .backtest.option_pnl import OptionMarket, price_all
    from .backtest.regime import load_vix, split_by_regime
    from .ml.model import load_dataset

    cache = Path(__file__).parent / "var" / f"mlset_{args.symbol}_{args.interval}.json"
    if not cache.exists():
        print(f"No dataset at {cache.name}. Run: python -m engine.cli ml")
        return 1

    samples, _ = load_dataset(cache)
    vix = load_vix()
    if not len(vix):
        print("No VIX history archived. Run:")
        print("  python -m engine.cli sync --source fyers --symbol INDIAVIX "
              "--interval 1d --days 4000")
        return 1

    lo, hi = vix.span
    print(f"\n  {len(vix)} daily VIX bars, {lo} .. {hi}")
    print(f"  {len(samples)} trades, priced at the VIX prevailing on each date")
    print("  (previous close — the day's own close is not knowable intraday)\n")

    market = OptionMarket(
        days_to_expiry=args.days_to_expiry, spread_pts=args.spread, lot_size=args.lot_size
    )
    scale = args.iv_scale
    if scale != 1.0:
        print(f"  weekly IV taken as {scale:.2f} x VIX "
              f"(measured 9.7% against VIX 11.4 on a live chain)\n")
    rows = price_all(
        samples, market,
        iv_for=lambda s: (v * scale / 100 if (v := vix.vix_at(s.ts_ms)) else None),
    )
    priced = [s for s, _, _ in rows]
    nets = [r.net_index_pts for _, r, _ in rows]

    stats, unmatched = split_by_regime(priced, vix, option_net=nets)
    print(f"  {'regime':12} {'trades':>6} {'share':>6}  {'win':>9}   "
          f"{'index pts':>13}   {'option pts':>15}")
    print("  " + "-" * 76)
    for s in stats:
        if s.trades:
            print(s.line())
    if unmatched:
        print(f"\n  {unmatched} trades had no VIX reading and were skipped")

    import statistics as st

    below = [n for (s, _, _), n in zip(rows, nets) if (v := vix.vix_at(s.ts_ms)) and v < args.gate]
    above = [n for (s, _, _), n in zip(rows, nets) if (v := vix.vix_at(s.ts_ms)) and v >= args.gate]
    print(f"\n  gate at VIX {args.gate:.0f}:")
    if below:
        print(f"    below   {len(below):5d} trades   net {st.mean(below):+7.2f} pts/trade   "
              f"total {sum(below):+9.0f}")
    if above:
        print(f"    above   {len(above):5d} trades   net {st.mean(above):+7.2f} pts/trade   "
              f"total {sum(above):+9.0f}")
    if below and above:
        kept = len(below) / (len(below) + len(above)) * 100
        print(f"    gating keeps {kept:.0f}% of trades and avoids "
              f"{sum(above):+.0f} pts")
        if st.mean(above) > 0:
            print("\n  The high-vol side is also positive, so the gate is not obviously")
            print("  needed. Prefer fewer moving parts unless it earns its place.")

    if args.with_filter:
        _gate_and_filter(rows, nets, vix, args, st)
    print()
    return 0


def _gate_and_filter(rows, nets, vix, args, st) -> None:
    """Do the VIX gate and the learned filter stack, or overlap?"""
    from .ml.model import out_of_sample_indices, walk_forward_selection

    resolved = [(i, s) for i, (s, _, _) in enumerate(rows)
                if s.status in ("target", "stop")]
    trainable = [s for _, s in resolved]
    if len(trainable) < 500:
        print("\n  Too few resolved trades to fit the filter.")
        return

    print(f"\n  stacking the filter on the gate ({len(trainable)} resolved trades,"
          f" {args.seeds} seeds):")

    kept = walk_forward_selection(trainable, keep_frac=args.keep, seeds=range(args.seeds))
    scored = out_of_sample_indices(trainable)

    # Map positions in `trainable` back to positions in `rows`.
    row_of = {j: i for j, (i, _) in enumerate(resolved)}

    def net_of(js) -> list[float]:
        return [nets[row_of[j]] for j in js]

    def calm(j) -> bool:
        v = vix.vix_at(trainable[j].ts_ms)
        return v is not None and v < args.gate

    groups = {
        "no filter, no gate": [j for j in scored],
        "gate only": [j for j in scored if calm(j)],
        "filter only": [j for j in scored if j in kept],
        "filter + gate": [j for j in scored if j in kept and calm(j)],
    }

    print(f"    {'':22}{'trades':>7}{'net/trade':>12}{'total':>10}")
    for label, js in groups.items():
        vals = net_of(js)
        if not vals:
            print(f"    {label:22}{0:>7}{'-':>12}{'-':>10}")
            continue
        print(f"    {label:22}{len(vals):>7}{st.mean(vals):>+12.2f}{sum(vals):>+10.0f}")

    both, gate_only = net_of(groups["filter + gate"]), net_of(groups["gate only"])
    if both and gate_only and st.mean(both) <= st.mean(gate_only):
        print("\n    The filter adds nothing on top of the gate. Once the regime is")
        print("    right, it is not finding anything further.")

    if both:
        _stress(both, groups["filter + gate"], trainable, st)


def _stress(values: list[float], js: list[int], samples, st) -> None:
    """Is the mean the population, or a handful of trades?

    A large mean over a small sample is the most common way a backtest lies.
    Three checks that usually expose it: the median (unaffected by outliers),
    the mean after removing the best few, and whether the result appears in
    more than one year.
    """
    n = len(values)
    ordered = sorted(values, reverse=True)
    top3 = sum(ordered[:3])
    without_top3 = st.mean(ordered[3:]) if n > 3 else 0.0
    positive = sum(1 for v in values if v > 0)

    print(f"\n    is that real? {n} trades is few enough to check:")
    print(f"      mean                 {st.mean(values):+.2f}")
    print(f"      median               {st.median(values):+.2f}")
    print(f"      winners              {positive}/{n} ({positive / n * 100:.0f}%)")
    print(f"      best 3 contribute    {top3:+.0f} of {sum(values):+.0f} "
          f"({top3 / sum(values) * 100:.0f}%)" if sum(values) else "")
    print(f"      mean without best 3  {without_top3:+.2f}")

    by_year: dict[str, list[float]] = {}
    for j, v in zip(js, values):
        year = (samples[j].date or "")[-4:]
        by_year.setdefault(year, []).append(v)
    spread = " ".join(
        f"{y}:{st.mean(vs):+.0f}({len(vs)})" for y, vs in sorted(by_year.items()) if y
    )
    print(f"      by year              {spread}")

    years_positive = sum(1 for vs in by_year.values() if st.mean(vs) > 0)
    if without_top3 <= 0:
        print("\n      Remove three trades and the edge is gone. This is a handful of")
        print("      outliers, not a strategy.")
    elif years_positive < len(by_year) * 0.6:
        print("\n      Most years are negative. The mean is carried by a minority of")
        print("      the period, which is not something to trade forward.")


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

    if not args.no_vix:
        from .backtest.regime import load_vix
        from .ml.model import enrich_with_vix

        vix = load_vix()
        if len(vix):
            matched = enrich_with_vix(samples, vix)
            print(f"  joined VIX regime to {matched}/{len(samples)} samples")
        else:
            print("  no VIX history archived — regime columns will be zero")

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


def cmd_sweep(args) -> int:
    """Test the Tier-1 strategy changes against v1 over the whole archive."""
    from .backtest import BacktestConfig, get_cost_model
    from .backtest.sweep import (
        DEFAULT_WINDOWS, VariantSpec, format_rows, longs_only, regrade,
        rows_to_dicts, run_sweep,
    )
    from .core.suggestion import StrategyFlags

    candles = _load_candles(args.symbol, args.segment, args.interval)
    if candles is None:
        return 1

    base = BacktestConfig(
        symbol=args.symbol, interval=args.interval, instrument=args.symbol,
        min_confidence=args.min_confidence, step=args.step, count_expired=True,
    )
    cost = args.costs

    specs = [VariantSpec("v1 baseline", StrategyFlags())]
    for tgt in args.atr_target:
        specs.append(VariantSpec(
            f"atr target {tgt:.1f}x",
            StrategyFlags(atr_target_mult=tgt, atr_stop_mult=tgt / 2),
        ))

    print(f"\n  {len(candles)} bars, {len(specs)} replays across {args.jobs} cores")
    print("  (long-only and the time exits are derived, not replayed)\n")

    results = run_sweep(candles, specs, base, cost, args.jobs)
    rows = rows_to_dicts(candles)

    print("  Levels and direction, at the inherited 24-hour window")
    print("  every trade counted, including those that expired flat\n")
    table = [(r.name, r.stats) for r in results]
    table += [(f"{r.name} + long only",
               regrade(longs_only(r.logs), rows, 24 * 60 * 60 * 1000,
                       get_cost_model(cost)))
              for r in results]
    for line in format_rows(table, baseline="v1 baseline"):
        print(line)

    print("\n\n  Time-based exit: close at market after N hours if neither")
    print("  level was reached. Same signals throughout.\n")
    baseline = next(r for r in results if r.name == "v1 baseline")
    arms = [("all signals", baseline.logs), ("long only", longs_only(baseline.logs))]
    for label, logs in arms:
        table = [
            (f"{label} @ {name}", regrade(logs, rows, ms, get_cost_model(cost)))
            for name, ms in DEFAULT_WINDOWS
        ]
        for line in format_rows(table):
            print(line)
        print()

    return 0


def cmd_train(args) -> int:
    """Fit the filter on all history and save it for the live runner.

    Deliberately separate from `ml`, which validates. This one trains on
    everything including the most recent period, so the saved model has no
    out-of-sample score of its own — `ml` is where that question is answered,
    and it should be answered before this file is trusted.
    """
    from pathlib import Path

    from .backtest import BacktestConfig, get_cost_model, run_backtest
    from .ml.model import (
        build_dataset, load_dataset, save_dataset, save_model, threshold_for, train,
    )

    out = Path(args.out or Path(__file__).parent / "var" / "filter.txt")
    cache = Path(__file__).parent / "var" / f"mlset_{args.symbol}_{args.interval}.json"

    if args.cached and cache.exists():
        samples, _ = load_dataset(cache)
        print(f"\n  loaded {len(samples)} cached samples")
    else:
        candles = _load_candles(args.symbol, args.segment, args.interval)
        if candles is None:
            return 1
        print(f"\n  replaying {len(candles)} bars…")
        result = run_backtest(
            candles,
            BacktestConfig(symbol=args.symbol, interval=args.interval,
                           instrument=args.symbol, collect_features=True),
            # Labels come from whether the trade reached target or stop, so the
            # cost model does not touch them; it only prices the summary this
            # command discards. Index points is the only unit a replay over
            # index candles can express.
            get_cost_model("index_points"),
        )
        samples = build_dataset(result.logs, include_expired=True)
        save_dataset(samples, cache, result.stats.get("costPerTradePts") or 6.0)
        print(f"  {len(samples)} signals collected")

    if not args.no_vix:
        from .backtest.regime import load_vix
        from .ml.model import enrich_with_vix

        vix = load_vix()
        if len(vix):
            matched = enrich_with_vix(samples, vix)
            print(f"  joined VIX regime to {matched}/{len(samples)} samples")
        else:
            print("  no VIX history archived — regime columns will be zero")

    trainable = [s for s in samples if s.status in ("target", "stop")]
    if len(trainable) < 200:
        print(f"  only {len(trainable)} resolved trades — too few to fit. Sync more history.")
        return 1

    model = train(trainable, {
        "seed": args.seed,
        "bagging_seed": args.seed,
        "feature_fraction_seed": args.seed,
    })
    cutoff = threshold_for(model, trainable, args.keep_frac)
    save_model(model, out, {
        "trained_on": len(trainable),
        "keep_frac": args.keep_frac,
        "threshold": cutoff,
        "period": f"{trainable[0].date} .. {trainable[-1].date}",
        "seed": args.seed,
    })

    print(f"\n  trained on   {len(trainable)} resolved trades")
    print(f"  period       {trainable[0].date} .. {trainable[-1].date}")
    print(f"  keep frac    {args.keep_frac:.0%}  ->  score threshold {cutoff:.4f}")
    print(f"  saved        {out}\n")
    print("  Validate before trusting it:  python -m engine.cli ml --cached")
    print(f"  Then run:                     python -m engine.cli paper --gate {args.gate}\n")
    return 0


def cmd_paper(args) -> int:
    """Trade on paper against the live market: signals, strikes, fills, P&L."""
    import time as _time
    from pathlib import Path

    from .live.book import PaperBook
    from .live.runner import PaperConfig

    var = Path(__file__).parent / "var" / "paper"
    book = PaperBook.load(Path(args.book) if args.book
                          else var / f"{now_ist():%Y-%m-%d}.json")

    if args.report:
        print(f"\n  {book.path}")
        return _paper_report(book)

    model, threshold = None, args.min_score
    if not args.no_filter:
        from .ml.model import load_model

        path = Path(args.model or Path(__file__).parent / "var" / "filter.txt")
        if not path.exists():
            print(f"\n  no model at {path}. Train one first:")
            print("    python -m engine.cli train\n")
            print("  Or run the strategy unfiltered with --no-filter\n")
            return 1
        model, meta = load_model(path)
        if threshold is None:
            threshold = meta.get("threshold")
        print(f"\n  filter    {path.name}  threshold {threshold:.4f} "
              f"(trained on {meta.get('trained_on', '?')} trades)")

    config = PaperConfig(
        symbol=args.symbol, interval=args.interval, instrument=args.symbol,
        gate=args.gate, min_score=threshold, lots=args.lots,
        max_open=args.max_open, min_confidence=args.min_confidence,
        shadow=not args.no_shadow,
    )

    try:
        source = get_source(args.source)
    except Exception as e:
        print(f"\n  cannot reach {args.source}: {e}\n")
        return 1

    print(f"  gate      stand aside above VIX {config.gate:.1f}")
    print(f"  size      {config.lots} lot ({config.lots * config.lot_size} qty), "
          f"max {config.max_open} open")
    if config.shadow:
        print("  shadow    declined signals followed separately, not counted")
    print(f"  book      {book.path}")
    print(f"  source    {args.source}\n")

    if args.once:
        _paper_tick(source, book, config, model)
        return _paper_report(book)

    try:
        status = market_status()
    except HolidayCalendarMissing:
        status = {"open": True, "label": "unknown", "reason": "no holiday calendar"}
    if not status["open"] and not args.force:
        print(f"  market is {status['label']} ({status['reason']}).")
        print("  Use --force to run anyway against the last available bars.\n")
        return 0

    print(f"  ticking every {args.every}s until square-off. Ctrl-C to stop.\n")
    try:
        while True:
            _paper_tick(source, book, config, model)
            if now_ist().time() >= config.squareoff_at and not book.open_positions:
                print("\n  square-off passed and the book is flat.\n")
                break
            _time.sleep(args.every)
    except KeyboardInterrupt:
        print("\n  stopped.\n")
    return _paper_report(book)


def _paper_tick(source, book, config, model) -> None:
    """One tick, with network failures survivable and bugs still visible.

    A dropped connection at 11:04 must not end the session, but swallowing
    every exception into a one-line message hides real defects for a whole
    trading day, so anything that is not a data-source failure prints its
    traceback.
    """
    import traceback

    from .data.base import DataSourceError
    from .live.runner import evaluate

    try:
        result = evaluate(source, book, config, model)
    except DataSourceError as e:
        book.note("error", str(e))
        book.save()
        print(f"{now_ist():%H:%M:%S}  data source: {e}")
        return
    except Exception as e:
        book.note("bug", f"{type(e).__name__}: {e}")
        book.save()
        print(f"{now_ist():%H:%M:%S}  unexpected {type(e).__name__}: {e}")
        traceback.print_exc()
        return

    print(result.line())
    for trade in result.closed:
        print(f"          closed {trade.position['symbol']} {trade.exit_reason} "
              f"@ {trade.exit_premium:.2f}  ->  Rs {trade.net_rupees:+,.0f}")
    book.save()


def _paper_report(book) -> int:
    print("\n  paper results")
    for line in book.summary_lines():
        print(line)
    for pos in book.open_positions:
        print(f"  open: {pos.action} {pos.symbol} @ {pos.entry_premium:.2f} "
              f"(target {pos.target_index:,.0f} / stop {pos.stop_index:,.0f})")

    if book.shadow_closed or book.shadow_open:
        print("\n  declined signals, followed but not counted")
        for line in book.summary_lines(shadow=True):
            print(line)
    for line in book.verdict_lines():
        print(line)
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
    ml.add_argument("--no-vix", action="store_true",
                    help="omit the volatility-regime features, to measure what they add")

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

    rg = sub.add_parser("regime", help="slice results by India VIX regime")
    rg.add_argument("--symbol", default="NIFTY")
    rg.add_argument("--interval", default="5m")
    rg.add_argument("--days-to-expiry", type=float, default=4.7)
    rg.add_argument("--spread", type=float, default=0.60)
    rg.add_argument("--lot-size", type=int, default=75)
    rg.add_argument("--gate", type=float, default=14.0,
                    help="VIX level to test as a stand-aside threshold")
    rg.add_argument("--iv-scale", type=float, default=1.0,
                    help="weekly IV as a multiple of VIX; VIX is a 30-day measure")
    rg.add_argument("--with-filter", action="store_true",
                    help="also test the learned filter stacked on the gate")
    rg.add_argument("--keep", type=float, default=0.5, help="filter keep fraction")
    rg.add_argument("--seeds", type=int, default=10)
    rg.set_defaults(fn=cmd_regime)
    ml.add_argument("--no-opening-range", action="store_true",
                    help="collect data from the variant with the opening-range factor removed")
    ml.add_argument("--costs", default="index_points",
                    choices=["index_points", "option_buy", "equity_intraday", "equity_delivery"])
    ml.set_defaults(fn=cmd_ml)

    rs = sub.add_parser("research", help="test for conditional structure worth trading")
    rs.add_argument("--symbol", default="NIFTY")
    rs.set_defaults(fn=cmd_research)

    sw = sub.add_parser("sweep", help="test direction, levels and exit timing against v1")
    sw.add_argument("--symbol", default="NIFTY")
    sw.add_argument("--segment", default="INDEX")
    sw.add_argument("--interval", default="5m")
    sw.add_argument("--min-confidence", type=int, default=80)
    sw.add_argument("--step", type=int, default=1)
    sw.add_argument("--costs", default="index_points",
                    help="cost model for the comparison")
    sw.add_argument("--atr-target", type=float, nargs="*", default=[2.0, 3.0, 4.0],
                    help="ATR multiples to try for the target (stop gets half)")
    sw.add_argument("--jobs", type=int, default=8, help="parallel replays")
    sw.set_defaults(fn=cmd_sweep)

    tr = sub.add_parser("train", help="fit the filter on all history and save it for live use")
    tr.add_argument("--symbol", default="NIFTY")
    tr.add_argument("--segment", default="INDEX")
    tr.add_argument("--interval", default="5m")
    tr.add_argument("--keep-frac", type=float, default=0.4,
                    help="fraction of signals to take; sets the score threshold")
    tr.add_argument("--seed", type=int, default=7)
    tr.add_argument("--gate", type=float, default=16.0, help="shown in the next-step hint")
    tr.add_argument("--cached", action="store_true", help="reuse the last collected dataset")
    tr.add_argument("--no-vix", action="store_true",
                    help="omit the volatility-regime features")
    tr.add_argument("--out", help="where to write the model (default engine/var/filter.txt)")
    tr.set_defaults(fn=cmd_train)

    pp = sub.add_parser("paper", help="paper trade live: signals, strikes, simulated fills")
    pp.add_argument("--symbol", default="NIFTY")
    pp.add_argument("--interval", default="5m")
    pp.add_argument("--source", default="fyers",
                    help="fyers gives the option chain; others cannot price strikes")
    pp.add_argument("--gate", type=float, default=16.0,
                    help="stand aside when India VIX is above this")
    pp.add_argument("--min-confidence", type=int, default=80)
    pp.add_argument("--min-score", type=float,
                    help="override the filter threshold saved with the model")
    pp.add_argument("--no-filter", action="store_true",
                    help="run the raw v1 strategy with no learned filter")
    pp.add_argument("--model", help="path to a trained filter")
    pp.add_argument("--lots", type=int, default=1)
    pp.add_argument("--max-open", type=int, default=2)
    pp.add_argument("--no-shadow", action="store_true",
                    help="stop following the signals the filter declined")
    pp.add_argument("--every", type=int, default=120, help="seconds between ticks")
    pp.add_argument("--once", action="store_true", help="evaluate a single tick and exit")
    pp.add_argument("--report", action="store_true",
                    help="print a saved book without trading (use with --book)")
    pp.add_argument("--force", action="store_true", help="run even when the market is shut")
    pp.add_argument("--book", help="journal file (default engine/var/paper/<date>.json)")
    pp.set_defaults(fn=cmd_paper)

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
