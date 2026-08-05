import { sql } from 'drizzle-orm'
import { check, date, foreignKey, index, integer, jsonb, pgEnum, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { auditColumns, id, tenantRef, users } from '@appkit/db'
import type { AgentVoiceConfig } from '@appkit/voice'

/**
 * The mixed directory: real human employees and AI agents live in one table so
 * the org chart, routing ("ask the ops manager"), and escalation are uniform.
 * Humans may link to an authenticated user; agents never do.
 */
export const personKind = pgEnum('person_kind', ['human', 'agent'])
export const personStatus = pgEnum('person_status', ['onboarding', 'active', 'offboarded'])

/** How an agent initiates work. Reactive agents only answer; job-description agents
 *  also run their duties; autonomous agents may self-initiate within role scope. */
export const proactivityMode = pgEnum('proactivity_mode', ['reactive', 'duties', 'autonomous'])

/** Who may put an agent to work by emailing it. staff_only = only directory
 *  members; known_contacts = staff plus prior counterparties on this mailbox;
 *  anyone = open inbound (customer service, collections). Enforced by the
 *  worker before a run ever starts — external mail is service input, not
 *  instructions, regardless of this gate. */
export const inboundPolicy = pgEnum('inbound_policy', ['staff_only', 'known_contacts', 'anyone'])

export type AgentPersonality = {
  /** Short first-person self-description used in the system prompt and profile. */
  bio: string
  /** Tone descriptors, e.g. ['warm', 'concise', 'plain-spoken']. */
  tone: string[]
  /** Sign-off used in outbound mail, e.g. 'Best, Dana'. */
  signoff: string
}

/**
 * Which brains an agent works with. Both models come from the same provider —
 * one key, one bill, one place to rotate.
 */
export type AgentModelConfig = {
  /** Provider key registered with the runtime, e.g. 'anthropic', 'openai-compatible'. */
  provider: string
  /**
   * The thinking model — the one every governed run uses: the email it writes,
   * the assignment it takes, the duty it runs, and the work a caller is waiting
   * on the line for. Historically the agent's only model, which is why the
   * field keeps the bare name: every existing row already carries it here.
   */
  model: string
  /**
   * The fast model — the one that holds the live conversation on a cascade
   * call, where first-token latency is audible to the person on the phone.
   * Optional: unset, the agent uses the provider's fast model, and failing
   * that the thinking model above. On a realtime voice agent the speech model
   * itself does the talking, so this applies only away from the call.
   */
  modelFast?: string
  /** Provider base URL override for openai-compatible/self-hosted gateways. */
  baseUrl?: string
  temperature?: number
  maxOutputTokens?: number
}

export type AgentSalary = {
  /** Monthly token budget in USD. The whole salary metaphor keys off this. */
  monthlyUsd: number
  /** What happens at 100% of budget: stop working, keep working (overtime), or ask a human. */
  overagePolicy: 'pause' | 'overtime' | 'ask'
  /**
   * Monthly ceiling on live call minutes, counted across every call this agent
   * takes or places. Undefined — the shape every existing row has — means no
   * ceiling: calls are limited by the money budget alone. Once the ceiling is
   * reached the agent stops answering and placing calls until the next month
   * begins; inbound callers are offered a voicemail instead.
   */
  monthlyCallMinutes?: number
}

/** An agent's working window; resolved in `timezone` (IANA). */
export type AgentWorkingHours = {
  /** Days worked, 0 = Sunday … 6 = Saturday. */
  days: number[]
  /** 24h clock, e.g. '08:00'. */
  start: string
  end: string
  timezone: string
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
    /** Plain-language description of what this person owns; agents use it to route work. */
    responsibilities: text('responsibilities'),
    reportsToId: uuid('reports_to_id'),
    /** Humans only: link to the authenticated user, when they have a login. */
    userId: uuid('user_id'),
    avatarFileId: uuid('avatar_file_id'),
    /** Agents only ------------------------------------------------------- */
    /**
     * The role this agent holds — a first-party pack's slug or a role built
     * here. Every resource assigned to that role reaches this agent, so this is
     * the one field a role link resolves against.
     */
    roleSlug: text('role_slug'),
    personality: jsonb('personality').$type<AgentPersonality>(),
    modelConfig: jsonb('model_config').$type<AgentModelConfig>(),
    salary: jsonb('salary').$type<AgentSalary>(),
    /** How this agent sounds on a call — null until voice is configured. */
    voiceConfig: jsonb('voice_config').$type<AgentVoiceConfig>(),
    /** The agent's phone-system short code (e.g. '701') — unique per tenant
     *  where set; desk phones reach the agent by dialing it. */
    extension: text('extension'),
    proactivity: proactivityMode('proactivity').default('duties'),
    /** Where this agent normally works. Null means no fixed desk. */
    departmentId: uuid('department_id'),
    inboundPolicy: inboundPolicy('inbound_policy').default('staff_only'),
    /**
     * When this agent works. Null = always on. With hours set, inbound email
     * work waits for the next working window (duties and calls are unaffected:
     * schedules are explicit, and a ringing phone gets answered).
     */
    workingHours: jsonb('working_hours').$type<AgentWorkingHours>(),
    startedOn: date('started_on'),
    endedOn: date('ended_on'),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex('people_tenant_email_key').on(t.tenantId, sql`lower(${t.email})`),
    uniqueIndex('people_tenant_extension_key')
      .on(t.tenantId, t.extension)
      .where(sql`${t.extension} is not null`),
    uniqueIndex('people_tenant_user_key')
      .on(t.tenantId, t.userId)
      .where(sql`${t.userId} is not null`),
    index('people_tenant_kind_idx').on(t.tenantId, t.kind),
    foreignKey({ columns: [t.reportsToId], foreignColumns: [t.id], name: 'people_reports_to_fk' }),
    foreignKey({ columns: [t.userId], foreignColumns: [users.id], name: 'people_user_fk' }).onDelete('set null'),
    check('people_agent_user_check', sql`${t.kind} = 'human' or ${t.userId} is null`),
  ],
)

export const PEOPLE_TENANT_TABLES = ['people', 'departments'] as const

/**
 * A place in the company, and what it looks like.
 *
 * The scene switcher used to be a wallpaper picker — six hardcoded rooms in
 * localStorage, every agent drawn on every one. A company has places, people
 * belong to them, and who-is-where is the entire reason to look at a floor.
 *
 * The backdrop is either one of the built-in scene kinds, which keep working
 * exactly as before and seed the defaults, or artwork generated for this
 * department. Generated SVG is sanitised before it is stored — see
 * `lib/scene-svg.ts` — because a model writing markup that lands in a trusted
 * origin is an XSS hole unless somebody makes it not one.
 */
export const departments = pgTable(
  'departments',
  {
    id: id(),
    tenantId: tenantRef(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    /** A built-in scene kind, or null when drawn from `backdropSvg`. */
    sceneKind: text('scene_kind'),
    /**
     * Sanitised SVG for the dark theme. Never rendered without having been
     * through the allowlist.
     */
    backdropSvg: text('backdrop_svg'),
    /**
     * The same room drawn for the light theme.
     *
     * Two drawings, not one recoloured: the palette is baked into the shapes,
     * so a room drawn in near-black slate is unreadable on a light canvas.
     */
    backdropSvgLight: text('backdrop_svg_light'),
    /** What was asked for, so it can be tweaked rather than re-described. */
    backdropPrompt: text('backdrop_prompt'),
    position: integer('position').notNull().default(0),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex('departments_slug_key').on(t.tenantId, t.slug),
    index('departments_order_idx').on(t.tenantId, t.position),
  ],
)
