import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { and, desc, eq, ne } from 'drizzle-orm'
import { cli, defineAgent, voice, ServerOptions, type JobContext, type JobProcess } from '@livekit/agents'
import { RoomEvent } from '@livekit/rtc-node'
import * as deepgram from '@livekit/agents-plugin-deepgram'
import * as elevenlabs from '@livekit/agents-plugin-elevenlabs'
import * as google from '@livekit/agents-plugin-google'
import * as openai from '@livekit/agents-plugin-openai'
import * as silero from '@livekit/agents-plugin-silero'
import { isAiProvider, providerSpec, type AiConfig } from '@appkit/ai'
import { buildSystemPrompt } from '@bunkhouse/runtime'
import { db } from '../src/db/client'
import {
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
import { autonomyDial, boundProcedures, requestApproval, runMemories } from '../src/lib/agent-runs'
import { callTools } from '../src/lib/call-tools'
import { createCallWorker, describeError, type CallWorker } from '../src/lib/call-worker'
import { openAgentEyes, type AgentEyes } from '../src/lib/call-vision'
import { resolveAgentAiConfig } from '../src/lib/ai'
import { OUTBOUND_ROOM_PREFIX, transferCallToExtension } from '../src/lib/outbound-call'
import { resolveRealtimeCredential, resolveSpeechCredential } from '../src/lib/voice'
import { MEETING_ROOM_PREFIX } from '../src/lib/meetings'
import { watchScreenShare } from '../src/lib/screen-share'
import { saveFile } from '../src/lib/files'
import { companyPromptProfile, getCompanyIdentity } from '../src/lib/company-identity'
import { priceSpend } from '../src/lib/pricing'
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
// - seeing: neither the framework's room input (videoEnabled is declared but
//   unimplemented in 1.6.0) nor the Gemini plugin's pushVideo (a no-op)
//   carries video into a realtime session, so pictures reach the model the way
//   both realtime plugins genuinely do accept images — as chat-context image
//   content, pushed between turns. Cascade sessions take the same path. There
//   are two sources: the guest's shared screen in a meeting, and the agent's
//   own browser while it works on the line. Both go through one pair of eyes
//   (openAgentEyes), and every picture is offered rather than predicted: a
//   model with no vision refuses one, and that refusal switches vision off for
//   the rest of the call, pulls the offered pictures back out of the context,
//   and has the agent say plainly that it cannot see. Every sampled screen
//   frame and every browser step is stored as evidence on the run regardless.
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

/** What the agent can see on this call, and what kind of call it is. */
type CallPosture = {
  /** A video meeting rather than a phone call: there is a screen to share. */
  meeting: boolean
  /**
   * True when pictures can reach the model at all — a shared screen, and the
   * agent's own browser. A model that turns out to refuse them is told so at
   * the moment it happens, by the eyes that offered the picture.
   */
  seesScreen: boolean
  /** True when this agent has its browser on the call. */
  browser: boolean
}

/** The agent's whole working identity, plus how to behave on a live call. */
async function buildInstructions(
  session: SessionRow,
  person: PersonRow,
  config: BunkhouseVoiceConfig,
  ai: AiConfig | null,
  posture: CallPosture,
): Promise<string> {
  const directory = await app.withTenantContext(session.tenantId, () =>
    app.db.select().from(people).where(eq(people.status, 'active')),
  )
  const identity = await getCompanyIdentity(session.tenantId)
  const procedures = await app.withTenantContext(session.tenantId, () => boundProcedures(session.tenantId, person))
  const notes = await app.withTenantContext(session.tenantId, () =>
    runMemories({ tenantId: session.tenantId, personId: person.id, query: 'phone call' }),
  )

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
    memories: notes,
  })

  const caller = session.counterparty.name ?? 'the caller'
  const voiceAddendum = [
    posture.meeting
      ? `You are in a live video meeting with ${caller}.`
      : `You are on a live voice call with ${caller}.`,
    'Talk like the colleague you are, not like a system. Warm, engaged, specific: react to what they actually said, use their name sometimes, carry context forward, and have opinions where your job gives you standing to. Contractions are normal speech. Plain spoken words only: no markdown, no lists, no headings, nothing that only works on a screen.',
    'Keep your turns SHORT — a sentence or two, five to ten seconds of speech, then stop and let them back in. This is a phone call, not a briefing: nobody listens to fifteen seconds of you without a turn. Give the headline first and offer the rest ("I found four that fit — want me to run through them?") rather than delivering all four unasked. Go longer only when they explicitly ask for detail, and even then come up for air.',
    'Never answer with a bare fact when a colleague would add the sentence of judgment that makes it useful. And never pad with filler phrases a human would not say on the phone.',
    ...(posture.meeting
      ? [
          ...(session.purpose
            ? [`You set this meeting up. What it is for: ${session.purpose}. Open by saying who you are and what the meeting is about, then let them talk.`]
            : []),
          'They joined from a link in their browser, so they have a camera, a microphone, and a Share screen button. If it would be quicker to be shown than told — an error, a document, a system they are stuck in — ask them to share their screen.',
          posture.seesScreen
            ? 'While a screen is shared you are sent a still picture of it every few seconds, whenever it changes. Talk about what you can actually see in those pictures, and ask them to scroll or move on when you need to see more. Never describe anything that has not appeared in one — if no picture has arrived yet, say so and ask them to start sharing. If the pictures ever stop reaching you, say so plainly at that point rather than guessing at what is on the screen.'
            : 'You cannot see their screen while the meeting is running. Say that plainly rather than pretending, and ask them to describe what is on it. Everything they share is captured to the meeting record, so you can tell them honestly that you will go through it after the meeting and follow up.',
        ]
      : []),
    ...(posture.browser
      ? [
          posture.seesScreen
            ? 'When you use your own browser on this call, a picture of the page arrives right after each step, so you can see what you are doing. Look at it before you decide what happened: if the picture and what you expected disagree, the picture is right. Never tell them a search came back empty, or a form went through, on the strength of a tool saying "done" — say what you can actually see on the page.'
            : 'Your browser gives you the page as text on this call; the pictures of it cannot reach you here. Work from the text and from what each step reports, never claim to have looked at something, and if a page will not do what you expect, say so plainly and offer to finish it after the call rather than guessing.',
        ]
      : []),
    ...(session.direction === 'outbound_phone' && session.purpose
      ? [
          `You placed this call. What it is for: ${session.purpose}. Whoever answers has no idea who is on the line, so say who you are and why you are calling before anything else, and let them go once you have what you called for.`,
        ]
      : []),
    `Speak ${config.language && config.language !== 'en' ? `in the language with BCP-47 tag "${config.language}"` : 'English'}.`,
    ...(config.style ? [`Speaking style: ${config.style}.`] : []),
    // The enumeration matters more than it looks: a model believes this
    // sentence over its own tool list, and an earlier version of it named only
    // search and email — so agents told callers they could not drive a browser
    // or run a command they had the tools for the whole time. Never describe
    // the toolset as narrower than it is.
    'You have your whole working kit on this call, not a reduced one: search the web and read pages; drive a real browser (open, click, type, read, screenshot) for anything a plain fetch cannot do; a persistent workspace of your own with a shell in it, where you can fetch, run, build and organize real files; write documents and spreadsheets; send email and messages; search and save your logbook; schedule follow-ups; and every company integration connected to you.',
    // The talker holds six tools; the kit above is reached through one of them.
    // Say so plainly, or the model reasons from the short tool list in front of
    // it and tells the caller it cannot do things it can.
    'You reach all of that one way while you are on the phone: do_work. Hand it what needs doing in plain language, exactly as you would ask a capable colleague — "find the three nearest suppliers of galvanised pipe and what they charge", "look up their last invoice and tell me what is outstanding". It comes back to you instantly, the work runs while you keep talking, and what is actually happening reaches you as it happens. Say what you have been told and nothing more: never invent a result, and never announce something is done before it comes back. If you are unsure whether something is possible, HAND IT OVER — the answer comes back from the attempt, never from your assumptions about yourself. Never tell a caller you cannot do something you have not attempted. Use check_work when you want to know where things stand before you speak.',
    'This is you working, not a machine you are operating. Never say "my worker", "the system", "the tool", "the task", or a reference number to a caller. You say "let me pull that up", "I am looking now", "just found it" — the ordinary words of someone with a laptop open at the next desk.',
    'The default is to do the work RIGHT NOW, on the call, together — hand it over while you talk, and share what you are finding as you find it. Say what you are doing in a few words ("give me a second, I am pulling that up"), keep the conversation going, and let them steer while the work is live in front of you both.',
    // Relentlessness. Models treat the first failure as a verdict and hand the
    // problem back to the person who asked; a colleague does not.
    // What a person does while something loads. Without this the agent hands
    // the work over and then sits in silence until it lands, which reads as a
    // dropped line — and worse, it treats its own status notes as the caller
    // talking, because they are the only thing arriving.
    'While work of yours is running, you are still on the phone with someone. Keep them company the way anyone does across a pause: ask the question you would need answered anyway to make the result useful ("are you driving up or flying in?", "is this for tonight or are the dates loose?"), pick up whatever they were saying before, or make a bit of ordinary conversation — how their day is going, the weather where they are, the thing they mentioned earlier. Read the room: someone in a hurry wants quiet and a fast answer, someone chatty will happily fill the gap. What you must not do is go silent and wait, and you must not narrate your own hands — nobody wants a running commentary of pages being opened.',
    'Be relentless. One source refusing you is not a dead end, it is the first thing you tried: a 403, a bot check, a dead domain, a page that will not load — go straight to the next route without being asked. Try the official site, then the search result you have not opened yet, then a directory or aggregator, then the cached or printable version, then a different search phrasing, then the browser instead of a plain fetch. Three or four genuine attempts down different paths before you even mention difficulty. Never answer a request with a question when you could answer it with an attempt, and never hand the work back ("would you like me to try another site?") — try it, then tell them what you found. Only when you have honestly exhausted the routes do you say so, and then say exactly what you tried and what stopped you.',
    'If the caller speaks while work is running, just talk with them — it keeps going and you share the result when it lands. Never hand the same thing over twice because you were interrupted.',
    // The line between the two dispositions of one capability: same kit, same
    // rules, different timing. do_work is what they are waiting on; an
    // assignment is what outlives the call and arrives by email.
    `take_assignment is the same work with different timing: it outlives this call and the outcome arrives by email. Use it when the work genuinely cannot be finished while you talk — hours of research, a document or spreadsheet to produce, waiting on someone else to reply — or when the caller asks you to take it away, get back to them, or send it on. Then confirm the brief out loud first: what a good outcome looks like, any file format they want (PDF, Word, Excel — many assignments need no file at all), who receives it, and any deadline. Never take something as an assignment that you could simply do on the line — if in doubt, hand it to do_work now and offer to finish it as an assignment when it turns out to be bigger than the call.`,
    'Use remember when the caller tells you something worth keeping — a preference, a correction, a fact about them or their business you would want on the next call.',
    'Some actions need human sign-off first. When something comes back queued for approval, tell the caller it is with their manager and will happen once signed off — never claim it is done, and never ask for the same sign-off twice.',
    'When the conversation is genuinely over — the work is agreed or done, they are wrapping up, goodbyes are being said — say your own goodbye and then call end_call to hang up, the way a person puts the receiver down. Never hang up mid-request or to dodge a question, and if you are unsure whether they are done, ask.',
  ].join('\n')

  return `${base}\n\n${voiceAddendum}`
}

