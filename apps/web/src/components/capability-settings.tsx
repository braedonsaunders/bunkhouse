'use client'

import * as React from 'react'
import { Badge, Button, EmptyState, Input, Label, Select, SettingsRow, SettingsSection, Textarea } from '@appkit/ui'
import {
  removeMcpIntegrationAction,
  removeSearchProviderAction,
  saveMcpIntegrationAction,
  setSearchProviderAction,
} from '../app/admin/settings/actions'

/**
 * The capability half of Settings: how agents research the web, and which
 * external systems they can work in. Both are governed downstream — research
 * is read-only, integrations run under the action category chosen here.
 */

const SEARCH_PROVIDERS = [
  { value: 'brave', label: 'Brave Search' },
  { value: 'tavily', label: 'Tavily' },
] as const

export function ResearchSection({ provider }: { provider: string | null }) {
  const [choice, setChoice] = React.useState<string>(SEARCH_PROVIDERS[0].value)
  const [key, setKey] = React.useState('')
  const [error, setError] = React.useState<string | null>(null)
  const [busy, startBusy] = React.useTransition()

  return (
    <SettingsSection
      title="Research"
      description="Every agent can search the web and read pages — on a call, in an email run, anywhere they work. Searches run on your provider key; without one they fall back to a keyless engine with lower-quality results."
    >
      {provider ? (
        <SettingsRow
          title={SEARCH_PROVIDERS.find((p) => p.value === provider)?.label ?? provider}
          description="Agents search on this provider."
          control={
            <span className="flex items-center gap-2">
              <Badge variant="secondary">key sealed</Badge>
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => startBusy(async () => removeSearchProviderAction())}
              >
                Remove
              </Button>
            </span>
          }
        />
      ) : (
        <SettingsRow
          title="Keyless fallback"
          description="No provider configured — searches use a public engine. Add a key for better, rate-stable results."
          control={<Badge variant="outline">active</Badge>}
        />
      )}
      <SettingsRow title={provider ? 'Replace the provider' : 'Add a provider'} stacked>
        <div className="grid gap-3 sm:grid-cols-[12rem_1fr_auto]">
          <div className="space-y-1">
            <Label htmlFor="search-provider">Provider</Label>
            <Select id="search-provider" value={choice} onChange={(event) => setChoice(event.target.value)}>
              {SEARCH_PROVIDERS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="search-key">API key</Label>
            <Input
              id="search-key"
              type="password"
              value={key}
              onChange={(event) => setKey(event.target.value)}
              placeholder="Verified against the provider before saving"
            />
          </div>
          <div className="flex items-end">
            <Button
              disabled={busy || !key.trim()}
              onClick={() =>
                startBusy(async () => {
                  setError(null)
                  const result = await setSearchProviderAction({ provider: choice, apiKey: key })
                  if (!result.ok) setError(result.message)
                  else setKey('')
                })
              }
            >
              Verify &amp; save
            </Button>
          </div>
        </div>
        {error ? <p className="mt-2 text-sm text-danger">{error}</p> : null}
      </SettingsRow>
    </SettingsSection>
  )
}

export type IntegrationRowView = {
  slug: string
  label: string
  url: string
  category: string
  hasHeaders: boolean
}

const CATEGORY_OPTIONS = [
  { value: 'record_write', label: 'Record writes' },
  { value: 'money_adjacent', label: 'Money-adjacent' },
  { value: 'file_write', label: 'File writes' },
  { value: 'external_email', label: 'External email' },
  { value: 'internal_email', label: 'Internal email' },
  { value: 'computer_use', label: 'Computer use' },
  { value: 'shell', label: 'Shell' },
  { value: 'phone_call', label: 'Phone calls' },
]

export function IntegrationsSection({ integrations }: { integrations: IntegrationRowView[] }) {
  const [label, setLabel] = React.useState('')
  const [slug, setSlug] = React.useState('')
  const [url, setUrl] = React.useState('')
  const [headersText, setHeadersText] = React.useState('')
  const [category, setCategory] = React.useState('record_write')
  const [notice, setNotice] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [busy, startBusy] = React.useTransition()

  return (
    <SettingsSection
      title="Integrations"
      description="External systems your agents can work in, connected over MCP — accounting, CRM, ticketing, anything that speaks it. Every tool a connection exposes is governed by the autonomy dial under the action category you choose here."
    >
      {integrations.length === 0 ? (
        <EmptyState
          title="No integrations yet"
          description="Connect a server and its tools appear in every agent's toolbox — on calls and in runs — governed like everything else."
        />
      ) : (
        integrations.map((entry) => (
          <SettingsRow
            key={entry.slug}
            title={`${entry.label} · ${entry.slug}`}
            description={entry.url}
            control={
              <span className="flex items-center gap-2">
                <Badge variant="secondary">{CATEGORY_OPTIONS.find((c) => c.value === entry.category)?.label ?? entry.category}</Badge>
                {entry.hasHeaders ? <Badge variant="outline">credentials sealed</Badge> : null}
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    startBusy(async () => {
                      const form = new FormData()
                      form.set('slug', entry.slug)
                      await removeMcpIntegrationAction(form)
                    })
                  }
                >
                  Remove
                </Button>
              </span>
            }
          />
        ))
      )}
      <SettingsRow title="Connect a server" description="The connection is tested before it is saved." stacked>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="mcp-label">Name</Label>
            <Input id="mcp-label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="OpenBooks" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="mcp-slug">Slug</Label>
            <Input id="mcp-slug" value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="openbooks — prefixes its tool names" />
          </div>
          <div className="space-y-1 sm:col-span-2">
            <Label htmlFor="mcp-url">Server URL</Label>
            <Input id="mcp-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…/mcp" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="mcp-headers">Headers (optional, sealed at rest)</Label>
            <Textarea
              id="mcp-headers"
              value={headersText}
              onChange={(e) => setHeadersText(e.target.value)}
              rows={2}
              placeholder={'Authorization: Bearer …\nOne per line'}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="mcp-category">Governed as</Label>
            <Select id="mcp-category" value={category} onChange={(e) => setCategory(e.target.value)}>
              {CATEGORY_OPTIONS.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </Select>
            <p className="text-xs text-fg-muted">The autonomy dial governs all of this server&apos;s tools under this category.</p>
          </div>
        </div>
        <div className="mt-3 flex items-center gap-3">
          <Button
            disabled={busy || !label.trim() || !url.trim()}
            onClick={() =>
              startBusy(async () => {
                setError(null)
                setNotice(null)
                const result = await saveMcpIntegrationAction({
                  slug: slug || label,
                  label,
                  url,
                  headersText,
                  category,
                })
                if (!result.ok) {
                  setError(result.message)
                  return
                }
                setNotice(`Connected — ${result.toolCount} tool${result.toolCount === 1 ? '' : 's'} available.`)
                setLabel('')
                setSlug('')
                setUrl('')
                setHeadersText('')
              })
            }
          >
            Test &amp; save
          </Button>
          {notice ? <p className="text-sm text-fg-muted">{notice}</p> : null}
          {error ? <p className="text-sm text-danger">{error}</p> : null}
        </div>
      </SettingsRow>
    </SettingsSection>
  )
}
