# ScalpAI - AI-Powered Trading Dashboard

Real-time scalping dashboard for NIFTY, SENSEX, BANK NIFTY with AI-powered signals and analysis.

## Features
- Live index prices (Yahoo Finance) + real candlestick charts
- Technical indicators calculated from real data (RSI, MACD, BB, EMA, ATR, Stochastic)
- Smart buy/sell signals for indices + your portfolio stocks
- Portfolio tracker with CSV upload + live stock prices
- Watchlist tab with live quotes
- Trade history with today/week/month filters (saved in browser)
- Live market news + portfolio-linked headlines
- Sound & browser alerts on new signals
- Scalp timer + quick BUY/SELL buttons
- AI chat assistant (requires `ANTHROPIC_API_KEY`)
- Light/dark theme, calculators, market hours display

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

### Phone alerts when the app is closed

The in-app alerts (sound + browser notification) come from a timer running in the page,
so they stop the moment the tab is backgrounded or the phone locks. Installing the site
as an app, or wrapping it in an APK, does not change this — it's the same frozen timer.

To be alerted with the app closed, the signal has to be evaluated **on the server** and
pushed to you. `/api/nifty-log/cron` already runs the whole evaluation (quote → candles →
indicators → signal → confidence filter → dedupe) with no browser involved. Point a
scheduler at it and it will send each new signal to Telegram.

**1. Signal storage (required).** Without it the tick has nowhere to dedupe against and
exits at `storage_not_configured`. Create a free database at
[console.upstash.com](https://console.upstash.com), then set `UPSTASH_REDIS_REST_URL` and
`UPSTASH_REDIS_REST_TOKEN`.

**2. Telegram bot.** Message [@BotFather](https://t.me/botfather) → `/newbot` → copy the
token into `TELEGRAM_BOT_TOKEN`. Send your new bot any message, then open
`https://api.telegram.org/bot<TOKEN>/getUpdates` and copy `result[0].message.chat.id`
into `TELEGRAM_CHAT_ID`.

**3. Cron secret.** Set `CRON_SECRET` to any long random string, then **redeploy** so all
the new variables take effect.

**4. Scheduler.** Vercel Hobby caps cron at once per day, so use an external one — at
[cron-job.org](https://cron-job.org) create a job for
`https://your-app.vercel.app/api/nifty-log/cron?secret=YOUR_CRON_SECRET`, and restrict it to
Mon–Fri 09:15–15:30 IST. (On Vercel Pro, merge `vercel.cron.pro.example.json` into
`vercel.json` instead.)

**Every 2 minutes is the recommended interval.** Each tick reads and rewrites the whole log
blob, so Upstash *bandwidth* (10 GB/month free) is the limit you'd hit first — not the
command count, which stays near 30K of the 500K free. A 2-minute schedule during market
hours keeps bandwidth comfortably inside the free tier; 1-minute can approach it once the
log fills toward its 300-entry cap. Signals are evaluated on 5-minute candles, so the
faster poll buys little.

**Verify it works** — add `&test=1` to that URL and open it in a browser. You get a
Telegram test message plus a config readout:

```json
{ "test": true, "config": { "storage": true, "telegram": true, "market": "Market Open" } }
```

Any `false` there is the thing to fix. Without `&test=1` the same URL runs a real tick and
returns what it decided — `skipped` with a reason outside market hours or below the
confidence bar, `"decision":"append"` when a new signal is logged and pushed.

Alerts fire on **new** signals only (BUY/SELL at 80%+ confidence). A signal that persists
or drifts in confidence updates its existing log row without re-notifying, so a live signal
won't message you every minute.

#### Turning alerts on and off

**Settings → Alerts → Background alerts** is the master switch. It's stored on the server
(in Upstash), not in your browser, which is what lets the cron see it — so flipping it on
one device applies everywhere, and works even with every copy of the app closed.

The scheduler keeps calling your endpoint either way; the switch decides whether the tick
does anything. With it off, each call returns `{"skipped":true,"reason":"alerts_disabled"}`
after one cheap storage read — no Yahoo fetch, no signal logging, no Telegram. Note this
pauses the **signal log too**, not just the messages, so your track record won't record
anything while it's off. If the setting was never touched it defaults to on.

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
| Header shows **DEMO** | Redeploy; test `/api/market?symbol=%5ENSEI` — should return `"source":"yahoo"` |
| AI says "not configured" | Add `ANTHROPIC_API_KEY` on Vercel and redeploy |
| Can't scroll on small screen | Fixed in latest version — hard refresh (`Ctrl+Shift+R`) |
| Prices frozen | Indian market hours 9:15 AM–3:30 PM IST; outside that shows last close |

Local dev: copy `.env.example` to `.env.local`, then run `npm run dev`.

## Usage

- Switch instruments via dropdown (NIFTY → SENSEX → BANK NIFTY)
- View live charts & technical analysis
- Log trades manually
- Get AI-powered trading suggestions
- Monitor portfolio in real-time
