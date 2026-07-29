import 'server-only'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { sealSecret, unsealSecret } from '@appkit/crypto'
import { defineAbility, type Ability, type RunOutcome } from '@bunkhouse/runtime'
import { people, tenantSettings, CHAT_INTEGRATIONS_KEY, type ChatIntegrationSettings } from '../db/schema'
import { chatChannelRoutes, chatInboundEvents } from '../db/schema/chat'
import { db } from '../db/client'
import { executeAgentRun } from './agent-runs'
import { assertPublicHost } from './research'
import { appOrigin } from './app-origin'

/**
 * The Slack / Microsoft Teams bridge. Product doctrine #1: mail is the
 * primary surface, chat is secondary — so this file never invents a parallel
 * work system. Every inbound message becomes exactly the same kind of run
 * `executeAgentRun` already produces for mail (trigger `{ type: 'chat' }`,
 * input `{ type: 'chat' }` — both already modeled in db/schema/work.ts and
 * packages/runtime/src/types.ts); the reply is just the run's own outcome
 * summary, posted back where the message came from.
 *
 * Two capabilities per provider:
 * - Slack: full inbound (Events API) + outbound (chat.postMessage). Real
 *   two-way parity with a Slack DM or channel.
 * - Microsoft Teams: full outbound (an Incoming Webhook connector). Inbound
 *   is optional and, when configured, uses Teams' lightweight **Outgoing
 *   Webhook** mechanism — a bot mention in a channel POSTs an activity to us
 *   and expects the reply activity back in the same HTTP response. This
 *   needs no Azure Bot Service registration, unlike full Bot Framework
 *   conversations. The honest limits, said plainly (also surfaced in the UI):
 *   no DMs, no proactive messages, and a slow agent run can outrun the ~5s
 *   window Teams waits before it shows the user its own timeout message
 *   (the run still finishes; the reply just never reaches the channel).
 *   Genuine bidirectional Teams parity with Slack would need an Azure Bot
 *   Service registration and the Bot Framework Connector API — not built here.
 */

// --- Tenant settings ---------------------------------------------------------

async function readChatSettings(tenantId: string): Promise<ChatIntegrationSettings> {
  const app = db()
  const [row] = await app.db
    .select({ value: tenantSettings.value })
    .from(tenantSettings)
    .where(and(eq(tenantSettings.tenantId, tenantId), eq(tenantSettings.key, CHAT_INTEGRATIONS_KEY)))
  return (row?.value as ChatIntegrationSettings | undefined) ?? {}
}

async function writeChatSettings(tenantId: string, value: ChatIntegrationSettings): Promise<void> {
  const app = db()
  await app.db
    .insert(tenantSettings)
    .values({ tenantId, key: CHAT_INTEGRATIONS_KEY, value })
    .onConflictDoUpdate({
      target: [tenantSettings.tenantId, tenantSettings.key],
      set: { value, updatedAt: new Date() },
    })
}

/** Every tenant with any chat configuration — used only to resolve an
 *  inbound webhook to its tenant (see resolveSlackTenant/resolveTeamsTenant).
 *  Bypasses RLS deliberately: the request has no tenant context yet. */
