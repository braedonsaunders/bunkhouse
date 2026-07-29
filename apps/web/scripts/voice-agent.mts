import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { and, desc, eq, ne } from 'drizzle-orm'
import { z } from 'zod'
import { cli, defineAgent, llm, voice, ServerOptions, type JobContext, type JobProcess } from '@livekit/agents'
import * as deepgram from '@livekit/agents-plugin-deepgram'
import * as elevenlabs from '@livekit/agents-plugin-elevenlabs'
import * as google from '@livekit/agents-plugin-google'
import * as openai from '@livekit/agents-plugin-openai'
import * as silero from '@livekit/agents-plugin-silero'
import { isAiProvider, providerSpec, type AiConfig } from '@appkit/ai'
import { buildSystemPrompt } from '@bunkhouse/runtime'
import { db } from '../src/db/client'
import {
  approvals,
  autonomySettings,
  callSessions,
  callTurns,
  people,
  phoneNumbers,
  runs,
  runEvents,
  tokenSpend,
  type BunkhouseVoiceConfig,
} from '../src/db/schema'
import { assembleAbilities } from '../src/lib/agent-abilities'
import { boundProcedures } from '../src/lib/agent-runs'
import { governedCallTools } from '../src/lib/call-tools'
import { resolveAgentAiConfig } from '../src/lib/ai'
import { OUTBOUND_ROOM_PREFIX, transferCallToExtension } from '../src/lib/outbound-call'
import { resolveRealtimeCredential, resolveSpeechCredential } from '../src/lib/voice'
import { MEETING_ROOM_PREFIX } from '../src/lib/meetings'
import { watchScreenShare } from '../src/lib/screen-share'
import { saveFile } from '../src/lib/files'
import { companyPromptProfile, getCompanyIdentity } from '../src/lib/company-identity'
import { pinnedNotes, retrieveNotes } from '../src/lib/memory'
import { resolvePrice } from '../src/lib/pricing'
import { isWithinWorkingHours } from '../src/lib/working-hours'
import { callMinutesBudget } from '../src/lib/call-budget'
import { finishCallRecording, startCallRecording, type CallRecordingHandle } from '../src/lib/voice-recording'
import { meterSpeechMinutes } from '../src/lib/voice-pricing'
import {
  callerLabel,
  deliverVoicemail,
  voicemailGreeting,
  voicemailInstructions,
  type VoicemailReason,
  type VoicemailTurn,
} from '../src/lib/voicemail'

// The bunkhouse voice agent: joins every `call-*` (browser call, session
// pre-created by the call page), `pbx-*` (inbound phone call dispatched by
// LiveKit SIP, session created here), `out-*` room (a call the agent placed
// itself, session pre-created by `place_call`), and `meet-*` room (a video
// meeting, session pre-created when the invitation went out), loads the
// session's agent, and holds the conversation. Media I/O lives here; identity,
// procedures, and memory come from the same context assembly email runs use.
// Every utterance is appended to the call_turns ledger; the run is completed
// with a deterministic summary and LLM usage is metered into token_spend.
//
// Provider support (engineering notes, never surfaced as-is to operators):
// - cascade LLM: OpenAI + OpenAI-compatible providers (OpenRouter, Groq, …)
//   via the openai plugin's baseURL. Anthropic text models still need a
//   bridge; the UI disables the cascade combo for such agents.
// - realtime: OpenAI Realtime and Gemini Live. The Gemini plugin enables
//   input+output audio transcription by default, so both speakers land in
//   the transcript ledger on either provider.
// - seeing a shared screen: neither the framework's room input (videoEnabled
//   is declared but unimplemented in 1.6.0) nor the Gemini plugin's pushVideo
//   (a no-op) carries video into a realtime session, so frames reach the model
//   the way both realtime plugins genuinely do accept images — as chat-context
//   image content, pushed between turns. Cascade sessions take the same path,
//   but only when the operator has turned live vision on for that agent: a
//   text model may have no vision at all, and the runtime cannot tell in
//   advance. If the model then refuses the picture, vision is switched off for
//   the rest of the meeting and the agent says so out loud. Either way every
//   sampled frame is stored as evidence on the run.
// - recording: LiveKit Egress mixes the room (audio only) straight into the
//   tenant's own object storage; this process never handles the bytes. The
//   uploaded object is ledgered in `files` and stamped on the session.
// - voicemail: an inbound call the agent cannot take — off shift, not yet
//   active, out of call minutes, or with no working voice — is still answered.
//   The answering machine (Deepgram hears, ElevenLabs speaks, nothing thinks)
//   takes the message and mails it to the agent's own inbox, where the normal
//   inbound-mail pass picks it up as work.

const app = db()

type SessionRow = typeof callSessions.$inferSelect
type PersonRow = typeof people.$inferSelect

async function findSessionByRoom(room: string): Promise<SessionRow | null> {
  const rows = await app.withSuperAdmin((superDb) =>
    superDb.select().from(callSessions).where(eq(callSessions.room, room)),
  )
  return (rows[0] as SessionRow | undefined) ?? null
}

/**
 * Inbound phone calls arrive with no pre-created session: LiveKit SIP's
 * dispatch rule names the room `pbx-<extension>` plus a random suffix, and
 * the agent is the first to learn the call exists. Resolve the agent by its
 * tenant-unique extension, then create the run and call_sessions row here —
 * idempotently: the room's unique key makes a concurrent second dispatch a
 * plain read of the winner's session.
 */
