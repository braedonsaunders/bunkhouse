import { and, asc, eq, sql } from 'drizzle-orm'
import { AI_PROVIDER_SPECS } from '@appkit/ai'
import { PageContainer } from '@appkit/ui'
import { autonomySettings, mailboxAccounts, people } from '../../../db/schema'
import { db } from '../../../db/client'
import { SettingsView } from '../../../components/settings-view'
import type { AgentDial } from '../../../components/autonomy-settings'
import { ACTION_CATEGORIES, DEFAULT_AUTONOMY_LEVEL } from '../../../lib/autonomy'
import { listAiProviders } from '../../../lib/ai'
import { getVoiceProviders } from '../../../lib/voice'
import { listSipTrunks, sipIngressAddress } from '../../../lib/pbx'
import { listPrices } from '../../../lib/pricing'
import { getImageProviderSetting, listAvatarPartRows, loadAvatarPartLibrary } from '../../../lib/avatars'
import { getResearchSettings } from '../../../lib/research'
import { listMcpIntegrations } from '../../../lib/agent-abilities'
import { AVATAR_PART_CATEGORIES, avatarPartCategory } from '../../../lib/avatar-parts'
import { IMAGE_MODELS } from '@appkit/avatars'
import { resolveTenantId } from '../../../lib/tenant'

export const dynamic = 'force-dynamic'

const fmt = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 16).replace('T', ' ') : '')

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ section?: string }>
}) {
  const { section } = await searchParams
  const tenantId = await resolveTenantId()
  const app = db()
  const [providers, prices, imageSetting, voiceProviders, trunks, agentExtensions, mailboxData, agentDials, partRows, partLibrary] = await Promise.all([
    listAiProviders(tenantId),
    listPrices(tenantId),
    getImageProviderSetting(tenantId),
    getVoiceProviders(tenantId),
    listSipTrunks(tenantId),
    app.withTenantContext(tenantId, () =>
      app.db
        .select({ id: people.id, name: people.name, title: people.title, extension: people.extension })
        .from(people)
        .where(and(eq(people.kind, 'agent'), sql`${people.extension} is not null`))
        .orderBy(asc(people.extension)),
    ),
    app.withTenantContext(tenantId, async () => {
      const boxes = await app.db
        .select({
          id: mailboxAccounts.id,
          personId: mailboxAccounts.personId,
          address: mailboxAccounts.address,
          status: mailboxAccounts.status,
          lastSyncAt: mailboxAccounts.lastSyncAt,
          lastError: mailboxAccounts.lastError,
          personName: people.name,
        })
        .from(mailboxAccounts)
        .innerJoin(people, eq(people.id, mailboxAccounts.personId))
      const unconnected = await app.db
        .select({ id: people.id, name: people.name, title: people.title })
        .from(people)
        .where(
          and(
            eq(people.kind, 'agent'),
            sql`not exists (select 1 from mailbox_accounts ma where ma.person_id = ${people.id})`,
          ),
        )
      return { boxes, unconnected }
    }),
    app.withTenantContext(tenantId, async (): Promise<AgentDial[]> => {
      const agents = await app.db
        .select({ id: people.id, name: people.name, title: people.title, status: people.status })
        .from(people)
        .where(eq(people.kind, 'agent'))
        .orderBy(asc(people.name))
      const dial = await app.db.select().from(autonomySettings)
      return agents.map((agent) => ({
        personId: agent.id,
        name: agent.name,
        title: agent.title,
        status: agent.status,
        levels: Object.fromEntries(
          ACTION_CATEGORIES.map((category) => [
            category,
            dial.find((d) => d.personId === agent.id && d.category === category)?.level ?? DEFAULT_AUTONOMY_LEVEL,
          ]),
        ) as AgentDial['levels'],
      }))
    }),
    listAvatarPartRows(tenantId),
    loadAvatarPartLibrary(tenantId),
  ])
  const research = await getResearchSettings(tenantId)
  const integrations = await app.withTenantContext(tenantId, () => listMcpIntegrations(tenantId))

  return (
    <PageContainer>
      <SettingsView
        providers={providers.map((p) => ({
          slug: p.slug,
          label: p.label,
          provider: p.provider,
          ...(p.modelSmart ? { modelSmart: p.modelSmart } : {}),
          ...(p.modelFast ? { modelFast: p.modelFast } : {}),
          ...(p.baseUrl ? { baseUrl: p.baseUrl } : {}),
        }))}
        kinds={AI_PROVIDER_SPECS.map((spec) => ({
          value: spec.value,
          label: spec.label,
          needsBaseUrl: spec.kind === 'openai-compatible' && !spec.baseUrl,
        }))}
        prices={prices.map((p) => ({
          id: p.id,
          model: p.model,
          inputUsdPerMtok: `$${Number(p.inputUsdPerMtok).toFixed(2)}`,
          outputUsdPerMtok: `$${Number(p.outputUsdPerMtok).toFixed(2)}`,
          source: p.source,
          ...(p.sourceRef ? { sourceRef: p.sourceRef } : {}),
          effectiveAt: fmt(p.effectiveAt),
        }))}
        mailboxes={mailboxData.boxes.map((b) => ({
          id: b.id,
          personId: b.personId,
          personName: b.personName,
          address: b.address,
          status: b.status,
          lastSyncAt: fmt(b.lastSyncAt),
          lastError: b.lastError ?? '',
        }))}
        agentsWithoutMailbox={mailboxData.unconnected}
        imageSetting={imageSetting}
        imageFallbackModels={IMAGE_MODELS}
        voiceProviders={{ deepgram: Boolean(voiceProviders.deepgram), elevenlabs: Boolean(voiceProviders.elevenlabs) }}
        research={research}
        integrations={integrations.map((entry) => ({
          slug: entry.slug,
          label: entry.label,
          url: entry.url,
          category: entry.category,
          hasHeaders: Boolean(entry.sealedHeaders),
        }))}
        phoneSystem={{
          trunks: trunks.map((t) => ({
            id: t.id,
            name: t.name,
            flavor: t.flavor,
            pbxHost: t.pbxHost ?? '',
            pbxPort: t.pbxPort,
            transport: t.transport,
            authUsername: t.authUsername ?? '',
            hasPassword: t.sealedAuthPassword !== null,
            extensionRange: t.extensionRange ?? '',
            status: t.status,
            lastError: t.lastError ?? '',
          })),
          extensions: agentExtensions.map((h) => ({
            personId: h.id,
            name: h.name,
            title: h.title,
            extension: h.extension ?? '',
          })),
          ingress: sipIngressAddress(),
        }}
        agentDials={agentDials}
        initialSection={section ?? 'autonomy'}
        avatarParts={partRows.map((part) => ({
          id: part.id,
          categoryId: part.categoryId,
          categoryLabel: avatarPartCategory(part.categoryId)?.label ?? part.categoryId,
          name: part.name,
          colorVariant: part.colorVariant ?? '',
          tags: part.tags,
          model: part.model,
          prompt: part.prompt ?? '',
          createdAt: fmt(part.createdAt),
        }))}
        avatarPartCategories={AVATAR_PART_CATEGORIES}
        avatarPartLibrary={partLibrary}
      />
    </PageContainer>
  )
}