/** How often a captured still is put in front of the model, at most. */
const SCREEN_VISION_INTERVAL_MS = 20_000

/** How long a greeting may take before silence is treated as a fault. */
const GREETING_GRACE_MS = 12_000

/**
 * How the framework talks to the agent about work running beside the call.
 *
 * Progress and results reach the model through the async-tool machinery, which
 * renders them with a template before inserting them into the conversation.
 * The stock templates say things like "The tool `do_work` has updated" and
 * quote call ids — mechanical language a caller must never hear the agent
 * repeat. These say the same things the way a person would.
 */
const ASYNC_TOOL_VOICE = {
  updateTemplate: ({ message }: { message: string }) =>
    // Emphatically not a turn from the caller: without this the model answers
    // the status line as though it had been spoken to, thanks them for it, and
    // carries on a conversation nobody was having.
    `[Status of your own background work — the caller did not say this and is not waiting for an answer to it: ${message}]\n(If you are already speaking, finish your sentence first. Then, only if it is worth mentioning, say where you are up to in one short clause, in your own words. If it adds nothing, say nothing at all. Never treat this as something the caller said, never thank them for it, never invent a result, and never call the work finished.)`,
  replyAtTailTemplate: () =>
    'The work you had running has come back. Tell them what came of it, briefly and naturally, in your own words — the actual facts, no mechanics, no reference numbers.',
  replyMaybeCoveredTemplate: () =>
    'The work you had running has come back, and you may already have said some of it. If they have heard it all, reply with nothing at all. Otherwise say only the part they have not heard, with a natural transition, in your own words.',
} as const

