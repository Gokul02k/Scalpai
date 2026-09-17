# The assistant

Adding a model, what it is asked, and what leaves the machine.

There are two of them, and they are asked different things. **Ask EA** sits on a
signal card and reviews that one call. **The chat** is the panel behind the AI
button in the header, and it answers questions about your holdings — it can also
edit them, which is the part worth reading before you use it.

Both are optional. With no key configured the dashboard works exactly as it
does otherwise; the assistant says it is not configured and nothing else
changes.

## Adding a key

Two providers, tried in that order:

| | Key from | Environment variable |
|---|---|---|
| Gemini | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) | `GEMINI_API_KEY`, or `GOOGLE_API_KEY` |
| Groq | [console.groq.com](https://console.groq.com) | `GROQ_API_KEY` |

One is enough. Gemini is asked first whenever it has a key; Groq is only
reached if Gemini has no key or the call failed, so it is a fallback rather than
a second opinion. Locally the keys go in `.env.local`; on Vercel they go in
**Settings → Environment Variables**, and a change needs a redeploy.

The placeholder strings from `.env.example` count as unset, so a half-filled
`.env.local` behaves as no key rather than as a key that mysteriously 400s.

Keys are read in the route handlers and never reach the browser. The page posts
to `/api/chat` and `/api/ea`; those two routes are the only things in the
repository that talk to a model.

## What is sent

The two ask for different things, and the difference matters if you would rather
not hand your positions to a third party.

**Ask EA** sends the signal and nothing about you:

- the instrument, the mode, the live price and today's move
- the app's own call — label, confidence, entry, target, stop, reward:risk
- every factor behind that call, with the reason attached to each

**The chat** sends your portfolio. Every message carries a fresh system prompt
containing the current NIFTY price, its RSI, the active theme, and one entry per
holding as `SYMBOL xQTY @ ₹BUY` — so the symbol, the size and the price you paid
leave the machine each time you ask anything. The last eight turns of the
conversation go with it.

Nothing else does. No candle history, no signal log, no CSV, no keys, and no
part of the engine's archive. If that portfolio line is more than you want to
send, the chat is the feature to leave alone; Ask EA does not include it.

## It can change your portfolio

This is the one behaviour that would be surprising to discover by accident. The
chat's system prompt teaches the model to answer with command blocks:

```
<CMD>{"action":"addStock","value":{"name":"RELIANCE","qty":10,"price":2850}}</CMD>
```

The reply is scanned for those blocks, each one is executed, and the blocks are
stripped before the text is shown. So "add 10 Reliance at 2850" edits your
holdings, and the model decides what the edit was.

| Action | Effect |
|---|---|
| `addStock` · `updateStock` | Add a holding, or change the quantity, price or sector of one you hold |
| `removeStock` | Drop a holding |
| `changeInstrument` · `changeTimeframe` | Switch the chart |
| `changeRefreshRate` · `setTheme` · `switchTab` | The same settings the UI exposes |
| `toggleIndicator` · `setRiskLimit` | Indicator switches, and the risk limit signals are sized against |

Two things to know about how that is handled. A command runs **without asking
you first** — there is no confirmation step, so a misread instruction becomes an
edit you then have to notice. And an update only overwrites the fields it was
actually given: re-adding a symbol you already hold without a quantity keeps the
quantity you had, because the earlier behaviour of defaulting it to one share
silently destroyed real positions.

Everything a command touches is local state in your browser, persisted to
`localStorage`. No order is placed and no broker is contacted — nothing in this
repository can.

## Picking a model

The chat has a picker. Only the ids below are accepted; anything else falls
back to `GEMINI_MODEL` from the environment, and then to the default.

| Gemini | |
|---|---|
| `gemini-2.5-flash` | the default, and the right answer for almost everything |
| `gemini-3.5-flash` | newest |
| `gemini-2.5-flash-lite` | fastest, least capable |
| `gemini-2.5-pro` | most capable, slowest |

The Groq side runs `llama-3.3-70b-versatile` by default, with
`llama-3.1-8b-instant`, `gemma2-9b-it` and a vision model also permitted, and
`GROQ_MODEL` overriding the default.

One asymmetry worth knowing: the picker only applies to Gemini. When the call
falls through to Groq, the requested model is not carried across and Groq's own
default answers instead — so a reply that arrives after a Gemini failure may not
be from the model named in the picker. The response says which provider
answered.

## When a provider fails

Failures are collected rather than hidden. If Gemini errors the message is
kept, Groq is tried, and if that fails too both messages come back joined
together, so the reason is the provider's own rather than "AI unavailable".

The status code distinguishes the two cases that need different fixes: **503**
means nothing is configured, and **502** means a provider was configured and
broke. A connection error that never reached the route shows as a connection
error in the chat.

## What it is not

It is commentary on a signal, not evidence for one. The system prompts tell it
to weigh fundamentals and technicals, to say plainly whether it agrees, and to
note that it is suggestion-only — but a model agreeing with a call is not a
measurement of that call, and this repository is fairly blunt about which calls
have been measured and what the numbers were. [What the engine
measured](../README.md#what-it-has-measured) is the part with evidence behind
it; the assistant is the part with prose behind it.

Worth asking it:

- Whether a holding still looks reasonable on fundamentals
- What the main risk in a setup is, before acting on it elsewhere
- To add, resize or drop a holding, in plain English
- What an indicator is saying, when you would rather not read the panel

Worth not asking it: anything where you would act on the answer without
checking it. It has the price, the RSI and your position sizes. It does not have
the order book, your risk appetite, or any part of the backtest.
