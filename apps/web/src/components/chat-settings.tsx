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
  SubtabNav,
  type PagedColumn,
} from '@appkit/ui'
import {
  removeChatChannelRouteAction,
  removeSlackConnectionAction,
  removeTeamsInboundAction,
  removeTeamsWebhookAction,
  saveChatChannelRouteAction,
  saveSlackConnectionAction,
  saveTeamsInboundAction,
  saveTeamsWebhookAction,
  testSlackConnectionAction,
  testTeamsWebhookAction,
} from '../app/admin/settings/chat-actions'

/**
 * Settings → Chat: reach an agent from Slack or Microsoft Teams and get a
 * real answer back. Doctrine #1 — mail is the primary surface, this is a
 * secondary door in that anchors to the exact same runs/audit trail.
 */

export type ChatConnectionsView = {
  slack: { connected: boolean; teamName: string | null }
  teams: { connected: boolean; inboundConnected: boolean; msTenantId: string | null; appId: string | null }
}

export type ChatChannelRouteRowView = {
  id: string
  provider: 'slack' | 'teams'
  channelId: string
  channelLabel: string | null
  personId: string
  personName: string
}

export type ChatAgentOption = { id: string; name: string; title: string }

export function ChatSettingsSection({
  connections,
  routes,
  agents,
  webhookUrls,
}: {
  connections: ChatConnectionsView
  routes: ChatChannelRouteRowView[]
  agents: ChatAgentOption[]
  webhookUrls: { slack: string; teams: string }
}) {
  const [open, setOpen] = React.useState(false)
  const [tab, setTab] = React.useState('slack')
  const anyConnected = connections.slack.connected || connections.teams.connected

  const summary = !anyConnected
    ? 'Connect Slack or Microsoft Teams so a message to an agent starts the same governed run mail does.'
    : [
        connections.slack.connected ? `Slack · ${connections.slack.teamName ?? 'connected'}` : null,
        connections.teams.connected ? 'Microsoft Teams · connected' : null,
        `${routes.length} channel${routes.length === 1 ? '' : 's'} routed`,
      ]
        .filter(Boolean)
        .join(' · ')

  return (
    <>
      <SettingsRow
        title="Chat bridge"
        description={summary}
        control={
          <span className="flex items-center gap-2">
            {connections.slack.connected ? <Badge variant="secondary">Slack</Badge> : null}
            {connections.teams.connected ? <Badge variant="secondary">Teams</Badge> : null}
            {!anyConnected ? <Badge variant="outline">not connected</Badge> : null}
            <Button variant={anyConnected ? 'outline' : 'default'} size="sm" onClick={() => setOpen(true)}>
              {anyConnected ? 'Manage' : 'Set up'}
            </Button>
          </span>
        }
      />

      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        title="Chat bridge"
        description="A message to an agent in Slack or Teams starts the same governed run — and the same ledger — a mail thread does. Mail stays the primary surface; this is a faster door in for quick asks."
        size="lg"
      >
        <div className="space-y-4">
          <SubtabNav
            ariaLabel="Chat bridge"
            active={tab}
            onSelect={setTab}
            tabs={[
              { key: 'slack', label: 'Slack' },
              { key: 'teams', label: 'Microsoft Teams' },
              { key: 'routing', label: 'Channel routing', count: routes.length },
            ]}
          />
          {tab === 'slack' ? <SlackTab connection={connections.slack} webhookUrl={webhookUrls.slack} /> : null}
          {tab === 'teams' ? <TeamsTab connection={connections.teams} webhookUrl={webhookUrls.teams} /> : null}
          {tab === 'routing' ? <RoutingTab routes={routes} agents={agents} /> : null}
        </div>
      </Drawer>
    </>
  )
}

// --- Slack ------------------------------------------------------------------

