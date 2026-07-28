import { AI_PROVIDER_SPECS } from '@appkit/ai'
import { PageContainer } from '@appkit/ui'
import { SettingsView } from '../../../components/settings-view'
import { listAiProviders } from '../../../lib/ai'
import { resolveTenantId } from '../../../lib/tenant'

export const dynamic = 'force-dynamic'

export default async function SettingsPage() {
  const tenantId = await resolveTenantId()
  const providers = await listAiProviders(tenantId)

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
      />
    </PageContainer>
  )
}