async function candidateChatSettings(): Promise<{ tenantId: string; settings: ChatIntegrationSettings }[]> {
  const app = db()
  const rows = await app.withSuperAdmin((superDb) =>
    superDb
      .select({ tenantId: tenantSettings.tenantId, value: tenantSettings.value })
      .from(tenantSettings)
      .where(eq(tenantSettings.key, CHAT_INTEGRATIONS_KEY)),
  )
  return rows.map((r) => ({ tenantId: r.tenantId, settings: (r.value as ChatIntegrationSettings | null) ?? {} }))
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Whether a provider is usable for outbound sends right now. */
export async function chatConfigured(tenantId: string, provider: 'slack' | 'teams'): Promise<boolean> {
  const app = db()
  const settings = await app.withTenantContext(tenantId, () => readChatSettings(tenantId))
  if (provider === 'slack') return Boolean(settings.slack)
  return Boolean(settings.teams?.sealedWebhookUrl)
}

export type ChatConnectionView = {
  slack: { connected: boolean; teamName: string | null }
  teams: { connected: boolean; inboundConnected: boolean; msTenantId: string | null; appId: string | null }
}

/** What Settings renders: connection state, never a secret. */
export async function listChatConnections(tenantId: string): Promise<ChatConnectionView> {
  const app = db()
  const settings = await app.withTenantContext(tenantId, () => readChatSettings(tenantId))
  return {
    slack: { connected: Boolean(settings.slack), teamName: settings.slack?.teamName ?? null },
    teams: {
      connected: Boolean(settings.teams?.sealedWebhookUrl),
      inboundConnected: Boolean(settings.teams?.sealedSecurityToken),
      msTenantId: settings.teams?.msTenantId ?? null,
      appId: settings.teams?.appId ?? null,
    },
  }
}

/**
 * The two webhook URLs an operator pastes into Slack's / Teams' own app config.
 * Derived from the request being served — see `appOrigin` — so what is on
 * screen is genuinely the address those services will reach.
 */
export async function chatWebhookUrls(): Promise<{ slack: string; teams: string }> {
  const origin = await appOrigin()
  return { slack: `${origin}/api/chat/slack`, teams: `${origin}/api/chat/teams` }
}

const OUTBOUND_TIMEOUT_MS = 15_000

// --- Slack: connect + send ---------------------------------------------------

async function slackAuthTest(botToken: string): Promise<{ team: string; teamId: string }> {
  const url = new URL('https://slack.com/api/auth.test')
  await assertPublicHost(url)
  const response = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${botToken}`, 'content-type': 'application/x-www-form-urlencoded' },
    signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS),
  })
  const payload = (await response.json()) as { ok: boolean; team?: string; team_id?: string; error?: string }
  if (!payload.ok || !payload.team_id) throw new Error(`Slack rejected the token: ${payload.error ?? 'unknown error'}`)
  return { team: payload.team ?? 'Slack workspace', teamId: payload.team_id }
}

/** Connect (or replace) the tenant's Slack app. Verifies the bot token against
 *  Slack's own `auth.test` before anything is persisted. */
export async function saveSlackConnection(input: {
  tenantId: string
  botToken: string
  signingSecret: string
}): Promise<{ ok: true; teamName: string } | { ok: false; message: string }> {
  const botToken = input.botToken.trim()
  const signingSecret = input.signingSecret.trim()
  if (!botToken) return { ok: false, message: 'Paste the bot token from the Slack app’s OAuth & Permissions page.' }
  if (!signingSecret) return { ok: false, message: 'Paste the signing secret from the Slack app’s Basic Information page.' }
  let identity: { team: string; teamId: string }
  try {
    identity = await slackAuthTest(botToken)
  } catch (error) {
    return { ok: false, message: messageOf(error) }
  }
  const app = db()
  await app.withTenant(input.tenantId, async () => {
    const current = await readChatSettings(input.tenantId)
    await writeChatSettings(input.tenantId, {
      ...current,
      slack: {
        teamId: identity.teamId,
        teamName: identity.team,
        sealedBotToken: sealSecret(botToken),
        sealedSigningSecret: sealSecret(signingSecret),
      },
    })
  })
  return { ok: true, teamName: identity.team }
}

export async function removeSlackConnection(tenantId: string): Promise<void> {
  const app = db()
  await app.withTenant(tenantId, async () => {
    const current = await readChatSettings(tenantId)
    const next = { ...current }
    delete next.slack
    await writeChatSettings(tenantId, next)
  })
}

/** Re-verify the stored token still works — the Settings "test connection" action. */
export async function testSlackConnection(tenantId: string): Promise<{ ok: true; teamName: string } | { ok: false; message: string }> {
  const app = db()
  const settings = await app.withTenantContext(tenantId, () => readChatSettings(tenantId))
  if (!settings.slack) return { ok: false, message: 'Slack is not connected.' }
  const token = unsealSecret(settings.slack.sealedBotToken)
  if (!token) return { ok: false, message: 'The stored token cannot be unsealed (APPKIT_SECRET changed?). Reconnect Slack.' }
  try {
    const identity = await slackAuthTest(token)
    return { ok: true, teamName: identity.team }
  } catch (error) {
    return { ok: false, message: messageOf(error) }
  }
}

/** Post (or reply, with `threadTs`) into a Slack channel. */
export async function postSlackMessage(args: {
  tenantId: string
  channel: string
  text: string
  threadTs?: string
}): Promise<{ ts: string }> {
  const app = db()
  const settings = await app.withTenantContext(args.tenantId, () => readChatSettings(args.tenantId))
  if (!settings.slack) throw new Error('Slack is not connected. Add it in Settings → Chat.')
  const token = unsealSecret(settings.slack.sealedBotToken)
  if (!token) throw new Error('Slack’s stored token cannot be unsealed (APPKIT_SECRET changed?). Reconnect Slack in Settings → Chat.')
  const url = new URL('https://slack.com/api/chat.postMessage')
  await assertPublicHost(url)
  const response = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ channel: args.channel, text: args.text, ...(args.threadTs ? { thread_ts: args.threadTs } : {}) }),
    signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS),
  })
  const payload = (await response.json()) as { ok: boolean; ts?: string; error?: string }
  if (!payload.ok || !payload.ts) throw new Error(`Slack refused the message: ${payload.error ?? 'unknown error'}`)
  return { ts: payload.ts }
}

// --- Slack: inbound signature verification -----------------------------------

const SLACK_TIMESTAMP_WINDOW_SECONDS = 5 * 60

function timingSafeStringsEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

function verifySlackSignature(signingSecret: string, rawBody: string, timestamp: string, signature: string): boolean {
  const seconds = Number(timestamp)
  if (!Number.isFinite(seconds) || Math.abs(Date.now() / 1000 - seconds) > SLACK_TIMESTAMP_WINDOW_SECONDS) return false
  const expected = `v0=${createHmac('sha256', signingSecret).update(`v0:${timestamp}:${rawBody}`).digest('hex')}`
  return timingSafeStringsEqual(expected, signature)
}

/**
 * Slack signs every request — including the one-time URL-verification
 * handshake — with the app's own signing secret, but nothing in the payload
 * reliably names a tenant ahead of time (the handshake call has no team id
 * at all). With a modest number of connected workspaces, trying each
 * tenant's own sealed signing secret against the HMAC is the correct,
 * simple resolution: a wrong guess proves nothing and costs nothing — the
 * signature is still the only thing that ever grants a match.
 */
export async function resolveSlackTenant(rawBody: string, timestamp: string, signature: string): Promise<string | null> {
  for (const { tenantId, settings } of await candidateChatSettings()) {
    if (!settings.slack) continue
    const secret = unsealSecret(settings.slack.sealedSigningSecret)
    if (!secret) continue
    if (verifySlackSignature(secret, rawBody, timestamp, signature)) return tenantId
  }
  return null
}

// --- Microsoft Teams: outbound (Incoming Webhook) ----------------------------

async function postTeamsWebhook(url: URL, text: string): Promise<void> {
  await assertPublicHost(url)
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS),
  })
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`Teams refused the message (HTTP ${response.status})${body ? `: ${body.slice(0, 200)}` : ''}.`)
  }
}

/** Connect (or replace) the tenant's Teams Incoming Webhook. The URL is
 *  proved to work — an actual test card is posted — before it is persisted. */
export async function saveTeamsWebhook(input: {
  tenantId: string
  webhookUrl: string
}): Promise<{ ok: true } | { ok: false; message: string }> {
  const raw = input.webhookUrl.trim()
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, message: 'That is not a valid URL.' }
  }
  if (url.protocol !== 'https:') return { ok: false, message: 'The webhook URL must be HTTPS.' }
  try {
    await postTeamsWebhook(url, 'Bunkhouse is connected — your agents will post to this channel through this webhook.')
  } catch (error) {
    return { ok: false, message: messageOf(error) }
  }
  const app = db()
  await app.withTenant(input.tenantId, async () => {
    const current = await readChatSettings(input.tenantId)
    await writeChatSettings(input.tenantId, { ...current, teams: { ...current.teams, sealedWebhookUrl: sealSecret(raw) } })
  })
  return { ok: true }
}

export async function removeTeamsWebhook(tenantId: string): Promise<void> {
  const app = db()
  await app.withTenant(tenantId, async () => {
    const current = await readChatSettings(tenantId)
    if (!current.teams) return
    const teams = { ...current.teams }
    delete teams.sealedWebhookUrl
    const next = { ...current }
    if (teams.sealedSecurityToken || teams.msTenantId || teams.appId) next.teams = teams
    else delete next.teams
    await writeChatSettings(tenantId, next)
  })
}

/** Post a real message through the tenant's Teams webhook — the Settings
 *  "send test message" action, and the path `chatAbilities`' `send_chat_message`
 *  and any other caller sends through. */
export async function postTeamsMessage(args: { tenantId: string; text: string }): Promise<void> {
  const app = db()
  const settings = await app.withTenantContext(args.tenantId, () => readChatSettings(args.tenantId))
  const sealed = settings.teams?.sealedWebhookUrl
  if (!sealed) throw new Error('Microsoft Teams is not connected. Add the incoming webhook URL in Settings → Chat.')
  const raw = unsealSecret(sealed)
  if (!raw) throw new Error('The stored Teams webhook cannot be unsealed (APPKIT_SECRET changed?). Reconnect it in Settings → Chat.')
  await postTeamsWebhook(new URL(raw), args.text)
}

export async function testTeamsWebhook(tenantId: string): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    await postTeamsMessage({ tenantId, text: 'Bunkhouse connection test — everything is working.' })
    return { ok: true }
  } catch (error) {
    return { ok: false, message: messageOf(error) }
  }
}

// --- Microsoft Teams: inbound (Outgoing Webhook, optional) -------------------

/** Connect the optional inbound bridge: Teams' Outgoing Webhook HMAC secret. */
export async function saveTeamsInbound(input: {
  tenantId: string
  securityToken: string
  msTenantId?: string
  appId?: string
}): Promise<{ ok: true } | { ok: false; message: string }> {
  const token = input.securityToken.trim()
  if (!token) return { ok: false, message: 'Paste the security token Teams generated when you created the outgoing webhook.' }
  if (!/^[A-Za-z0-9+/]+=*$/.test(token)) return { ok: false, message: 'That does not look like a base64 security token.' }
  const app = db()
  await app.withTenant(input.tenantId, async () => {
    const current = await readChatSettings(input.tenantId)
    await writeChatSettings(input.tenantId, {
      ...current,
      teams: {
        ...current.teams,
        sealedSecurityToken: sealSecret(token),
        ...(input.msTenantId?.trim() ? { msTenantId: input.msTenantId.trim() } : {}),
        ...(input.appId?.trim() ? { appId: input.appId.trim() } : {}),
      },
    })
  })
  return { ok: true }
}

export async function removeTeamsInbound(tenantId: string): Promise<void> {
  const app = db()
  await app.withTenant(tenantId, async () => {
    const current = await readChatSettings(tenantId)
    if (!current.teams) return
    const teams = { ...current.teams }
    delete teams.sealedSecurityToken
    delete teams.msTenantId
    delete teams.appId
    const next = { ...current }
    if (teams.sealedWebhookUrl) next.teams = teams
    else delete next.teams
    await writeChatSettings(tenantId, next)
  })
}

/**
 * Teams' Outgoing Webhook HMAC: `Authorization: HMAC <base64>`, where the
 * base64 value is HMAC-SHA256 of the exact request body, keyed by the
 * base64-decoded security token. Same try-each-tenant resolution as Slack,
 * for the same reason: nothing in the activity reliably names a tenant
 * before the signature is checked.
 */
export async function resolveTeamsTenant(rawBody: string, authorizationHeader: string | null): Promise<string | null> {
  if (!authorizationHeader) return null
  const match = /^HMAC\s+(.+)$/i.exec(authorizationHeader.trim())
  if (!match) return null
  const provided = match[1]!.trim()
  for (const { tenantId, settings } of await candidateChatSettings()) {
    const sealed = settings.teams?.sealedSecurityToken
    if (!sealed) continue
    const tokenB64 = unsealSecret(sealed)
    if (!tokenB64) continue
    let key: Buffer
    try {
      key = Buffer.from(tokenB64, 'base64')
    } catch {
      continue
    }
    const expected = createHmac('sha256', key).update(Buffer.from(rawBody, 'utf8')).digest('base64')
    if (timingSafeStringsEqual(expected, provided)) return tenantId
  }
  return null
}

// --- Channel → agent routing --------------------------------------------------

export type ChatChannelRouteView = {
  id: string
  provider: 'slack' | 'teams'
  channelId: string
  channelLabel: string | null
  personId: string
  personName: string
}

export async function listChatChannelRoutes(tenantId: string): Promise<ChatChannelRouteView[]> {
  const app = db()
  return app.withTenantContext(tenantId, async () =>
    app.db
      .select({
        id: chatChannelRoutes.id,
        provider: chatChannelRoutes.provider,
        channelId: chatChannelRoutes.channelId,
        channelLabel: chatChannelRoutes.channelLabel,
        personId: chatChannelRoutes.personId,
        personName: people.name,
      })
      .from(chatChannelRoutes)
      .innerJoin(people, eq(people.id, chatChannelRoutes.personId))
      .orderBy(chatChannelRoutes.provider, chatChannelRoutes.channelId),
  )
}

/** Add or replace a channel's route. `channelId: '*'` is the default-agent
 *  sentinel — it answers anything with no specific mapping. */
export async function saveChatChannelRoute(args: {
  tenantId: string
  provider: 'slack' | 'teams'
  channelId: string
  channelLabel?: string
  personId: string
}): Promise<{ ok: true } | { ok: false; message: string }> {
  const channelId = args.channelId.trim()
  if (!channelId) return { ok: false, message: 'Enter a channel ID, or "*" for the default agent.' }
  const app = db()
  return app.withTenant(args.tenantId, async () => {
    const [agent] = await app.db
      .select({ id: people.id })
      .from(people)
      .where(and(eq(people.id, args.personId), eq(people.kind, 'agent'), eq(people.status, 'active')))
    if (!agent) return { ok: false as const, message: 'Pick an active agent to answer this channel.' }
    await app.db
      .insert(chatChannelRoutes)
      .values({
        tenantId: args.tenantId,
        provider: args.provider,
        channelId,
        channelLabel: args.channelLabel?.trim() || null,
        personId: args.personId,
      })
      .onConflictDoUpdate({
        target: [chatChannelRoutes.tenantId, chatChannelRoutes.provider, chatChannelRoutes.channelId],
        set: { channelLabel: args.channelLabel?.trim() || null, personId: args.personId, updatedAt: new Date() },
      })
    return { ok: true as const }
  })
}

export async function removeChatChannelRoute(tenantId: string, routeId: string): Promise<void> {
  const app = db()
  await app.withTenant(tenantId, async () => {
    await app.db.delete(chatChannelRoutes).where(eq(chatChannelRoutes.id, routeId))
  })
}

/** The route's agent for a channel, falling back to the tenant's default
 *  (`channelId: '*'`) agent when nothing specific is configured. */
async function resolveRouteAgent(tenantId: string, provider: 'slack' | 'teams', channelId: string): Promise<string | null> {
  const app = db()
  return app.withTenantContext(tenantId, async () => {
    const [specific] = await app.db
      .select({ personId: chatChannelRoutes.personId })
      .from(chatChannelRoutes)
      .where(and(eq(chatChannelRoutes.provider, provider), eq(chatChannelRoutes.channelId, channelId)))
    if (specific) return specific.personId
    const [fallback] = await app.db
      .select({ personId: chatChannelRoutes.personId })
      .from(chatChannelRoutes)
      .where(and(eq(chatChannelRoutes.provider, provider), eq(chatChannelRoutes.channelId, '*')))
    return fallback?.personId ?? null
  })
}

/** Claims an inbound event id for one tenant; false means it was already
 *  claimed (a retry) and must not start a second run. */
async function claimInboundEvent(tenantId: string, provider: 'slack' | 'teams', eventId: string): Promise<boolean> {
  const app = db()
  return app.withTenant(tenantId, async () => {
    const [row] = await app.db
      .insert(chatInboundEvents)
      .values({ tenantId, provider, eventId })
      .onConflictDoNothing({ target: [chatInboundEvents.tenantId, chatInboundEvents.provider, chatInboundEvents.eventId] })
      .returning({ id: chatInboundEvents.id })
    return Boolean(row)
  })
}

function replyTextForOutcome(outcome: RunOutcome): string {
  switch (outcome.status) {
    case 'completed':
      return outcome.summary
    case 'waiting_approval':
      return "I need a colleague's sign-off before I can act on that — I'll follow up here once it's decided."
    case 'waiting_reply':
      return `I'm waiting to hear back from ${outcome.wait.to} before I can finish this — I'll follow up here.`
    case 'budget_paused':
      return "I've reached my token budget for this month, so I can't take this on right now — please flag it to an operator."
    case 'failed':
      return `I ran into a problem and couldn't finish that: ${outcome.error}`
  }
}

