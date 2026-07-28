# The Switchboard — bunkhouse voice & telephony architecture (design, researched 2026-07-27)

Owner's epic: configurable voice per agent; call an agent on a real telephone; agents send
Teams/Discord-style video links; you share your screen and they see it and talk.

Verdict from the July-2026 field survey (OpenAI Realtime, Gemini Live, Nova Sonic,
ElevenLabs Agents, Deepgram Voice Agent; Twilio vs Telnyx vs Vonage; LiveKit Agents vs
Pipecat/Daily): build on **one self-hostable media plane — LiveKit (Apache-2.0 server,
SIP bridge, and Agents SDK incl. Node)** — and keep **speech providers as adapters**
behind a bunkhouse seam, exactly like model providers. One plane serves all three
surfaces: browser call, PSTN phone call, video meeting with screen share. Full-stack
agent platforms (ElevenLabs Agents, Deepgram Voice Agent, Vapi/Retell) are rejected:
they own the loop, the tools, and the transcript — that breaks doctrine #6
(model-agnostic, runtime owns the loop), #5 (no markup, tenant's own keys), and the
append-only audit model. Carriers are likewise config, not code: LiveKit's SIP bridge
speaks standard SIP trunking, so Twilio vs Telnyx vs Vonage is a tenant settings row.

## Field survey (what the numbers said, mid-2026)
- **Speech-to-speech (S2S) models** — voice IS the model: OpenAI gpt-realtime ~0.8s
  TTFT, ~$0.06–0.11/min (mini ~⅓), 10+ named voices + consent-gated custom voice,
  native tool calling, server VAD barge-in. Gemini Live ~$0.015–0.02/min, 30 named
  voices, 70 languages, barge-in + tool calling, but slower TTFT in benchmarks.
  Amazon Nova Sonic ~$0.015/min, Bedrock-keyed. Cheap, but the call-time brain is
  locked to that provider's model.