function SlackTab({ connection, webhookUrl }: { connection: ChatConnectionsView['slack']; webhookUrl: string }) {
  const [botToken, setBotToken] = React.useState('')
  const [signingSecret, setSigningSecret] = React.useState('')
  const [notice, setNotice] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [busy, startBusy] = React.useTransition()

  return (
    <div className="space-y-4 text-sm">
      <div className="flex items-center justify-between rounded-md border border-border px-3 py-2">
        <span className="text-fg-muted">Status</span>
        {connection.connected ? (
          <span className="flex items-center gap-2">
            <Badge variant="default">connected · {connection.teamName ?? 'workspace'}</Badge>
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() =>
                startBusy(async () => {
                  setError(null)
                  setNotice(null)
                  const result = await testSlackConnectionAction()
                  if (!result.ok) setError(result.message)
                  else setNotice(`Still working — connected to ${result.teamName}.`)
                })
              }
            >
              Test connection
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() =>
                startBusy(async () => {
                  await removeSlackConnectionAction()
                })
              }
            >
              Remove
            </Button>
          </span>
        ) : (
          <Badge variant="outline">not connected</Badge>
        )}
      </div>

      <div className="space-y-1">
        <Label htmlFor="slack-request-url">Event Subscriptions Request URL</Label>
        <Input id="slack-request-url" readOnly value={webhookUrl} onFocus={(event) => event.target.select()} />
        <p className="text-xs text-fg-muted">Paste this into the Slack app&apos;s Event Subscriptions page — Slack verifies it the moment you save.</p>
      </div>

      <details className="rounded-md border border-border px-3 py-2" open={!connection.connected}>
        <summary className="cursor-pointer text-sm font-medium">
          {connection.connected ? 'Replace the connection' : 'Connect a Slack app'}
        </summary>
        <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-xs text-fg-muted">
          <li>
            Create an app at{' '}
            <a href="https://api.slack.com/apps" target="_blank" rel="noreferrer" className="text-primary underline underline-offset-2">
              api.slack.com/apps
            </a>
            .
          </li>
          <li>
            Under OAuth &amp; Permissions, add the bot scopes <code>chat:write</code>, <code>channels:history</code>,{' '}
            <code>groups:history</code>, <code>im:history</code>, and <code>app_mentions:read</code>, then install the app to the
            workspace.
          </li>
          <li>
            Under Event Subscriptions, turn events on, paste the Request URL above, and subscribe to the bot events{' '}
            <code>message.channels</code>, <code>message.im</code>, and <code>app_mention</code>.
          </li>
          <li>Invite the bot to any channel it should answer in, then map that channel to an agent under Channel routing.</li>
        </ol>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="slack-bot-token">Bot token</Label>
            <Input
              id="slack-bot-token"
              type="password"
              value={botToken}
              onChange={(event) => setBotToken(event.target.value)}
              placeholder="xoxb-…"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="slack-signing-secret">Signing secret</Label>
            <Input
              id="slack-signing-secret"
              type="password"
              value={signingSecret}
              onChange={(event) => setSigningSecret(event.target.value)}
              placeholder="From Basic Information"
            />
          </div>
        </div>
        <div className="mt-3 flex items-center gap-3">
          <Button
            size="sm"
            disabled={busy || !botToken.trim() || !signingSecret.trim()}
            onClick={() =>
              startBusy(async () => {
                setError(null)
                setNotice(null)
                const result = await saveSlackConnectionAction({ botToken, signingSecret })
                if (!result.ok) {
                  setError(result.message)
                  return
                }
                setNotice(`Connected to ${result.teamName}.`)
                setBotToken('')
                setSigningSecret('')
              })
            }
          >
            {busy ? 'Verifying…' : 'Verify & connect'}
          </Button>
          {notice ? <p className="text-fg-muted">{notice}</p> : null}
        </div>
      </details>
      {error ? <p className="text-danger">{error}</p> : null}
    </div>
  )
}

// --- Microsoft Teams ----------------------------------------------------------

