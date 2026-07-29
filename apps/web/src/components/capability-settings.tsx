'use client'

import * as React from 'react'
import {
  Badge,
  Button,
  Drawer,
  EmptyState,
  Input,
  Label,
  PagedTable,
  Select,
  SettingsRow,
  SettingsSection,
  Textarea,
  type PagedColumn,
} from '@appkit/ui'
import { isSmsProvider, smsProviderSpec, SMS_PROVIDER_SPECS, type SmsProvider } from '@appkit/sms/providers'
import {
  AVAILABILITY_LABELS,
  INTEGRATION_LIBRARY,
  LIBRARY_GROUPS,
  type IntegrationLibraryEntry,
} from '../lib/integration-library'
import {
  beginMcpOauthAction,
  removeMcpIntegrationAction,
  removeSearchProviderAction,
  removeSmsSettingsAction,
  saveDocumentBrandingAction,
  saveMcpIntegrationAction,
  saveSmsSettingsAction,
  saveWorkspacePolicyAction,
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
  /** Signed in with OAuth; tokens are minted fresh on every connection. */
  isOauth: boolean
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

/** The path providers redirect back to; the origin is whatever domain the
 *  operator reaches us on. Shown when a provider needs the app registered by
 *  hand. */
const MCP_OAUTH_REDIRECT_PATH = '/api/mcp-oauth/callback'

const categoryLabel = (value: string) => CATEGORY_OPTIONS.find((c) => c.value === value)?.label ?? value

const INTEGRATION_COLUMNS: PagedColumn<IntegrationRowView>[] = [
  {
    key: 'label',
    header: 'Connection',
    cell: (row) => (
      <span className="min-w-0">
        <span className="block truncate font-medium text-primary">{row.label}</span>
        <span className="block truncate text-xs text-fg-muted">{row.slug}</span>
      </span>
    ),
    search: (row) => `${row.label} ${row.slug}`,
    sortValue: (row) => row.label,
  },
  {
    key: 'url',
    header: 'Server',
    cell: (row) => <span className="block max-w-xs truncate">{row.url}</span>,
    search: (row) => row.url,
    sortValue: (row) => row.url,
  },
  {
    key: 'category',
    header: 'Governed as',
    cell: (row) => <Badge variant="secondary">{categoryLabel(row.category)}</Badge>,
    search: (row) => categoryLabel(row.category),
    sortValue: (row) => categoryLabel(row.category),
  },
  {
    key: 'credentials',
    header: 'Credentials',
    cell: (row) =>
      row.isOauth ? (
        <Badge variant="secondary">signed in</Badge>
      ) : row.hasHeaders ? (
        <Badge variant="outline">sealed</Badge>
      ) : (
        <span className="text-fg-muted">none</span>
      ),
    sortValue: (row) => (row.isOauth ? 2 : row.hasHeaders ? 1 : 0),
  },
]

type IntegrationsPanel =
  | { kind: 'library' }
  | { kind: 'new'; prefill?: IntegrationLibraryEntry }
  | { kind: 'edit'; entry: IntegrationRowView }

/** How the last OAuth sign-in ended, as the callback route reported it. */
export type McpOauthOutcome = { ok: boolean; message: string }

/**
 * Drop the callback's parameters from the address bar once they have been
 * rendered, so a reload does not replay a stale outcome. Touching history is
 * an external-system update, which is exactly what an effect is for.
 */
function useClearedOauthParams(present: boolean): void {
  React.useEffect(() => {
    if (!present) return
    const params = new URLSearchParams(window.location.search)
    for (const key of ['mcpOauthConnected', 'mcpOauthError', 'mcpOauthTools']) params.delete(key)
    const query = params.toString()
    window.history.replaceState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}`)
  }, [present])
}

/**
 * The MCP connections agents work through. The list is the record; adding or
 * changing one happens in a drawer, so a long form never sits under the table.
 * The library is the front door — a curated catalog that prefills the same
 * drawer a custom server uses, so there is exactly one path to a saved entry.
 */
export function IntegrationsSection({
  integrations,
  oauthOutcome,
}: {
  integrations: IntegrationRowView[]
  oauthOutcome?: McpOauthOutcome | null
}) {
  const [panel, setPanel] = React.useState<IntegrationsPanel | null>(null)
  const outcome = oauthOutcome ?? null
  useClearedOauthParams(outcome !== null)

  return (
    <SettingsSection
      title="Integrations"
      description="External systems your agents can work in, connected over MCP — accounting, CRM, ticketing, anything that speaks it. Every tool a connection exposes is governed by the autonomy dial under the action category you choose here."
    >
      {outcome ? (
        <div className="px-5 pt-4">
          <p className={outcome.ok ? 'text-sm text-fg-muted' : 'text-sm text-danger'}>{outcome.message}</p>
        </div>
      ) : null}
      <SettingsRow
        title="Connected servers"
        description="Each server's tools appear in every agent's toolbox — on calls and in runs — governed like everything else."
        control={
          <span className="flex items-center gap-2">
            <Button size="sm" onClick={() => setPanel({ kind: 'library' })}>
              Browse library
            </Button>
            <Button variant="outline" size="sm" onClick={() => setPanel({ kind: 'new' })}>
              Connect custom
            </Button>
          </span>
        }
      />
      <div className="px-5 py-4">
        <PagedTable
          columns={INTEGRATION_COLUMNS}
          rows={integrations}
          rowKey={(row) => row.slug}
          pageSize={10}
          searchable
          defaultSort={{ key: 'label', dir: 'asc' }}
          onRowClick={(row) => setPanel({ kind: 'edit', entry: row })}
          labels={{ searchPlaceholder: 'Search integrations…', searchLabel: 'Search integrations' }}
          empty={
            <EmptyState
              title="No integrations yet"
              description="Pick a system from the library — or connect any custom MCP server — and its tools appear in every agent's toolbox, governed like everything else."
              action={<Button onClick={() => setPanel({ kind: 'library' })}>Browse library</Button>}
            />
          }
        />
      </div>

      {panel?.kind === 'library' ? (
        <LibraryDrawer
          connectedSlugs={new Set(integrations.map((row) => row.slug))}
          onPick={(entry) => setPanel({ kind: 'new', prefill: entry })}
          onClose={() => setPanel(null)}
        />
      ) : null}
      {panel?.kind === 'new' || panel?.kind === 'edit' ? (
        <IntegrationDrawer
          key={panel.kind === 'edit' ? panel.entry.slug : (panel.prefill?.slug ?? 'new')}
          entry={panel.kind === 'edit' ? panel.entry : null}
          prefill={panel.kind === 'new' ? (panel.prefill ?? null) : null}
          onClose={() => setPanel(null)}
        />
      ) : null}
    </SettingsSection>
  )
}

/**
 * The catalog: common business systems, each one click from the connect
 * drawer. Entries the vendor hosts are prefilled with the real server URL;
 * the rest carry directions (self-host or through a gateway) so an operator
 * is never left guessing what to paste.
 */
function LibraryDrawer({
  connectedSlugs,
  onPick,
  onClose,
}: {
  connectedSlugs: Set<string>
  onPick: (entry: IntegrationLibraryEntry) => void
  onClose: () => void
}) {
  const [query, setQuery] = React.useState('')

  const q = query.trim().toLowerCase()
  const matches = (entry: IntegrationLibraryEntry) =>
    !q || `${entry.label} ${entry.description} ${entry.group}`.toLowerCase().includes(q)

  return (
    <Drawer
      open
      onClose={onClose}
      title="Integration library"
      description="Common business systems, ready to connect. Picking one prefills the connection — you add the credential, the connection is tested, and every tool it exposes is governed by the autonomy dial."
      size="md"
    >
      <div className="space-y-5">
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search the library…"
          aria-label="Search the library"
        />
        {LIBRARY_GROUPS.map((group) => {
          const entries = INTEGRATION_LIBRARY.filter((entry) => entry.group === group && matches(entry))
          if (entries.length === 0) return null
          return (
            <div key={group}>
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-fg-muted">{group}</p>
              <div className="space-y-1">
                {entries.map((entry) => (
                  <button
                    key={entry.slug}
                    type="button"
                    onClick={() => onPick(entry)}
                    className="w-full rounded-md border border-transparent px-3 py-2 text-left transition-colors hover:border-border hover:bg-surface-hover"
                  >
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-primary">{entry.label}</span>
                      <Badge variant="outline">{AVAILABILITY_LABELS[entry.availability]}</Badge>
                      {entry.auth === 'oauth' ? <Badge variant="outline">sign-in</Badge> : null}
                      {connectedSlugs.has(entry.slug) ? <Badge variant="secondary">connected</Badge> : null}
                    </span>
                    <span className="mt-0.5 block text-sm text-fg-muted">{entry.description}</span>
                  </button>
                ))}
              </div>
            </div>
          )
        })}
        {INTEGRATION_LIBRARY.some(matches) ? null : (
          <p className="text-sm text-fg-muted">
            Nothing in the library matches. Any system with an MCP server still works — close this and use Connect
            custom.
          </p>
        )}
      </div>
    </Drawer>
  )
}

/** Add or replace one MCP connection. The server is probed before it saves.
 *  A library pick lands here as a prefill — same form, fields filled in. */
function IntegrationDrawer({
  entry,
  prefill,
  onClose,
}: {
  entry: IntegrationRowView | null
  prefill?: IntegrationLibraryEntry | null
  onClose: () => void
}) {
  const [label, setLabel] = React.useState(entry?.label ?? prefill?.label ?? '')
  const [slug, setSlug] = React.useState(entry?.slug ?? prefill?.slug ?? '')
  const [url, setUrl] = React.useState(entry?.url ?? prefill?.url ?? '')
  const [headersText, setHeadersText] = React.useState('')
  const [category, setCategory] = React.useState(entry?.category ?? prefill?.defaultCategory ?? 'record_write')
  const [method, setMethod] = React.useState<'headers' | 'oauth'>(
    entry?.isOauth ? 'oauth' : (prefill?.auth ?? 'headers'),
  )
  const [clientId, setClientId] = React.useState('')
  const [clientSecret, setClientSecret] = React.useState('')
  const [notice, setNotice] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [busy, startBusy] = React.useTransition()

  return (
    <Drawer
      open
      onClose={onClose}
      title={entry ? entry.label : prefill ? `Connect ${prefill.label}` : 'Connect a server'}
      description="Every tool this server exposes is governed by the autonomy dial under the action category you choose. The connection is tested before it is saved."
      size="md"
    >
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="mcp-label">Name</Label>
            <Input id="mcp-label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="OpenBooks" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="mcp-slug">Slug</Label>
            <Input
              id="mcp-slug"
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              disabled={entry !== null}
              placeholder="openbooks — prefixes its tool names"
            />
          </div>
          <div className="space-y-1 sm:col-span-2">
            <Label htmlFor="mcp-url">Server URL</Label>
            <Input id="mcp-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…/mcp" />
            {prefill?.urlHint ? <p className="text-xs text-fg-muted">{prefill.urlHint}</p> : null}
          </div>
          <div className="space-y-1 sm:col-span-2">
            <Label htmlFor="mcp-auth">How it signs in</Label>
            <Select
              id="mcp-auth"
              value={method}
              onChange={(e) => setMethod(e.target.value === 'oauth' ? 'oauth' : 'headers')}
            >
              <option value="headers">A token or API key you paste</option>
              <option value="oauth">Sign in with the provider (OAuth)</option>
            </Select>
            <p className="text-xs text-fg-muted">
              {method === 'oauth'
                ? 'You sign in at the provider and land back here. The connection keeps a refresh token, sealed at rest, and mints a fresh access token whenever an agent works.'
                : 'For servers that accept a standing token — paste it as a request header below.'}
            </p>
          </div>
          {method === 'headers' ? (
            <div className="space-y-1 sm:col-span-2">
              <Label htmlFor="mcp-headers">Headers (optional, sealed at rest)</Label>
              <Textarea
                id="mcp-headers"
                value={headersText}
                onChange={(e) => setHeadersText(e.target.value)}
                rows={2}
                placeholder={'Authorization: Bearer …\nOne per line'}
              />
              {prefill?.authHint ? <p className="text-xs text-fg-muted">{prefill.authHint}</p> : null}
              {entry?.hasHeaders ? (
                <p className="text-xs text-fg-muted">
                  Credentials are already sealed for this server. Leave this blank to keep them, or enter new headers to
                  replace them.
                </p>
              ) : null}
            </div>
          ) : (
            <>
              <div className="space-y-1">
                <Label htmlFor="mcp-client-id">Client ID (optional)</Label>
                <Input
                  id="mcp-client-id"
                  value={clientId}
                  onChange={(e) => setClientId(e.target.value)}
                  placeholder="Leave blank to register automatically"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="mcp-client-secret">Client secret (optional)</Label>
                <Input
                  id="mcp-client-secret"
                  type="password"
                  value={clientSecret}
                  onChange={(e) => setClientSecret(e.target.value)}
                  placeholder="Only if the provider issued one"
                />
              </div>
              <p className="text-xs text-fg-muted sm:col-span-2">
                Most servers register this company automatically. Fill these in only when the provider asks you to
                create an application first — then use{' '}
                <span className="font-mono">{MCP_OAUTH_REDIRECT_PATH}</span> on your own domain as its redirect URI.
              </p>
              {entry?.isOauth ? (
                <p className="text-xs text-fg-muted sm:col-span-2">
                  This connection is already signed in. Signing in again replaces the stored grant.
                </p>
              ) : null}
            </>
          )}
          <div className="space-y-1 sm:col-span-2">
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
        <div className="flex flex-wrap items-center gap-3">
          <Button
            disabled={busy || !label.trim() || !url.trim()}
            onClick={() =>
              startBusy(async () => {
                setError(null)
                setNotice(null)
                if (method === 'oauth') {
                  const started = await beginMcpOauthAction({
                    slug: slug || label,
                    label,
                    url,
                    category,
                    ...(clientId.trim() ? { clientId } : {}),
                    ...(clientSecret.trim() ? { clientSecret } : {}),
                  })
                  if (!started.ok) {
                    setError(started.message)
                    return
                  }
                  // The provider takes over from here; the callback saves the
                  // connection and brings the operator back to Settings.
                  window.location.href = started.url
                  return
                }
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
                onClose()
              })
            }
          >
            {busy ? (method === 'oauth' ? 'Starting…' : 'Testing…') : method === 'oauth' ? 'Sign in & connect' : 'Test & save'}
          </Button>
          {entry ? (
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() =>
                startBusy(async () => {
                  const form = new FormData()
                  form.set('slug', entry.slug)
                  await removeMcpIntegrationAction(form)
                  onClose()
                })
              }
            >
              Remove
            </Button>
          ) : null}
          {notice ? <p className="text-sm text-fg-muted">{notice}</p> : null}
          {error ? <p className="text-sm text-danger">{error}</p> : null}
        </div>
      </div>
    </Drawer>
  )
}

export type DocumentBrandingView = { companyName: string; accentColor: string; footerText: string }

/**
 * How agent-authored documents present the company: the letterhead line,
 * accent color, and footer on every generated .docx and .pdf deliverable.
 * The company is named once, under Company → Identity; the field here is only
 * for the rare case where documents carry a different name.
 */
export function DocumentsSection({
  branding,
  identityName,
}: {
  branding: DocumentBrandingView
  /** The company name from Company → Identity, used when this is left blank. */
  identityName: string
}) {
  const [companyName, setCompanyName] = React.useState(branding.companyName)
  const [accentColor, setAccentColor] = React.useState(branding.accentColor)
  const [footerText, setFooterText] = React.useState(branding.footerText)
  const [notice, setNotice] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [busy, startBusy] = React.useTransition()

  return (
    <SettingsSection
      title="Documents"
      description="Agents produce real .docx, .xlsx, and .pdf files — attached to their emails and kept on the record. Letterhead settings here appear on every generated document."
    >
      <SettingsRow title="Letterhead" stacked>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="doc-company">Company name on documents</Label>
            <Input
              id="doc-company"
              value={companyName}
              onChange={(event) => setCompanyName(event.target.value)}
              placeholder={identityName || 'Set your company name under Company → Identity'}
            />
            <p className="text-xs text-fg-muted">
              {identityName
                ? `Leave blank and documents are headed "${identityName}" — your company name.`
                : 'Set your company name under Company → Identity; this field only overrides it on documents.'}
            </p>
          </div>
          <div className="space-y-1">
            <Label htmlFor="doc-accent">Accent color</Label>
            <Input
              id="doc-accent"
              value={accentColor}
              onChange={(event) => setAccentColor(event.target.value)}
              placeholder="#1a4d8f"
            />
          </div>
        </div>
        <div className="mt-3 space-y-1">
          <Label htmlFor="doc-footer">Footer line</Label>
          <Input
            id="doc-footer"
            value={footerText}
            onChange={(event) => setFooterText(event.target.value)}
            placeholder="e.g. 123 Main St · (555) 010-0000 · company.com"
          />
        </div>
        <div className="mt-3 flex items-center gap-3">
          <Button
            disabled={busy}
            onClick={() =>
              startBusy(async () => {
                setError(null)
                setNotice(null)
                const result = await saveDocumentBrandingAction({ companyName, accentColor, footerText })
                if (!result.ok) setError(result.message)
                else setNotice('Saved. New documents use this letterhead.')
              })
            }
          >
            Save letterhead
          </Button>
          {notice ? <p className="text-sm text-fg-muted">{notice}</p> : null}
          {error ? <p className="text-sm text-danger">{error}</p> : null}
        </div>
      </SettingsRow>
    </SettingsSection>
  )
}

export type WorkspacePolicyView = { retentionDays: number | null }

/**
 * Housekeeping for agents' persistent workspaces. Retention is off by default:
 * nothing an agent keeps on its desk is deleted unless an operator turns this
 * on, and turning it off again stops the sweep without touching anything.
 */
export function WorkspaceSection({ policy }: { policy: WorkspacePolicyView }) {
  const [enabled, setEnabled] = React.useState(policy.retentionDays !== null)
  const [days, setDays] = React.useState(String(policy.retentionDays ?? 90))
  const [notice, setNotice] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [busy, startBusy] = React.useTransition()

  return (
    <SettingsSection
      title="Workspace"
      description="Each agent has a persistent workspace — its own desk. Files it saves there stay across runs and calls; shell work inside it is sandboxed and recorded. Retention keeps the desk tidy by retiring files that have not been touched in a while."
    >
      <SettingsRow
        title="Keep everything"
        description="With retention off, workspace files are never deleted."
        control={<Badge variant={enabled ? 'outline' : 'secondary'}>{enabled ? 'off' : 'active'}</Badge>}
      />
      <SettingsRow title="Retire untouched files" stacked>
        <div className="grid gap-3 sm:grid-cols-[12rem_1fr]">
          <div className="space-y-1">
            <Label htmlFor="workspace-retention-mode">Retention</Label>
            <Select
              id="workspace-retention-mode"
              value={enabled ? 'on' : 'off'}
              onChange={(event) => setEnabled(event.target.value === 'on')}
            >
              <option value="off">Keep everything</option>
              <option value="on">Retire old files</option>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="workspace-retention-days">Days a file may sit untouched</Label>
            <Input
              id="workspace-retention-days"
              type="number"
              min={7}
              value={days}
              onChange={(event) => setDays(event.target.value)}
              disabled={!enabled}
            />
          </div>
        </div>
        <p className="mt-2 text-xs text-fg-muted">
          The sweep runs daily and removes only files whose last change is older than the window — published
          deliverables, mail attachments, and everything else in the company file record are never touched.
        </p>
        <div className="mt-3 flex items-center gap-3">
          <Button
            disabled={busy}
            onClick={() =>
              startBusy(async () => {
                setError(null)
                setNotice(null)
                const result = await saveWorkspacePolicyAction({
                  retentionEnabled: enabled,
                  retentionDays: Number(days),
                })
                if (!result.ok) setError(result.message)
                else setNotice(enabled ? `Saved — files untouched for ${days} days are retired daily.` : 'Saved — nothing is deleted.')
              })
            }
          >
            Save policy
          </Button>
          {notice ? <p className="text-sm text-fg-muted">{notice}</p> : null}
          {error ? <p className="text-sm text-danger">{error}</p> : null}
        </div>
      </SettingsRow>
    </SettingsSection>
  )
}

export type SmsSettingsView = { provider: string | null; fromNumber: string | null }

type SmsDynamicFields = {
  twilioAccountSid?: string
  vonageApiKey?: string
  plivoAuthId?: string
  telnyxMessagingProfileId?: string
}

/**
 * Outbound text messaging: an operator connects one of five SMS providers,
 * whose single credential is sealed at rest and only unsealed at send time.
 * Every agent texts through the one connected provider — nothing to assign
 * per agent, unlike Model providers.
 */
export function SmsSection({ settings }: { settings: SmsSettingsView }) {
  const configuredProvider = settings.provider && isSmsProvider(settings.provider) ? settings.provider : null
  const [provider, setProvider] = React.useState<SmsProvider>(configuredProvider ?? SMS_PROVIDER_SPECS[0]!.value)
  const [fromNumber, setFromNumber] = React.useState('')
  const [secret, setSecret] = React.useState('')
  const [fields, setFields] = React.useState<SmsDynamicFields>({})
  const [notice, setNotice] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [busy, startBusy] = React.useTransition()

  const spec = smsProviderSpec(provider)
  const providerLabel = configuredProvider ? smsProviderSpec(configuredProvider).label : null

  const setField = (key: string, value: string) =>
    setFields((prev) => ({ ...prev, [key]: value }) as SmsDynamicFields)

  return (
    <SettingsSection
      title="Text messaging"
      description="Send SMS from your agents — reminders, confirmations, quick replies. Connect one provider below and every agent can text through it; the credential is sealed at rest and unsealed only when a message goes out."
    >
      {providerLabel ? (
        <SettingsRow
          title={providerLabel}
          description={settings.fromNumber ? `Sending from ${settings.fromNumber}` : 'Sender configured'}
          control={
            <span className="flex items-center gap-2">
              <Badge variant="secondary">key sealed</Badge>
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => startBusy(async () => removeSmsSettingsAction())}
              >
                Remove
              </Button>
            </span>
          }
        />
      ) : (
        <SettingsRow
          title="Not configured"
          description="Agents cannot send text messages until a provider is connected below."
        />
      )}
      <SettingsRow title={providerLabel ? 'Replace the provider' : 'Connect a provider'} stacked>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="sms-provider">Provider</Label>
            <Select
              id="sms-provider"
              value={provider}
              onChange={(event) => {
                const next = event.target.value
                if (isSmsProvider(next)) {
                  setProvider(next)
                  setFields({})
                }
              }}
            >
              {SMS_PROVIDER_SPECS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="sms-from">Sender (number or ID)</Label>
            <Input
              id="sms-from"
              value={fromNumber}
              onChange={(event) => setFromNumber(event.target.value)}
              placeholder="+15551234567"
            />
          </div>
          {spec.fields.map((field) => (
            <div key={field.key} className="space-y-1">
              <Label htmlFor={`sms-field-${field.key}`}>{field.label}</Label>
              <Input
                id={`sms-field-${field.key}`}
                value={fields[field.key as keyof SmsDynamicFields] ?? ''}
                onChange={(event) => setField(field.key, event.target.value)}
                placeholder={field.placeholder}
              />
            </div>
          ))}
          <div className="space-y-1 sm:col-span-2">
            <Label htmlFor="sms-secret">{spec.secretLabel}</Label>
            <Input
              id="sms-secret"
              type="password"
              value={secret}
              onChange={(event) => setSecret(event.target.value)}
              placeholder={spec.keyHint}
            />
          </div>
        </div>
        {spec.docsHint ? <p className="mt-2 text-xs text-fg-muted">{spec.docsHint}</p> : null}
        <div className="mt-3 flex items-center gap-3">
          <Button
            disabled={busy || !fromNumber.trim() || !secret.trim()}
            onClick={() =>
              startBusy(async () => {
                setError(null)
                setNotice(null)
                const result = await saveSmsSettingsAction({
                  provider,
                  fromNumber,
                  secret,
                  ...fields,
                })
                if (!result.ok) {
                  setError(result.message)
                  return
                }
                setNotice('Saved. Agents can send text messages through this provider.')
                setSecret('')
              })
            }
          >
            Verify &amp; save
          </Button>
          {notice ? <p className="text-sm text-fg-muted">{notice}</p> : null}
          {error ? <p className="text-sm text-danger">{error}</p> : null}
        </div>
      </SettingsRow>
    </SettingsSection>
  )
}
