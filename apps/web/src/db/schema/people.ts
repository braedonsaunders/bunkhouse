import { sql } from 'drizzle-orm'
import { date, foreignKey, index, jsonb, pgEnum, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { auditColumns, id, tenantRef } from '@appkit/db'
import type { AgentVoiceConfig } from '@appkit/voice'

/**
 * The mixed directory: real human employees and AI hands live in one table so
 * the org chart, routing ("ask the ops manager"), and escalation are uniform.
 * Humans may link to an authenticated user; hands never do.
 */
export const personKind = pgEnum('person_kind', ['human', 'hand'])
export const personStatus = pgEnum('person_status', ['onboarding', 'active', 'offboarded'])

/** How a hand initiates work. Reactive hands only answer; job-description hands
 *  also run their duties; autonomous hands may self-initiate within role scope. */
export const proactivityMode = pgEnum('proactivity_mode', ['reactive', 'duties', 'autonomous'])

/** Who may put a hand to work by emailing it. staff_only = only directory
 *  members; known_contacts = staff plus prior counterparties on this mailbox;
 *  anyone = open inbound (customer service, collections). Enforced by the
 *  worker before a run ever starts — external mail is service input, not
 *  instructions, regardless of this gate. */
export const inboundPolicy = pgEnum('inbound_policy', ['staff_only', 'known_contacts', 'anyone'])

export type HandPersonality = {
  /** Short first-person self-description used in the system prompt and profile. */
  bio: string
  /** Tone descriptors, e.g. ['warm', 'concise', 'plain-spoken']. */
  tone: string[]
  /** Sign-off used in outbound mail, e.g. 'Best, Dana'. */
  signoff: string
}

export type HandModelConfig = {
  /** Provider key registered with the runtime, e.g. 'anthropic', 'openai-compatible'. */
  provider: string
  model: string
  /** Provider base URL override for openai-compatible/self-hosted gateways. */
  baseUrl?: string
  temperature?: number
  maxOutputTokens?: number
}

export type HandSalary = {
  /** Monthly token budget in USD. The whole salary metaphor keys off this. */
  monthlyUsd: number
  /** What happens at 100% of budget: stop working, keep working (overtime), or ask a human. */
  overagePolicy: 'pause' | 'overtime' | 'ask'
}

export const people = pgTable(
  'people',
  {
    id: id(),
    tenantId: tenantRef(),
    kind: personKind('kind').notNull(),
    status: personStatus('status').notNull().default('onboarding'),
    name: text('name').notNull(),
    title: text('title').notNull(),
    email: text('email').notNull(),
    phone: text('phone'),
    timezone: text('timezone'),
    /** Plain-language description of what this person owns; hands use it to route work. */
    responsibilities: text('responsibilities'),
    reportsToId: uuid('reports_to_id'),
    /** Humans only: link to the authenticated user, when they have a login. */
    userId: uuid('user_id'),
    avatarFileId: uuid('avatar_file_id'),
    /** Hands only ------------------------------------------------------- */
    rolePackSlug: text('role_pack_slug'),
    personality: jsonb('personality').$type<HandPersonality>(),
    modelConfig: jsonb('model_config').$type<HandModelConfig>(),
    salary: jsonb('salary').$type<HandSalary>(),
    /** How this hand sounds on a call — null until voice is configured. */
    voiceConfig: jsonb('voice_config').$type<AgentVoiceConfig>(),
    proactivity: proactivityMode('proactivity').default('duties'),
    inboundPolicy: inboundPolicy('inbound_policy').default('staff_only'),
    startedOn: date('started_on'),
    endedOn: date('ended_on'),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex('people_tenant_email_key').on(t.tenantId, sql`lower(${t.email})`),
    index('people_tenant_kind_idx').on(t.tenantId, t.kind),
    foreignKey({ columns: [t.reportsToId], foreignColumns: [t.id], name: 'people_reports_to_fk' }),
  ],
)

export const PEOPLE_TENANT_TABLES = ['people'] as const