const NO_ROUTE_TEXT = 'No agent is set up to answer this channel yet — ask an operator to add one under Settings → Chat.'

// --- Inbound: Slack Events API ------------------------------------------------

export type SlackEventEnvelope = {
  type: string
  event_id?: string
  challenge?: string
  event?: {
    type: string
    subtype?: string
    channel: string
    user?: string
    bot_id?: string
    text?: string
    ts: string
    thread_ts?: string
  }
}

const SLACK_BOT_MENTION_RE = /^<@[^>]+>\s*/

/**
 * Handle one verified Slack event: dedupe, resolve the agent, run it exactly
 * like an inbound email would, and post the reply back into the same thread.
 * Never throws — by the time this runs, Slack has already been acknowledged
 * and there is no retry path left to use, so a failure only ever reaches the
 * server log.
 */
export async function handleSlackEvent(tenantId: string, envelope: SlackEventEnvelope): Promise<void> {
  try {
    const event = envelope.event
    if (!event || (event.type !== 'message' && event.type !== 'app_mention')) return
    if (event.bot_id || event.subtype === 'bot_message' || !event.user) return
    const eventId = envelope.event_id
    if (!eventId) return
    if (!(await claimInboundEvent(tenantId, 'slack', eventId))) return

    const threadTs = event.thread_ts ?? event.ts
    const personId = await resolveRouteAgent(tenantId, 'slack', event.channel)
    if (!personId) {
      await postSlackMessage({ tenantId, channel: event.channel, threadTs, text: NO_ROUTE_TEXT }).catch((error) =>
        console.error('[chat-bridge] slack no-route reply failed', error),
      )
      return
    }
    const message = (event.text ?? '').replace(SLACK_BOT_MENTION_RE, '').trim() || '(empty message)'
    const { outcome } = await executeAgentRun({
      tenantId,
      personId,
      trigger: { type: 'chat', conversationId: `slack:${event.channel}:${threadTs}` },
      input: { type: 'chat', message },
    })
    await postSlackMessage({ tenantId, channel: event.channel, threadTs, text: replyTextForOutcome(outcome) })
  } catch (error) {
    console.error('[chat-bridge] slack event handling failed', error)
  }
}