async function ensureInboundPhoneSession(ctx: JobContext, roomName: string): Promise<SessionRow | null> {
  const existing = await findSessionByRoom(roomName)
  if (existing) return existing

  // The dialed callee names the room: a PBX sends the short extension, a
  // carrier sends the provisioned number (usually with a leading '+').
  const callee = /^pbx-(\+?[0-9]+)/.exec(roomName)?.[1]
  if (!callee) {
    console.error(`[voice] room ${roomName}: no dialable callee in the room name`)
    return null
  }
  const digits = callee.replace(/[^0-9]/g, '')

  // The SIP participant's join is what triggered dispatch. Its attributes
  // carry the caller's number, and — from the trunk's dispatch rule — which
  // company the line belongs to. Reading it before resolving the callee is
  // what makes routing deterministic: numbers and extensions are unique per
  // company, not across all of them, so two companies holding the same number
  // would otherwise be an ambiguity with nowhere to send the call.
  const participant = await ctx.waitForParticipant()
  const callerNumber = participant.attributes?.['sip.phoneNumber'] || null
  const lineTenantId = participant.attributes?.['bunkhouse.tenantId'] || null

  // Provisioned numbers first, then the PBX extension path. An agent that is
  // still onboarding is routed to as well: it cannot hold a conversation yet,
  // but a ringing number must never go unanswered, and it can take a message.
  // An offboarded agent is gone — its number belongs to whoever took the work.
  let person: PersonRow | null = null
  let viaNumber = false
  const numbered = await app.withSuperAdmin((superDb) =>
    superDb
      .select({ personId: phoneNumbers.personId })
      .from(phoneNumbers)
      .where(
        and(
          eq(phoneNumbers.number, digits),
          ...(lineTenantId ? [eq(phoneNumbers.tenantId, lineTenantId)] : []),
        ),
      ),
  )
  if (numbered.length === 1) {
    const rows = await app.withSuperAdmin((superDb) =>
      superDb
        .select()
        .from(people)
        .where(and(eq(people.id, numbered[0]!.personId), eq(people.kind, 'agent'), ne(people.status, 'offboarded'))),
    )
    person = (rows[0] as PersonRow | undefined) ?? null
    viaNumber = person !== null
  }
  if (!person) {
    const agents = await app.withSuperAdmin((superDb) =>
      superDb
        .select()
        .from(people)
        .where(
          and(
            eq(people.extension, digits),
            eq(people.kind, 'agent'),
            ne(people.status, 'offboarded'),
            ...(lineTenantId ? [eq(people.tenantId, lineTenantId)] : []),
          ),
        ),
    )
    // Still ambiguous when the line names no company and two of them use the
    // same extension — that cannot be routed on the digits alone.
    if (agents.length === 1) person = agents[0] as PersonRow
  }
  if (!person) {
    console.error(`[voice] room ${roomName}: ${digits} matches no provisioned number and no unique extension — cannot route`)
    return null
  }
  const tenantId = person.tenantId
  const counterparty = {
    name: callerNumber ? `Caller ${callerNumber}` : 'Caller',
    identity: participant.identity,
    ...(callerNumber ? { number: callerNumber } : {}),
  }
  const sessionId = randomUUID()
  const summary = `Inbound call from ${callerNumber ?? 'an unknown number'}`

  return app.withTenant(tenantId, async () => {
    const inserted = await app.db
      .insert(callSessions)
      .values({
        id: sessionId,
        tenantId,
        personId: person.id,
        room: roomName,
        direction: 'inbound_phone',
        counterparty,
        // How the callee was reached: a provisioned number is a carrier (PSTN)
        // leg, a bare extension came off the company's own phone system.
        peerKind: viaNumber ? 'pstn' : 'pbx_extension',
        peerExtension: viaNumber ? null : digits,
      })
      .onConflictDoNothing({ target: callSessions.room })
      .returning({ id: callSessions.id })
    if (!inserted[0]) {
      const rows = await app.db.select().from(callSessions).where(eq(callSessions.room, roomName))
      return (rows[0] as SessionRow | undefined) ?? null
    }
    const [run] = await app.db
      .insert(runs)
      .values({
        tenantId,
        personId: person.id,
        status: 'running',
        trigger: { type: 'chat', conversationId: sessionId },
        summary,
      })
      .returning({ id: runs.id })
    await app.db.insert(runEvents).values({
      tenantId,
      runId: run!.id,
      seq: 0,
      kind: 'message',
      payload: { text: `${summary} — answered on ${digits}. Room ${roomName}.` },
    })
    const [row] = await app.db
      .update(callSessions)
      .set({ runId: run!.id, updatedAt: new Date() })
      .where(eq(callSessions.id, sessionId))
      .returning()
    return (row as SessionRow | undefined) ?? null
  })
}

async function markFailed(session: SessionRow, message: string): Promise<void> {
  const now = new Date()
  await app.withTenant(session.tenantId, async () => {
    await app.db
      .update(callSessions)
      .set({ status: 'failed', endedAt: now, updatedAt: now })
      .where(eq(callSessions.id, session.id))
    if (session.runId) {
      await app.db.insert(runEvents).values({
        tenantId: session.tenantId,
        runId: session.runId,
        seq: 1,
        kind: 'error',
        payload: { message },
      })
      await app.db
        .update(runs)
        .set({ status: 'failed', finishedAt: now, summary: message.slice(0, 500) })
        .where(eq(runs.id, session.runId))
    }
  })
}

/** What a video meeting adds on top of a call: a purpose, and a screen. */
type MeetingPosture = {
  /** True when frames of a shared screen actually reach the speech model. */
  seesScreen: boolean
}

