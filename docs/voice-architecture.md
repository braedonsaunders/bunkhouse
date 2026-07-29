# The call architecture

How an agent holds a phone call: what runs where, why, and what it costs. This
is the design the voice agent is being rebuilt onto, and the reasoning behind
it — including what we got wrong first, because the wrong version is instructive.

## What we built first, and why it fails

One realtime speech-to-speech model, with the agent's entire working kit —
twenty-nine tools — attached directly to the voice session. Every tool call
blocked the conversation until it returned.

That design fails in four ways at once, and a single evening of real calls
produced all four:

1. **The model picks badly from a large surface.** Tool-choice accuracy falls
   as the surface grows, and a speech-to-speech model is weaker at it than a
   text model to begin with. Asked to browse, agents holding a browser said
   they could not.
2. **Work blocks talking.** A search, a page fetch, a document — the caller
   hears silence until it returns. We papered over it with a filler line after
   2.5 seconds, which is a worse version of what the framework already ships.
3. **One model is asked to be two things.** Sub-second prosody and turn-taking
   want a small fast model; multi-step tool reasoning wants a large one. A
   single model is a compromise at both.
4. **A failing leg is invisible.** Everything reports success and the caller
   hears nothing.

## The shape: a talker and a worker

The consensus architecture — Fast Brain / Slow Brain, Talker–Reasoner —
separates the conversation from the work. Two processes, one shared record.

```
     caller
       │  audio
       ▼
┌──────────────────┐   intent    ┌───────────────────────┐
│  TALKER          │────────────▶│  WORKER               │
│  realtime S2S    │             │  the governed runtime │
│  ~6 tools        │◀────────────│  the full kit         │
│  never blocks    │  narration  │  runs in background   │
└──────────────────┘             └───────────────────────┘
       │                                   │
       └──────────── call record ──────────┘
              turns · tool events · frames
```

**The talker** owns the line: hearing, prosody, turn-taking, barge-in,
backchannels, and the social contract of a phone call. It carries a deliberately
tiny tool surface — the handful of things that are genuinely part of talking —
and it must never be blocked. Its job is to be a person on the phone.

**The worker** is the runtime that already exists: the same governed loop email
runs use, with the whole ability set, autonomy dial, approvals, procedures, and
memory. It runs *outside* the voice session, asynchronously, and reports
progress back.

**One engine, two dispositions.** The worker is not a second execution engine.
It is `executeAgentRun` — the same function an assignment, a duty, and an
inbound email all go through — in its *live* disposition: the caller is waiting,
so the work runs now, in the process holding the conversation, inside the run
the call already owns, narrating as it goes. The *deferred* disposition is
`take_assignment`, unchanged: queued, run by the background worker process,
delivered by email. Same loop, same dial, same approvals, same metering, same
ledger. What differs is only when the answer is wanted and where it goes. Two
loops to keep in step would drift; there is one.

**The record is the bus.** Call turns, run events, and browser frames are
already an append-only ledger both sides read and write. It is what the call
page renders, what the run desk replays, and what the talker narrates from. No
new transport.

## The talker's tools

Six, not twenty-nine:

| Tool | Why it belongs on the line |
|---|---|
| `do_work` | Hand an intent to the worker. Returns immediately with a handle. |
| `check_work` | What has the worker got so far. |
| `end_call` | Hang up when the goodbye is said. |
| `transfer_call` | Put the caller through to a human. |
| `take_assignment` | Work that outlives the call. |
| `remember` | Save something the caller just said. |

Everything else — search, browser, documents, email, integrations, shell —
belongs to the worker. The talker never sees them, so it never chooses badly
among them, and its context stays small enough to be fast.

`take_assignment` and `remember` are not reimplementations: they are the
agent's own abilities, lifted out of the assembled set by name and governed by
the same dial and the same approval gate as everything else.

## Never blocking

Three mechanisms, in order of preference:

1. **Async tools.** `do_work` returns a handle in milliseconds. The framework
   supports this natively (`asyncToolOptions`, `ToolFlag.CANCELLABLE`); we
   should use it rather than the hand-rolled filler timer.
