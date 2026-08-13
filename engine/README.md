# ScalpAI v2 — trading engine

Python backend that owns market data, indicators, signals, backtesting and
(later) execution. Runs on your own machine — no Vercel, no serverless. The
Next.js app becomes a read-only view over this.

Branch layout: `version-1.0` pins the v1 dashboard, `version-2.0` is this work.

---

## Setup

```bash
python3 -m venv .venv
.venv/bin/pip install -r engine/requirements.txt
```

Python 3.13. `pip` was missing from the system Python; `python3 -m ensurepip
--upgrade` fixes that if you rebuild the venv.

```bash
.venv/bin/python -m engine.cli status      # market open/closed
.venv/bin/python -m engine.cli probe       # which data providers work
.venv/bin/python -m engine.cli sync        # archive candles locally
.venv/bin/python -m engine.cli inventory   # what history is banked
.venv/bin/python -m engine.cli backtest --show 20
.venv/bin/python -m pytest engine/tests -q
```

---

## Market data

One `DataSource` contract, several providers, chosen by name. Swapping
providers is a config change.

| Provider | Cost | Intraday history | Options | Account |
|---|---|---|---|---|
| **yfinance** | free | rolling 60 days at 5m, 8 days at 1m | none | not needed |
| **Fyers** | free | 1m from 3 Jul 2017 | full chain | required |
| Groww | ₹499/mo | from 2020 | yes | required |

Two libraries commonly recommended for NSE data were tested and do **not**
work: `openchart` returns empty results and wrong symbol matches, and NSE's
`api/option-chain-indices` endpoint returns 404.

Groww is the most expensive of the three and has the shallowest history. Fyers
covers everything it does, for free, with six more years of minute data.

### Why the local archive exists

Every free provider serves a *rolling* window. yfinance drops 5-minute bars
older than 60 days permanently — that history is not retrievable later at any
price. `engine.cli sync` merges each pull into a SQLite store, so running it on
a schedule converts a disappearing window into history you own. Re-syncing an
overlapping range is idempotent.

A weekly cron is enough:

```
0 18 * * 6 cd /home/gokul/Scalpai && .venv/bin/python -m engine.cli sync
```

### Fyers setup

1. Open a Fyers account, create an app at <https://myapi.fyers.in/dashboard>
2. Put `FYERS_CLIENT_ID`, `FYERS_SECRET_KEY`, `FYERS_REDIRECT_URI` in `.env.local`
3. `python -m engine.cli fyers-auth` — **tokens expire daily**, so this is a
   morning ritual, not a one-off

The adapter talks to the v3 REST API directly rather than through the official
`fyers-apiv3` SDK, which hard-pins `aiohttp==3.9.3` (no Python 3.13 wheel, fails
to build) and pulls `aws_lambda_powertools` and therefore boto3 into what will
eventually be an order-placing process.

---

## Layout

```
engine/
├── data/          provider adapters, SQLite archive, IST + NSE holiday calendar
├── core/          strategy ported from app/lib/*.js, behaviourally identical
├── backtest/      replay, cost models, variant comparison, option re-pricing
├── research/      hypothesis tests with multiple-testing correction
├── ml/            signal features and the walk-forward-validated filter
├── tests/         153 tests, most of them parity against the live JavaScript
└── cli.py
```

Commands: `status`, `probe`, `sync`, `inventory`, `backtest`, `ab`, `ml`,
`costs`, `option-pnl`, `regime`, `research`, `fyers-auth`.

### On the port

`core/` reproduces `indicators.js`, `signals.js`, `suggestion.js` and
`signalLog.js` exactly, pinned by tests that run the real JavaScript under Node
and diff the output. That matters because a backtest of an *approximation* of
your strategy tells you nothing about your strategy.

Most of the difficulty was JavaScript semantics, not trading logic: `toFixed`
rounds ties away from zero while Python uses banker's rounding, `Math.round`
breaks ties toward +∞, `String(12.0)` is `"12"` not `"12.0"`, `toLocaleString
('en-IN')` groups by twos above the last three digits, `{}` is truthy in JS and
falsy in Python, and `JSON.stringify` drops `undefined` keys. `core/jsnum.py`
carries these.

Two v1 behaviours are preserved even though they look like bugs: the EMA seeds
from the first value rather than an SMA, and the RSI uses a simple mean instead
of Wilder's smoothing. Both are worth revisiting — as measured changes, in
their own commits, so a port bug and a deliberate change stay distinguishable.

---

## Open-source AI stack

