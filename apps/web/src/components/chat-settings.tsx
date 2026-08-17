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
  type PagedColumn,
} from '@braedonsaunders/appkit-ui'
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
import { SectionTabs } from './section-tabs'

/**
 * Settings → Chat: reach an agent from Slack or Microsoft Teams and get a
 * real answer back. Doctrine #1 — mail is the primary surface, this is a
 * secondary door in that anchors to the exact same runs/audit trail.
 *
 * One subtab per workspace, plus the routing table. Every connection and every
 * route is opened in a drawer, so no setup form is ever stacked under a list.
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
  const [tab, setTab] = React.useState('slack')

  return (
    <div className="space-y-4">
      <SectionTabs
        ariaLabel="Chat bridge"
        active={tab}
        onSelect={setTab}
        tabs={[
          { key: 'slack', label: 'Slack' },
          { key: 'teams', label: 'Microsoft Teams' },
          { key: 'routing', label: 'Channel routing', count: routes.length },
        ]}
      />
      {tab === 'slack' ? <SlackSection connection={connections.slack} webhookUrl={webhookUrls.slack} /> : null}
      {tab === 'teams' ? <TeamsSection connection={connections.teams} webhookUrl={webhookUrls.teams} /> : null}
      {tab === 'routing' ? <RoutingSection routes={routes} agents={agents} /> : null}
    </div>
  )
}

// --- Slack ------------------------------------------------------------------

function SlackSection({ connection, webhookUrl }: { connection: ChatConnectionsView['slack']; webhookUrl: string }) {
  const [open, setOpen] = React.useState(false)
  const [botToken, setBotToken] = React.useState('')
  const [signingSecret, setSigningSecret] = React.useState('')
  const [notice, setNotice] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [busy, startBusy] = React.useTransition()

  return (
    <SettingsSection
      title="Slack"
      description="A message to an agent in Slack starts the same governed run — and the same ledger — a mail thread does. Mail stays the primary surface; this is a faster door in for quick asks."
    >
      <SettingsRow
        title="Slack app"
        description={
          connection.connected
            ? `Connected to ${connection.teamName ?? 'your workspace'}. Agents answer mentions and direct messages.`
            : 'Not connected. Create a Slack app, then paste its bot token and signing secret.'
        }
        control={
          <span className="flex items-center gap-2">
            <Badge variant={connection.connected ? 'default' : 'outline'}>
              {connection.connected ? 'connected' : 'not connected'}
            </Badge>
            <Button variant={connection.connected ? 'outline' : 'default'} size="sm" onClick={() => setOpen(true)}>
              {connection.connected ? 'Manage' : 'Connect'}
            </Button>
          </span>
        }
      />
      <SettingsRow title="Event Subscriptions Request URL" stacked>
        <Input id="slack-request-url" readOnly value={webhookUrl} onFocus={(event) => event.target.select()} />
        <p className="mt-1 text-xs text-fg-muted">
          Paste this into the Slack app&apos;s Event Subscriptions page — Slack verifies it the moment you save.
        </p>
      </SettingsRow>

      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        title="Slack app"
        description="The workspace credentials agents answer through. Both values are sealed at rest and verified against Slack before saving."
        size="md"
      >
        <div className="space-y-4 text-sm">
          {connection.connected ? (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2">
              <Badge>connected · {connection.teamName ?? 'workspace'}</Badge>
              <span className="flex items-center gap-2">
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
                      setOpen(false)
                    })
                  }
                >
                  Remove
                </Button>
              </span>
            </div>
          ) : null}

          <ol className="list-decimal space-y-1.5 pl-5 text-xs text-fg-muted">
            <li>
              Create an app at{' '}
              <a
                href="https://api.slack.com/apps"
                target="_blank"
                rel="noreferrer"
                className="text-primary underline underline-offset-2"
              >
                api.slack.com/apps
              </a>
              .
            </li>
            <li>
              Under OAuth &amp; Permissions, add the bot scopes <code>chat:write</code>, <code>channels:history</code>,{' '}
              <code>groups:history</code>, <code>im:history</code>, and <code>app_mentions:read</code>, then install the
              app to the workspace.
            </li>
            <li>
              Under Event Subscriptions, turn events on, paste the Request URL from the Slack page, and subscribe to the
              bot events <code>message.channels</code>, <code>message.im</code>, and <code>app_mention</code>.
            </li>
            <li>
              Invite the bot to any channel it should answer in, then map that channel to an agent under Channel
              routing.
            </li>
          </ol>

          <div className="grid gap-3 sm:grid-cols-2">
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
          <div className="flex flex-wrap items-center gap-3">
            <Button
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
                  setBotToken('')
                  setSigningSecret('')
                  setOpen(false)
                })
              }
            >
              {busy ? 'Verifying…' : 'Verify & connect'}
            </Button>
            {notice ? <p className="text-fg-muted">{notice}</p> : null}
            {error ? <p className="text-danger">{error}</p> : null}
          </div>
        </div>
      </Drawer>
    </SettingsSection>
  )
}

// --- Microsoft Teams ----------------------------------------------------------

function TeamsSection({ connection, webhookUrl }: { connection: ChatConnectionsView['teams']; webhookUrl: string }) {
  const [open, setOpen] = React.useState<'outbound' | 'inbound' | null>(null)

  return (
    <SettingsSection
      title="Microsoft Teams"
      description="Agents post into a Teams channel through an Incoming Webhook, and can answer an @mention through Teams' lightweight Outgoing Webhook."
    >
      <SettingsRow
        title="Send messages to Teams"
        description={
          connection.connected
            ? 'Connected. Agents can post into the channel this webhook belongs to.'
            : 'Not connected. Add an Incoming Webhook to the channel agents should post in.'
        }
        control={
          <span className="flex items-center gap-2">
            <Badge variant={connection.connected ? 'default' : 'outline'}>
              {connection.connected ? 'connected' : 'not connected'}
            </Badge>
            <Button
              variant={connection.connected ? 'outline' : 'default'}
              size="sm"
              onClick={() => setOpen('outbound')}
            >
              {connection.connected ? 'Manage' : 'Connect'}
            </Button>
          </span>
        }
      />
      <SettingsRow
        title="Answer messages from Teams"
        description={
          connection.inboundConnected
            ? 'Connected. A bot mention in a channel reaches the agent routed to it.'
            : 'Optional. An Outgoing Webhook lets a bot mention in a channel reach an agent — no Azure Bot registration required.'
        }
        control={
          <span className="flex items-center gap-2">
            <Badge variant={connection.inboundConnected ? 'default' : 'outline'}>
              {connection.inboundConnected ? 'connected' : 'not connected'}
            </Badge>
            <Button
              variant={connection.inboundConnected ? 'outline' : 'default'}
              size="sm"
              onClick={() => setOpen('inbound')}
            >
              {connection.inboundConnected ? 'Manage' : 'Set up'}
            </Button>
          </span>
        }
      />

      <Drawer
        open={open === 'outbound'}
        onClose={() => setOpen(null)}
        title="Send messages to Teams"
        description="The Incoming Webhook agents post through. Saving posts a real test message, so a bad URL is caught immediately."
        size="md"
      >
        {open === 'outbound' ? <TeamsOutboundForm connection={connection} onDone={() => setOpen(null)} /> : null}
      </Drawer>

      <Drawer
        open={open === 'inbound'}
        onClose={() => setOpen(null)}
        title="Answer messages from Teams"
        description="Teams' Outgoing Webhook fires on an @mention in a channel the bot is added to. It carries no direct messages and no agent-initiated messages, and a long task can outrun the few seconds Teams waits — Teams then shows its own timeout notice even though the agent finishes the work."
        size="md"
      >
        {open === 'inbound' ? (
          <TeamsInboundForm connection={connection} webhookUrl={webhookUrl} onDone={() => setOpen(null)} />
        ) : null}
      </Drawer>
    </SettingsSection>
  )
}

function TeamsOutboundForm({
  connection,
  onDone,
}: {
  connection: ChatConnectionsView['teams']
  onDone: () => void
}) {
  const [webhookInput, setWebhookInput] = React.useState('')
  const [notice, setNotice] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [busy, startBusy] = React.useTransition()

  return (
    <div className="space-y-4 text-sm">
      {connection.connected ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2">
          <Badge>connected</Badge>
          <span className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() =>
                startBusy(async () => {
                  setError(null)
                  setNotice(null)
                  const result = await testTeamsWebhookAction()
                  if (!result.ok) setError(result.message)
                  else setNotice('Test message sent — check the channel.')
                })
              }
            >
              Send test message
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() =>
                startBusy(async () => {
                  await removeTeamsWebhookAction()
                  onDone()
                })
              }
            >
              Remove
            </Button>
          </span>
        </div>
      ) : null}

      <ol className="list-decimal space-y-1.5 pl-5 text-xs text-fg-muted">
        <li>
          In the Teams channel an agent should post to, open the channel menu → Connectors (or Workflows on newer
          tenants).
        </li>
        <li>Add an Incoming Webhook, name it after the agent, and copy the URL it gives you.</li>
        <li>Paste it below — saving sends an actual test message so a bad URL is caught immediately.</li>
      </ol>

      <div className="space-y-1">
        <Label htmlFor="teams-webhook-url">Incoming Webhook URL</Label>
        <Input
          id="teams-webhook-url"
          type="password"
          value={webhookInput}
          onChange={(event) => setWebhookInput(event.target.value)}
          placeholder="https://…webhook.office.com/webhookb2/…"
        />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          disabled={busy || !webhookInput.trim()}
          onClick={() =>
            startBusy(async () => {
              setError(null)
              setNotice(null)
              const result = await saveTeamsWebhookAction({ webhookUrl: webhookInput })
              if (!result.ok) {
                setError(result.message)
                return
              }
              setWebhookInput('')
              onDone()
            })
          }
        >
          {busy ? 'Testing…' : 'Verify & connect'}
        </Button>
        {notice ? <p className="text-fg-muted">{notice}</p> : null}
        {error ? <p className="text-danger">{error}</p> : null}
      </div>
    </div>
  )
}

function TeamsInboundForm({
  connection,
  webhookUrl,
  onDone,
}: {
  connection: ChatConnectionsView['teams']
  webhookUrl: string
  onDone: () => void
}) {
  const [securityToken, setSecurityToken] = React.useState('')
  const [msTenantId, setMsTenantId] = React.useState(connection.msTenantId ?? '')
  const [appId, setAppId] = React.useState(connection.appId ?? '')
  const [error, setError] = React.useState<string | null>(null)
  const [busy, startBusy] = React.useTransition()

  return (
    <div className="space-y-4 text-sm">
      {connection.inboundConnected ? (
        <div className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2">
          <Badge>connected</Badge>
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() =>
              startBusy(async () => {
                await removeTeamsInboundAction()
                onDone()
              })
            }
          >
            Remove
          </Button>
        </div>
      ) : null}

      <div className="space-y-1">
        <Label htmlFor="teams-callback-url">Callback URL</Label>
        <Input id="teams-callback-url" readOnly value={webhookUrl} onFocus={(event) => event.target.select()} />
      </div>
      <ol className="list-decimal space-y-1.5 pl-5 text-xs text-fg-muted">
        <li>In the team, open Manage team → Apps → Create an outgoing webhook.</li>
        <li>Name it after the agent, paste the callback URL above, and add a short description and profile picture.</li>
        <li>Teams shows a security token once — paste it below immediately, it is not shown again.</li>
      </ol>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1 sm:col-span-2">
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
          <Input
            id="teams-app-id"
            value={appId}
            onChange={(event) => setAppId(event.target.value)}
            placeholder="Optional, informational"
          />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          disabled={busy || !securityToken.trim()}
          onClick={() =>
            startBusy(async () => {
              setError(null)
              const result = await saveTeamsInboundAction({ securityToken, msTenantId, appId })
              if (!result.ok) {
                setError(result.message)
                return
              }
              setSecurityToken('')
              onDone()
            })
          }
        >
          {busy ? 'Saving…' : 'Save'}
        </Button>
        {error ? <p className="text-danger">{error}</p> : null}
      </div>
    </div>
  )
}

// --- Channel routing ----------------------------------------------------------

/** Routes are short-lived mappings: one row, one channel, one agent. */
const ROUTE_COLUMNS: PagedColumn<ChatChannelRouteRowView>[] = [
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
]