2. **Narration, not filler.** The worker emits structured progress — "opened
   the site", "two of four checked", "no availability on those dates" — into
   the talker's context. The agent says what is actually happening, in its own
   words. Canned filler is the fallback for gaps between real events, not the
   primary mechanism. Where that narration is allowed to land is a problem of
   its own; see [Delivery: the mailbox](#delivery-the-mailbox).
3. **Barge-in that knows a backchannel.** "Uh-huh" while the agent talks is not
   an interruption. A minimum speech duration before treating detected speech
   as barge-in keeps the agent from being shredded mid-sentence.

## Latency budget

Under 800ms voice-to-voice at the median is table stakes; past ~1.2s callers
start talking over the agent. Where it goes, and what we control:

| Leg | Budget | Lever |
|---|---|---|
| End of utterance detection | ~300ms | Semantic turn detection, not silence timers |
| Model first token | ~300ms | Small talker model; prompt caching; small tool surface |
| Speech first byte | ~100ms | Preemptive TTS on the cascade path |
| Everything else | the rest | Co-locate; keep the socket warm |

Work does not appear in this budget. That is the point: the worker's latency is
absorbed by narration, not by the caller's ear.

## Two paths, honestly described

**Realtime (speech-to-speech)** is the default: no relay hop, natural
interruption, real prosody. Weaker at tools and harder to inspect — which is
survivable precisely because the talker barely has tools.

**Cascade** (hear → think → speak) keeps the agent's own governed models in the
loop and is the fallback where a realtime key is absent, or where the tenant
needs the text model's exact behaviour. It costs a hop.

Both drive the same worker. The choice of talker does not change what an agent
can do — only how it sounds.

**Both separate the two models.** Every agent's record carries two: the model
it works with, and the model it answers with on a call. A realtime agent gets
the split structurally — the realtime speech model does the talking, the
assigned working model does the work. A cascade agent gets it deliberately:
the conversation runs on the agent's fast model, the work behind `do_work` on
its working model. An agent that names no fast model of its own answers with
its provider's, and failing that with the model it works with — which is
exactly the single-model behaviour every existing agent already had.

## What this fixes

- An agent cannot claim it lacks a capability the worker holds: intent goes to
  the worker, which owns the whole kit and answers from the tool, not from the
  model's self-image.
- Slow work stops producing silence.
- The talker's context stays small, so it stays fast and picks well.
- The worker can be a frontier text model without paying for it in prosody, and
  the talker can be a small fast model without paying for it in intelligence.
- One failing leg is visible, because the legs are separate.

## How it is wired

| Piece | Where |
|---|---|
| The talker's six tools | `apps/web/src/lib/call-tools.ts` |
| The worker bound to one call | `apps/web/src/lib/call-worker.ts` |
| The delivery mailbox | `apps/web/src/lib/call-mailbox.ts` (tested by `apps/web/scripts/mailbox.test.mts`) |
| The engine, and its live disposition | `executeAgentRun` / `LiveRun` in `apps/web/src/lib/agent-runs.ts` |
| The call itself | `apps/web/scripts/voice-agent.mts` |
| The two models an agent runs on | `AgentModelConfig` in `apps/web/src/db/schema/people.ts`, resolved by `resolveAgentAiConfig` in `apps/web/src/lib/ai.ts` |
| Where an operator picks them | the agent record's Model tab — `apps/web/src/components/assign-model-form.tsx` |
| The agent's screen, live | `apps/web/src/lib/browser-cast.ts` (cursor + screencast), `apps/web/src/lib/call-screen.ts` (the track), `apps/web/src/lib/agent-screen.ts` (the contract they share) |

`do_work` is the framework's own async tool. The first `RunContext.update()`
answers the model with the handle, marks the call non-blocking, and returns
control to the session. The tool's eventual return value comes back the same
way, as the result the agent reads out. Nothing is on a timer.

The worker's progress lines are the run's own events, put into words with the
same `describeToolCall` the call page renders — so what the caller hears and
what the operator watches are the same story from the same ledger. Browser
frames go to the call's eyes, unchanged.

## Delivery: the mailbox

Dispatch and delivery are separate problems, and only the first one was solved
by making `do_work` async. Everything the worker had to say went straight out
as another `RunContext.update()`, and every update becomes a fresh reply. A
fresh reply lands on top of the speech already in the caller's ear:

```
agent 37s  Got it... Let me check what's available.
agent 38s  I'm                          <- one word, cut off
agent 45s  Any preferences on type?     <- a different thought
agent 55s  Understood. I'm seeing...    <- "Understood" to nobody
```

Deleting the narration stopped the bleeding and cost the whole point of the
architecture: the agent went silent while it worked. The fix is the shape a
coding agent already uses to receive a finished subagent — queue it, coalesce
it, deliver it at a turn boundary — and it is one framework-free module.

**Four rules on the queue.** *Coalescing:* everything pending at one boundary
goes out as one message, and progress about the same piece of work supersedes
itself, because only where it is up to now matters. *Priority:* an approval or
a failure outranks the answer itself — those are the two things a caller can
act on while still on the phone — and plain progress ranks bottom, so an
answer arriving discards the progress still queued behind it. *Rate limiting:*
progress opens a delivery of its own at most once every twenty seconds, which
is about how often a colleague looking something up says where they are up to;
answers, approvals and failures are never rate limited, and progress waiting
behind one rides along free. *Deduplication:* the same words about the same
work are never said twice, by any route.

**One boundary, defined by events.** `AgentSession` publishes `agentState` and
`userState` and emits `AgentStateChanged` / `UserStateChanged`; the mailbox
flushes when the agent is neither speaking nor thinking and the caller is not
speaking. Driven off those two events, never polled.

**A delivery can never cancel speech**, and three things together are why. The
line must read quiet, and must have read that way for a settling moment, so a
flush cannot fire into the gap between two sentences of one reply. The delivery
is then awaited to the end of its playout, so a second one cannot start while
the first is still being said. And the framework's own speech queue plays
handles serially rather than pre-empting, so even a boundary that closed
between the check and the call costs a wait, never an interruption.

The answer itself does not go through the mailbox: it is `do_work`'s return
value, which the framework already speaks at the turn tail in the agent's own
words. The mailbox is told it was said, which is what retires the work.

## Watching the agent work

The caller should be able to watch the agent's browser the way they would watch
a colleague share a screen — the page scrolling, links being clicked, text
going in a character at a time, a cursor crossing it. A still per recorded
step, polled, cannot be that however often it is polled; it reads as a
slideshow of results with no work between them.

The agent is already a participant in the caller's room, so the answer is to
publish its browser as an ordinary video track:

```
   puppeteer page ──Page.startScreencast──▶ JPEG per repaint
                                              │  sharp → packed RGBA
                                              ▼
                      VideoSource ──▶ LocalVideoTrack ──▶ the call's room
                                                              │
                                                    the call page's stage
```

Four things make it honest rather than decorative:

- **A real cursor.** A devtools mouse paints nothing, so one is drawn into the
  page: a closed shadow root hung off `<html>`, `position:fixed`,
  `pointer-events:none`, driven by the page's own mouse events. It is outside
  the subtree the page summarizer reads, and the target finders refuse to match
  inside it, so the agent can neither read nor click its own pointer. Because
  the browser tools target by element and never by coordinate, nothing would
  move that pointer on its own — so before each click or keystroke it is led to
  the target's centre over about a fifth of a second, scrolling the page
  smoothly underneath if the target was off-screen. That is the whole added
  latency, and it is paid only when somebody is watching.
- **Frames Chromium already makes.** `Page.startScreencast` emits a JPEG when
  the page repaints and nothing at all when it does not, with an ack per frame.
  Screenshotting in a loop — the thing this replaces — pays a full capture
  round trip whether or not anything moved, and competes with the agent's own
  work for the same page.
- **Drops, never queues.** While a conversion is in flight every arriving frame
  is acked and discarded. A slow encoder lowers the frame rate the caller sees
  and can never slow the agent down.
- **Calls only.** The voice agent registers an offer against its call's run
  before any browser exists. An email run, a duty, or an assignment registers
  nothing, so its browser opens with no cursor, no screencast, and no track.

The screenshot ledger is untouched by all of it. It is the audit record —
doctrine #9 — it is what the run desk replays, and it is what the call stage
falls back to for a screen the agent has already left. The track is the live
view; the ledger is the evidence.

## Migration

Staged, each stage shippable and independently valuable:

1. ~~**Shrink the talker's surface** to the six tools~~ — landed.
2. ~~**Make it async** — the framework's own async tools, replacing the filler
   timer, with the worker's events narrated as they land~~ — landed.
3. ~~**Split the model** — talker and worker on separately configured models,
   so the worker can be the strongest text model available and the talker the
   fastest voice one~~ — landed. The agent's record now carries both: the model
   it works with and the model it answers with on a call, chosen separately on
   the Model tab from one provider. The cascade talker is built from the fast
   one; every governed run still uses the working one. Measured on this
   deployment, a small model answers in ~570ms where a large reasoning model
   takes seconds — on a call that difference is the whole experience.
4. **Speculative preparation** — the worker starts fetching likely context
   while the caller is still speaking, so the answer is often ready before the
   question finishes.

## Sources

- [Fast Brain / Slow Brain for voice agents (ML6)](https://www.ml6.eu/en/blog/stop-building-voice-wrappers-the-architecture-behind-reliable-voice-agents)
- [Async tools for voice agents (LiveKit)](https://livekit.com/blog/async-tools-voice-agents)
- [Realtime model prompting guide (OpenAI)](https://developers.openai.com/api/docs/guides/realtime-models-prompting)
- [gpt-realtime and Realtime API updates (OpenAI)](https://openai.com/index/introducing-gpt-realtime/)
- [VoiceAgentRAG: dual-agent architectures](https://arxiv.org/html/2603.02206v1)
- [Turn detection for voice agents (LiveKit)](https://livekit.com/blog/turn-detection-voice-agents-vad-endpointing-model-based-detection)