function TeamsTab({ connection, webhookUrl }: { connection: ChatConnectionsView['teams']; webhookUrl: string }) {
  const [webhookInput, setWebhookInput] = React.useState('')
  const [outboundNotice, setOutboundNotice] = React.useState<string | null>(null)
  const [outboundError, setOutboundError] = React.useState<string | null>(null)
  const [outboundBusy, startOutboundBusy] = React.useTransition()

  const [securityToken, setSecurityToken] = React.useState('')
  const [msTenantId, setMsTenantId] = React.useState('')
  const [appId, setAppId] = React.useState('')
  const [inboundNotice, setInboundNotice] = React.useState<string | null>(null)
  const [inboundError, setInboundError] = React.useState<string | null>(null)
  const [inboundBusy, startInboundBusy] = React.useTransition()

  return (
    <div className="space-y-6 text-sm">
      <div>
        <h4 className="mb-2 text-sm font-medium">Send messages to Teams</h4>
        <div className="flex items-center justify-between rounded-md border border-border px-3 py-2">
          <span className="text-fg-muted">Status</span>
          {connection.connected ? (
            <span className="flex items-center gap-2">
              <Badge variant="default">connected</Badge>
              <Button
                variant="outline"
                size="sm"
                disabled={outboundBusy}
                onClick={() =>
                  startOutboundBusy(async () => {
                    setOutboundError(null)
                    setOutboundNotice(null)
                    const result = await testTeamsWebhookAction()
                    if (!result.ok) setOutboundError(result.message)
                    else setOutboundNotice('Test message sent — check the channel.')
                  })
                }
              >
                Send test message
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={outboundBusy}
                onClick={() => startOutboundBusy(async () => removeTeamsWebhookAction())}
              >
                Remove
              </Button>
            </span>
          ) : (
            <Badge variant="outline">not connected</Badge>
          )}
        </div>
        <details className="mt-2 rounded-md border border-border px-3 py-2" open={!connection.connected}>
          <summary className="cursor-pointer text-sm font-medium">{connection.connected ? 'Replace the webhook' : 'Connect a channel'}</summary>
          <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-xs text-fg-muted">
            <li>In the Teams channel an agent should post to, open the channel menu → Connectors (or Workflows on newer tenants).</li>
            <li>Add an Incoming Webhook, name it after the agent, and copy the URL it gives you.</li>
            <li>Paste it below — saving sends an actual test message so a bad URL is caught immediately.</li>
          </ol>
          <div className="mt-3 space-y-1">
            <Label htmlFor="teams-webhook-url">Incoming Webhook URL</Label>
            <Input
              id="teams-webhook-url"
              type="password"
              value={webhookInput}
              onChange={(event) => setWebhookInput(event.target.value)}
              placeholder="https://…webhook.office.com/webhookb2/…"
            />
          </div>
          <div className="mt-3 flex items-center gap-3">
            <Button
              size="sm"
              disabled={outboundBusy || !webhookInput.trim()}
              onClick={() =>
                startOutboundBusy(async () => {
                  setOutboundError(null)
                  setOutboundNotice(null)
                  const result = await saveTeamsWebhookAction({ webhookUrl: webhookInput })
                  if (!result.ok) {
                    setOutboundError(result.message)
                    return
                  }
                  setOutboundNotice('Connected — a test message was posted to the channel.')
                  setWebhookInput('')
                })
              }
            >
              {outboundBusy ? 'Testing…' : 'Verify & connect'}
            </Button>
            {outboundNotice ? <p className="text-fg-muted">{outboundNotice}</p> : null}
          </div>
        </details>
        {outboundError ? <p className="mt-2 text-danger">{outboundError}</p> : null}
      </div>

      <div className="border-t border-border pt-4">
        <h4 className="mb-1 text-sm font-medium">Answer messages from Teams (optional)</h4>
        <p className="mb-2 text-xs text-fg-muted">
          Inbound uses Teams&apos; lightweight Outgoing Webhook — a bot mention in a channel reaches an agent, no Azure Bot
          registration required. This is intentionally lighter than Slack: it only fires on an @mention in a channel the bot
          is added to (no direct messages, no agent-initiated messages), and a long-running agent task can outrun the few
          seconds Teams waits for a reply, in which case Teams shows its own timeout notice even though the agent finishes
          the work. Full parity with Slack would need a separate Azure Bot Service registration, which this build does not
          set up.
        </p>
        <div className="flex items-center justify-between rounded-md border border-border px-3 py-2">
          <span className="text-fg-muted">Status</span>
          {connection.inboundConnected ? (
            <span className="flex items-center gap-2">
              <Badge variant="default">connected</Badge>
              <Button variant="outline" size="sm" disabled={inboundBusy} onClick={() => startInboundBusy(async () => removeTeamsInboundAction())}>
                Remove
              </Button>
            </span>
          ) : (
            <Badge variant="outline">not connected</Badge>
          )}
        </div>
        <details className="mt-2 rounded-md border border-border px-3 py-2">
          <summary className="cursor-pointer text-sm font-medium">{connection.inboundConnected ? 'Replace the outgoing webhook' : 'Set up the outgoing webhook'}</summary>
          <div className="mt-2 space-y-1">
            <Label htmlFor="teams-callback-url">Callback URL</Label>
            <Input id="teams-callback-url" readOnly value={webhookUrl} onFocus={(event) => event.target.select()} />
          </div>
          <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-xs text-fg-muted">
            <li>In the team, open Manage team → Apps → Create an outgoing webhook.</li>
            <li>Name it after the agent, paste the callback URL above, and add a short description and profile picture.</li>
            <li>Teams shows a security token once — paste it below immediately, it is not shown again.</li>
          </ol>
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            <div className="space-y-1 sm:col-span-3">
              <Label htmlFor="teams-security-token">Security token</Label>
              <Input
                id="teams-security-token"
                type="password"
                value={securityToken}
                onChange={(event) => setSecurityToken(event.target.value)}
                placeholder="Shown once, when the webhook is created"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="teams-ms-tenant">Microsoft 365 tenant ID</Label>
              <Input
                id="teams-ms-tenant"
                value={msTenantId}
                onChange={(event) => setMsTenantId(event.target.value)}
                placeholder="Optional, informational"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="teams-app-id">Bot/app ID</Label>
              <Input id="teams-app-id" value={appId} onChange={(event) => setAppId(event.target.value)} placeholder="Optional, informational" />
            </div>
          </div>
          <div className="mt-3 flex items-center gap-3">
            <Button
              size="sm"
              disabled={inboundBusy || !securityToken.trim()}
              onClick={() =>
                startInboundBusy(async () => {
                  setInboundError(null)
                  setInboundNotice(null)
                  const result = await saveTeamsInboundAction({ securityToken, msTenantId, appId })
                  if (!result.ok) {
                    setInboundError(result.message)
                    return
                  }
                  setInboundNotice('Saved. Mention the bot in a routed channel to try it.')
                  setSecurityToken('')
                })
              }
            >
              Save
            </Button>
            {inboundNotice ? <p className="text-fg-muted">{inboundNotice}</p> : null}
          </div>
        </details>
        {inboundError ? <p className="mt-2 text-danger">{inboundError}</p> : null}
      </div>
    </div>
  )
}

