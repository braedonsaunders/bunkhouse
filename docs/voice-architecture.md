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
   primary mechanism.
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

**Cascade** (hear → think → speak) keeps the agent's own governed model in the
loop and is the fallback where a realtime key is absent, or where the tenant
needs the text model's exact behaviour. It costs a hop.

Both drive the same worker. The choice of talker does not change what an agent
can do — only how it sounds.

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
| The engine, and its live disposition | `executeAgentRun` / `LiveRun` in `apps/web/src/lib/agent-runs.ts` |
| The call itself | `apps/web/scripts/voice-agent.mts` |

`do_work` is the framework's own async tool. The first `RunContext.update()`
answers the model with the handle, marks the call non-blocking, and returns
control to the session; every later update is inserted into the chat context
and spoken only once the session is idle, so progress never lands on top of the
caller or of the agent itself. The tool's eventual return value arrives the same
way, as the result the agent reads out. Nothing is on a timer.

The worker's progress lines are the run's own events, put into words with the
same `describeToolCall` the call page renders — so what the caller hears and
what the operator watches are the same story from the same ledger. Browser
frames go to the call's eyes, unchanged.

## Migration

Staged, each stage shippable and independently valuable:

1. ~~**Shrink the talker's surface** to the six tools~~ — landed.
2. ~~**Make it async** — the framework's own async tools, replacing the filler
   timer, with the worker's events narrated as they land~~ — landed.
3. **Split the model** — talker and worker on separately configured models, so
   the worker can be the strongest text model available and the talker the
   fastest voice one. Structurally already true of a realtime agent: the talker
   runs the realtime voice model and the worker runs the agent's assigned text
   model. What is left is the operator-facing knob — a cascade agent still uses
   one model for both, and nobody can yet pick them apart deliberately.
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