The AI that decides trades is not a language model, and the part that matters
runs comfortably on CPU. No GPU is required for any of it.

| Layer | Tool | RAM | Role |
|---|---|---|---|
| Trade confidence | **LightGBM** + scikit-learn | <1 GB | Replaces the hand-tuned confidence formula with a probability calibrated on real graded outcomes |
| News sentiment | **FinBERT** (110M) | ~2 GB | Veto gate — blocks longs into hostile news |
| Chat / journaling | **Qwen2.5 7B** or **Llama 3.1 8B**, Q4 via Ollama | ~6 GB | Explaining and reviewing, never in the execution path |

LightGBM is the one that earns its keep. `suggestion.py` currently derives
confidence from `42 + agreement * 35 + |margin| * 4`, capped at 90, and the
80-point logging threshold inherits that formula's arbitrariness. Those
constants were chosen by hand and have never been validated against outcomes.

Keep the LLM out of the trading loop permanently — it is non-deterministic, and
an unattended order path needs decisions that are reproducible and auditable.

### System requirements

Measured against this machine: 32 vCPU AMD EPYC 7763, 30 GB RAM, 218 GB free,
**no GPU** (virtio display only).

| Workload | Verdict |
|---|---|
| LightGBM / XGBoost training | Trivial. Seconds on 32 cores, well under 1 GB |
| FinBERT inference | Fine. ~50–100 ms per headline on CPU |
| 7–8B LLM, Q4 | Fine. ~10–15 tok/s |
| 14B LLM, Q4 | Usable. ~5–8 tok/s |
| 32B LLM, Q4 | Painful. ~2–3 tok/s, ~20 GB |
| 70B | Won't fit — needs ~40 GB |

CPU inference is bottlenecked by memory bandwidth rather than core count, and
this is a VM slice, so treat the token rates as estimates until benchmarked.

Not installed yet, deliberately, to keep the environment light — add them when
the relevant phase starts:

```bash
.venv/bin/pip install transformers torch --index-url https://download.pytorch.org/whl/cpu
curl -fsSL https://ollama.com/install.sh | sh && ollama pull qwen2.5:7b
```

---

## Backtesting

```bash
.venv/bin/python -m engine.cli backtest --symbol NIFTY --interval 5m --show 20
.venv/bin/python -m engine.cli backtest --min-confidence 85 --costs option_buy
```

The replay hands the engine the same 5-day trailing window production requests
and grades with the same `evaluate_signal_outcome` used on live signals, so the
backtest number and the live number are directly comparable.

Costs are modelled, not ignored. A scalp targeting fifty index points is
working with roughly 0.2% of notional, which is the same order of magnitude as
its own round-trip cost, so a cost-free backtest answers a different question
than the one being asked. Models cover option-buy, equity intraday and equity
delivery with STT, exchange fees, SEBI turnover, stamp duty, GST and spread.

Where a single bar contains both target and stop, the stop wins. Intrabar
ordering is unknown, and assuming the favourable fill is the standard way a
backtest flatters itself.

### Current result: a real but too-thin edge

On the full 5-minute archive — 168,177 bars, 21 Jul 2017 to 11 Aug 2026:

```
signals logged    1494        win rate          42%
resolved          1356        avg win           +78.3 pts
                              avg loss          −46.4 pts
profit factor     1.21        gross/trade       +5.65 pts
max drawdown      3402 pts    cost/trade        −6.00 pts
                              net/trade         −0.35 pts
```

The number that matters is the profit factor of **1.21 gross**. The indicators
do carry signal; over nine years they extracted about 7,660 index points. Costs
took 8,140. The strategy is not wrong about direction — it is too small to
survive its own friction.

That distinction changes what "improve the strategy" means. Break-even needs
either 6% more gross per trade or 6% fewer trades at the same quality, so
**cutting bad trades is worth more than finding a new signal**.

Longer timeframes on the same code, for reference:

| Timeframe | Mode | Trades | Period | Win rate | Profit factor | Net pts/trade |
|---|---|---|---|---|---|---|
| 5m | scalp | 1,356 | 9 years | 42% | 1.21 | −0.35 |
| 1h | scalp | 292 | 23 months | 36% | 0.92 | −12.4 |
| 1d | swing | 1,235 | 19 years | 37% | 0.99 | −6.5 |
| 1d | longterm | 1,150 | 19 years | 47% | 1.02 | −3.5 |