- **Cascaded (STT → agent's own model → TTS)**: Deepgram Flux STT <300ms; ElevenLabs
  (~75ms streaming TTS, best cloning: instant clone from ~1min audio) / Cartesia
  (<90ms). ~1–1.5s round trip with streaming — acceptable for phone, and the agent's
  *actual configured model* answers with its full governed toolset.
- **Both shapes ship as adapters.** `voice.mode: 'realtime' | 'cascade'` per agent.
  Cascade is the doctrinal default (any provider, real governance); realtime is the
  low-latency option when the tenant runs an OpenAI/Google/AWS key anyway.
- **Carrier**: Telnyx ≈ half Twilio's per-minute cost; Twilio fastest to first call;
  both (and Vonage) are just SIP trunks to LiveKit SIP. Ship Twilio + Telnyx setup
  recipes; the trunk record is generic SIP (address, auth, numbers).
- **Video**: LiveKit Agents joins rooms as a participant and consumes
  SOURCE_SCREENSHARE video tracks natively (frame sampling → multimodal model).
  Pipecat/Daily is excellent but Python-centric with product pull toward Pipecat
  Cloud; Jitsi has no first-class agent-participant framework. LiveKit wins on
  license, Node SDK, one-plane unification, and self-host.

## Core decisions
1. **One media plane, three surfaces.** LiveKit room = the session primitive. Browser
   "Call" button, PSTN via livekit/sip + tenant trunk, and video meetings are the same
   room joined by the same voice worker. Self-hosted alongside the app (docker-compose
   + prod), LiveKit Cloud allowed as deployment infra choice — never a tenant concern.
2. **The runtime stays the brain.** The voice worker (new `apps/voice-worker`, Node
   LiveKit Agents) does media I/O only; every model turn goes through
   `packages/runtime` context assembly (identity, procedures version-pinned, Logbook
   pinned notes + search_memory, governed abilities). Tool calls — including from S2S
   sessions, which surface function calls over the session — route through
   `governedToolSet`; a mid-call `approval` dial answer makes the agent *say* it needs
   sign-off and log the pending approval, same as email runs.
3. **Voice is HR config, not agent config.** The agent's profile gets a Voice section
   (picker with named provider voices, style notes, language, live preview). Voice
   cloning is consent-gated paperwork: upload consent recording, store the artifact,
   then the clone id — surfaced like any other HR record.
4. **Calls are runs.** Every call creates a run; turns stream as run_events (live in
   the observatory) and persist to an append-only call ledger (below). Recording via
   LiveKit Egress to tenant storage; retention is a tenant setting.
5. **New autonomy category `phone_call`** (enum migration on `action_category`) gates
   outbound dials and meeting invitations; inbound answering is governed by a
   per-number answering policy (mirror of `0007_inbound_policy` for mail). Video
   join implies whatever the meeting's purpose category is; screen-share *viewing* is
   recorded evidence (doctrine #9), not a separate dial.
6. **Cost is salary.** Per-call provider + carrier spend computed with the shared
   `money` type, metered into the agent's monthly budget next to tokens; minutes and
   $ visible on the call record and the agent's budget page.
7. **Tenant-key doctrine**: speech-provider keys, carrier trunk credentials, and
   numbers are sealed tenant settings (@appkit/crypto) with settings UI. Env holds
   only deployment infra: LiveKit server URL/API key, worker concurrency.

## Schema (to become migrations when built)
people.voice_config jsonb — { mode: 'realtime'|'cascade', provider, model?, voiceId,
  language, style?, sttProvider?, ttsProvider?, cloneId?, cloneConsentFileId? }
phone_numbers(id, tenant_id, e164, trunk_id, assigned_person_id NULLABLE, label,
  answering_policy jsonb, status active|released)
sip_trunks(id, tenant_id, carrier twilio|telnyx|vonage|generic, sip_address,
  auth sealed, direction in|out|both, status, last_error)
call_sessions(id, tenant_id, person_id, run_id, channel web|phone|video,
  direction inbound|outbound, peer_e164/peer_label, phone_number_id, room_name,
  status ringing|active|ended|failed|declined, started_at, answered_at, ended_at,
  recording_file_id, minutes, carrier_cost money, speech_cost money)
call_turns(id, session_id, seq, at, speaker agent|human|system, kind utterance|
  tool_call|tool_result|dtmf|screen_frame|note, text, payload jsonb, file_id)
  -- append-only, unique (session_id, seq); the transcript ledger, like mail_messages
meeting_links(id, tenant_id, session_id, token, created_by_person_id, expires_at,
  joined_at NULLABLE)  -- /meet/[token] guest page, no account needed (doctrine #1)

## Build order (each slice ships its UI or it doesn't exist)
1. **Web call.** `@appkit/voice` (adapter contract: RealtimeSpeechAdapter,
   SttAdapter, TtsAdapter + provider registry, mailbox-pattern) with cascade
   (Deepgram + ElevenLabs) and realtime (OpenAI, Gemini) adapters; voice-worker;
   schema; Company Settings → Voice (feature gate `voice`, provider keys sealed);
   agent profile Voice section with live preview; "Call" button on the agent profile;
   call record drawer with transcript + observatory live view.
   **SHIPPED (first pass):** `@appkit/voice` (config types, catalogs, key
   verification, LiveKit token minting) + `0010/0011` migrations
   (`people.voice_config`, `call_sessions`, `call_turns`, `phone_call`
   category), Settings → Voice (Deepgram/ElevenLabs keys, verified + sealed),
   per-agent Voice tab (cascade/realtime picker, live ElevenLabs voice list,
   Call button), `/call/[personId]` browser room with live captions, the
   `voice-agent` worker (`apps/web/scripts/voice-agent.mts`, LiveKit Agents),
   and the call transcript on the run desk. Realtime now runs on BOTH
   OpenAI Realtime and Gemini Live (agents-plugin-google; input+output
   transcription on, so both speakers ledger). Honest limits, for now:
   cascade LLM speaks the OpenAI protocol only (OpenAI/OpenRouter/Groq/…
   keys; Anthropic text bridge is a follow-up — the Voice tab disables
   the cascade combo for such agents); LLM tokens are metered into
   token_spend, STT/TTS minutes are not yet priced.
2. **Inbound phone.** livekit/sip in compose; Settings → Telephony (gate `telephony`,
   dependent on `voice`): trunk setup (Twilio/Telnyx recipes), numbers directory,
   number→agent assignment + answering policy. Ring a real number, the agent answers as
   itself; recording, transcript, run all land on the agent's Calls tab.
3. **Outbound phone.** `place_call` ability + `phone_call` autonomy category
   (dial row appears on every agent's autonomy page); approval flow; "Ask to call"
   action from the agent profile and from mail threads; call outcome logged to the run.
4. **Video + screen share.** `send_meeting_link` ability (delivers over mail/SMS —
   existing surfaces); /meet/[token] guest room (camera/mic/screen-share, appkit-
   tokenized UI); agent joins as participant, samples screen-share frames (~1fps,
   on-change) into its multimodal context; frames persisted as `screen_frame` turns —
   the replayable session record. Gate `videoMeetings`, dependent on `voice`.
5. **Operations polish.** Transfer-to-human (SIP REFER), voicemail→mail-thread
   handoff, per-agent call-minutes budget lines, retention policies UI.

AppKit backfill: `@appkit/voice` (adapters + session contract) and the meeting-room UI
primitives are built AppKit-shaped and committed upstream per AGENTS.md; the voice
worker's bunkhouse-specific context assembly stays here.

Key refs: LiveKit Agents/SIP docs (Apache-2.0, Node SDK, SOURCE_SCREENSHARE vision),
OpenAI Realtime pricing/voices, Gemini Live API guide (30 voices, barge-in, tools),
Deepgram Voice Agent flat $4.50/hr, ElevenLabs Agents May-2026 repricing + cloning,
Telnyx/Twilio LiveKit trunk guides, Pipecat 1.0 / Daily Bots merge notes.