/** What the agent is told to say if a screen still is the picture that bounces. */
const SCREEN_REFUSED_LINE =
  'The pictures of their screen are not reaching you after all. Tell them plainly, in one sentence, that you cannot see their screen, ask them to describe what is on it, and carry on with the meeting.'

/**
 * The meeting's screen. Every sampled still of a shared screen is stored and
 * ledgered on the run — that is the record of what the agent was shown, and it
 * outlives the meeting. The most recent still is also handed to the agent's
 * eyes between turns, so the agent is talking about the screen it can actually
 * see rather than one it was told about.
 */
function watchMeetingScreen(args: {
  ctx: JobContext
  session: SessionRow
  person: PersonRow
  eyes: AgentEyes
  recordEvent: (kind: string, payload: Record<string, unknown>) => Promise<void>
}): void {
  const { ctx, session, person, eyes, recordEvent } = args
  let frameSeq = 0
  let shownAt = 0

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
      if (!eyes.active()) return
      const now = Date.now()
      if (now - shownAt < SCREEN_VISION_INTERVAL_MS) return
      shownAt = now
      await eyes.show({
        dataUrl: frame.dataUrl,
        caption: `${frame.participantName} is sharing their screen. This is what it looks like right now:`,
        ifRefused: SCREEN_REFUSED_LINE,
      })
    },
  })
  ctx.addShutdownCallback(() => watcher.stop())
}