// --- Inbound: Microsoft Teams Outgoing Webhook (optional) --------------------

export type TeamsActivity = {
  type: string
  id: string
  text?: string
  conversation?: { id: string }
  channelData?: { teamsChannelId?: string; teamsTeamId?: string; tenant?: { id: string } }
}

export type TeamsWebhookReply = { type: 'message'; text: string }

const TEAMS_MENTION_RE = /<at>[\s\S]*?<\/at>/g

/**
 * Handle one verified Teams Outgoing Webhook activity. Unlike Slack, the
 * reply is not posted out-of-band — Teams expects the reply activity back in
 * the same HTTP response, so the caller (the route handler) must await this
 * rather than fire-and-forget it. That is the mechanism's real limit: a slow
 * agent run can outrun the ~5s window Teams waits, in which case the user
 * sees Teams' own timeout notice even though the run finishes normally.
 */
export async function handleTeamsActivity(tenantId: string, activity: TeamsActivity): Promise<TeamsWebhookReply | null> {
  try {
    if (activity.type !== 'message' || !activity.id) return null
    if (!(await claimInboundEvent(tenantId, 'teams', activity.id))) return null

    const channelId = activity.channelData?.teamsChannelId ?? activity.conversation?.id ?? '*'
    const personId = await resolveRouteAgent(tenantId, 'teams', channelId)
    if (!personId) return { type: 'message', text: NO_ROUTE_TEXT }

    const message = (activity.text ?? '').replace(TEAMS_MENTION_RE, '').trim() || '(empty message)'
    const conversationId = `teams:${channelId}:${activity.conversation?.id ?? activity.id}`
    const { outcome } = await executeAgentRun({
      tenantId,
      personId,
      trigger: { type: 'chat', conversationId },
      input: { type: 'chat', message },
    })
    return { type: 'message', text: replyTextForOutcome(outcome) }
  } catch (error) {
    console.error('[chat-bridge] teams activity handling failed', error)
    return { type: 'message', text: 'Something went wrong handling that message — please try again.' }
  }
}