/** The agent's whole working identity, plus how to behave on a live call. */
async function buildInstructions(
  session: SessionRow,
  person: PersonRow,
  config: BunkhouseVoiceConfig,
  ai: AiConfig | null,
  meeting: MeetingPosture | null = null,
): Promise<string> {
  const directory = await app.withTenantContext(session.tenantId, () =>
    app.db.select().from(people).where(eq(people.status, 'active')),
  )
  const identity = await getCompanyIdentity(session.tenantId)
  const procedures = await app.withTenantContext(session.tenantId, () => boundProcedures(session.tenantId, person))
  const pinned = await pinnedNotes({ tenantId: session.tenantId, personId: person.id })
  const retrieved = await retrieveNotes({ tenantId: session.tenantId, personId: person.id, query: 'phone call' })
  const notes = [...pinned, ...retrieved.filter((r) => !pinned.some((p) => p.id === r.id))]

  const base = buildSystemPrompt({
    agent: {
      id: person.id,
      name: person.name,
      title: person.title,
      email: person.email,
      personality: person.personality ?? {
        bio: person.responsibilities ?? `I am the ${person.title}.`,
        tone: ['professional'],
        signoff: `Best,\n${person.name.split(' ')[0]}`,
      },
      // Prompt assembly never reads the config; realtime agents may have no text model.
      ai: ai ?? ({ provider: 'openai', apiKey: '' } as AiConfig),
      ...(person.responsibilities ? { responsibilities: person.responsibilities } : {}),
      proactivity: person.proactivity ?? 'duties',
    },
    company: {
      // The same identity mail runs stand on — an agent on the phone works
      // at the same company it writes for.
      ...companyPromptProfile(identity),
      directory: directory.map((p) => ({
        id: p.id,
        kind: p.kind,
        name: p.name,
        title: p.title,
        email: p.email,
        ...(p.responsibilities ? { responsibilities: p.responsibilities } : {}),
        ...(p.reportsToId ? { reportsToId: p.reportsToId } : {}),
      })),
    },
    procedures,
    memories: notes.map((n) => ({ scope: n.scope, slug: n.slug, title: n.title, body: n.body })),
  })

  const caller = session.counterparty.name ?? 'the caller'
  const voiceAddendum = [
    meeting
      ? `You are in a live video meeting with ${caller}.`
      : `You are on a live voice call with ${caller}.`,
    'Talk like the colleague you are, not like a system. Warm, engaged, specific: react to what they actually said, use their name sometimes, carry context forward, and have opinions where your job gives you standing to. Contractions are normal speech. Vary your rhythm — a quick "sure, done" one moment, a couple of sentences of substance the next; never a monologue, and let them in often. Plain spoken words only: no markdown, no lists, no headings, nothing that only works on a screen.',
    'Never answer with a bare fact when a colleague would add the sentence of judgment that makes it useful. And never pad with filler phrases a human would not say on the phone.',
    ...(meeting
      ? [
          ...(session.purpose
            ? [`You set this meeting up. What it is for: ${session.purpose}. Open by saying who you are and what the meeting is about, then let them talk.`]
            : []),
          'They joined from a link in their browser, so they have a camera, a microphone, and a Share screen button. If it would be quicker to be shown than told — an error, a document, a system they are stuck in — ask them to share their screen.',
          meeting.seesScreen
            ? 'While a screen is shared you are sent a still picture of it every few seconds, whenever it changes. Talk about what you can actually see in those pictures, and ask them to scroll or move on when you need to see more. Never describe anything that has not appeared in one — if no picture has arrived yet, say so and ask them to start sharing. If the pictures ever stop reaching you, say so plainly at that point rather than guessing at what is on the screen.'
            : 'You cannot see their screen while the meeting is running. Say that plainly rather than pretending, and ask them to describe what is on it. Everything they share is captured to the meeting record, so you can tell them honestly that you will go through it after the meeting and follow up.',
        ]
      : []),
    ...(session.direction === 'outbound_phone' && session.purpose
      ? [
          `You placed this call. What it is for: ${session.purpose}. Whoever answers has no idea who is on the line, so say who you are and why you are calling before anything else, and let them go once you have what you called for.`,
        ]
      : []),
    `Speak ${config.language && config.language !== 'en' ? `in the language with BCP-47 tag "${config.language}"` : 'English'}.`,
    ...(config.style ? [`Speaking style: ${config.style}.`] : []),
    'You have your working tools on this call: search the web, read pages, send email, search and save your logbook, schedule follow-ups, and use the company integrations. The default is to do the work RIGHT NOW, on the call, together — search while you talk, read the results, and share what you are finding as you find it, like a colleague at the next desk with a laptop open. Say what you are doing in a few words ("give me a second, I am pulling that up"), keep the conversation going, and let them steer while the work is live in front of you both.',
    'If the caller speaks while you are mid-task, just talk with them — the work keeps running in the background and you can share the result when it lands. Never restart a task because you were interrupted.',
    `Work becomes an assignment (take_assignment) only when it genuinely cannot be finished while you talk — hours of research, a document or spreadsheet to produce, waiting on someone else to reply — or when the caller asks you to take it away, get back to them, or send it on. Then confirm the brief out loud first: what a good outcome looks like, any file format they want (PDF, Word, Excel — many assignments need no file at all), who receives it, and any deadline; the outcome arrives by email and the work continues after the call. Never take something as an assignment that you could simply start doing on the line — if in doubt, start live and offer to finish it as an assignment when it turns out to be bigger than the call.`,
    'Some actions need human sign-off first. When a tool answers pending_approval, tell the caller it is queued for approval and will happen once signed off — never claim it is done.',
    'When the conversation is genuinely over — the work is agreed or done, they are wrapping up, goodbyes are being said — say your own goodbye and then call end_call to hang up, the way a person puts the receiver down. Never hang up mid-request or to dodge a question, and if you are unsure whether they are done, ask.',
  ].join('\n')

  return `${base}\n\n${voiceAddendum}`
}

/** How often a captured still is put in front of the model, at most. */
const SCREEN_VISION_INTERVAL_MS = 20_000

/** Live vision, once the meeting is running. */
type ScreenWatch = {
  /** True while stills are still being put in front of the model. */
  visionActive: () => boolean
  /**
   * The model would not take the picture. Stop sending them, take the ones
   * already sent back out of the context so the next turn can succeed, and
   * have the agent say plainly that it cannot see the screen.
   */
  imageRejected: (message: string) => void
}

/**
 * The meeting's eyes. Every sampled still of a shared screen is stored and
 * ledgered on the run — that is the record of what the agent was shown, and it
 * outlives the meeting. Where the speech model takes images, the most recent
 * still is also handed to it between turns, so the agent is talking about the
 * screen it can actually see rather than one it was told about.
 *
 * Whether a text model takes images at all is not something the runtime can
 * know in advance, which is why live vision for cascade agents is an explicit
 * choice on the Voice tab. If the model turns out to refuse the picture, the
 * meeting does not fail: vision goes off, the pictures come back out of the
 * context, and the agent tells the guest it cannot see their screen.
 */
function watchMeetingScreen(args: {
  ctx: JobContext
  session: SessionRow
  person: PersonRow
  agent: voice.Agent
  agentSession: voice.AgentSession
  seesScreen: boolean
  recordEvent: (kind: string, payload: Record<string, unknown>) => Promise<void>
}): ScreenWatch {
  const { ctx, session, person, agent, agentSession, seesScreen, recordEvent } = args
  let frameSeq = 0
  let shownAt = 0
  let visionOn = seesScreen
  const shownMessageIds = new Set<string>()

  const imageRejected = (message: string) => {
    if (!visionOn || shownMessageIds.size === 0) return
    visionOn = false
    console.error(`[voice] room ${ctx.room.name ?? ''}: the model refused a screen still — vision off for this meeting: ${message}`)
    void recordEvent('error', {
      message: `Live screen vision was switched off for this meeting: the agent's model would not accept the picture (${message}).`,
    }).catch(() => undefined)
    // The refused pictures are still in the context; leave them there and
    // every following turn fails the same way.
    const chatCtx = agent.chatCtx.copy()
    chatCtx.items = chatCtx.items.filter((item) => !shownMessageIds.has(item.id))
    shownMessageIds.clear()
    void agent
      .updateChatCtx(chatCtx)
      .then(() => {
        agentSession.generateReply({
          instructions:
            'The pictures of their screen are not reaching you after all. Tell them plainly, in one sentence, that you cannot see their screen, ask them to describe what is on it, and carry on with the meeting.',
        })
      })
      .catch((error) => console.error(`[voice] room ${ctx.room.name ?? ''}: ${(error as Error).message}`))
  }

  const watcher = watchScreenShare({
    room: ctx.room,
    onError: (message) => console.error(`[voice] room ${ctx.room.name ?? ''}: ${message}`),
    onFrame: async (frame) => {
      frameSeq += 1
      const file = await saveFile({
        tenantId: session.tenantId,
        personId: person.id,
        ...(session.runId ? { runId: session.runId } : {}),
        kind: 'recording',
        filename: `screen-${session.id}-${String(frameSeq).padStart(4, '0')}.jpg`,
        contentType: frame.contentType,
        bytes: frame.bytes,
      })
      await recordEvent('message', {
        text: 'Screen-share frame captured',
        fileId: file.id,
        filename: file.filename,
        sharedBy: frame.participantName,
        width: frame.width,
        height: frame.height,
      })
      if (!visionOn) return
      const now = Date.now()
      if (now - shownAt < SCREEN_VISION_INTERVAL_MS) return
      shownAt = now
      const chatCtx = agent.chatCtx.copy()
      const message = chatCtx.addMessage({
        role: 'user',
        content: [
          `${frame.participantName} is sharing their screen. This is what it looks like right now:`,
          llm.createImageContent({ image: frame.dataUrl }),
        ],
      })
      try {
        await agent.updateChatCtx(chatCtx)
        shownMessageIds.add(message.id)
      } catch (error) {
        // Some models refuse image content the moment it is offered rather
        // than at inference time; either way the answer is the same.
        shownMessageIds.add(message.id)
        imageRejected((error as Error).message)
      }
    },
  })
  ctx.addShutdownCallback(() => watcher.stop())
  return { visionActive: () => visionOn, imageRejected }
}

