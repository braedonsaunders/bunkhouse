import Link from 'next/link'
import { notFound } from 'next/navigation'
import { eq } from 'drizzle-orm'
import { Button, EmptyState, PageContainer, PageHeader } from '@braedonsaunders/appkit-ui'
import { providerSpec, isAiProvider } from '@braedonsaunders/appkit-ai'
import { people } from '../../../db/schema'
import { db } from '../../../db/client'
import { resolveTenantId } from '../../../lib/tenant'
import { resolveAgentAiConfig } from '../../../lib/ai'
import { getVoiceProviders, listRealtimeCapableProviders } from '../../../lib/voice'
import { CallRoom } from '../../../components/call-room'
import { getAvatarComposition, loadAvatarPartLibrary } from '../../../lib/avatars'
import { AVATAR_PART_CATEGORIES } from '../../../lib/avatar-parts'

export const dynamic = 'force-dynamic'

/** Full-page honest stop: what is missing and exactly where to fix it. */
function Blocked({ title, description, href, linkLabel }: { title: string; description: string; href: string; linkLabel: string }) {
  return (
    <PageContainer className="space-y-6">
      <PageHeader title="Call" description="Talk to an agent in the browser." />
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
  const tenantId = await resolveTenantId('calls.manage')
  const app = db()
  const [person] = await app.withTenantContext(tenantId, () =>
    app.db.select().from(people).where(eq(people.id, personId)),
  )
  if (!person || person.kind !== 'agent') notFound()

  const profileHref = `/organization?person=${person.id}`
  if (person.status !== 'active') {
    return (
      <Blocked
        title={`${person.name} is not active`}
        description="Only active agents take calls. Activate them from their profile first."
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
    const ai = await resolveAgentAiConfig(tenantId, person.id)
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
          title="Cascade calls need an OpenAI-compatible model"
          description={`Voice calls in cascade mode are available for agents running OpenAI-compatible models. Choose realtime mode for ${person.name}, or assign an OpenAI-compatible model on their profile.`}
          href={profileHref}
          linkLabel="Open Voice tab"
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
          description={`This agent's realtime voice runs on ${providerKind === 'google' ? 'a Google' : 'an OpenAI'} key, but none is configured. Add one under Settings → Model providers.`}
          href="/admin/settings"
          linkLabel="Open Settings"
        />
      )
    }
  }

  const livekitUrl = process.env.LIVEKIT_URL
  if (!livekitUrl || !process.env.LIVEKIT_API_KEY || !process.env.LIVEKIT_API_SECRET) {
    throw new Error('LIVEKIT_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET must be set — deployment infrastructure, see .env.local.')
  }

  // The session, its run, and the token are created by startCallAction when
  // the caller connects — this page only validates and renders the room shell.

  // The face on the call: their one composition, zoomed to the head.
  const [composition, partLibrary] = await Promise.all([
    getAvatarComposition(tenantId, person.id),
    loadAvatarPartLibrary(tenantId),
  ])

  // Not PageContainer: a call is a single fixed screen, so it takes the shell's
  // canvas whole rather than being a document that scrolls inside it. From `lg`
  // up the room fills this exactly and nothing overflows; below it the columns
  // stack and this is the one thing that scrolls — the same scroll region every
  // other page in the app has, with the same scrollbar.
  return (
    <div className="app-scroll min-h-0 flex-1 overflow-y-auto lg:overflow-hidden">
      <CallRoom
        serverUrl={livekitUrl}
        agent={{ id: person.id, name: person.name, title: person.title }}
        avatar={{ composition, parts: partLibrary, categories: AVATAR_PART_CATEGORIES }}
      />
    </div>
  )
}
