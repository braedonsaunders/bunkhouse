import { integer, jsonb, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core'
import { auditColumns, id, tenantRef } from '@appkit/db'
import { inboundPolicy } from './people'

/**
 * Tenant-authored role definitions — the same shape as first-party role packs
 * (@bunkhouse/roles), built entirely in the UI. Builtin packs stay code; a
 * tenant can duplicate one here to customize it. Onboarding reads both.
 *
 * A role holds no copies of company resources. The procedures it binds, the
 * skills it draws on, the knowledge it is given and the systems it works in are
 * all links — recorded once on the resource, as its assignment, and edited from
 * either end. Duties are the exception and belong here: a duty is this role's
 * standing work, with its own schedule, not a shared object to point at.
 */
export type RoleDuty = { slug: string; title: string; instruction: string; cron: string }
export type RoleAutonomyDefaults = Partial<
  Record<
    | 'external_email'
    | 'internal_email'
    | 'record_write'
    | 'money_adjacent'
    | 'file_write'
    | 'computer_use'
    | 'shell'
    | 'phone_call',
    'forbidden' | 'approval' | 'notify' | 'trusted'
  >
>

export const roleDefs = pgTable(
  'role_defs',
  {
    id: id(),
    tenantId: tenantRef(),
    slug: text('slug').notNull(),
    title: text('title').notNull(),
    pitch: text('pitch').notNull(),
    description: text('description').notNull(),
    personality: jsonb('personality').$type<{ bio: string; tone: string[] }>().notNull(),
    duties: jsonb('duties').$type<RoleDuty[]>().notNull().default([]),
    autonomyDefaults: jsonb('autonomy_defaults').$type<RoleAutonomyDefaults>().notNull().default({}),
    inboundPolicy: inboundPolicy('inbound_policy').notNull().default('staff_only'),
    suggestedSalaryUsd: integer('suggested_salary_usd').notNull().default(50),
    ...auditColumns,
  },
  (t) => [uniqueIndex('role_defs_tenant_slug_key').on(t.tenantId, t.slug)],
)

export const ROLES_TENANT_TABLES = ['role_defs'] as const