type RouteDraft = {
  id?: string
  provider: 'slack' | 'teams'
  channelId: string
  channelLabel: string
  personId: string
}

function RoutingSection({ routes, agents }: { routes: ChatChannelRouteRowView[]; agents: ChatAgentOption[] }) {
  const [draft, setDraft] = React.useState<RouteDraft | null>(null)

  const newDraft = (): RouteDraft => ({
    provider: 'slack',
    channelId: '',
    channelLabel: '',
    personId: agents[0]?.id ?? '',
  })

  return (
    <SettingsSection
      title="Channel routing"
      description="Which agent answers which channel or direct message. A route with channel ID * is the default agent — it answers any mention or DM that has no specific mapping, so a message never goes unanswered."
    >
      <SettingsRow
        title="Routed channels"
        description="Open a route to change who answers it, or remove it."
        control={
          <Button size="sm" disabled={agents.length === 0} onClick={() => setDraft(newDraft())}>
            Add route
          </Button>
        }
      />
      <div className="px-5 py-4">
        <PagedTable
          columns={ROUTE_COLUMNS}
          rows={routes}
          rowKey={(row) => row.id}
          pageSize={10}
          searchable
          defaultSort={{ key: 'channel', dir: 'asc' }}
          onRowClick={(row) =>
            setDraft({
              id: row.id,
              provider: row.provider,
              channelId: row.channelId,
              channelLabel: row.channelLabel ?? '',
              personId: row.personId,
            })
          }
          labels={{ searchPlaceholder: 'Search routes…', searchLabel: 'Search routes' }}
          empty={
            <EmptyState
              title="No channels routed yet"
              description="Map a channel to an agent, or add a * route so a single default agent answers anything unmapped."
              {...(agents.length > 0 ? { action: <Button onClick={() => setDraft(newDraft())}>Add route</Button> } : {})}
            />
          }
        />
      </div>

      <Drawer
        open={draft !== null}
        onClose={() => setDraft(null)}
        title={draft?.id ? 'Channel route' : 'Add a route'}
        description="One channel, one agent. A channel already routed is updated in place rather than duplicated."
        size="md"
      >
        {draft ? <RouteForm draft={draft} agents={agents} onDone={() => setDraft(null)} /> : null}
      </Drawer>
    </SettingsSection>
  )
}