One supporting observation that motivated everything below: **raising the
confidence threshold does not help.** Results are flat from 75 through 90. If
`vote_from_factors` ranked signals by quality, the 90+ subset would outperform.
It does not, so the number reads like a confidence without behaving like one —
and that is a fixable problem rather than an absence of edge.

---

## Strategy variants

```bash
.venv/bin/python -m engine.cli ab      # v1 vs variants over identical bars
```

Variants live behind `StrategyFlags` rather than as edits to the strategy, so
the default path stays byte-identical to v1 and the parity tests keep meaning
what they say. A failing parity test is then always a port bug, never an
intentional change hiding in the same diff.

### Removing the opening-range factor makes things worse

The research below finds no directional edge in opening-range breaks
(mean ≈ 0.0003%, p = 0.99), which looked like a clear case for deleting the
factor. Measured over the same 168k bars, it is not:

| | v1 | opening range removed |
|---|---|---|
| trades | 1,356 | 1,298 |
| win rate | 42.0% | 41.0% |
| gross pts/trade | +5.65 | +5.16 |
| **net pts/trade** | **−0.35** | **−0.84** |
| profit factor | 1.21 | 1.19 |
| max drawdown | 3,402 | 4,054 |

The factor is not a directional predictor, and it is also not noise. It votes
`HOLD` while price sits inside the opening range, which damps confidence on
setups that have not yet chosen a side, and removing that damping lets worse
trades through. The learned filter independently agrees: `or_pos` is its third
most useful feature.

The general lesson is worth more than the specific result. A univariate test
answers "does this predict direction on its own", which is not the question
"does removing this from a multi-factor vote help".

---

## Learned signal filter

```bash
.venv/bin/python -m engine.cli ml               # collect, train, validate
.venv/bin/python -m engine.cli ml --cached      # reuse the dataset (fast)
```

Replaces the hand-tuned confidence with a LightGBM model fit on 37 features
extracted at signal time, trained on the strategy's own graded outcomes. It
does not predict the market; it predicts which of *this strategy's* signals
reach target, so the rest can be skipped.

Validation is chronological and expanding: fold *k* trains on everything before
a cut date and tests after it. The keep-threshold is a quantile of the
**training** predictions, never the test set — choosing it on test data is the
easiest way to leak the answer and the hardest to notice afterwards.

### Result

Out-of-sample AUC is **0.528**, which is barely above chance. Taken alone that
reads as failure, and the economics still improve sharply:

| Keep | Trades | Win rate | Gross/trade | Net/trade |
|---|---|---|---|---|
| all (baseline) | 956 | 41.0% | +4.21 | **−1.79** |
| top 50% | 483 | 44.1% | +9.20 | **+3.20** |
| top 40% | 344 | 43.9% | +11.86 | +5.86 |
| top 30% | 196 | 44.9% | +12.60 | +6.60 |
| top 20% | 94 | 46.8% | +13.13 | +7.13 |

Win rate moves only 3 points while gross more than doubles, which says the
model is selecting for **payoff rather than direction** — it is finding setups
where the fixed target/stop geometry is favourable, not calling the market
better. That is a weaker claim than "it predicts winners", and it is the claim
the data actually supports.

Two checks before believing it. Across 10 seeds, every keep-fraction stays
positive (top 50%: +1.62 to +3.09, 10/10 positive), so the result is not a
lucky draw. And by fold:

| Fold | Period | Train | AUC | Baseline | Filtered |
|---|---|---|---|---|---|
| 0 | Apr 2020 – Jan 2021 | 400 | 0.452 | −7.86 | **−9.95** |
| 1 | Jan 2021 – Feb 2022 | 639 | 0.576 | −2.60 | +5.30 |
| 2 | Feb 2022 – Feb 2024 | 878 | 0.566 | +4.01 | +11.76 |
| 3 | **Feb 2024 – Aug 2026** | 1,117 | 0.549 | −0.69 | **+8.08** |

Fold 0 is a genuine failure — the filter made a bad period worse, on the
smallest training set and with sub-chance AUC. That the failure is at the
*start* rather than the end is the encouraging direction: it looks like a
learning curve, not a decaying edge. Fold 3 is the current regime and the only
one that speaks to switching this on today; it holds at +5.31 to +11.30 across
all 10 seeds.

### What this does not establish

* 130 trades in the deployable fold. Meaningful, not conclusive.
* Fold 0 shows the filter needs roughly 600+ graded trades before it helps.
* Backtest, not live. Nothing here has met a real spread.

---

## What a round trip really costs

