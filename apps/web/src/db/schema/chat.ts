import { index, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { id, tenantRef } from '@braedonsaunders/appkit-db'

/**
 * The Slack / Microsoft Teams bridge. Chat is a secondary surface (doctrine
 * #1 — mail is primary, chat bridges reach the same runs/run_events ledger
 * mail does). These two tables are the bridge-specific state mail never
 * needed: which agent answers which channel, and a dedupe ledger so a
 * retried inbound delivery never starts two runs. Tenant configuration
 * (credentials) lives in `tenant_settings` under 'integrations.chat', not
 * here — see lib/chat-bridge.ts.
 */
export const chatProvider = pgEnum('chat_provider', ['slack', 'teams'])

/**
 * Channel (or DM) → agent routing, operator-configured. `channelId: '*'` is
 * the sentinel for "default agent": it answers an inbound message from any
 * channel or direct message that has no specific mapping, so a bare mention
 * or DM still reaches somebody instead of being silently dropped.
 */
export const chatChannelRoutes = pgTable(
  'chat_channel_routes',
  {
    id: id(),
    tenantId: tenantRef(),
    provider: chatProvider('provider').notNull(),
    /** Slack channel id (e.g. C0123…) or the Teams channel/conversation id. */
    channelId: text('channel_id').notNull(),
    /** Display label captured at save time — channels don't rename themselves here. */
    channelLabel: text('channel_label'),
    personId: uuid('person_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('chat_channel_routes_key').on(t.tenantId, t.provider, t.channelId),
    index('chat_channel_routes_person_idx').on(t.tenantId, t.personId),
  ],
)

/**
 * Inbound-event dedupe. Slack retries aggressively on any non-2xx or slow
 * response, replaying the same top-level `event_id`; Teams' Outgoing Webhook
 * activity carries its own stable `id` for the same purpose. Insert-first-
 * wins (`onConflictDoNothing`): a duplicate delivery finds its row already
 * there and is dropped before it ever reaches `executeAgentRun`, so one
 * retry never starts two runs.
 */
export const chatInboundEvents = pgTable(
  'chat_inbound_events',
  {
    id: id(),
    tenantId: tenantRef(),
    provider: chatProvider('provider').notNull(),
    eventId: text('event_id').notNull(),
    personId: uuid('person_id'),
    runId: uuid('run_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('chat_inbound_events_key').on(t.tenantId, t.provider, t.eventId)],
)

export const CHAT_TENANT_TABLES = ['chat_channel_routes', 'chat_inbound_events'] as const