function RouteForm({
  draft,
  agents,
  onDone,
}: {
  draft: RouteDraft
  agents: ChatAgentOption[]
  onDone: () => void
}) {
  const [provider, setProvider] = React.useState<'slack' | 'teams'>(draft.provider)
  const [channelId, setChannelId] = React.useState(draft.channelId)
  const [channelLabel, setChannelLabel] = React.useState(draft.channelLabel)
  const [personId, setPersonId] = React.useState(draft.personId)
  const [error, setError] = React.useState<string | null>(null)
  const [busy, startBusy] = React.useTransition()
  const editing = draft.id !== undefined

  return (
    <div className="space-y-4 text-sm">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="route-provider">Provider</Label>
          <Select
            id="route-provider"
            value={provider}
            disabled={editing}
            onChange={(event) => setProvider(event.target.value as 'slack' | 'teams')}
          >
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
          <Input
            id="route-channel"
            value={channelId}
            disabled={editing}
            onChange={(event) => setChannelId(event.target.value)}
            placeholder="C0123ABC, or * for default"
          />
          {editing ? (
            <p className="text-xs text-fg-muted">
              The channel is fixed. Remove this route and add another to point a different channel at an agent.
            </p>
          ) : null}
        </div>
        <div className="space-y-1">
          <Label htmlFor="route-label">Label (optional)</Label>
          <Input
            id="route-label"
            value={channelLabel}
            onChange={(event) => setChannelLabel(event.target.value)}
            placeholder="#support"
          />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          disabled={busy || !channelId.trim() || !personId}
          onClick={() =>
            startBusy(async () => {
              setError(null)
              const result = await saveChatChannelRouteAction({ provider, channelId, channelLabel, personId })
              if (!result.ok) {
                setError(result.message)
                return
              }
              onDone()
            })
          }
        >
          {busy ? 'Saving…' : editing ? 'Save route' : 'Add route'}
        </Button>
        {draft.id ? (
          <Button
            variant="destructive"
            disabled={busy}
            onClick={() =>
              startBusy(async () => {
                await removeChatChannelRouteAction(draft.id!)
                onDone()
              })
            }
          >
            Remove
          </Button>
        ) : null}
        {error ? <p className="text-danger">{error}</p> : null}
      </div>
    </div>
  )
}
