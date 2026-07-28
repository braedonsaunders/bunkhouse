import { fileURLToPath } from 'node:url'
import { eq } from 'drizzle-orm'
import { cli, defineAgent, voice, ServerOptions, type JobContext, type JobProcess } from '@livekit/agents'
import * as deepgram from '@livekit/agents-plugin-deepgram'
import * as elevenlabs from '@livekit/agents-plugin-elevenlabs'
import * as openai from '@livekit/agents-plugin-openai'
import * as silero from '@livekit/agents-plugin-silero'
import { isAiProvider, providerSpec, type AiConfig } from '@appkit/ai'
import { buildSystemPrompt } from '@bunkhouse/runtime'
import { db } from '../src/db/client'
import { callSessions, callTurns, people, runs, runEvents, tokenSpend } from '../src/db/schema'
import { boundProcedures } from '../src/lib/hand-runs'
import { resolveHandAiConfig } from '../src/lib/ai'
import { resolveRealtimeCredential, resolveSpeechCredential } from '../src/lib/voice'
import { pinnedNotes, retrieveNotes } from '../src/lib/memory'
import { resolvePrice } from '../src/lib/pricing'

// The bunkhouse voice agent: joins every `call-*` LiveKit room, loads the
// session's hand, and holds the conversation. Media I/O lives here; identity,
// procedures, and memory come from the same context assembly email runs use.
// Every utterance is appended to the call_turns ledger; the run is completed
// with a deterministic summary and LLM usage is metered into token_spend.
//
// Provider support today (honest limits, surfaced to the operator):
// - cascade LLM: OpenAI + OpenAI-compatible providers (OpenRouter, Groq, …)
//   via the openai plugin's baseURL. Anthropic/Google text models need a
//   bridge plugin — documented follow-up; such calls fail with a clear note.
// - realtime: OpenAI Realtime only. Gemini Live needs the google plugin —
//   documented follow-up.

const app = db()

type SessionRow = typeof callSessions.$inferSelect
type PersonRow = typeof people.$inferSelect

async function findSessionByRoom(room: string): Promise<SessionRow | null> {
  const rows = await app.withSuperAdmin((superDb) =>
    superDb.select().from(callSessions).where(eq(callSessions.room, room)),
  )
  return (rows[0] as SessionRow | undefined) ?? null
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

/** The hand's whole working identity, plus how to behave on a live call. */
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
    hand: {
      id: person.id,
      name: person.name,
      title: person.title,
      email: person.email,
      personality: person.personality ?? {
        bio: person.responsibilities ?? `I am the ${person.title}.`,
        tone: ['professional'],
        signoff: `Best,\n${person.name.split(' ')[0]}`,
      },
      // Prompt assembly never reads the config; realtime hands may have no text model.
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
    'You cannot take actions, send email, or change records during this call yet. If asked to do work, capture exactly what is needed and say you will follow up from your mailbox.',
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
    if (!roomName.startsWith('call-')) {
      // Automatic dispatch offers every room; only call rooms are ours.
      ctx.shutdown('not a call room')
      return
    }
    const session = await findSessionByRoom(roomName)
    if (!session) {
      console.error(`[voice] no call_sessions row for room ${roomName}`)
      ctx.shutdown('unknown call session')
      return
    }

    const person = await app.withTenantContext(session.tenantId, async () => {
      const [row] = await app.db.select().from(people).where(eq(people.id, session.personId))
      return row ?? null
    })
    if (!person || person.kind !== 'hand' || !person.voiceConfig) {
      await markFailed(session, 'Call failed: the hand or its voice configuration no longer exists.')
      ctx.shutdown('hand not callable')
      return
    }
    const config = person.voiceConfig

    // --- Build the speech pipeline from tenant-sealed credentials ----------
    let agentSession: voice.AgentSession
    let ai: AiConfig | null = null
    try {
      if (config.mode === 'cascade') {
        ai = await resolveHandAiConfig(session.tenantId, person.id)
        if (!ai || !ai.modelSmart) {
          throw new Error('No model assigned — set a provider and model on the profile before calling.')
        }
        const kind = isAiProvider(ai.provider) ? providerSpec(ai.provider).kind : null
        if (kind !== 'openai' && kind !== 'openai-compatible') {
          // Honest limit: the cascade LLM leg speaks the OpenAI protocol today.
          // An Anthropic/Google bridge is a documented follow-up.
          throw new Error(
            `Cascade voice supports OpenAI and OpenAI-compatible model providers today; this hand thinks on "${ai.provider}". Assign an OpenAI-family provider for calls, or switch to realtime mode.`,
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
        if (realtime.provider !== 'openai') {
          // Gemini Live needs @livekit/agents-plugin-google — documented follow-up.
          throw new Error(
            'Realtime voice runs on OpenAI today; Gemini Live support is a follow-up. Switch the hand to OpenAI realtime or cascade mode.',
          )
        }
        const credential = await resolveRealtimeCredential(session.tenantId, 'openai')
        if (!credential) {
          throw new Error('No OpenAI provider is configured under Settings → Model providers — realtime voice needs its key.')
        }
        agentSession = new voice.AgentSession({
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
    const appendTurn = async (speaker: 'hand' | 'human', text: string) => {
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
      const speaker = item.role === 'assistant' ? 'hand' : item.role === 'user' ? 'human' : null
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
            await app.db
              .update(runs)
              .set({
                status: 'completed',
                finishedAt: endedAt,
                summary: `Voice call with ${session.counterparty.name ?? 'the caller'}: ${turnCount} turn${turnCount === 1 ? '' : 's'}, ${minutes} minute${minutes === 1 ? '' : 's'}.`,
              })
              .where(eq(runs.id, session.runId))
          }
        }
      })
      console.log(`[voice] call ${session.id} finalized — ${turnCount} turns, ${durationSeconds}s`)
    }
    ctx.addShutdownCallback(finalize)

    try {
      const instructions = await buildInstructions(session, person, ai)
      await agentSession.start({
        agent: new voice.Agent({ instructions }),
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
