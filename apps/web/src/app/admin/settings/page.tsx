import { and, eq, sql } from 'drizzle-orm'
import { AI_PROVIDER_SPECS } from '@appkit/ai'
import { PageContainer } from '@appkit/ui'
import { mailboxAccounts, people } from '../../../db/schema'
import { db } from '../../../db/client'
import { SettingsView } from '../../../components/settings-view'
import { listAiProviders } from '../../../lib/ai'
import { listPrices } from '../../../lib/pricing'
import { getImageProviderSetting } from '../../../lib/avatars'
import { IMAGE_MODELS } from '@appkit/avatars'
import { resolveTenantId } from '../../../lib/tenant'

export const dynamic = 'force-dynamic'

const fmt = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 16).replace('T', ' ') : '')

export default async function SettingsPage() {
  const tenantId = await resolveTenantId()
  const app = db()
  const [providers, prices, imageSetting, mailboxData] = await Promise.all([
    listAiProviders(tenantId),
    listPrices(tenantId),
    getImageProviderSetting(tenantId),
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
            eq(people.kind, 'hand'),
            sql`not exists (select 1 from mailbox_accounts ma where ma.person_id = ${people.id})`,
          ),
        )
      return { boxes, unconnected }
    }),
  ])

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
        handsWithoutMailbox={mailboxData.unconnected}
        imageSetting={imageSetting}
        imageModels={IMAGE_MODELS}
      />
    </PageContainer>
  )
}