```bash
.venv/bin/python -m engine.cli costs                  # measure a live chain
.venv/bin/python -m engine.cli option-pnl --sweep     # re-price the backtest
```

Everything above is denominated in index points, but the index is not
tradeable. The execution vehicle is a weekly option, and until its cost is
measured the whole result rests on an assumed 6 points per round trip.

### Measuring the chain

Measured on a live NIFTY weekly chain (18 Aug 2026 expiry, 4.7 days out,
India VIX 11.4), for strikes with delta between 0.35 and 0.70:

| | |
|---|---|
| median spread | 0.60 premium pts |
| median statutory charges | 0.83 premium pts |
| median delta | 0.52 |
| **round trip** | **2.75 index pts** |

The conversion is the part worth internalising: **premium points divide by
delta to become index points.** At delta 0.52, every premium point of cost is
about two index points. A 0.60-point spread that looks trivial against a
78-point average win is really 1.15 index points before any fee.

One correction was needed to get this right. The chain reports a futures price
of 24,467 while put-call parity across all 21 strikes gives 24,438 — the
reported figure belongs to a different contract. Feeding the wrong forward to
the solver split call and put implied vols apart (6–8% against 10–15%) and
biased every delta. `forward_from_parity` recovers the right one, after which
both sides agree at 9–11%, consistent with VIX at 11.4.

### Re-pricing the trades as options

A scalar cost cannot represent an option, because the instrument is nonlinear
in two directions at once:

* **Theta** bleeds the position while held — a cost the index-points backtest
  cannot see at all.
* **Gamma** pays the buyer. A winning move earns more than `delta x move`
  because delta grows into it, and a losing move costs less for the same
  reason.

So `option-pnl` prices each of the 1,494 trades at entry and at exit with
Black-76, using its actual holding period. Median hold is 1.4 hours, which
matters: an assumed six-hour hold overstates theta roughly fourfold.

| Per trade, in index points | |
|---|---|
| theta | −5.06 |
| gamma | **+6.66** |
| spread + charges | −2.86 |
| **net effect of using options** | **−1.26** |
| index-points gross | +6.32 |
| **option net** | **+5.07** |

Gamma more than covers theta. The effective all-in cost is about **1.3 index
points, not 6.0** — because this strategy's payoff shape (+78 average win
against −46 average loss) is exactly what long convexity rewards.

Expired signals are included. They are the trades that sat there decaying and
paid nothing, and dropping them — as an earlier version of this did — removes
the worst cases and flatters the answer.

### Correction: that number was measured in the wrong regime

The +5.07 above prices every trade at one snapshot's 10% implied vol — a calm
day in August 2026. Nine years of trades did not happen in August 2026.

Pricing each trade at the India VIX that actually prevailed on its date
reverses the conclusion:

| VIX regime | Trades | Share | Index pts | Option pts |
|---|---|---|---|---|
| below 12 | 57 | 3.8% | −5.43 | **−10.02** |
| 12–14 | 163 | 10.9% | +12.35 | **+9.17** |
| 14–18 | 421 | 28.2% | +6.38 | +1.50 |
| 18–25 | 548 | 36.7% | +2.87 | −4.63 |
| above 25 | 305 | 20.4% | +11.43 | −3.58 |

*(weekly IV taken as 0.85 x VIX, the ratio measured on the live chain: 9.7%
against VIX 11.4)*

**The strategy's signals cluster in exactly the regimes where options are
expensive.** Fifty-seven percent of trades fire above VIX 18, and those lose
money as options no matter how good the index-point call was. The
index-points column stays positive throughout; the option column does not.
That gap is the cost of the instrument, and it is regime-dependent.

The bottom row of the earlier sensitivity table was not hypothetical. It was
where most of the trades actually lived.

Note also that **below 12 is bad too**, and not because of cost — the
index-point P&L is itself negative there. Dead-calm tape gives the signals
nothing to catch. The strategy needs movement to be right and cheap options to
get paid, and those two conditions overlap in a narrow band.

For reference, the sensitivity that produced this, holding realised moves
fixed and varying implied vol:

| IV | spread 0.30 | 0.60 | 1.20 | 2.00 |
|---|---|---|---|---|
| 8% | +8.34 | +7.74 | +6.54 | +4.95 |
| 10% | +5.66 | **+5.07** | +3.87 | +2.28 |
| 14% | +1.63 | +1.04 | −0.16 | −1.75 |
| 18% | −1.58 | −2.17 | −3.37 | −4.95 |
| 25% | −6.38 | −6.97 | −8.16 | −9.74 |