/** A built speech pipeline, and what it can do. */
type SpeechPipeline = {
  session: voice.AgentSession
  /** The agent's text model config — cascade only; null on realtime. */
  ai: AiConfig | null
  /** The cascade LLM leg, so its errors can be told apart from the others'. */
  cascadeLlm: openai.LLM | null
  /** True when stills of a shared screen genuinely reach the model. */
  seesScreen: boolean
}

/**
 * The agent's own voice: cascade (Deepgram hears, the agent's governed model
 * thinks, ElevenLabs speaks) or realtime speech-to-speech. Throws with an
 * operator-readable reason when the configuration cannot hold a call.
 */
async function buildSpeechPipeline(args: {
  tenantId: string
  personId: string
  config: BunkhouseVoiceConfig
  vad: InstanceType<typeof silero.VAD>
}): Promise<SpeechPipeline> {
  const { tenantId, config } = args
  if (config.mode === 'cascade') {
    const ai = await resolveAgentAiConfig(tenantId, args.personId)
    if (!ai || !ai.modelSmart) {
      throw new Error('No model assigned — set a provider and model on the profile before calling.')
    }
    const kind = isAiProvider(ai.provider) ? providerSpec(ai.provider).kind : null
    if (kind !== 'openai' && kind !== 'openai-compatible') {
      // The cascade LLM leg speaks the OpenAI protocol; the Voice tab
      // disables this combo up front — this guard covers stale configs.
      throw new Error(
        'Voice calls in cascade mode are available for agents running OpenAI-compatible models. Choose realtime mode for this agent, or assign an OpenAI-compatible model.',
      )
    }
    const deepgramKey = await resolveSpeechCredential(tenantId, 'deepgram')
    const elevenKey = await resolveSpeechCredential(tenantId, 'elevenlabs')
    if (!deepgramKey || !elevenKey) {
      throw new Error('Speech provider keys are missing — add Deepgram and ElevenLabs in Settings → Voice.')
    }
    const cascade = config.cascade!
    const baseURL = ai.baseUrl ?? (isAiProvider(ai.provider) ? providerSpec(ai.provider).baseUrl : null)
    const cascadeLlm = new openai.LLM({
      apiKey: ai.apiKey,
      model: ai.modelSmart,
      ...(baseURL ? { baseURL } : {}),
    })
    return {
      session: new voice.AgentSession({
        vad: args.vad,
        stt: new deepgram.STT({
          apiKey: deepgramKey,
          model: cascade.sttModel,
          ...(config.language ? { language: config.language } : {}),
        }),
        llm: cascadeLlm,
        tts: new elevenlabs.TTS({
          apiKey: elevenKey,
          voiceId: cascade.ttsVoiceId,
          model: cascade.ttsModel,
          ...(config.language ? { language: config.language } : {}),
        }),
      }),
      ai,
      cascadeLlm,
      // Live vision is the operator's call for a cascade agent: their text
      // model may have no eyes, and only they know.
      seesScreen: config.cascadeVision === true,
    }
  }

  const realtime = config.realtime!
  const credential = await resolveRealtimeCredential(tenantId, realtime.provider)
  if (!credential) {
    throw new Error(
      `No ${realtime.provider === 'google' ? 'Google' : 'OpenAI'} provider is configured under Settings → Model providers — realtime voice runs on its key.`,
    )
  }
  const realtimeModel =
    realtime.provider === 'google'
      ? // Gemini Live. Input and output audio transcription are on by
        // default in the plugin, so both speakers reach the ledger.
        new google.realtime.RealtimeModel({
          apiKey: credential.apiKey,
          model: realtime.model,
          voice: realtime.voice,
          // The Live API takes regioned BCP-47 tags only — it rejects
          // a bare "en" outright. A two-letter preference still steers
          // the agent through the prompt; the model auto-detects the
          // spoken language when none is pinned here.
          ...(config.language && config.language.includes('-') ? { language: config.language } : {}),
        })
      : new openai.realtime.RealtimeModel({
          apiKey: credential.apiKey,
          model: realtime.model,
          voice: realtime.voice,
        })
  return {
    session: new voice.AgentSession({ llm: realtimeModel }),
    ai: null,
    cascadeLlm: null,
    // Screen frames go in as chat-context images between turns, which a
    // session that refuses mid-flight updates cannot take.
    seesScreen: realtimeModel.capabilities.midSessionChatCtxUpdate === true,
  }
}

/**
 * The answering machine. Deepgram hears, ElevenLabs speaks, and nothing
 * thinks: it says one fixed line and then records what the caller says. No
 * model runs, so it costs nothing beyond the minutes and it works even when
 * the agent's own thinking is not configured — which is precisely one of the
 * cases it exists for.
 *
 * Null when the company has no speech provider keys; the caller then falls
 * back to the agent's own voice for the message.
 */
async function buildAnsweringMachine(args: {
  tenantId: string
  config: BunkhouseVoiceConfig | null
  vad: InstanceType<typeof silero.VAD>
}): Promise<voice.AgentSession | null> {
  const deepgramKey = await resolveSpeechCredential(args.tenantId, 'deepgram')
  const elevenKey = await resolveSpeechCredential(args.tenantId, 'elevenlabs')
  if (!deepgramKey || !elevenKey) return null
  const cascade = args.config?.cascade
  const language = args.config?.language
  return new voice.AgentSession({
    vad: args.vad,
    stt: new deepgram.STT({
      apiKey: deepgramKey,
      ...(cascade?.sttModel ? { model: cascade.sttModel } : {}),
      ...(language ? { language } : {}),
    }),
    tts: new elevenlabs.TTS({
      apiKey: elevenKey,
      // The agent's own voice where it has one, so the greeting sounds like
      // the person the caller was trying to reach.
      ...(cascade?.ttsVoiceId ? { voiceId: cascade.ttsVoiceId } : {}),
      ...(cascade?.ttsModel ? { model: cascade.ttsModel } : {}),
      ...(language ? { language } : {}),
    }),
  })
}

