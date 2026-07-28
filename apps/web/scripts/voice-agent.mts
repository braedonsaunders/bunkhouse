import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { and, eq } from 'drizzle-orm'
import { cli, defineAgent, voice, ServerOptions, type JobContext, type JobProcess } from '@livekit/agents'
import * as deepgram from '@livekit/agents-plugin-deepgram'
import * as elevenlabs from '@livekit/agents-plugin-elevenlabs'
import * as google from '@livekit/agents-plugin-google'
import * as openai from '@livekit/agents-plugin-openai'
import * as silero from '@livekit/agents-plugin-silero'
import { isAiProvider, providerSpec, type AiConfig } from '@appkit/ai'
import { buildSystemPrompt } from '@bunkhouse/runtime'
import { db } from '../src/db/client'
import { approvals, autonomySettings, callSessions, callTurns, people, phoneNumbers, runs, runEvents, tokenSpend } from '../src/db/schema'
import { assembleAbilities } from '../src/lib/agent-abilities'
import { boundProcedures } from '../src/lib/agent-runs'
import { governedCallTools } from '../src/lib/call-tools'
import { resolveAgentAiConfig } from '../src/lib/ai'
import { resolveRealtimeCredential, resolveSpeechCredential } from '../src/lib/voice'
import { pinnedNotes, retrieveNotes } from '../src/lib/memory'
import { resolvePrice } from '../src/lib/pricing'

// The bunkhouse voice agent: joins every `call-*` (browser call, session
// pre-created by the call page) and `pbx-*` (inbound phone call dispatched
// by LiveKit SIP, session created here) room, loads the session's agent, and
// holds the conversation. Media I/O lives here; identity, procedures, and
// memory come from the same context assembly email runs use. Every utterance
// is appended to the call_turns ledger; the run is completed with a
// deterministic summary and LLM usage is metered into token_spend.
//
// Provider support (engineering notes, never surfaced as-is to operators):
// - cascade LLM: OpenAI + OpenAI-compatible providers (OpenRouter, Groq, …)
//   via the openai plugin's baseURL. Anthropic text models still need a
//   bridge; the UI disables the cascade combo for such agents.
// - realtime: OpenAI Realtime and Gemini Live. The Gemini plugin enables
//   input+output audio transcription by default, so both speakers land in
//   the transcript ledger on either provider.

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

  // Provisioned numbers first — they are globally unique by nature — then the
  // PBX extension path.
  let person: PersonRow | null = null
  const numbered = await app.withSuperAdmin((superDb) =>
    superDb
      .select({ personId: phoneNumbers.personId })
      .from(phoneNumbers)
      .where(eq(phoneNumbers.number, digits)),
  )
  if (numbered.length === 1) {
    const rows = await app.withSuperAdmin((superDb) =>
      superDb
        .select()
        .from(people)
        .where(and(eq(people.id, numbered[0]!.personId), eq(people.kind, 'agent'), eq(people.status, 'active'))),
    )
    person = (rows[0] as PersonRow | undefined) ?? null
  }
  if (!person) {
    const agents = await app.withSuperAdmin((superDb) =>
      superDb
        .select()
        .from(people)
        .where(and(eq(people.extension, digits), eq(people.kind, 'agent'), eq(people.status, 'active'))),
    )
    // Extensions are unique per tenant; a cross-tenant collision (or an
    // unassigned callee) cannot be routed deterministically.
    if (agents.length === 1) person = agents[0] as PersonRow
  }
  if (!person) {
    console.error(`[voice] room ${roomName}: ${digits} matches no provisioned number and no unique extension — cannot route`)
    return null
  }
  const tenantId = person.tenantId

  // The SIP participant's join is what triggered dispatch; its attributes
  // carry the caller's number.
  const participant = await ctx.waitForParticipant()
  const callerNumber = participant.attributes?.['sip.phoneNumber'] || null
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

