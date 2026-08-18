# ScalpAI → Algo Trading: Phased Plan

Converting ScalpAI from a signal dashboard into an executing algo on the Fyers
API, with open-source ML for signal quality.

> **Broker changed from Groww to Fyers (18 Aug 2026).** The plan was written
> around the Groww Trading API. What actually got built is a Fyers adapter
> (`engine/data/fyers_source.py`): OAuth app flow, daily token, 5-minute history
> back to 2017, quotes, and the live option chain that `engine.cli costs` prices
> a round trip from. Execution on Fyers extends that one adapter instead of
> onboarding a second broker on separate credentials, and it removes the
> ₹499/mo Groww subscription from the cost table below.
>
> What the change does **not** buy: the static IP whitelisted with the broker is
> the SEBI algo framework rather than a Groww requirement, so the VPS stays; and
> Fyers tokens still expire daily, so the pre-open re-auth job is still needed —
> today's `engine.cli fyers-auth` is interactive and has to become a TOTP flow
> before anything can start itself. Groww references below stand as written
> where they describe the shape of the work rather than the vendor.

**Instruments chosen:** NIFTY weekly options (intraday scalp) + cash equity (swing).
No futures — margin requirement rejected.

Every phase ends in a **gate**. Do not start the next phase until the gate passes.
The gates exist so that a strategy without an edge gets killed cheaply, before
infrastructure and subscription money is spent on it.

---

## What already exists

The decision side of the system is largely built. Worth being explicit about it,
because the plan below reuses all of it rather than starting over.

| Component | File | Reuse |
|---|---|---|
| Indicator maths (RSI, MACD, BB, EMA, ATR, VWAP, opening range, FVG) | `app/lib/indicators.js` | Port to Python |
| Signal rules | `app/lib/signals.js` | Port to Python |
| Weighted vote → action + confidence | `app/lib/suggestion.js` (`voteFromFactors`) | Port, then replace confidence with ML |
| Risk-first level sizing with min R:R and `viable:false` gate | `app/lib/suggestion.js` (`tradeLevels`) | Port; extend for options |
| Outcome grading with MFE/MAE | `app/lib/signalLog.js` (`evaluateSignalOutcome`) | Port; becomes the backtest scorer |
| Dedupe / session merge | `app/lib/signalLog.js` (`decideSignalLog`) | Port as-is |
| Headless tick loop | `app/lib/niftyLogTick.js` | Becomes the engine main loop |
| Server-side kill switch pattern | `app/lib/alertSettings.js` | Extend into the full risk kill switch |
| Telegram push | `app/lib/telegram.js` | Reuse for fill/error/halt alerts |

### What is missing

Order execution, position state, real-time data, broker reconciliation, risk
limits, an NSE holiday calendar (`marketHours.js` only handles weekends), and any
notion of what instrument a NIFTY signal actually maps to.

---

## Phase 0 — Validate the edge

**Cost: ₹0. Time: ~1 week (mostly waiting for data to accumulate).**

Nothing else in this document matters if this phase fails.

1. Dump the Upstash NIFTY log and run `summarizeOutcomes` over it. Record win
   rate, sample size, and the distribution of `mfePct` / `maePct`.
2. Model real costs per round trip: brokerage, STT, exchange transaction charges,
   SEBI turnover fee, stamp duty, GST, plus assumed slippage. For NIFTY options
   assume the bid-ask spread costs you half a tick each way at minimum.
3. Compute expectancy: `(winRate × avgWin) − ((1 − winRate) × avgLoss) − costs`.
4. Separately check the calibration problem already visible in the code: the cron
   runs with `profitPct: 1.5` (≈375 points on a 25,000 NIFTY — a swing move, not a
   scalp) while `NIFTY_MIN_PASS_POINTS` grades a pass at 50 points, over a 24-hour
   `NIFTY_EVAL_WINDOW_MS`. Those three numbers describe three different strategies.
   Decide which one you are actually trading.

**Gate:** positive expectancy after costs, on a sample of at least 100 resolved
signals. If the sample is too small, keep the logger running and come back. If
expectancy is negative, stop — automating a losing strategy only loses money
faster.

