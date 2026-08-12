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
├── backtest/      bar-by-bar replay, Indian cost models
├── tests/         66 tests, most of them parity against the live JavaScript
└── cli.py
```

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

### Current result: no measurable edge

NIFTY, across every timeframe and mode currently available:

| Timeframe | Mode | Trades | Period | Win rate | Profit factor | Net pts/trade |
|---|---|---|---|---|---|---|
| 5m | scalp | 11 | 60 days | 18% | 0.36 | −40.8 |
| 1h | scalp | 292 | 23 months | 36% | 0.92 | −12.4 |
| 1d | swing | 1,235 | 19 years | 37% | 0.99 | −6.5 |
| 1d | longterm | 1,150 | 19 years | 47% | 1.02 | −3.5 |

The important column is profit factor, and the important fact is that **it
converges to 1.00 as the sample grows**: 0.36 on 11 trades, 0.92 on 292, 0.99
on 1,235, 1.02 on 1,150. Gross wins and gross losses cancel almost exactly.

That is the signature of no edge rather than of a bad edge. The small-sample
results are not evidence of a worse strategy — they are noise around the same
zero. On the largest samples the strategy is a fair coin flip before costs and
a losing one after.

Reward:risk is consistently fine (roughly 1.6:1); the hit rate simply lands
wherever break-even is. On the daily swing series break-even needs 37.6% and
the strategy delivers 37%.

Two supporting observations:

* **Raising the confidence threshold does not help.** On 5-minute data results
  are flat from 75 through 90. If confidence ranked signals by quality the
  90+ subset would outperform. It does not, so the number reads like a
  confidence without behaving like one.
* **BANKNIFTY flips sign with the threshold** (+3.6, −4.4, +6.6, −12.9 across
  75/80/85/90), which is noise, not edge. It also runs a different code path —
  `collect_factors` only applies the scalp factor set when the instrument is
  NIFTY, so those are two strategies, not one on two symbols.

The most likely explanation is the ordinary one: RSI, MACD, Bollinger Bands and
moving-average crossovers on a liquid index contain no information the market
has not already priced. This is the expected result for standard indicators,
not a defect in the implementation.

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
corrected bar. The opening-range result matters for v1 specifically, since
`suggestion.py` votes on breaks of the opening range — that factor is
contributing noise.

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
backtest with costs, and an edge measurement across 19 years and ~2,700 trades.

**Do not build execution against this strategy.** The infrastructure work —
VPS, static IP, OAuth, order management, reconciliation, risk limits — is
several weeks and only pays off on top of a real edge. There isn't one yet.

Price-only structure has now been searched fairly thoroughly: fifty hypotheses
across nineteen years, and the one large effect found is decaying out of
tradeability. That is informative rather than merely disappointing — it says
the remaining edge, if any, is not in the price series alone.

Reasonable next steps, in rough order of expected value:

1. **Options positioning.** The one major data source not yet examined, and
   the one with the best prior: open-interest shifts, put/call skew, max-pain
   drift into expiry, and India VIX term structure. This is information about
   *positioning* rather than past prices, so it is not ruled out by anything
   above. Needs a Fyers account for the chain data.
2. **Drop the opening-range factor from the vote**, or verify it separately.
   The research finds no predictive content in opening-range breaks, so it is
   currently adding noise to every signal.
3. **Try LightGBM on the existing features** — cheap, and it can find
   nonlinear combinations a linear vote misses. Calibrate expectations: if the
   features carry no information, no model manufactures any.
4. **Keep v1 as decision support.** A dashboard that surfaces levels and
   context for a human is legitimately useful, and is what the current signal
   quality actually supports.

Paper trading is deliberately absent from that list. Paper trading a zero-edge
strategy confirms it makes no money, slowly.