**Break-even is around 14% implied vol.** Below it the strategy is a buyer of
cheap convexity; above it, it is paying for movement it does not get.

Shorter-dated options score better (+12.97 at half a day against +5.07 at 4.7
days) because gamma concentrates near expiry. Treat that with suspicion: on
expiry day the constant-vol assumption breaks down, and holds routinely exceed
the option's remaining life.

---

## Regime gate plus filter

```bash
.venv/bin/python -m engine.cli regime --iv-scale 0.85 --with-filter
```

Standing aside above VIX 14 and keeping the top half of the filter's picks, on
out-of-sample trades only:

| | Trades | Net/trade | Total |
|---|---|---|---|
| neither | 956 | −1.67 | −1,600 |
| gate only | 130 | +7.86 | +1,022 |
| filter only | 477 | +2.13 | +1,016 |
| **both** | **57** | **+37.53** | **+2,139** |

They stack rather than overlap, which makes sense — they filter on different
things. The gate asks whether the instrument is cheap; the filter asks whether
the setup is good.

### Checking whether 57 trades means anything

A large mean over a small sample is the most common way a backtest lies, so:

```
mean                 +37.53      median               +58.31
winners              31/57 (54%) mean without best 3   +21.38
by year   2021:+32(6) 2022:+70(1) 2023:+12(16) 2024:+72(11) 2025:+25(14) 2026:+61(9)
```

The median sits *above* the mean, so the result is not a few lucky winners
carrying a mass of losers — if anything a few large losers drag the average
down. Removing the best three trades still leaves +21.38. All six years are
positive.

It is also not knife-edge on the gate level, which would suggest a threshold
fitted to noise. Sweeping it gives a plateau:

| Gate | Trades | Net/trade | Total | Net/trade at IV = 1.0 x VIX |
|---|---|---|---|---|
| 12 | 15 | −4.17 | −63 | — |
| 13 | 29 | +25.00 | +725 | — |
| 14 | 57 | +37.53 | +2,139 | +34.48 |
| 16 | 128 | +21.21 | +2,715 | +18.48 |
| 18 | 160 | +18.51 | +2,962 | +15.82 |

Anywhere from 13 to 18 works, trading per-trade edge against trade count, and
it survives the pessimistic assumption that weekly IV equals VIX outright.
Gate 16–18 is the more practical setting: roughly 21–27 trades a year instead
of 9, at a still-large per-trade edge.

### What this is worth, concretely

At gate 18: ~27 trades a year at +18.5 index points, which at delta 0.52 on a
75-unit lot is about **₹21,600 per year per lot**. Real, but small enough that
execution quality and a single bad fill matter. This is not a strategy that
tolerates sloppiness, and the trade count is low enough that a bad quarter
tells you very little.

### Still not modelled

* **Vega.** Implied vol is held constant from entry to exit. A vol crush after
  a directional move is common and would eat into the gamma gain.
* **The VIX proxy.** VIX is a 30-day measure applied to weeklies, at a fixed
  0.85 ratio taken from one calm chain. In stress the weekly term structure
  inverts and weekly IV exceeds VIX, so the high-VIX buckets are flattered
  here — which strengthens the case for the gate rather than weakening it.
* Spread is held at 0.60 premium points across all regimes. It widens in
  stress, again penalising the buckets the gate already excludes.
* Closing quotes, measured with the market shut, at one point in a calm
  regime. Depth past one lot is unmeasured.

---

## Edge research

```bash
.venv/bin/python -m engine.cli research --symbol NIFTY
```

Different in kind from the backtest. The backtest asks "does this strategy make
money"; this asks "is there any conditional structure worth building a strategy
around". Measuring the conditional distribution first is what stops rules being
fitted to noise.

Every test reports sample size, effect size and a 95% confidence interval, not
just a p-value — on nineteen years of data an effect can be highly significant
and still far too small to survive costs. Fifty hypotheses are tested, so the
bar is Bonferroni-corrected to p < 0.001; at plain p < 0.05 you would expect
two or three false positives by construction.

### What it found

Most of the usual suspects are empty: weekday effects, month effects, gap
continuation, streak reversal and opening-range breakout all fail to clear the
corrected bar.

The opening-range result looked like an immediate fix for v1, since
`suggestion.py` votes on breaks of the opening range. Backtesting the removal
showed the opposite (see above) — a univariate test cannot answer what a factor
contributes inside a multi-factor vote.

