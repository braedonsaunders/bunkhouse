import 'server-only'
import { and, eq, gte, sql } from 'drizzle-orm'
import { callSessions, people, type AgentSalary } from '../db/schema'
import { db } from '../db/client'

/**
 * The call-minutes side of salary. Money is the primary budget; minutes are
 * the second line, because a phone line has a cost shape of its own — a long
 * call is expensive in carrier and speech minutes whatever the model spent.
 *
 * The ceiling is optional (`salary.monthlyCallMinutes`), and an agent without
 * one is limited by money alone. Minutes reset with the calendar month, in
 * UTC, exactly like the money budget.
 */

function monthStart(at = new Date()): Date {
  const start = new Date(at)
  start.setUTCDate(1)
  start.setUTCHours(0, 0, 0, 0)
  return start
}

/**
 * Minutes this agent has spent on calls since the month began — every call,
 * inbound and outbound, browser and telephone. Calls still in progress have no
 * duration yet and count once they end.
 */
export async function monthCallMinutes(tenantId: string, personId: string): Promise<number> {
  const app = db()
  const [row] = await app.withTenantContext(tenantId, () =>
    app.db
      .select({ seconds: sql<string>`coalesce(sum(${callSessions.durationSeconds}), 0)` })
      .from(callSessions)
      .where(
        and(
          eq(callSessions.tenantId, tenantId),
          eq(callSessions.personId, personId),
          gte(callSessions.startedAt, monthStart()),
        ),
      ),
  )
  return Number(row?.seconds ?? 0) / 60
}

export type CallMinutesBudget = {
  /** The agent's monthly ceiling, or null when it has none. */
  limitMinutes: number | null
  usedMinutes: number
  /** Minutes left, or null when there is no ceiling. Never below zero. */
  remainingMinutes: number | null
  /** True only when a ceiling exists and has been reached. */
  exhausted: boolean
}

/** Where an agent stands against its call-minutes ceiling right now. */
export async function callMinutesBudget(args: {
  tenantId: string
  personId: string
  salary?: AgentSalary | null
}): Promise<CallMinutesBudget> {
  let salary = args.salary
  if (salary === undefined) {
    const app = db()
    const [row] = await app.withTenantContext(args.tenantId, () =>
      app.db.select({ salary: people.salary }).from(people).where(eq(people.id, args.personId)),
    )
    salary = row?.salary ?? null
  }
  const configured = salary?.monthlyCallMinutes
  const limitMinutes =
    typeof configured === 'number' && Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : null
  const usedMinutes = await monthCallMinutes(args.tenantId, args.personId)
  return {
    limitMinutes,
    usedMinutes,
    remainingMinutes: limitMinutes === null ? null : Math.max(0, limitMinutes - usedMinutes),
    exhausted: limitMinutes !== null && usedMinutes >= limitMinutes,
  }
}

/** When the ceiling lifts, in the words the agent uses on a call. */
export function nextMonthPhrase(at = new Date()): string {
  const next = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1))
  return next.toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' })
}
