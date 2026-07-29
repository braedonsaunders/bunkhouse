'use client'

import * as React from 'react'
import {
  Badge,
  Button,
  Drawer,
  Input,
  Label,
  RecordList,
  Select,
  Textarea,
  type RecordColumn,
} from '@appkit/ui'
import {
  AVAILABILITY_LABELS,
  INTEGRATION_LIBRARY,
  LIBRARY_GROUPS,
  type IntegrationLibraryEntry,
} from '../lib/integration-library'
import {
  beginMcpOauthAction,
  removeMcpIntegrationAction,
  saveMcpIntegrationAction,
} from '../app/resources/system-actions'

/**
 * Systems: the outside software an agent is given access to, connected over
 * MCP. It sits with the rest of an agent's resources rather than in Settings —
 * a connection to the company's accounting package is something staff *have*,
 * like systems access on an onboarding checklist, not deployment configuration.
 *
 * Every tool a connection exposes runs under the one action category chosen
 * here, so the autonomy dial governs an unknown integration the same way it
 * governs everything else.
 */

export type SystemRowView = {
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

const COLUMNS: RecordColumn<SystemRowView>[] = [
  {
    key: 'label',
    label: 'System',
    sortable: true,
    render: (row) => (
      <span className="min-w-0">
        <span className="block truncate font-medium text-primary">{row.label}</span>
        <span className="block truncate text-xs text-fg-muted">{row.slug}</span>
      </span>
    ),
  },
  {
    key: 'url',
    label: 'Server',
    render: (row) => <span className="block max-w-xs truncate">{row.url}</span>,
  },
  {
    key: 'category',
    label: 'Governed as',
    sortable: true,
    render: (row) => <Badge variant="secondary">{categoryLabel(row.category)}</Badge>,
  },
  {
    key: 'credentials',
    label: 'Credentials',
    render: (row) =>
      row.isOauth ? (
        <Badge variant="secondary">signed in</Badge>
      ) : row.hasHeaders ? (
        <Badge variant="outline">sealed</Badge>
      ) : (
        <span className="text-fg-muted">none</span>
      ),
  },
]

type SystemsPanel =
  | { kind: 'library' }
  | { kind: 'new'; prefill?: IntegrationLibraryEntry }
  | { kind: 'edit'; entry: SystemRowView }

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
 * The list is the record; connecting or changing a system happens in a drawer,
 * so a long form never sits under the table. The library is the front door — a
 * curated catalog that prefills the same drawer a custom server uses, so there
 * is exactly one path to a saved connection.
 */
export function SystemsView({
  systems,
  oauthOutcome,
}: {
  systems: SystemRowView[]
  oauthOutcome?: McpOauthOutcome | null
}) {
  const [panel, setPanel] = React.useState<SystemsPanel | null>(null)
  const [query, setQuery] = React.useState('')
  const outcome = oauthOutcome ?? null
  useClearedOauthParams(outcome !== null)

  const q = query.trim().toLowerCase()
  const rows = q
    ? systems.filter((row) => `${row.label} ${row.slug} ${row.url}`.toLowerCase().includes(q))
    : systems

  return (
    <div className="space-y-3">
      <p className="text-sm text-fg-muted">
        The outside software your agents work in, connected over MCP — accounting, CRM, ticketing, anything that speaks
        it. Each system&apos;s tools appear in every agent&apos;s toolbox, on calls and in runs, governed by the autonomy
        dial under the action category you choose.
      </p>

      {outcome ? (
        <p className={outcome.ok ? 'text-sm text-fg-muted' : 'text-sm text-danger'}>{outcome.message}</p>
      ) : null}

      <RecordList
        columns={COLUMNS}
        rows={rows}
        getRowId={(row) => row.slug}
        onRowClick={(row) => setPanel({ kind: 'edit', entry: row })}
        search={{ value: query, onChange: setQuery, placeholder: 'Search systems…' }}
        toolbarActions={
          <span className="flex items-center gap-2">
            <Button size="sm" onClick={() => setPanel({ kind: 'library' })}>
              Browse library
            </Button>
            <Button variant="outline" size="sm" onClick={() => setPanel({ kind: 'new' })}>
              Connect custom
            </Button>
          </span>
        }
        empty={{
          title: 'No systems connected',
          description:
            'Pick one from the library — or connect any custom MCP server — and its tools appear in every agent’s toolbox, governed like everything else.',
          action: <Button onClick={() => setPanel({ kind: 'library' })}>Browse library</Button>,
        }}
      />

      {panel?.kind === 'library' ? (
        <LibraryDrawer
          connectedSlugs={new Set(systems.map((row) => row.slug))}
          onPick={(entry) => setPanel({ kind: 'new', prefill: entry })}
          onClose={() => setPanel(null)}
        />
      ) : null}
      {panel?.kind === 'new' || panel?.kind === 'edit' ? (
        <SystemDrawer
          key={panel.kind === 'edit' ? panel.entry.slug : (panel.prefill?.slug ?? 'new')}
          entry={panel.kind === 'edit' ? panel.entry : null}
          prefill={panel.kind === 'new' ? (panel.prefill ?? null) : null}
          onClose={() => setPanel(null)}
        />
      ) : null}
    </div>
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
      title="System library"
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

/** Add or replace one system connection. The server is probed before it saves.
 *  A library pick lands here as a prefill — same form, fields filled in. */
function SystemDrawer({
  entry,
  prefill,
  onClose,
}: {
  entry: SystemRowView | null
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
      title={entry ? entry.label : prefill ? `Connect ${prefill.label}` : 'Connect a system'}
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
                  Credentials are already sealed for this system. Leave this blank to keep them, or enter new headers to
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
                  This system is already signed in. Signing in again replaces the stored grant.
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
                  // connection and brings the operator back to Resources.
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
              Disconnect
            </Button>
          ) : null}
          {notice ? <p className="text-sm text-fg-muted">{notice}</p> : null}
          {error ? <p className="text-sm text-danger">{error}</p> : null}
        </div>
      </div>
    </Drawer>
  )
}