---

## Phase 1 — Honest backtest

**Cost: ₹499/mo. Time: 2–3 weeks.**

The existing log is a forward record of a few hundred signals. That is not enough
to trust. Groww provides candles back to 2020.

1. Subscribe to the Groww Trading API. Complete OAuth setup and 2FA.
2. Stand up `engine/` as a Python service. Port `indicators.js`, `signals.js`,
   `suggestion.js`, `signalLog.js` — roughly 1,500 lines. Port with unit tests that
   assert the Python output matches the JS output on identical candle input; any
   divergence here silently invalidates everything downstream.
3. Pull 5-minute NIFTY index candles from 2020 onward. Note the request limit:
   30 days per call at 1–5 minute intervals, so this is a paginated crawl.
4. Build a replay harness (VectorBT or a plain loop — VectorBT if you want fast
   parameter sweeps). Feed candles through the real engine bar by bar, never
   letting it see future bars.
5. Grade with the ported `evaluateSignalOutcome`, with costs and slippage applied.
6. Walk-forward validate: fit any parameters on one window, test on the next,
   roll forward. A single in-sample backtest across 2020–2026 will look great and
   mean nothing.

**Gate:** positive expectancy out-of-sample, across at least two distinct market
regimes (include 2022's drawdown and a low-volatility stretch). Also check that
the result does not depend on one or two outlier trades.

---

## Phase 2 — Options translation layer

**Time: 1–2 weeks.** This is new code with no equivalent in the current repo.

The core design decision: **the signal stays on the index, the option is only the
execution vehicle.** Entry and exit triggers fire on NIFTY spot levels, exactly as
`tradeLevels` computes them today. The option position is opened and closed in
response to those spot triggers. This preserves the entire existing engine. The
alternative — setting stops on option premium — decouples exits from the signal
and throws away the risk-reward logic you already built.

**Direction handling.** Both directions are option *purchases*: a BUY signal buys
a CE, a SELL signal buys a PE. Never sell/write options. This keeps risk defined
at the premium paid, removes margin calls entirely, and means the worst case per
trade is known before entry.

**Strike selection.** Use the option chain API (added Nov 2025). Pick near-ATM
weekly strikes only — ATM delta near 0.5, so a 50-point index move is roughly a
25-point premium move. Far-OTM strikes have wide spreads that will eat a scalp
edge whole. Add a hard liquidity filter on open interest and spread width, and
reject the trade if it fails.

**Time stop — mandatory, and new.** Theta is irrelevant over a 20-minute hold and
fatal over a 24-hour one. The current `NIFTY_EVAL_WINDOW_MS` of 24 hours cannot
carry over to a real option position. Set an explicit maximum hold (start with one
hour) and exit on it regardless of signal state.

**Expiry-day handling.** Gamma on expiry day makes premium behaviour wildly
non-linear against spot. Simplest safe policy: no new entries on expiry day.
Revisit later if the data says otherwise.

**Sizing.** Compute lots from the premium outlay and your per-trade capital cap,
not from index points. Verify the current NIFTY lot size against the contract spec
before hardcoding it — it has been revised more than once.

**Backtest it.** Option candles are available from 2020, so re-run Phase 1 against
actual option contracts rather than index points. Expect the numbers to be
noticeably worse than the index backtest. That gap is the real cost of the
execution vehicle, and it is the number that matters.

**Gate:** the option-level backtest still shows positive expectancy after costs.

---

## Phase 3 — ML confidence model

**Time: 1–2 weeks.** Optional but high value.

`voteFromFactors` currently scores confidence as
`min(90, 42 + agreement × 35 + |margin| × 4)`. Those constants are guesses, and
the 80-point logging threshold inherits their arbitrariness.

1. Build a feature table from the backtest: one row per signal, columns for each
   factor type and weight, RSI, MACD histogram, EMA positions, distance to
   support/resistance, VWAP side, opening-range state, liquidity ratio, FVG
   status, time of day, and realised volatility.
2. Label with the graded outcome (target hit before stop = 1).
3. Train LightGBM or XGBoost. Walk-forward split, never random — random splits
   leak future information into training and produce a model that looks excellent
   and fails live.
4. Calibrate the output (Platt scaling or isotonic) so a predicted 0.8 genuinely
   means 80% of those trades win.
5. Replace the confidence formula with the calibrated probability. Re-tune the
   entry threshold on the calibrated scale.

**Gate:** the model beats the hand-tuned formula out-of-sample on both Brier
score and realised expectancy. If it does not, keep the formula — it is simpler
and you already understand its failure modes.

---

## Phase 4 — Infrastructure

**Time: 1–2 weeks.**

Vercel cannot host this: serverless has no persistent WebSocket, no long-lived
process, and no static IP. The dashboard can stay there as a read-only view.

**Done (18 Aug 2026):**

- **Read-only JSON service.** `python -m engine.cli serve` exposes `/status`,
  `/candles`, `/quote` and `/analysis` over the archive and the decision path;
  `/api/candles` and `/api/market` prefer it and fall back to Yahoo when it is
  down, not configured, or knowingly behind the tape. Set `ENGINE_URL` to turn
  it on — unset, as on Vercel, nothing changes. See `engine/README.md`.
- **NSE holiday calendar in `marketHours.js`**, mirrored from
  `engine/data/timeutil.py` and diffed against it by `test_market_hours_parity.py`.

**Required:**

- VPS in an Indian region with a **static IP**, whitelisted with the broker.
  Mandatory under the SEBI framework in force since 1 April 2026, regardless of
  order rate. Not a Groww-specific requirement — Fyers needs it too.
- OAuth 2.0 with 2FA. API sessions close at end of day, so a morning re-auth
  routine is required — build it as a pre-open task with a Telegram alert on
  failure, because a silent auth failure means the algo simply does not trade.
  This is live today: `engine.cli serve` logs "Fyers token issued … has expired"
  and serves the archive, and the dashboard falls back to Yahoo. Correct
  behaviour, and it means the chart is only as live as the last `fyers-auth`.
- Fyers WebSocket feed replaces `yahooServer.js` for anything the engine acts on.
  Yahoo stays as the dashboard's fallback.
- Redis (your existing Upstash) for positions, open orders, daily P&L, kill-switch
  state, and an idempotency key set.
- **Idempotency on every order.** Deterministic key per signal. A retry, a restart,
  or an overlapping tick must never be able to double the position.
- Reconciliation loop, every 30 seconds: fetch broker positions and orders, diff
  against internal state, halt and alert on mismatch. Never let internal state be
  the source of truth about money.
- Market orders must carry a **non-zero market protection value** — plain market
  orders are no longer permitted through broker APIs.
- Order rate stays under 10/sec (a 5-minute loop is nowhere near it), so no
  exchange algo registration is needed.

**Architecture.** Python engine owns data, decisions, orders, and state, and
exposes read-only JSON. The existing Next.js app reads that endpoint and renders
what it already renders. No trading logic in the Node layer.

---

## Phase 5 — Risk layer

**Time: ~1 week. Non-negotiable — this ships before the first real order.**

- Max daily loss, hard halt for the session when hit
- Max concurrent positions
- Max capital per trade, and max total deployed
- Global kill switch, server-side (extend the `alertSettings.js` pattern — it is
  already the right design: stored server-side so it works with every client closed)
- Forced square-off at 15:20 for all intraday positions
- Circuit breaker: halt after N consecutive API errors or rejected orders
- Telegram alert on every fill, halt, reconciliation mismatch, and auth failure
- Startup safety check: refuse to trade if broker state and internal state disagree

---

## Phase 6 — Paper trading

**Minimum one month. Do not shorten this.**

Full engine, live Groww data, real strike selection, orders computed and logged
but never sent. Simulate fills at the far side of the spread — assuming mid-price
fills is the most common way a paper record flatters a strategy.

**Gate:** paper results are within a reasonable band of the Phase 2 backtest. A
large divergence means the backtest is wrong, and finding out here is free.

---

## Phase 7 — Live, micro size

**Minimum one month.**

Smallest possible size — one lot, capital you would not mind losing entirely.
The goal is not profit; it is discovering the differences between paper and real
that only real money reveals: actual slippage, partial fills, rejections, and
your own reaction to a live drawdown.

Scale only after a month of live results tracking paper results.

---

## Phase 8 — Cash equity track (parallel, slower)

Separate from the options work and much less time-critical.

`getPortfolioSuggestion` already blends technicals, fundamentals (P/E, ROE, debt,
growth, analyst targets) and news sentiment. That is a swing engine and it suits
equity well.

**The constraint that shapes this whole track:** selling delivery holdings
requires TPIN verification, which **cannot be automated** — not via the API, not
via MCP. Two workable options:

- **Intraday only (MIS):** fully automatable, square off same day, no TPIN.
- **Delivery buy-only (CNC):** algo accumulates, you sell manually. Fits the
  existing fundamentals-weighted `longterm` mode well.

Pick one before building. Restrict the universe to liquid large caps with a
minimum average traded value.

---

## Phase 9 — AI layer

Once the algo is live and stable.

Conversational portfolio queries — replacing the current `/api/chat` route with
something that can actually see your positions. Human-in-the-loop only; it must
never sit in the execution path.

Originally specced as **Groww MCP** (`https://mcp.groww.in/mcp`). With execution
on Fyers there is no equivalent hosted MCP, so this becomes a thin MCP server
over `engine.cli serve` — which is the better shape anyway, since the engine
already holds positions and the P&L and the model would otherwise be reading
them from a second source.

**Ollama running Llama 3.x or Qwen** locally, to drop the Gemini/Groq dependency.
Note you are already using open-weight models — Groq's `llama-3.3-70b-versatile`
is Meta's open model, just hosted.

**FinBERT or a local LLM as a news veto gate.** You already fetch and sentiment-tag
news. Wire it as a veto that blocks entries into adverse headlines — never as an
entry trigger. A veto can only make the algo trade less, which is the safe
direction for a non-deterministic component to fail in.

---

## Regulatory summary

SEBI's retail algo framework has been fully in force since 1 April 2026.

| Requirement | Applies |
|---|---|
| Static IP whitelisted with broker | All API users, any volume |
| OAuth 2.0 + mandatory 2FA | All API users |
| Daily session expiry | All API users |
| Orders tagged as algo orders | Broker-side, automatic |
| Non-zero market protection on market orders | All API users |
| Exchange algo registration + audit | Only at ≥10 orders/sec — not applicable here |
| DDPI authorisation | Required to sell holdings |
| TPIN verification | Manual only, cannot be automated |

Self-built algos are permitted for personal use and immediate family (spouse,
dependent children, dependent parents). Sharing or selling the strategy outside
that is not permitted. The broker is the principal and is responsible for
monitoring compliance.

---

## Cost summary

| Item | Cost |
|---|---|
| ~~Groww Trading API~~ — dropped, execution moves to Fyers | ~~₹499/mo~~ ₹0 |
| Fyers API (data + orders, one app credential) | ₹0 |
| VPS with static IP (Indian region) | ~₹500–1,500/mo |
| Upstash Redis | Free tier likely sufficient |
| Open-source ML stack (LightGBM, VectorBT, Ollama) | ₹0 |
| Trading capital for Phase 7 | Your call — treat as fully at risk |

Roughly ₹500–1,500/month in running costs before capital, now that the broker
API subscription is gone.

---

## Realistic timeline

Phases 0–5 are around 8–10 weeks of part-time work. Phases 6–7 add two months of
mandatory observation that cannot be compressed. Call it four to five months to
live trading at meaningful size, assuming every gate passes on the first attempt.

The most likely outcome — and this is worth internalising before starting — is
that Phase 0 or Phase 1 kills the current strategy and you iterate on the signal
rules before any of the infrastructure gets built. That is the plan working
correctly, not the plan failing.