/** The agent's whole working identity, plus how to behave on a live call. */
async function buildInstructions(session: SessionRow, person: PersonRow, ai: AiConfig | null): Promise<string> {
  const config = person.voiceConfig!
  const directory = await app.withTenantContext(session.tenantId, () =>
    app.db.select().from(people).where(eq(people.status, 'active')),
  )
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
      name: 'the company',
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
    `You are on a live voice call with ${caller}. Speak naturally, in short turns — one to three sentences, then let them respond. Plain spoken words only: no markdown, no lists, no headings, nothing that only works on a screen.`,
    `Speak ${config.language && config.language !== 'en' ? `in the language with BCP-47 tag "${config.language}"` : 'English'}.`,
    ...(config.style ? [`Speaking style: ${config.style}.`] : []),
    'You have your working tools on this call: search the web, read pages, send email, search and save your logbook, schedule follow-ups, and use the company integrations. Use them mid-conversation when they help — say what you are doing in a few words ("give me a second, I am looking that up"), keep talking naturally, and report what you found or did.',
    'If the caller speaks while you are mid-task, just talk with them — the work keeps running in the background and you can share the result when it lands. Never restart a task because you were interrupted.',
    `When the caller asks for work that takes real time — research, a report or spreadsheet, contacting someone, comparing options, drafting something, chasing an answer — take it as an assignment rather than attempting it live. First confirm the brief out loud: what a good outcome looks like, any file format they want (PDF, Word, Excel — many assignments need no file at all), who receives it, and any deadline. Then call take_assignment with the full brief. Tell the caller it is underway and the outcome will arrive by email — the work starts immediately and continues after the call ends. Quick lookups you can answer in a sentence or two stay on the call; anything bigger becomes an assignment.`,
    'Some actions need human sign-off first. When a tool answers pending_approval, tell the caller it is queued for approval and will happen once signed off — never claim it is done.',
  ].join('\n')

  return `${base}\n\n${voiceAddendum}`
}