/** A built speech pipeline, and what it can do. */
type SpeechPipeline = {
  session: voice.AgentSession
  /** The agent's text model config — cascade only; null on realtime. */
  ai: AiConfig | null
  /** The cascade LLM leg, so its errors can be told apart from the others'. */
  cascadeLlm: openai.LLM | null
  /**
   * True when this session can carry a picture at all. It says nothing about
   * whether the model will accept one — that is discovered by offering.
   */
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
        // The framework already generates the reply preemptively on the
        // stable partial transcript; speaking it preemptively too takes TTS
        // off the critical path as well. The cost is resynthesizing the odd
        // discarded turn — characters, not conversations.
        turnHandling: { preemptiveGeneration: { preemptiveTts: true } },
      }),
      ai,
      cascadeLlm,
      // Nobody can say in advance whether a text model has eyes — not the
      // runtime, not the operator. So the pictures are offered, and a model
      // that refuses one turns vision off for the rest of the call and says
      // so out loud. An unknown answered by trying, not by a settings switch.
      seesScreen: true,
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
      const message = describeError(error)
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
        console.error(`[voice] turn append failed for ${session.id}:`, describeError(error)),
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
        // Named, because which speech-to-speech model is answering is the
        // single biggest lever on how long a caller waits.
        const who = [m.metadata?.modelProvider, m.metadata?.modelName].filter(Boolean).join(' ') || m.label
        console.log(`[voice] ${session.id} realtime (${who}): first audio ${ms(m.ttftMs)}, total ${ms(m.durationMs)}`)
      }
    })
    // Whether the agent has genuinely made a sound. The session enters
    // 'speaking' when audio starts playing out — on the cascade path and the
    // realtime one alike — which is the only honest answer to "did the caller
    // hear anything", and the one the silence watchdog below stands on.
    let agentSpoke = false
    agentSession.on(voice.AgentSessionEventTypes.AgentStateChanged, (event) => {
      if (event.newState === 'speaking') agentSpoke = true
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
    // Settles when the egress request has been answered, one way or the other.
    // Declared before the finalizer that awaits it, because the finalizer is
    // registered as a shutdown callback before the request is made.
    let recordingStarted: Promise<unknown> = Promise.resolve()

    // --- End of call: finalize the ledger, complete the run, meter spend ---
    // A completed REFER hands the line to a human and the call ends there; the
    // outcome belongs in the run summary, since no session status says it.
    let transferredTo: string | null = null
    let finalized = false
    // Built below, once the abilities are assembled. Named here because the
    // finalizer is the one place every ending passes through, and work with
    // nobody left to tell must not outlive the call on any of them.
    let worker: CallWorker | null = null
    const finalize = async () => {
      if (finalized) return
      finalized = true
      await worker?.stop('the call ended')
      const endedAt = new Date()
      const durationSeconds = Math.max(0, Math.round((endedAt.getTime() - startedAtMs) / 1000))
      const minutes = Math.max(1, Math.round(durationSeconds / 60))

      // Stop the recording and file the object the egress uploaded. A lost
      // recording never takes the transcript, the run, or the metering with it.
      // The start was left running in the background so the caller was not kept
      // waiting; a call that ends before it settled waits for it here, which is
      // the one place waiting costs nobody anything.
      await recordingStarted
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
          // The call framework hands back token counts and nothing else — its
          // model client takes no request-body options, so there is no way to
          // ask the gateway to price the turn the way an email run does. These
          // rows are priced from the table and reconciled afterwards like any
          // other estimate.
          const priced = await priceSpend({
            tenantId: session.tenantId,
            model,
            inputTokens,
            outputTokens,
          })
          totalCost = (totalCost ?? 0) + Number(priced.costUsd)
          await app.withTenant(session.tenantId, async () => {
            await app.db.insert(tokenSpend).values({
              tenantId: session.tenantId,
              personId: person.id,
              runId: session.runId ?? session.id,
              provider: entry.provider ?? 'unknown',
              model,
              inputTokens,
              outputTokens,
              ...priced,
            })
          })
        }
      } catch (error) {
        console.error(`[voice] usage metering failed for ${session.id}:`, describeError(error))
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
        console.error(`[voice] speech metering failed for ${session.id}:`, describeError(error))
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
    //
    // Deliberately NOT awaited. Someone is on the line: making them listen to
    // silence while an egress request negotiates — or worse, times out — buys
    // nothing, because the recording covers the room from whenever it starts.
    // `finalize` waits on this promise, so a hangup can never race past a
    // recording that was still being set up.
    recordingStarted = startCallRecording({
      tenantId: session.tenantId,
      sessionId: session.id,
      room: roomName,
    })
      .then((started) => {
        if (started.started) {
          recording = started.recording
          return
        }
        console.warn(`[voice] room ${roomName}: not recording — ${started.reason}`)
        return recordEvent('message', {
          text: `This call is not being recorded: ${started.reason}`,
        }).catch(() => undefined)
      })
      .catch((error: unknown) => {
        console.error(`[voice] room ${roomName}: recording could not be started — ${describeError(error)}`)
      })

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
        const message = describeError(error)
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
    const dial = await app.withTenantContext(session.tenantId, () =>
      autonomyDial({ tenantId: session.tenantId, personId: person.id }),
    )

    // The agent's eyes open with the session, which is built below; the worker
    // is wired first, so the frame handler reaches them through this.
    let eyes: AgentEyes | null = null

    // --- The work, beside the conversation ---------------------------------
    // The talker holds six tools and never blocks. Everything the agent
    // actually does runs here, on the same engine an assignment or an email
    // runs on — the difference is only disposition: this caller is waiting.
    worker = createCallWorker({
      tenantId: session.tenantId,
      person,
      runId: session.runId ?? session.id,
      trigger: { type: 'chat', conversationId: session.id },
      abilities: assembled.abilities,
      caller: session.counterparty.name ?? 'the caller',
      record: (kind, payload) => recordEvent(kind, payload),
      // A step that took a picture of what it did — the browser, today. A
      // function tool's result is text, so the picture goes into the context
      // as image content instead.
      onFrame: async (frame) => {
        if (!eyes?.active()) return
        await eyes.show({
          dataUrl: `data:${frame.mediaType};base64,${frame.data}`,
          caption: frame.label,
          ifRefused:
            'The pictures from your browser are not reaching you after all. Tell them plainly, in one sentence, that you cannot see the page and are working from its text, and carry on.',
        })
      },
      onError: (message) => console.error(`[voice] room ${roomName}: ${message}`),
    })

    const tools = callTools({
      worker,
      abilities: assembled.abilities,
      governance: {
        autonomy: dial,
        fileApproval: async (input) => {
          // approvals.run_id is NOT NULL: an approval with no run to hang off
          // cannot be filed, and silently dropping the column would fail the
          // insert mid-call. Say so instead — the caller is told it is queued
          // only when it genuinely is.
          if (!session.runId) {
            throw new Error('This call has no run to record an approval against.')
          }
          const runId = session.runId
          return app.withTenantContext(session.tenantId, () =>
            requestApproval({ tenantId: session.tenantId, runId, personId: person.id, ...input }),
          )
        },
      },
      record: (kind, payload) => recordEvent(kind, payload),
      // The hangup waits for the agent's last words to play out (close()
      // drains), settles the ledger, and then takes the room down, which is
      // what actually ends the call for the caller.
      hangUp: () => {
        void (async () => {
          // Stop the work first. Closing the session drains its tools, and a
          // request still running would hold the hangup open for as long as it
          // took — the caller said goodbye, so nothing is waiting on it now.
          await worker.stop('the call ended')
          try {
            await agentSession.close()
          } catch {
            // Already closing — the hangup below still stands.
          }
          try {
            await finalize()
            await ctx.deleteRoom()
          } catch (error) {
            console.error(`[voice] room ${roomName}: hangup failed — ${describeError(error)}`)
          }
        })()
      },
      // Handing the caller to a human acts on this room's SIP leg, so it is
      // offered only where there is one. A completed REFER is cold — the phone
      // leg goes to the PBX and the agent is out — so the ledger closes here
      // rather than waiting for a hangup that never comes.
      transfer:
        session.direction === 'inbound_phone' || session.direction === 'outbound_phone'
          ? async ({ extension }) => {
              const phoneLeg = Array.from(ctx.room.remoteParticipants.values()).find((participant) =>
                Object.keys(participant.attributes).some((key) => key.startsWith('sip.')),
              )
              if (!phoneLeg) {
                return { transferred: false, reason: 'There is no phone line on this call to transfer.' }
              }
              const result = await transferCallToExtension({
                tenantId: session.tenantId,
                room: roomName,
                participantIdentity: phoneLeg.identity,
                extension,
              })
              if (!result.transferred) return result
              transferredTo = extension.trim()
              await finalize()
              return result
            }
          : null,
      onError: (message) => console.error(`[voice] room ${roomName}: ${message}`),
    })
    // Work in flight belongs to the call: when the line goes down it stops,
    // rather than running on with nobody to tell. The room event is the first
    // honest sign the call is over, and it matters that it is first: closing
    // the session drains its tools, so a request still running would hold the
    // whole teardown open long after there was anyone to tell.
    ctx.room.on(RoomEvent.ParticipantDisconnected, () => {
      if (ctx.room.remoteParticipants.size > 0) return
      void worker?.stop('the caller hung up')
    })
    ctx.addShutdownCallback(async () => {
      await worker?.stop('the call ended')
      await assembled.close()
    })

    try {
      const instructions = await buildInstructions(session, person, liveConfig, ai, {
        meeting: isMeeting,
        seesScreen,
        browser: assembled.abilities.some((ability) => ability.name.startsWith('browser_')),
      })
      // The async-tool templates are the words the framework puts in front of
      // the model when work reports in or finishes. The stock ones name the
      // tool and its call id, which is precisely what a caller must never
      // hear, so they are replaced with the sentences a colleague would use.
      const agent = new voice.Agent({ instructions, tools, toolHandling: { asyncOptions: ASYNC_TOOL_VOICE } })
      await agentSession.start({ agent, room: ctx.room })
      // One pair of eyes for the whole call: the guest's shared screen in a
      // meeting, and the agent's own browser on any call at all.
      eyes = openAgentEyes({
        agent,
        session: agentSession,
        sees: seesScreen,
        onBlind: (message) => {
          console.error(`[voice] room ${roomName}: the model refused a picture — vision off for this call: ${message}`)
          void recordEvent('error', {
            message: `Live vision was switched off for this call: the agent's model would not accept the picture (${message}).`,
          }).catch(() => undefined)
        },
        onError: (message) => console.error(`[voice] room ${roomName}: ${message}`),
      })
      // Every error the session raises is written down, whichever leg it came
      // from. Nothing did this before, and a hearing, thinking or speaking leg
      // could fail on every turn while the process logged not one word — which
      // is exactly how a call ends up silent with no explanation anywhere. The
      // leg is named, because "the model refused" and "the voice would not
      // synthesize" are different problems with different fixes.
      agentSession.on(voice.AgentSessionEventTypes.Error, (event) => {
        const leg =
          event.source === cascadeLlm
            ? 'model'
            : event.source === agentSession.stt
              ? 'hearing'
              : event.source === agentSession.tts
                ? 'voice'
                : 'session'
        // Serialized properly: a plain `String(error)` on a provider's error
        // object writes "[object Object]" into the log and the run ledger, and
        // costs a whole diagnostic round trip to get back what it already knew.
        const message = event.error === undefined || event.error === null ? 'no detail given' : describeError(event.error)
        console.error(`[voice] ${session.id} ${leg} error: ${message}`)
        void recordEvent('error', { message: `The ${leg} leg of this call failed: ${message}` }).catch(() => undefined)
        // A cascade agent's text model may simply be refusing the picture; that
        // surfaces as an error on the LLM leg and nowhere else, which is why
        // the instance is kept — an STT or TTS hiccup must never read as
        // blindness.
        if (cascadeLlm && event.source === cascadeLlm && eyes?.active()) {
          eyes.refused(message)
        }
      })
      // A shared screen is watched on every call, not only in meetings. The
      // caller has a Share screen button on the call page too, and a screen
      // nobody is looking at is worse than no button at all.
      watchMeetingScreen({ ctx, session, person, eyes, recordEvent })
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

      // A call where nobody speaks is the worst failure this process has,
      // because every part of it reports success: the session starts, the
      // model answers, and the caller hears silence. It happens when a leg
      // produces nothing — a text model that returns no content has nothing
      // for the voice to say — and nothing throws. So watch for real speech:
      // if the agent has not said one word by the time a greeting should long
      // since have landed, say so on the run and in the log, where it can be
      // acted on, instead of leaving an operator to guess from a silent
      // recording.
      //
      // The signal is the session's own playout state, not the transcript
      // ledger. A cascade turn reaches the ledger differently from a realtime
      // one, and this watchdog used to cry wolf on perfectly healthy calls
      // because of it — a false alarm on a working call is worse than none.
      const spokeCheck = setTimeout(() => {
        if (finalized || agentSpoke) return
        const detail = `${liveConfig.mode === 'cascade' ? `the ${ai?.modelSmart ?? 'assigned'} model` : 'the realtime model'} produced no speech`
        console.error(`[voice] room ${roomName}: SILENT — ${detail}, ${GREETING_GRACE_MS}ms after answering`)
        void recordEvent('error', {
          message: `${person.name} answered but said nothing: ${detail}. The caller heard silence.`,
        }).catch(() => undefined)
      }, GREETING_GRACE_MS)
      ctx.addShutdownCallback(async () => clearTimeout(spokeCheck))
    } catch (error) {
      const message = describeError(error)
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