The strongest survivor-adjacent finding, and the best untested lead here, is
**momentum after a large up day**: following any close of +1% or more, the next
day averages +0.238% (n=698, CI [+0.111, +0.365], p=0.0029). That misses the
corrected bar of p<0.001, but +0.238% is roughly 57 index points against ~6
points of cost, so the effect size is large enough to be worth a proper test.

One large effect is real. **NIFTY's entire return happens overnight:**

| Component | Mean per day | 95% CI | p |
|---|---|---|---|
| Overnight (prev close → open) | **+0.094%** | [+0.078, +0.111] | ~0 |
| Intraday (open → close) | **−0.049%** | [−0.083, −0.015] | 0.004 |
| Full day (close → close) | +0.045% | [+0.008, +0.082] | 0.018 |

The session itself has *negative* drift. Over 250 sessions that is roughly
−12% a year, which means **any intraday long-biased strategy starts behind
before its signals do anything at all**. That is structural, not a flaw in the
signal logic, and it is part of why the scalp cannot get above break-even.

### And why it is not a free lunch

Splitting by period shows the effect decaying:

| Period | NIFTY overnight | BANKNIFTY overnight |
|---|---|---|
| 2008–2011 | +0.053% | +0.086% |
| 2012–2015 | +0.101% | +0.126% |
| 2016–2019 | +0.127% | +0.113% |
| 2020–2023 | +0.133% | +0.127% |
| **2024–2027** | **+0.049%** (p=0.03) | **+0.016%** (p=0.55) |

NIFTY's overnight drift is now roughly a third of its 2020–2023 level and no
longer clears the corrected bar. BANKNIFTY's has gone entirely. This is the
ordinary life cycle of a published anomaly, and it is exactly what the
period-split test exists to catch.

What remains for NIFTY is about 12 index points a night against roughly 8
points of round-trip cost on futures — and it requires carrying overnight gap
risk, which is the fat tail that ends accounts. Not worth trading on that
margin.

---

## Status

Done: data layer, local archive, Fyers adapter, verified strategy port,
backtest with costs, edge research across 19 years, a strategy-variant harness,
and a walk-forward-validated signal filter.

The picture changed with the full 5-minute archive. The raw strategy is not
edgeless — it is gross-positive at a profit factor of 1.21 and loses to costs.
Filtering it with a learned model turns the recent out-of-sample period from
−0.69 to +8.08 net points per trade, robust across seeds.

**That is still not a reason to build execution yet.** It is one backtest, on
130 deployable-fold trades, against an assumed cost model. But it is the first
result here that justifies continuing rather than stopping.

Costs are now measured rather than assumed, and measured *per regime* rather
than from one snapshot. That second step mattered more than the first: pricing
at a single calm-day vol said the strategy cleared costs comfortably, and
pricing at the vol that actually prevailed said it does not.

What survives is narrower and better supported than the raw strategy. Stand
aside above VIX 16–18, take the filter's better half, and roughly 25 trades a
year clear costs with a per-trade edge that holds up under seed changes, gate
changes, year-by-year splits, and the pessimistic IV assumption.

**This is still not a reason to send orders.** It is a backtest whose
conclusion has already flipped once, on a correction I would not have caught
without the VIX join.

Next steps, in rough order of expected value:

1. **Model vega.** Implied vol is frozen between entry and exit. A crush after
   a directional move is common and attacks the gamma term the whole result
   depends on. Largest remaining hole by some distance.
2. **Add VIX as a model feature** rather than a hard gate, and let the filter
   learn the interaction. The plateau from 13 to 18 suggests a soft boundary
   is closer to the truth than a cliff.
3. **Re-measure the chain intraday, and in a stressed tape.** Both the 0.85 IV
   ratio and the 0.60 spread come from one calm closing snapshot, and both are
   applied to regimes where neither holds.
4. **Forward-test on paper.** Log what the gate plus filter would take, against
   live quotes, and compare fills to the model. No orders.
5. **Test momentum after a large up day** (+0.238%, n=698). Largest untested
   effect in the research table, and cheap to check.
6. **Options positioning.** Open-interest shifts, put/call skew, max-pain drift
   into expiry, VIX term structure. Information about *positioning* rather than
   past prices, so nothing above rules it out.
7. **Retrain cadence.** Fold 0 shows the filter needs ~600 graded trades to
   help. Decide how often it refits, and on what window, before it runs live.

Keeping v1 as decision support remains legitimate regardless. A dashboard that
surfaces levels and context for a human is useful independently of whether the
automated version clears costs.
