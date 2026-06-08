# ScalpAI - AI-Powered Trading Dashboard

Real-time scalping dashboard for NIFTY, SENSEX, BANK NIFTY with AI-powered signals and analysis.

## Features
- Live price tracking & candlestick charts
- Technical indicators (RSI, MACD, Bollinger Bands)
- Buy/Sell scalping signals
- Portfolio tracker
- Trade history & statistics
- Market news & insights
- AI Chat assistant (powered by Claude)

## Quick Start

1. Install dependencies:
   ```bash
   npm install
   ```

2. Run locally:
   ```bash
   npm run dev
   ```

3. Open http://localhost:3000

## Deploy to Vercel

1. Push this repo to GitHub
2. Import the repo at [vercel.com/new](https://vercel.com/new)
3. **Optional:** add `FINNHUB_API_KEY` from [finnhub.io/dashboard](https://finnhub.io/dashboard) — **not required** for Indian indices (Finnhub free tier does not include NSE/BSE). Live prices use **Yahoo Finance** automatically.
4. Deploy (or **Redeploy** after any env var change)

The header shows **LIVE** when real market data is connected (via Yahoo Finance), or **DEMO** when using simulated prices.

### Troubleshooting live data

| Symptom | Fix |
|---------|-----|
| Header shows **DEMO** | Redeploy on Vercel; test `/api/market?symbol=%5ENSEI` — should return `"source":"yahoo"` |
| Finnhub key set but still Yahoo | Normal — Finnhub free plan does not include Indian index quotes |
| Prices frozen | Indian market hours are 9:15 AM–3:30 PM IST; outside that, last close is shown |

Local dev: copy `.env.example` to `.env.local` and add your key, then run `npm run dev`.

## Usage

- Switch instruments via dropdown (NIFTY → SENSEX → BANK NIFTY)
- View live charts & technical analysis
- Log trades manually
- Get AI-powered trading suggestions
- Monitor portfolio in real-time