// --- Outbound ability ---------------------------------------------------------

/**
 * `send_chat_message` — internal company comms, present only once a provider
 * is connected. Governed as `internal_email` (the runtime's closest category
 * to "talk to the company", same as `email_colleague`).
 */
export async function chatAbilities(args: { tenantId: string; person: { id: string }; runId: string }): Promise<Ability[]> {
  const { tenantId } = args
  const [slackOn, teamsOn] = await Promise.all([chatConfigured(tenantId, 'slack'), chatConfigured(tenantId, 'teams')])
  if (!slackOn && !teamsOn) return []
  return [
    defineAbility({
      name: 'send_chat_message',
      description:
        'Post a message into a connected Slack or Microsoft Teams channel — internal company comms, not a customer-facing reply. Give a Slack channel (e.g. #ops or a channel ID) to post there; omit it to post to Microsoft Teams, which always posts to the one channel its webhook was set up for.',
      category: 'internal_email',
      inputSchema: z.object({
        channel: z
          .string()
          .optional()
          .describe('Slack channel name (e.g. #ops) or ID. Required to post to Slack; ignored for Teams.'),
        message: z.string().describe('The message text.'),
      }),
      execute: async ({ channel, message }) => {
        if (channel) {
          if (!slackOn) {
            return { sent: false, reason: 'Slack is not connected — connect it in Settings → Chat, or omit the channel to post to Teams.' }
          }
          const posted = await postSlackMessage({ tenantId, channel, text: message })
          return { sent: true, provider: 'slack' as const, channel, ts: posted.ts }
        }
        if (teamsOn) {
          await postTeamsMessage({ tenantId, text: message })
          return { sent: true, provider: 'teams' as const }
        }
        if (slackOn) return { sent: false, reason: 'Connected to Slack — include a channel (e.g. #ops) to send there.' }
        return { sent: false, reason: 'No chat integration is connected.' }
      },
    }),
  ]
}