export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    proc.userData.vad = await silero.VAD.load()
  },
  entry: async (ctx: JobContext) => {
    await ctx.connect()
    const roomName = ctx.room.name ?? ''
    let resolvedSession: SessionRow | null = null
    if (roomName.startsWith('call-')) {
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
    if (!person || person.kind !== 'agent' || !person.voiceConfig) {
      await markFailed(session, 'Call failed: the agent or its voice configuration no longer exists.')
      ctx.shutdown('agent not callable')
      return
    }
    const config = person.voiceConfig

    // --- Build the speech pipeline from tenant-sealed credentials ----------
    let agentSession: voice.AgentSession
    let ai: AiConfig | null = null
    try {
      if (config.mode === 'cascade') {
        ai = await resolveAgentAiConfig(session.tenantId, person.id)
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
        const deepgramKey = await resolveSpeechCredential(session.tenantId, 'deepgram')
        const elevenKey = await resolveSpeechCredential(session.tenantId, 'elevenlabs')
        if (!deepgramKey || !elevenKey) {
          throw new Error('Speech provider keys are missing — add Deepgram and ElevenLabs in Settings → Voice.')
        }
        const cascade = config.cascade!
        const baseURL = ai.baseUrl ?? (isAiProvider(ai.provider) ? providerSpec(ai.provider).baseUrl : null)
        agentSession = new voice.AgentSession({
          vad: ctx.proc.userData.vad as InstanceType<typeof silero.VAD>,
          stt: new deepgram.STT({
            apiKey: deepgramKey,
            model: cascade.sttModel,
            ...(config.language ? { language: config.language } : {}),
          }),
          llm: new openai.LLM({
            apiKey: ai.apiKey,
            model: ai.modelSmart,
            ...(baseURL ? { baseURL } : {}),
          }),
          tts: new elevenlabs.TTS({
            apiKey: elevenKey,
            voiceId: cascade.ttsVoiceId,
            model: cascade.ttsModel,
            ...(config.language ? { language: config.language } : {}),
          }),
        })
      } else {
        const realtime = config.realtime!
        const credential = await resolveRealtimeCredential(session.tenantId, realtime.provider)
        if (!credential) {
          throw new Error(
            `No ${realtime.provider === 'google' ? 'Google' : 'OpenAI'} provider is configured under Settings → Model providers — realtime voice runs on its key.`,
          )
        }
        agentSession =
          realtime.provider === 'google'
            ? new voice.AgentSession({
                // Gemini Live. Input and output audio transcription are on by
                // default in the plugin, so both speakers reach the ledger.
                llm: new google.realtime.RealtimeModel({
                  apiKey: credential.apiKey,
                  model: realtime.model,
                  voice: realtime.voice,
                  // The Live API takes regioned BCP-47 tags only — it rejects
                  // a bare "en" outright. A two-letter preference still steers
                  // the agent through the prompt; the model auto-detects the
                  // spoken language when none is pinned here.
                  ...(config.language && config.language.includes('-')
                    ? { language: config.language }
                    : {}),
                }),
              })
            : new voice.AgentSession({
                llm: new openai.realtime.RealtimeModel({
                  apiKey: credential.apiKey,
                  model: realtime.model,
                  voice: realtime.voice,
                }),
              })
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[voice] room ${roomName}: ${message}`)
      await markFailed(session, `Call failed to start: ${message}`)
      ctx.shutdown('setup failed')
      return
    }

    // --- Transcript ledger: append-only, both speakers ---------------------
    const startedAtMs = session.startedAt.getTime()
    let seq = 0
    let turnCount = 0
    const appendTurn = async (speaker: 'agent' | 'human', text: string) => {
      const mySeq = seq++
      turnCount += 1
      await app.withTenant(session.tenantId, async () => {
        await app.db.insert(callTurns).values({
          tenantId: session.tenantId,
          sessionId: session.id,
          seq: mySeq,
          speaker,
          text,
          atMs: Math.max(0, Date.now() - startedAtMs),
        })
      })
    }
    agentSession.on(voice.AgentSessionEventTypes.ConversationItemAdded, (event) => {
      const item = event.item
      if (item.type !== 'message') return
      const text = item.textContent
      if (!text) return
      const speaker = item.role === 'assistant' ? 'agent' : item.role === 'user' ? 'human' : null
      if (!speaker) return
      void appendTurn(speaker, text).catch((error) =>
        console.error(`[voice] turn append failed for ${session.id}:`, (error as Error).message),
      )
    })

    // --- End of call: finalize the ledger, complete the run, meter spend ---
    let finalized = false
    const finalize = async () => {
      if (finalized) return
      finalized = true
      const endedAt = new Date()
      const durationSeconds = Math.max(0, Math.round((endedAt.getTime() - startedAtMs) / 1000))
      const minutes = Math.max(1, Math.round(durationSeconds / 60))

      // Meter LLM usage from the framework's per-model usage summaries into
      // the same token_spend ledger email runs use. STT/TTS usage has no
      // token price here yet; when no LLM usage was exposed, costUsd stays
      // null — never fabricated.
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
            const tail = `${turnCount} turn${turnCount === 1 ? '' : 's'}, ${minutes} minute${minutes === 1 ? '' : 's'}.`
            await app.db
              .update(runs)
              .set({
                status: 'completed',
                finishedAt: endedAt,
                summary:
                  session.direction === 'inbound_phone'
                    ? `Inbound call from ${session.counterparty.number ?? 'an unknown number'}: ${tail}`
                    : `Voice call with ${session.counterparty.name ?? 'the caller'}: ${tail}`,
              })
              .where(eq(runs.id, session.runId))
          }
        }
      })
      console.log(`[voice] call ${session.id} finalized — ${turnCount} turns, ${durationSeconds}s`)
    }
    ctx.addShutdownCallback(finalize)

    // --- The working toolset: same abilities as email runs, call posture ---
    // Tool activity lands on the call's run as ordinary run events; seq starts
    // high above the fixed rows the session setup writes.
    let eventSeq = 100
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
      fileApproval: async (input) =>
        app.withTenant(session.tenantId, async () => {
          const [row] = await app.db
            .insert(approvals)
            .values({
              tenantId: session.tenantId,
              ...(session.runId ? { runId: session.runId } : {}),
              personId: person.id,
              category: input.category,
              payload: { description: input.description, action: input.action },
            })
            .returning({ id: approvals.id })
          return { approvalId: row!.id }
        }),
      record: (kind, payload) => recordEvent(kind, payload),
      onSlow: ({ toolName }) => speakFiller(toolName),
      onSettled: ({ toolName }) => resumeAfterSettle(toolName),
    })
    ctx.addShutdownCallback(() => assembled.close())

    try {
      const instructions = await buildInstructions(session, person, ai)
      await agentSession.start({
        agent: new voice.Agent({ instructions, tools }),
        room: ctx.room,
      })
      agentSession.generateReply({
        instructions: `Greet ${session.counterparty.name ?? 'the caller'} briefly, as yourself, and ask how you can help.`,
      })
      console.log(`[voice] ${person.name} answered room ${roomName} (${config.mode})`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[voice] room ${roomName} session error: ${message}`)
      await markFailed(session, `Call failed: ${message}`)
      ctx.shutdown('session error')
    }
  },
})

cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url) }))
