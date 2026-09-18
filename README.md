<div align="center">

<img src="public/icons/icon-512.png" alt="ScalpAI" width="110" />

# ScalpAI

<p>
  <img src="https://img.shields.io/badge/Next.js-14-00E676?style=for-the-badge&logo=nextdotjs&logoColor=white&labelColor=040810" alt="Next.js 14" />
  <img src="https://img.shields.io/badge/Python-3.13-4C8DFF?style=for-the-badge&logo=python&logoColor=white&labelColor=040810" alt="Python 3.13" />
  <img src="https://img.shields.io/badge/AI%20Assistant-enabled-8B5CF6?style=for-the-badge&labelColor=040810" alt="AI assistant" />
  <img src="https://img.shields.io/badge/Fyers%20%2B%20Yahoo-data-E3A008?style=for-the-badge&labelColor=040810" alt="Fyers and Yahoo data" />
  <img src="https://img.shields.io/badge/local%20archive-SQLite-A371F7?style=for-the-badge&labelColor=040810" alt="SQLite archive" />
  <img src="https://img.shields.io/badge/app%20ready-PWA-2DD4BF?style=for-the-badge&labelColor=040810" alt="Installable app" />
</p>

An intraday market dashboard and research engine for NIFTY, SENSEX, and BANK NIFTY.
Built to measure whether a scalping idea actually survives costs, data quality, and real market behavior.

<p>
  <a href="#quick-start"><b>Quick Start</b></a> &nbsp;·&nbsp;
  <a href="#why-it-exists"><b>Why it exists</b></a> &nbsp;·&nbsp;
  <a href="engine/README.md"><b>Engine Docs</b></a> &nbsp;·&nbsp;
  <a href="docs/assistant.md"><b>Assistant</b></a> &nbsp;·&nbsp;
  <a href="ALGO-PLAN.md"><b>Plan</b></a>
</p>

</div>

## Overview

ScalpAI is a two-part system:

- The dashboard is a Next.js app that works on its own with free Yahoo market data.
- The Python engine owns the deeper market archive, backtests, model filtering, and paper-trading logic.

The idea is straightforward: if a strategy does not survive the real cost structure, it is not a strategy — it is a story.

> So far, the answer has mostly been: the signal exists, but the edge is smaller than the friction.

## Why it exists

<div align="center">

| Feature | What it does |
| --- | --- |
| 📈 Intraday watchlist | Tracks NIFTY, SENSEX, BANK NIFTY and user-defined stocks/ETFs |
| 🧠 Strategy testing | Replays signals against real data, not a simplified approximation |
| 🗃️ Local archive | Merges rolling provider windows into a local SQLite store you control |
| 🔍 Cost-aware evaluation | Measures round-trip cost per volatility regime instead of assuming a flat fee |
| 🧪 Learned filter | Trains a model to keep only the higher-quality setups from the strategy |
| 📱 Installable app | Runs as a PWA with a mobile-friendly dashboard |

</div>

## What it measures

The important part is not just whether a signal fires — it is whether it survives the actual market structure.

- The project measures real backtest performance on archived bars.
- It tests whether a strategy is robust to costs, not just gross P&L.
- It distinguishes between a signal working and a strategy winning after fees and volatility conditions.

### Current result snapshot

The engine has found a real but thin edge in measured conditions, and the strongest evidence suggests the trade quality matters more than the raw signal count.

- Gross profit factor: 1.21
- Real cost-sensitive behavior is regime dependent
- The filter can improve out-of-sample performance in recent periods
- Long-only and other variants are being evaluated carefully rather than trusted by intuition

## Quick start

### 1) Run the dashboard

```bash
npm install
npm run dev
```

Then open: http://localhost:3000

The dashboard works without a broker key and can use free Yahoo data by default.

### 2) Run the Python engine

```bash
python3 -m venv .venv
.venv/bin/pip install -r engine/requirements.txt

.venv/bin/python -m engine.cli status
.venv/bin/python -m engine.cli probe
.venv/bin/python -m engine.cli sync
.venv/bin/python -m engine.cli backtest --show 20
```

`./start.sh` wraps the recurring workflow for syncing, status checks, paper trading, and dashboard setup.

## Architecture

```text
app/        Dashboard: Next.js App Router
app/lib/    Indicator, signal, and strategy logic mirrored in Python
engine/     Data adapters, archive, research, ML, backtest, and paper trading
docs/       Dashboard documentation and assistant notes
public/     PWA assets, icons, manifest, service worker
scripts/    Setup, sync, paper, and status routines
```

## Project flow

1. Pull market data from Yahoo or Fyers.
2. Merge it into a local SQLite archive.
3. Run the strategy with parity checks against the JS dashboard logic.
4. Backtest and score the strategy under real cost assumptions.
5. Filter weak candidates with a learned model.
6. Run a paper-trading loop before trusting any live behavior.

## Documentation

| Resource | Purpose |
| --- | --- |
| [Engine README](engine/README.md) | Detailed setup, market data, backtests, and strategy notes |
| [Assistant Docs](docs/assistant.md) | AI assistant behavior, prompts, and privacy-related settings |
| [Algorithm Plan](ALGO-PLAN.md) | Roadmap and phases for future development |
| [Market Data Notes](engine/README.md#market-data) | Provider comparison and local archive reasoning |
| [Backtesting](engine/README.md#backtesting) | Replay, variants, and filter performance |
| [Paper Trading](engine/README.md#paper-trading) | Live paper-trading workflow and risk controls |

## Configuration

Copy `.env.example` to `.env.local` if you want to enable environment-backed settings.

Common keys and config include:

- `GEMINI_API_KEY` / `GROQ_API_KEY`
- `FYERS_CLIENT_ID`, `FYERS_SECRET_KEY`, `FYERS_REDIRECT_URI`
- `ENGINE_URL`
- `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`
- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`
- `CRON_SECRET`

Most features are optional; the dashboard still runs without a fully configured environment.

## On your phone

The app is installable as a PWA.

- Chrome: Install app from the menu
- iPhone: Share → Add to Home Screen
- Works best over HTTPS, which is required for install support

This gives it a more native feel while still being served from the same dashboard codebase.

## Assistant

ScalpAI includes two assistant modes:

- Ask EA: reviews a signal card and explains whether it agrees with the call
- Chat assistant: answers questions about holdings and updates local portfolio state

Keys remain browser-local by default, which helps avoid sharing one public deployment's billing and permissions across all users.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Header shows DEMO | Check the market source response and make sure the provider is connected |
| Chart is stale | Refresh Fyers auth or fall back to Yahoo |
| VWAP panel shows no volume | Expected on Yahoo index data; engine data resolves this |
| Assistant not configured | Add the key and redeploy or set it in the app settings |
| Phone install not available | Use HTTPS; local HTTP is not enough for PWAs |

## License

There is no license file in the repository yet.

That means the default copyright applies unless a license is added. If this project is intended to be shared or reused publicly, it is worth adding one explicitly.

---

<div align="center">
  <sub>Built for research, measurement, and disciplined market testing.</sub>
</div>