// --- Channel routing ----------------------------------------------------------

/** Routes are short-lived mappings: one row, one channel, one agent. */
const routeColumns = (
  busy: boolean,
  remove: (id: string) => void,
): PagedColumn<ChatChannelRouteRowView>[] => [
  {
    key: 'provider',
    header: 'Provider',
    cell: (row) => <Badge variant="outline">{row.provider === 'slack' ? 'Slack' : 'Teams'}</Badge>,
    search: (row) => row.provider,
    sortValue: (row) => row.provider,
  },
  {
    key: 'channel',
    header: 'Channel',
    cell: (row) => (
      <span className="min-w-0">
        <span className="block truncate font-medium">
          {row.channelId === '*' ? 'Default (unmapped)' : row.channelId}
        </span>
        {row.channelLabel ? <span className="block truncate text-xs text-fg-muted">{row.channelLabel}</span> : null}
      </span>
    ),
    search: (row) => `${row.channelId} ${row.channelLabel ?? ''}`,
    sortValue: (row) => row.channelId,
  },
  {
    key: 'personName',
    header: 'Answered by',
    cell: (row) => row.personName,
    search: (row) => row.personName,
    sortValue: (row) => row.personName,
  },
  {
    key: 'actions',
    header: '',
    align: 'right',
    cell: (row) => (
      <Button variant="outline" size="sm" disabled={busy} onClick={() => remove(row.id)}>
        Remove
      </Button>
    ),
  },
]

function RoutingTab({ routes, agents }: { routes: ChatChannelRouteRowView[]; agents: ChatAgentOption[] }) {
  const [provider, setProvider] = React.useState<'slack' | 'teams'>('slack')
  const [channelId, setChannelId] = React.useState('')
  const [channelLabel, setChannelLabel] = React.useState('')
  const [personId, setPersonId] = React.useState(agents[0]?.id ?? '')
  const [error, setError] = React.useState<string | null>(null)
  const [busy, startBusy] = React.useTransition()

  return (
    <div className="space-y-4 text-sm">
      <p className="text-fg-muted">
        Which agent answers which channel or direct message. A route with channel ID <code>*</code> is the default agent —
        it answers any mention or DM that has no specific mapping, so a message never goes unanswered.
      </p>
      <PagedTable
        columns={routeColumns(busy, (id) => startBusy(async () => removeChatChannelRouteAction(id)))}
        rows={routes}
        rowKey={(row) => row.id}
        pageSize={8}
        searchable
        defaultSort={{ key: 'channel', dir: 'asc' }}
        labels={{ searchPlaceholder: 'Search routes…', searchLabel: 'Search routes' }}
        empty={
          <EmptyState
            title="No channels routed yet"
            description="Add one below, or add a * route so a single default agent answers anything unmapped."
          />
        }
      />
      <div className="space-y-3 rounded-md border border-border p-3">
        <p className="font-medium">Add a route</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="route-provider">Provider</Label>
            <Select id="route-provider" value={provider} onChange={(event) => setProvider(event.target.value as 'slack' | 'teams')}>
              <option value="slack">Slack</option>
              <option value="teams">Microsoft Teams</option>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="route-agent">Answered by</Label>
            <Select id="route-agent" value={personId} onChange={(event) => setPersonId(event.target.value)}>
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name} — {agent.title}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="route-channel">Channel ID</Label>
            <Input id="route-channel" value={channelId} onChange={(event) => setChannelId(event.target.value)} placeholder="C0123ABC, or * for default" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="route-label">Label (optional)</Label>
            <Input id="route-label" value={channelLabel} onChange={(event) => setChannelLabel(event.target.value)} placeholder="#support" />
          </div>
        </div>
        <div className="flex items-center gap-3">
          <Button
            size="sm"
            disabled={busy || !channelId.trim() || !personId}
            onClick={() =>
              startBusy(async () => {
                setError(null)
                const result = await saveChatChannelRouteAction({ provider, channelId, channelLabel, personId })
                if (!result.ok) {
                  setError(result.message)
                  return
                }
                setChannelId('')
                setChannelLabel('')
              })
            }
          >
            Add route
          </Button>
          {error ? <p className="text-danger">{error}</p> : null}
        </div>
      </div>
    </div>
  )
}