export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    proc.userData.vad = await silero.VAD.load()
  },
  entry: async (ctx: JobContext) => {
    await ctx.connect()
    const roomName = ctx.room.name ?? ''
    const isMeeting = roomName.startsWith(MEETING_ROOM_PREFIX)
    let resolvedSession: SessionRow | null = null
    if (roomName.startsWith('call-') || roomName.startsWith(OUTBOUND_ROOM_PREFIX) || isMeeting) {
      // All three are pre-created sessions: the call page's, the one `place_call`
      // committed before asking LiveKit SIP to dial the callee into this room,
      // and the meeting the agent opened when it mailed the invitation.
      resolvedSession = await findSessionByRoom(roomName)
      if (!resolvedSession) {
        console.error(`[voice] no call_sessions row for room ${roomName}`)
        ctx.shutdown('unknown call session')
        return
      }
    } else if (roomName.startsWith('pbx-')) {
      resolvedSession = await ensureInboundPhoneSession(ctx, roomName)
      if (!resolvedSession) {
        ctx.shutdown('unroutable inbound call')
        return
      }
    } else {
      // Automatic dispatch offers every room; only call rooms are ours.
      ctx.shutdown('not a call room')
      return
    }
    const session = resolvedSession

    const person = await app.withTenantContext(session.tenantId, async () => {
      const [row] = await app.db.select().from(people).where(eq(people.id, session.personId))
      return row ?? null
    })
    if (!person || person.kind !== 'agent') {
      await markFailed(session, 'Call failed: the agent no longer exists.')
      ctx.shutdown('agent not callable')
      return
    }
    const isInboundPhone = session.direction === 'inbound_phone'
    const config = (person.voiceConfig as BunkhouseVoiceConfig | null) ?? null
    if (!config && !isInboundPhone) {
      await markFailed(session, 'Call failed: the agent or its voice configuration no longer exists.')
      ctx.shutdown('agent not callable')
      return
    }

    // --- Can this agent take the call at all? ------------------------------
    // A ringing phone is always answered. When the agent cannot hold the
    // conversation the call becomes a voicemail instead of a failure — the
    // caller is told plainly why, and the message becomes work by email.
    let voicemail: VoicemailReason | null = null
    if (isInboundPhone) {
      if (!config) voicemail = 'misconfigured'
      else if (person.status !== 'active') voicemail = 'inactive'
      else if (!isWithinWorkingHours(person.workingHours)) voicemail = 'off_hours'
      else {
        const budget = await callMinutesBudget({
          tenantId: session.tenantId,
          personId: person.id,
          salary: person.salary,
        })
        if (budget.exhausted) voicemail = 'over_budget'
      }
    }

    // --- Build the speech pipeline from tenant-sealed credentials ----------
    let built: voice.AgentSession | null = null
    let ai: AiConfig | null = null
    let cascadeLlm: openai.LLM | null = null
    // Whether frames of a shared screen can reach the model at all: the
    // realtime providers while their session accepts mid-flight context
    // updates, and cascade agents whose operator has turned live vision on.
    let seesScreen = false
    // True while the fixed-script answering machine holds the line: no model
    // runs, so there are no tools, no abilities, and no thinking.
    let answeringMachine = false
    try {
      const vad = ctx.proc.userData.vad as InstanceType<typeof silero.VAD>
      if (voicemail) {
        built = await buildAnsweringMachine({ tenantId: session.tenantId, config, vad })
        answeringMachine = built !== null
      }
      if (!built) {
        if (!config) {
          throw new Error(
            'This agent has no voice configured, and the company has no speech provider keys for it to take a message with. Add Deepgram and ElevenLabs in Settings → Voice.',
          )
        }
        const pipeline = await buildSpeechPipeline({
          tenantId: session.tenantId,
          personId: person.id,
          config,
          vad,
        })
        built = pipeline.session
        ai = pipeline.ai
        cascadeLlm = pipeline.cascadeLlm
        seesScreen = pipeline.seesScreen
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[voice] room ${roomName}: ${message}`)
      await markFailed(session, `Call failed to start: ${message}`)
      ctx.shutdown('setup failed')
      return
    }
    const agentSession = built

    // --- Transcript ledger: append-only, both speakers ---------------------
    const startedAtMs = session.startedAt.getTime()
    let seq = 0
    let turnCount = 0
    /** The same turns in memory — what a voicemail is mailed out as. */
    const transcript: VoicemailTurn[] = []
    const appendTurn = async (speaker: 'agent' | 'human', text: string) => {
      const mySeq = seq++
      turnCount += 1
      const atMs = Math.max(0, Date.now() - startedAtMs)
      transcript.push({ speaker, text, atMs })
      await app.withTenant(session.tenantId, async () => {
        await app.db.insert(callTurns).values({
          tenantId: session.tenantId,
          sessionId: session.id,
          seq: mySeq,
          speaker,
          text,
          atMs,
        })
      })
    }
    const ledgerTurn = (speaker: 'agent' | 'human', text: string) =>
      void appendTurn(speaker, text).catch((error) =>
        console.error(`[voice] turn append failed for ${session.id}:`, (error as Error).message),
      )
    // --- Where a slow turn spends its time -------------------------------
    // One compact line per pipeline leg, so a "ten seconds to answer" report
    // against any deployment can be split into turn detection, model, and
    // speech synthesis by reading the service log instead of guessing.
    agentSession.on(voice.AgentSessionEventTypes.MetricsCollected, (event) => {
      const m = event.metrics
      const ms = (v: number) => `${Math.round(v)}ms`
      if (m.type === 'eou_metrics') {
        console.log(
          `[voice] ${session.id} turn-detect: end-of-utterance ${ms(m.endOfUtteranceDelayMs)}, transcript ${ms(m.transcriptionDelayMs)}`,
        )
      } else if (m.type === 'llm_metrics') {
        console.log(`[voice] ${session.id} llm: first token ${ms(m.ttftMs)}, total ${ms(m.durationMs)}`)
      } else if (m.type === 'tts_metrics') {
        console.log(`[voice] ${session.id} tts: first byte ${ms(m.ttfbMs)}`)
      } else if (m.type === 'realtime_model_metrics') {
        console.log(`[voice] ${session.id} realtime: first audio ${ms(m.ttftMs)}, total ${ms(m.durationMs)}`)
      }
    })
    agentSession.on(voice.AgentSessionEventTypes.ConversationItemAdded, (event) => {
      const item = event.item
      if (item.type !== 'message') return
      const text = item.textContent
      if (!text) return
      const speaker = item.role === 'assistant' ? 'agent' : item.role === 'user' ? 'human' : null
      if (!speaker) return
      ledgerTurn(speaker, text)
    })
    if (answeringMachine) {
      // With no model in the session the framework has nowhere to put a user
      // turn, so the caller's message is ledgered straight off the transcriber.
      agentSession.on(voice.AgentSessionEventTypes.UserInputTranscribed, (event) => {
        if (!event.isFinal) return
        const text = event.transcript.trim()
        if (!text) return
        ledgerTurn('human', text)
      })
    }

    // --- Run events: tool activity, evidence, and anything worth an audit ---
    // Seq starts high above the fixed rows the session setup writes. A call the
    // agent placed itself anchors to the run that placed it, which already has
    // events of its own — (run_id, seq) is unique, so continue past the last.
    let eventSeq = 100
    if (session.runId) {
      const [last] = await app.withTenantContext(session.tenantId, () =>
        app.db
          .select({ seq: runEvents.seq })
          .from(runEvents)
          .where(eq(runEvents.runId, session.runId!))
          .orderBy(desc(runEvents.seq))
          .limit(1),
      )
      if (last) eventSeq = Math.max(eventSeq, last.seq + 1)
    }
    const recordEvent = async (kind: string, payload: Record<string, unknown>) => {
      if (!session.runId) return
      const mySeq = eventSeq++
      await app.withTenant(session.tenantId, async () => {
        await app.db.insert(runEvents).values({
          tenantId: session.tenantId,
          runId: session.runId!,
          seq: mySeq,
          kind: kind as 'tool_call',
          payload,
        })
      })
    }

    // The call's audio, once it is running. Started below, after the finalizer
    // is registered — nothing may be left recording with no one to stop it.
    let recording: CallRecordingHandle | null = null

    // --- End of call: finalize the ledger, complete the run, meter spend ---
    // A completed REFER hands the line to a human and the call ends there; the
    // outcome belongs in the run summary, since no session status says it.
    let transferredTo: string | null = null
    let finalized = false
    const finalize = async () => {
      if (finalized) return
      finalized = true
      const endedAt = new Date()
      const durationSeconds = Math.max(0, Math.round((endedAt.getTime() - startedAtMs) / 1000))
      const minutes = Math.max(1, Math.round(durationSeconds / 60))

      // Stop the recording and file the object the egress uploaded. A lost
      // recording never takes the transcript, the run, or the metering with it.
      if (recording) {
        const result = await finishCallRecording({
          tenantId: session.tenantId,
          sessionId: session.id,
          personId: person.id,
          runId: session.runId ?? null,
          recording,
        })
        if (result.recorded) {
          await recordEvent('message', {
            text: 'Call recording filed',
            fileId: result.fileId,
            filename: recording.filename,
          }).catch(() => undefined)
        } else {
          console.error(`[voice] recording for ${session.id} was not filed: ${result.reason}`)
          await recordEvent('error', { message: `The call recording was not saved: ${result.reason}` }).catch(
            () => undefined,
          )
        }
      }

      // Meter LLM usage from the framework's per-model usage summaries into
      // the same token_spend ledger email runs use. When no LLM usage was
      // exposed, costUsd stays null — never fabricated.
      let totalCost: number | null = null
      try {
        const usage = agentSession.usage.modelUsage
        for (const entry of usage) {
          if (entry.type !== 'llm_usage') continue
          const inputTokens = entry.inputTokens ?? 0
          const outputTokens = entry.outputTokens ?? 0
          if (inputTokens === 0 && outputTokens === 0) continue
          const model = entry.model ?? 'unknown'
          const price = await resolvePrice(session.tenantId, model)
          const cost = (inputTokens * price.inputUsdPerMtok + outputTokens * price.outputUsdPerMtok) / 1_000_000
          totalCost = (totalCost ?? 0) + cost
          await app.withTenant(session.tenantId, async () => {
            await app.db.insert(tokenSpend).values({
              tenantId: session.tenantId,
              personId: person.id,
              runId: session.runId ?? session.id,
              provider: entry.provider ?? 'unknown',
              model,
              inputTokens,
              outputTokens,
              costUsd: cost.toFixed(6),
              inputUsdPerMtok: price.inputUsdPerMtok.toFixed(4),
              outputUsdPerMtok: price.outputUsdPerMtok.toFixed(4),
              priceSource: price.source,
            })
          })
        }
      } catch (error) {
        console.error(`[voice] usage metering failed for ${session.id}:`, (error as Error).message)
      }

      // Speech is billed by the minute, not by the token: price the call's
      // hearing and speaking legs from the tenant's own per-minute rates and
      // add them to the same ledger, so salary reflects the whole call. With
      // no rates configured the minutes are still recorded and no money is
      // claimed for them.
      // The answering machine runs on Deepgram and ElevenLabs whatever the
      // agent's own mode is — including when it has no configuration at all.
      const speechConfig: BunkhouseVoiceConfig | null = answeringMachine
        ? { mode: 'cascade', ...(config?.cascade ? { cascade: config.cascade } : {}) }
        : config
      try {
        const speech = await meterSpeechMinutes({
          tenantId: session.tenantId,
          personId: person.id,
          runId: session.runId ?? session.id,
          config: speechConfig,
          durationSeconds,
        })
        if (speech.usd > 0) totalCost = (totalCost ?? 0) + speech.usd
      } catch (error) {
        console.error(`[voice] speech metering failed for ${session.id}:`, (error as Error).message)
      }

      // A message taken becomes work the ordinary way: mailed to the agent's
      // own inbox, where the inbound-mail pass picks it up on its next run.
      let voicemailNote: string | null = null
      if (voicemail) {
        const delivery = await deliverVoicemail({
          tenantId: session.tenantId,
          person: { id: person.id, name: person.name, email: person.email },
          counterparty: session.counterparty,
          reason: voicemail,
          turns: transcript,
          durationSeconds,
          runId: session.runId ?? null,
          receivedAt: endedAt,
        })
        if (delivery.delivered) {
          voicemailNote = `message mailed to ${person.email}`
          await recordEvent('message', {
            text: `Voicemail taken and mailed to ${person.email}`,
            subject: delivery.subject,
            threadId: delivery.threadId,
          }).catch(() => undefined)
        } else {
          voicemailNote = 'message could not be mailed'
          console.error(`[voice] voicemail for ${session.id} was not delivered: ${delivery.reason}`)
          await recordEvent('error', {
            message: `The voicemail could not be mailed to ${person.email}: ${delivery.reason}. The transcript is on this call.`,
          }).catch(() => undefined)
        }
      }

      await app.withTenant(session.tenantId, async () => {
        const [current] = await app.db.select().from(callSessions).where(eq(callSessions.id, session.id))
        if (current && current.status === 'active') {
          await app.db
            .update(callSessions)
            .set({
              status: 'ended',
              endedAt,
              durationSeconds,
              ...(totalCost !== null ? { costUsd: totalCost.toFixed(4) } : {}),
              updatedAt: endedAt,
            })
            .where(eq(callSessions.id, session.id))
        } else if (current && totalCost !== null && current.costUsd === null) {
          await app.db
            .update(callSessions)
            .set({ costUsd: totalCost.toFixed(4), updatedAt: endedAt })
            .where(eq(callSessions.id, session.id))
        }
        if (session.runId) {
          const [run] = await app.db.select().from(runs).where(eq(runs.id, session.runId))
          if (run && run.status === 'running') {
            const parts = [
              `${turnCount} turn${turnCount === 1 ? '' : 's'}`,
              `${minutes} minute${minutes === 1 ? '' : 's'}`,
              ...(transferredTo ? [`transferred to ${transferredTo}`] : []),
              ...(voicemailNote ? [voicemailNote] : []),
            ]
            const opening = voicemail
              ? `Voicemail from ${callerLabel(session.counterparty)}`
              : session.direction === 'inbound_phone'
                ? `Inbound call from ${session.counterparty.number ?? 'an unknown number'}`
                : session.direction === 'outbound_phone'
                  ? `Outbound call to ${session.counterparty.name ?? session.counterparty.number ?? 'an unknown number'}`
                  : isMeeting
                    ? `Video meeting with ${session.counterparty.name ?? 'the guest'}`
                    : `Voice call with ${session.counterparty.name ?? 'the caller'}`
            await app.db
              .update(runs)
              .set({
                status: 'completed',
                finishedAt: endedAt,
                summary: `${opening}: ${parts.join(', ')}.`,
              })
              .where(eq(runs.id, session.runId))
          }
        }
      })
      console.log(`[voice] call ${session.id} finalized — ${turnCount} turns, ${durationSeconds}s`)
    }
    ctx.addShutdownCallback(finalize)

    // --- Recording ----------------------------------------------------------
    // LiveKit Egress mixes the room straight into the company's own object
    // storage; the bytes never come through this process. A call that cannot
    // be recorded still happens — the reason goes on the run, in the open.
    const startedRecording = await startCallRecording({
      tenantId: session.tenantId,
      sessionId: session.id,
      room: roomName,
    })
    if (startedRecording.started) {
      recording = startedRecording.recording
    } else {
      console.warn(`[voice] room ${roomName}: not recording — ${startedRecording.reason}`)
      await recordEvent('message', {
        text: `This call is not being recorded: ${startedRecording.reason}`,
      }).catch(() => undefined)
    }

    // --- Taking a message ---------------------------------------------------
    // The agent cannot hold this conversation, so it answers, says why, and
    // records what the caller has to say. No tools, no abilities, no work
    // started on the line: the message is the whole job, and it becomes work
    // when it lands in the agent's inbox at the end of the call.
    if (voicemail) {
      const caller = callerLabel(session.counterparty)
      try {
        const instructions = voicemailInstructions({
          agentName: person.name,
          reason: voicemail,
          caller,
          language: config?.language,
        })
        await recordEvent('message', {
          text: `Answering as voicemail (${voicemail.replace('_', ' ')}) — taking a message from ${caller}.`,
        }).catch(() => undefined)
        await agentSession.start({ agent: new voice.Agent({ instructions }), room: ctx.room })
        if (answeringMachine) {
          // Nothing is thinking: the greeting is a fixed line, spoken once.
          agentSession.say(voicemailGreeting({ agentName: person.name, reason: voicemail }))
        } else {
          agentSession.generateReply({
            instructions:
              'Answer the call: say who you are, that you cannot take it right now, and ask them to leave their message.',
          })
        }
        console.log(
          `[voice] ${person.name} is taking a voicemail in room ${roomName} (${voicemail}${answeringMachine ? '' : ', own voice'})`,
        )
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.error(`[voice] room ${roomName} voicemail error: ${message}`)
        await markFailed(session, `Call failed: ${message}`)
        ctx.shutdown('voicemail error')
      }
      return
    }

    // Past this point the call is a working conversation, which is only
    // reached when the agent's own voice configuration held: every route that
    // leaves it unset answers as a voicemail above.
    const liveConfig = config!

    // --- The working toolset: same abilities as email runs, call posture ---
    const assembled = await app.withTenantContext(session.tenantId, () =>
      assembleAbilities({
        tenantId: session.tenantId,
        person,
        runId: session.runId ?? session.id,
        // Work taken on this call anchors to the call, and defaults its
        // delivery to whoever is on the line (web callers carry an email).
        assignmentSource: { kind: 'call', sessionId: session.id },
        counterparty: {
          ...(session.counterparty.name ? { name: session.counterparty.name } : {}),
          ...(session.counterparty.email ? { address: session.counterparty.email } : {}),
        },
      }),
    )
    for (const failure of assembled.integrationFailures) {
      console.error(`[voice] room ${roomName}: integration unavailable — ${failure}`)
    }
    const dialRows = await app.withTenantContext(session.tenantId, () =>
      app.db.select().from(autonomySettings).where(eq(autonomySettings.personId, person.id)),
    )
    const dial = new Map(dialRows.map((r) => [r.category, r.level]))

    // --- Human pacing around slow tools ------------------------------------
    // When a tool runs past the slow threshold, the agent says one short
    // filler line — never stacked (one filler at a time), and never over the
    // caller's or its own speech. The model's tool-result continuation is
    // native; the only quiet failure mode is the filler having consumed the
    // turn, so a settle after a filler watches briefly and nudges the agent
    // to share the result only if nobody resumed on their own.
    let fillerToolName: string | null = null
    const speakFiller = (toolName: string) => {
      if (finalized || fillerToolName !== null) return
      if (agentSession.userState === 'speaking' || agentSession.agentState === 'speaking') return
      fillerToolName = toolName
      try {
        agentSession.generateReply({
          instructions:
            'The lookup is still running. Say one very short natural filler line to keep the caller company. Do not repeat yourself.',
        })
      } catch {
        // The session is draining or closed — skip the nicety, keep the call.
        fillerToolName = null
      }
    }
    const resumeAfterSettle = (toolName: string) => {
      if (fillerToolName !== toolName) return
      fillerToolName = null
      let resumed = false
      const onState = (event: { newState: string }) => {
        if (event.newState === 'thinking' || event.newState === 'speaking') resumed = true
      }
      agentSession.on(voice.AgentSessionEventTypes.AgentStateChanged, onState)
      setTimeout(() => {
        agentSession.off(voice.AgentSessionEventTypes.AgentStateChanged, onState)
        if (finalized || resumed) return
        if (agentSession.agentState === 'thinking' || agentSession.agentState === 'speaking') return
        if (agentSession.userState === 'speaking') return
        try {
          agentSession.generateReply({ instructions: 'Share what you found, naturally.' })
        } catch {
          // The session closed while we waited — nothing to resume.
        }
      }, 2000)
    }

    const tools = governedCallTools({
      abilities: assembled.abilities,
      // Missing categories default to 'approval' — the safe posture for
      // anything nobody configured, same as email runs.
      autonomy: (category) => dial.get(category) ?? 'approval',
      fileApproval: async (input) => {
        // approvals.run_id is NOT NULL: an approval with no run to hang off
        // cannot be filed, and silently dropping the column would fail the
        // insert mid-call. Say so instead — the caller is told it is queued
        // only when it genuinely is.
        if (!session.runId) {
          throw new Error('This call has no run to record an approval against.')
        }
        const runId = session.runId
        return app.withTenant(session.tenantId, async () => {
          const [row] = await app.db
            .insert(approvals)
            .values({
              tenantId: session.tenantId,
              runId,
              personId: person.id,
              category: input.category,
              payload: { description: input.description, action: input.action },
            })
            .returning({ id: approvals.id })
          return { approvalId: row!.id }
        })
      },
      record: (kind, payload) => recordEvent(kind, payload),
      onSlow: ({ toolName }) => speakFiller(toolName),
      onSettled: ({ toolName }) => resumeAfterSettle(toolName),
    })
    // Handing the caller to a human is not a shared ability: it acts on this
    // room's SIP leg, so it exists only where there is one. A completed REFER
    // is cold — the phone leg goes to the PBX and the agent is out — so the
    // ledger closes here rather than waiting for a hangup that never comes.
    if (session.direction === 'inbound_phone' || session.direction === 'outbound_phone') {
      tools.transfer_call = llm.tool({
        description:
          'Transfer the person on the line to a human colleague at their extension. Tell them who you are putting them through to first — the transfer is final and takes you off the call.',
        parameters: z.object({
          extension: z.string().describe("The colleague's extension, or a full number with country code."),
          reason: z.string().describe('Why the call is being transferred — recorded on the run.'),
        }),
        execute: async ({ extension, reason }) => {
          await recordEvent('tool_call', {
            toolName: 'transfer_call',
            category: 'phone_call',
            input: { extension, reason },
          })
          const phoneLeg = Array.from(ctx.room.remoteParticipants.values()).find((participant) =>
            Object.keys(participant.attributes).some((key) => key.startsWith('sip.')),
          )
          if (!phoneLeg) {
            const output = { transferred: false, reason: 'There is no phone line on this call to transfer.' }
            await recordEvent('tool_result', { toolName: 'transfer_call', output })
            return { ...output, note: 'Say plainly that you cannot transfer this call, and offer to pass the message on instead.' }
          }
          const result = await transferCallToExtension({
            tenantId: session.tenantId,
            room: roomName,
            participantIdentity: phoneLeg.identity,
            extension,
          })
          await recordEvent('tool_result', { toolName: 'transfer_call', output: result })
          if (!result.transferred) {
            return {
              ...result,
              note: 'Tell them the transfer did not go through, apologize, and carry on with the call yourself.',
            }
          }
          const destination = extension.trim()
          transferredTo = destination
          await finalize()
          return {
            transferred: true,
            note: `The line is on its way to ${destination}. Say nothing further — you are off this call.`,
          }
        },
      }) as unknown as llm.FunctionTool
    }
    // Hanging up is the agent's to do when the goodbye is genuinely said —
    // the receiver going down, not a timeout. The tool returns immediately so
    // the model can finish its last words; the hangup itself waits for that
    // speech to play out (close() drains), settles the ledger, and then takes
    // the room down, which is what actually ends the call for the caller.
    tools.end_call = llm.tool({
      description:
        'Hang up the call. Use only when the conversation has reached its natural end — the work is agreed or done and goodbyes have been said. Never to cut someone off.',
      parameters: z.object({
        reason: z.string().describe('One line on how the call concluded — recorded on the run.'),
      }),
      execute: async ({ reason }) => {
        await recordEvent('tool_call', { toolName: 'end_call', category: 'phone_call', input: { reason } })
        // Result lands with the call, not after it: the activity feed pairs
        // calls with results, and this one's outcome is the hangup itself.
        await recordEvent('tool_result', { toolName: 'end_call', output: { ended: true, reason } }).catch(() => {})
        void (async () => {
          try {
            await agentSession.close()
          } catch {
            // Already closing — the hangup below still stands.
          }
          try {
            await finalize()
            await ctx.deleteRoom()
          } catch (error) {
            console.error(`[voice] room ${roomName}: hangup failed — ${(error as Error).message}`)
          }
        })()
        return { ended: true, note: 'The line is closing — finish your goodbye if any words are left, nothing more.' }
      },
    }) as unknown as llm.FunctionTool
    ctx.addShutdownCallback(() => assembled.close())

    try {
      const instructions = await buildInstructions(session, person, liveConfig, ai, isMeeting ? { seesScreen } : null)
      const agent = new voice.Agent({ instructions, tools })
      await agentSession.start({ agent, room: ctx.room })
      if (isMeeting) {
        const screen = watchMeetingScreen({ ctx, session, person, agent, agentSession, seesScreen, recordEvent })
        // A cascade agent's text model may simply refuse the picture. The
        // failure surfaces on its next inference, so the LLM leg's errors are
        // what tell us — and only that leg's, which is why the instance is
        // kept: an STT or TTS hiccup must never be read as blindness.
        if (cascadeLlm) {
          agentSession.on(voice.AgentSessionEventTypes.Error, (event) => {
            if (event.source !== cascadeLlm || !screen.visionActive()) return
            const error = event.error as { message?: string }
            screen.imageRejected(error.message ?? 'the model rejected the request')
          })
        }
      }
      agentSession.generateReply({
        instructions: isMeeting
          ? session.purpose
            ? `Greet ${session.counterparty.name ?? 'them'} briefly, as yourself, say the meeting is about: ${session.purpose}, and ask them to show you what they are working with when they are ready.`
            : `Greet ${session.counterparty.name ?? 'them'} briefly, as yourself, and ask what they would like to go through.`
          : session.direction === 'outbound_phone' && session.purpose
            ? `You placed this call to: ${session.purpose}. Introduce yourself and get to it politely.`
            : `Greet ${session.counterparty.name ?? 'the caller'} briefly, as yourself, and ask how you can help.`,
      })
      console.log(`[voice] ${person.name} answered room ${roomName} (${liveConfig.mode})`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[voice] room ${roomName} session error: ${message}`)
      await markFailed(session, `Call failed: ${message}`)
      ctx.shutdown('session error')
    }
  },
})

// One warm job process, not one per core. In production mode the framework
// prewarms `min(cores, 4)` idle processes, and each one is a full import of
// this file — the app's db client, the appkit packages, the LiveKit plugins,
// and silero's onnx runtime — so four of them cost more resident memory than
// the deployment's container limit allows, and the whole worker is killed
// before it can register. Dev mode prewarms none, which is why calls only go
// unanswered once deployed. One process answers the first call just as fast;
// further concurrent calls spawn their own.
cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url), numIdleProcesses: 1 }))
