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
├── backtest/      bar-by-bar replay, Indian cost models, variant comparison
├── research/      hypothesis tests with multiple-testing correction
├── ml/            signal features and the walk-forward-validated filter
├── tests/         102 tests, most of them parity against the live JavaScript
└── cli.py
```

Commands: `status`, `probe`, `sync`, `inventory`, `backtest`, `ab`, `ml`,
`research`, `fyers-auth`.

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

* Costs are the assumed 6 index points. Real weekly-option round trips near
  the money may differ, and at +3.20 net there is not much room.
* 130 trades in the deployable fold. Meaningful, not conclusive.
* Fold 0 shows the filter needs roughly 600+ graded trades before it helps.
* Backtest, not live. Nothing here has met a real spread.

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

Next steps, in rough order of expected value:

1. **Confirm the real cost per round trip.** The whole conclusion sits on the
   6-point assumption. Pull actual weekly-option spreads near the money from
   the Fyers chain and re-run. If the true cost is 10 points, the filtered edge
   mostly disappears and everything below is moot.
2. **Forward-test the filter on paper.** Now worth doing, which it was not
   before: run the filter live against real ticks and compare its selections to
   backtest expectations. No orders.
3. **Test momentum after a large up day** (+0.238%, n=698). Largest untested
   effect in the research table, and cheap to check.
4. **Options positioning.** Open-interest shifts, put/call skew, max-pain drift
   into expiry, India VIX term structure. The one major data source not yet
   examined, and information about *positioning* rather than past prices, so
   nothing above rules it out.
5. **Retrain cadence.** Fold 0 shows the filter needs ~600 graded trades to
   help. Decide how often it refits and on what window before it runs live.

Keeping v1 as decision support remains legitimate regardless. A dashboard that
surfaces levels and context for a human is useful independently of whether the
automated version clears costs.
