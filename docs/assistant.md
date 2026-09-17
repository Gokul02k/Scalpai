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

A key you add stays in the browser you typed it into. It is sent to `/api/chat`
and `/api/ea` with your own questions and nowhere else, and it is never written
to the server — there are no accounts here, so there is nowhere to keep a key
*for* somebody.

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

Patchvane resolves this the other way round — there, the environment beats
anything typed into the page, so an operator can pin a key the page cannot
replace. That is the right answer for something self-hosted one person at a
time. Here the goal is the opposite.

The placeholder strings from `.env.example` count as unset, so a half-filled
`.env.local` behaves as no key rather than as a key that mysteriously 400s.

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

The chat has a picker, and it offers the models of whichever provider is going
to answer — Gemini's when you hold a Gemini key, Groq's when Groq is all you
have. It used to list Gemini's unconditionally, which meant somebody arriving
with only a Groq key was offered four models their key could not reach.

| Gemini | |
|---|---|
| `gemini-2.5-flash` | the default, and the right answer for almost everything |
| `gemini-3.5-flash` | newest |
| `gemini-2.5-flash-lite` | fastest, least capable |
| `gemini-2.5-pro` | most capable, slowest |

| Groq | |
|---|---|
| `openai/gpt-oss-120b` | the default |
| `openai/gpt-oss-20b` | faster |
| `groq/compound`, `groq/compound-mini` | Groq's own |
| `qwen/qwen3.8-27b` | |

`GEMINI_MODEL` and `GROQ_MODEL` override the defaults.

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
