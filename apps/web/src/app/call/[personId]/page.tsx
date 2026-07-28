import { randomUUID } from 'node:crypto'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { eq } from 'drizzle-orm'
import { Button, EmptyState, PageContainer, PageHeader } from '@appkit/ui'
import { mintLiveKitToken } from '@appkit/voice'
import { providerSpec, isAiProvider } from '@appkit/ai'
import { callSessions, people, runEvents, runs } from '../../../db/schema'
import { db } from '../../../db/client'
import { resolveTenantId } from '../../../lib/tenant'
import { resolveHandAiConfig } from '../../../lib/ai'
import { getVoiceProviders, listRealtimeCapableProviders } from '../../../lib/voice'
import { CallRoom } from '../../../components/call-room'

export const dynamic = 'force-dynamic'

/** Full-page honest stop: what is missing and exactly where to fix it. */
function Blocked({ title, description, href, linkLabel }: { title: string; description: string; href: string; linkLabel: string }) {
  return (
    <PageContainer className="space-y-6">
      <PageHeader title="Call" description="Talk to a hand in the browser." />
      <EmptyState
        title={title}
        description={description}
        action={
          <Button asChild variant="outline">
            <Link href={href}>{linkLabel}</Link>
          </Button>
        }
      />
    </PageContainer>
  )
}

export default async function CallPage({ params }: { params: Promise<{ personId: string }> }) {
  const { personId } = await params
  const tenantId = await resolveTenantId()
  const app = db()
  const [person] = await app.withTenantContext(tenantId, () =>
    app.db.select().from(people).where(eq(people.id, personId)),
  )
  if (!person || person.kind !== 'hand') notFound()

  const profileHref = `/people?person=${person.id}`
  if (person.status !== 'active') {
    return (
      <Blocked
        title={`${person.name} is not active`}
        description="Only active hands take calls. Activate them from their profile first."
        href={profileHref}
        linkLabel="Open profile"
      />
    )
  }
  const config = person.voiceConfig
  if (!config) {
    return (
      <Blocked
        title="Voice not configured"
        description={`${person.name} has no voice yet. Pick how they hear and speak on the Voice tab of their profile.`}
        href={profileHref}
        linkLabel="Open Voice tab"
      />
    )
  }

  if (config.mode === 'cascade') {
    const speech = await getVoiceProviders(tenantId)
    const missing = [!speech.deepgram ? 'Deepgram (hearing)' : null, !speech.elevenlabs ? 'ElevenLabs (speaking)' : null].filter(Boolean)
    if (missing.length > 0) {
      return (
        <Blocked
          title="Speech providers missing"
          description={`Cascade calls need ${missing.join(' and ')}. Add the key${missing.length > 1 ? 's' : ''} in Settings → Voice.`}
          href="/admin/settings"
          linkLabel="Open Settings → Voice"
        />
      )
    }
    const ai = await resolveHandAiConfig(tenantId, person.id)
    if (!ai || !ai.modelSmart) {
      return (
        <Blocked
          title="No model assigned"
          description={`${person.name} has no brain to think with on the call — assign a provider and model on their Overview tab.`}
          href={profileHref}
          linkLabel="Open profile"
        />
      )
    }
    const kind = isAiProvider(ai.provider) ? providerSpec(ai.provider).kind : null
    if (kind !== 'openai' && kind !== 'openai-compatible') {
      return (
        <Blocked
          title="This model cannot take calls yet"
          description={`${person.name} thinks on a ${ai.provider} model. Cascade voice currently supports OpenAI and OpenAI-compatible providers (OpenRouter, Groq, …) — an Anthropic/Google bridge is a documented follow-up. Assign an OpenAI-family provider for calls, or use realtime mode.`}
          href={profileHref}
          linkLabel="Open profile"
        />
      )
    }
  } else {
    const capable = await listRealtimeCapableProviders(tenantId)
    const providerKind = config.realtime?.provider
    if (!providerKind || !capable.some((p) => p.kind === providerKind)) {
      return (
        <Blocked
          title="Realtime provider missing"
          description={`This hand's realtime voice runs on ${providerKind === 'google' ? 'a Google' : 'an OpenAI'} key, but none is configured. Add one under Settings → Model providers.`}
          href="/admin/settings"
          linkLabel="Open Settings"
        />
      )
    }
    if (providerKind === 'google') {
      return (
        <Blocked
          title="Gemini Live calls are not wired up yet"
          description={`${person.name} is configured for Gemini Live, but the voice worker currently drives realtime calls through OpenAI only — the Google realtime plugin is a documented follow-up. Switch the hand's realtime provider to OpenAI, or use cascade mode.`}
          href={profileHref}
          linkLabel="Open Voice tab"
        />
      )
    }
  }

  const livekitUrl = process.env.LIVEKIT_URL
  const livekitKey = process.env.LIVEKIT_API_KEY
  const livekitSecret = process.env.LIVEKIT_API_SECRET
  if (!livekitUrl || !livekitKey || !livekitSecret) {
    throw new Error('LIVEKIT_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET must be set — deployment infrastructure, see .env.local.')
  }

  // One session per page load: the run is the audit anchor, the room is the call.
  const sessionId = randomUUID()
  const room = `call-${sessionId}`
  const counterparty = { name: 'Demo Owner', identity: 'human:owner' }
  await app.withTenant(tenantId, async () => {
    const [run] = await app.db
      .insert(runs)
      .values({
        tenantId,
        personId: person.id,
        status: 'running',
        trigger: { type: 'chat', conversationId: sessionId },
      })
      .returning({ id: runs.id })
    await app.db.insert(runEvents).values({
      tenantId,
      runId: run!.id,
      seq: 0,
      kind: 'message',
      payload: { text: `Web call started with ${counterparty.name}. Room ${room}.` },
    })
    await app.db.insert(callSessions).values({
      id: sessionId,
      tenantId,
      personId: person.id,
      runId: run!.id,
      room,
      direction: 'web',
      counterparty,
    })
  })

  const token = await mintLiveKitToken(
    { apiKey: livekitKey, apiSecret: livekitSecret },
    {
      identity: counterparty.identity,
      name: counterparty.name,
      room,
      metadata: JSON.stringify({ tenantId, sessionId }),
    },
  )

  return (
    <PageContainer className="space-y-6">
      <CallRoom
        serverUrl={livekitUrl}
        token={token}
        sessionId={sessionId}
        hand={{ id: person.id, name: person.name, title: person.title }}
      />
    </PageContainer>
  )
}
