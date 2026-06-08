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
3. **Optional:** add `FINNHUB_API_KEY` from [finnhub.io/dashboard](https://finnhub.io/dashboard) — **not required** for Indian indices. Live prices use **Yahoo Finance** automatically.
4. **Required for AI chat:** add `ANTHROPIC_API_KEY` from [console.anthropic.com/settings/keys](https://console.anthropic.com/settings/keys)
5. Deploy (or **Redeploy** after any env var change)

The header shows **LIVE** when real market data is connected (via Yahoo Finance), or **DEMO** when using simulated prices.

### Use on your phone

Yes — open your Vercel link in **Chrome or Safari** on your phone (e.g. `https://your-app.vercel.app`). It works like a normal website.

**Install like an app (no browser bar):**
- **iPhone (Safari):** Share → **Add to Home Screen**
- **Android (Chrome):** Menu (⋮) → **Install app** or **Add to Home screen**

### Use your own domain (instead of vercel.app link)

1. Vercel → your project → **Settings** → **Domains**
2. Add a domain you own (e.g. `scalpai.yourdomain.com`)
3. Follow Vercel's DNS instructions at your domain registrar
4. Once verified, open your custom domain on any device — same app, cleaner URL

### AI chat setup

The AI calls Claude through a secure server route (`/api/chat`). It will **not** work without an API key.

1. Create a key at [console.anthropic.com](https://console.anthropic.com/settings/keys)
2. Vercel → **Settings** → **Environment Variables**
3. Name: `ANTHROPIC_API_KEY` | Value: your key | Environments: all
4. **Redeploy**

Local dev: copy `.env.example` to `.env.local` and add both keys if needed.

### Troubleshooting

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
