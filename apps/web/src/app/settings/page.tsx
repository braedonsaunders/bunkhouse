import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  Input,
  Label,
  PageContainer,
  PageHeader,
  Select,
} from '@appkit/ui'
import { AI_PROVIDER_SPECS } from '@appkit/ai'
import { listAiProviders } from '../../lib/ai'
import { resolveTenantId } from '../../lib/tenant'
import { addProviderAction, removeProviderAction } from './actions'

export const dynamic = 'force-dynamic'

export default async function SettingsPage() {
  const tenantId = await resolveTenantId()
  const providers = await listAiProviders(tenantId)

  return (
    <PageContainer className="space-y-6">
      <PageHeader
        title="Settings"
        description="Company-level configuration. Everything lives here, nothing in env."
      />
      <Card>
        <CardHeader>
          <CardTitle>Model providers</CardTitle>
          <CardDescription>
            Your own API keys, sealed at rest. Every key is verified with a live prompt before it saves.
            Hands are assigned a provider + model on their profile — each hand can run a different one.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {providers.length === 0 ? (
            <EmptyState
              title="No providers yet"
              description="Add one API key and your hands can start thinking."
            />
          ) : (
            <div className="space-y-2">
              {providers.map((entry) => (
                <div
                  key={entry.slug}
                  className="flex items-center justify-between gap-3 rounded-md border border-border p-3 text-sm"
                >
                  <div>
                    <p className="font-medium">
                      {entry.label} <span className="text-fg-muted">· {entry.slug}</span>
                    </p>
                    <p className="text-fg-muted">
                      {entry.provider}
                      {entry.modelSmart ? ` · default ${entry.modelSmart}` : ''}
                      {entry.baseUrl ? ` · ${entry.baseUrl}` : ''}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant="secondary">key sealed</Badge>
                    <form action={removeProviderAction}>
                      <input type="hidden" name="slug" value={entry.slug} />
                      <Button type="submit" variant="outline" size="sm">
                        Remove
                      </Button>
                    </form>
                  </div>
                </div>
              ))}
            </div>
          )}

          <form action={addProviderAction} className="grid gap-4 rounded-md border border-dashed border-border p-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="provider">Provider</Label>
              <Select id="provider" name="provider" required defaultValue="anthropic">
                {AI_PROVIDER_SPECS.map((spec) => (
                  <option key={spec.value} value={spec.value}>
                    {spec.label}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="slug">Slug</Label>
              <Input id="slug" name="slug" placeholder="anthropic-main" required />
            </div>
            <div className="space-y-2">
              <Label htmlFor="label">Label</Label>
              <Input id="label" name="label" placeholder="Anthropic (company account)" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="apiKey">API key</Label>
              <Input id="apiKey" name="apiKey" type="password" required />
            </div>
            <div className="space-y-2">
              <Label htmlFor="modelSmart">Default model</Label>
              <Input id="modelSmart" name="modelSmart" placeholder="claude-sonnet-5" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="baseUrl">Base URL (custom/openai-compatible only)</Label>
              <Input id="baseUrl" name="baseUrl" placeholder="https://…" />
            </div>
            <div className="md:col-span-2">
              <Button type="submit">Verify & add provider</Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </PageContainer>
  )
}
