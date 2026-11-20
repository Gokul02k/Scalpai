# The assistant

Adding a model, what it is asked, and what leaves the machine.

There are three, and they are asked different things. **Ask EA** sits on a
signal card and reviews that one call. **The chat** is the panel behind the AI
button in the header, and it answers questions about your holdings — it can also
edit them, which is the part worth reading before you use it. **The news brief**
on the News tab summarises the day's market and commodity news, searching the
web where the provider can.

Both are optional. With no key configured the dashboard works exactly as it
does otherwise; the assistant says it is not configured and nothing else
changes.

## Adding a key

**Settings → Assistant → Add a key.** Paste it, press **Test**, and it becomes
available. Two providers, tried in this order:

| | Key from | Environment variable |
|---|---|---|
| Gemini | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) | `GEMINI_API_KEY`, or `GOOGLE_API_KEY` |
| Groq | [console.groq.com/keys](https://console.groq.com/keys) | `GROQ_API_KEY` |

One is enough. Gemini is asked first whenever it has a key; Groq is only
reached if Gemini has no key or the call failed, so it is a fallback rather than
a second opinion.

**Test** lists the provider's models rather than generating anything, so it
costs no tokens, and it names the model it would actually use. That last part
matters more than it sounds — see [when a provider fails](#when-a-provider-fails).

### Your key, not the deployment's

A key you add stays in the browser you typed it into. It travels in the request
body to the routes that call a model — `/api/chat`, `/api/ea` and
`/api/news/brief` — and to `/api/ai-test` when you press **Test**, and nowhere
else. It is never written to the server: there are no accounts here, so there
is nowhere to keep a key *for* somebody.

Ticking **remember on this device** puts it in `localStorage`, where it survives
closing the tab. Leaving it unticked uses `sessionStorage`, and it is gone when
the tab closes. Saving moves the key between the two rather than copying it, so
un-ticking genuinely stops it surviving a restart instead of leaving a stale
copy behind. It is deliberately kept out of the `scalpai-v1` blob that holds
your portfolio and settings, because that blob is read and rewritten as a single
object and a secret riding inside it would be copied by anything that ever
copies it.

A remembered key is readable by anyone with the device, and by any script that
manages to run on the page — the same footing as a password saved in a browser,
and the reason the session-only option exists.

### The environment is not consulted by default

`GEMINI_API_KEY` and `GROQ_API_KEY` in the environment are ignored unless
`SCALPAI_SHARED_KEYS=1` is also set. Without that, a public deployment answers
nobody's questions on the owner's key, which is what it used to do with no
indication on screen and the bill arriving later.

Set `SCALPAI_SHARED_KEYS=1` for local development, or on a deployment only you
can reach, and the environment key fills in for anyone who has not added their
own. A supplied key still wins over it.

The placeholder strings from `.env.example` count as unset, so a half-filled
`.env.local` behaves as no key rather than as a key that mysteriously 400s.

## What is sent

Each sends something different, and the difference matters if you would rather
not hand your positions to a third party.

**Ask EA** sends the signal and nothing about you:

- the instrument, the mode, the live price and today's move
- the app's own call — label, confidence, entry, target, stop, reward:risk
- every factor behind that call, with the reason attached to each

**The news brief** sends the index and commodity prices on screen, the market
status and the current headlines — nothing about your holdings.

**The chat** sends your portfolio. Every message carries a fresh system prompt
containing the current NIFTY price, its RSI, the active theme, and one entry per
holding as `SYMBOL @ ₹BUY` — so the symbol and the price you paid leave the
machine each time you ask anything. Not the size: quantity is not tracked
anywhere in the app, so there is none to send. The last eight turns of the
conversation go with it.

Nothing else goes into the prompt: no candle history, no signal log and no part
of the engine's archive. Your key rides in the same request body (see above) so
the server can call the provider, but it is never put into the prompt. If that
portfolio line is more than you want to send, the chat is the feature to leave
alone; Ask EA and the brief do not include it.

## It can change your portfolio

This is the one behaviour that would be surprising to discover by accident. The
chat's system prompt teaches the model to answer with command blocks:

```
<CMD>{"action":"addStock","value":{"name":"RELIANCE","price":2850,"sector":"Energy"}}</CMD>
```

The reply is scanned for those blocks, each one is executed, and the blocks are
stripped before the text is shown. So "add Reliance at 2850" edits your
holdings, and the model decides what the edit was.

| Action | Effect |
|---|---|
| `addStock` · `updateStock` | Add a holding, or change the price or sector of one you hold |
| `removeStock` | Drop a holding |
| `changeRefreshRate` | Price refresh interval, clamped to the Settings slider's 3–60 seconds |
| `setTheme` | `dark` or `light` |
| `switchTab` | One of the bottom-bar tabs |

Nothing else is honoured. Model output is treated as untrusted input: an
unknown action is ignored, and each known one is range-checked before it runs.
Commands that once changed the analysis instrument, timeframe, indicator
switches or risk limit were removed — the prompt never taught them, nothing in
the UI showed their effect, and there was no way back.

Two things to know about how that is handled. A command runs **without asking
you first** — there is no confirmation step, so a misread instruction becomes an
edit you then have to notice. And an update only overwrites the fields it was
actually given, so updating a price leaves the sector alone.

Everything a command touches is local state in your browser, persisted to
`localStorage`. No order is placed and no broker is contacted — nothing in this
repository can.

## Picking a model

The chat has a picker, and it offers the models of whichever provider is going
to answer — Gemini's when you hold a Gemini key, Groq's when Groq is all you
have. It used to list Gemini's unconditionally, which meant somebody arriving
with only a Groq key was offered four models their key could not reach.

The lists live in `app/lib/geminiModels.js` and `app/lib/groqModels.js`; those
files are the source of truth, and this page only summarises them.

| Gemini | |
|---|---|
| `gemini-3.8-flash` | the default |
| `gemini-3.5-flash-lite` | fastest |
| `gemini-3.1-pro-preview` | most capable |
| `gemini-2.5-flash`, `gemini-2.5-pro` | legacy, for keys that can still reach them |

| Groq | |
|---|---|
| `openai/gpt-oss-120b` | the default, and the model the news brief searches with |
| `openai/gpt-oss-20b` | faster |
| `qwen/qwen3.8-27b` | |

`GEMINI_MODEL` and `GROQ_MODEL` override the defaults. Groq's Compound systems
(`groq/compound`, `groq/compound-mini`) were decommissioned; web search now uses
the `browser_search` tool on the GPT-OSS models.

## When a provider fails

Failures are collected rather than hidden. If Gemini errors the message is
kept, Groq is tried, and if that fails too both messages come back joined
together, so the reason is the provider's own rather than "AI unavailable".

The status code distinguishes the two cases that need different fixes: **503**
means no key is available, and **502** means a provider was reached and broke.

### A retired model is not a bad key

Groq turns its catalogue over quickly, and every model this project originally
named has since been withdrawn. What a valid key returns in that situation is:

```
The model `llama-3.3-70b-versatile` does not exist or you do not have access to it.
```

Which is almost indistinguishable from a rejected key, and sends the diagnosis
in entirely the wrong direction — the symptom is "I added my key and the
assistant still does not work".

So a named model is treated as a preference. When the provider says it is gone,
the key is asked which models it can actually reach and the best of those
answers instead, with non-conversational ones — speech, text-to-speech,
moderation classifiers — filtered out, because they are served from the same
endpoint and a naive choice would send a trading question to Whisper. This is
also why **Test** reports the model it would use rather than just "key works".

The lists above will go stale again. The recovery is the part meant to last.

## What it is not

It is commentary on a signal, not evidence for one. The system prompts tell it
to weigh fundamentals and technicals, to say plainly whether it agrees, and to
note that it is suggestion-only — but a model agreeing with a call is not a
measurement of that call, and this repository is fairly blunt about which calls
have been measured and what the numbers were. [What the engine
measures](../README.md#what-it-measures) is the part with evidence behind
it; the assistant is the part with prose behind it.

Worth asking it:

- Whether a holding still looks reasonable on fundamentals
- What the main risk in a setup is, before acting on it elsewhere
- To add, reprice or drop a holding, in plain English
- What an indicator is saying, when you would rather not read the panel

Worth not asking it: anything where you would act on the answer without
checking it. It has the NIFTY price, its RSI and what you hold. It does not have
the order book, your risk appetite, or any part of the backtest.
