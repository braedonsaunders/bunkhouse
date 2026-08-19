import 'server-only'
import { and, desc, eq, gt, isNotNull, ne, sql } from 'drizzle-orm'
import { ACP_PROTOCOL_VERSION, BUNKHOUSE_ACP_CAPABILITIES } from '@bunkhouse/acp'
import { approvals, duties, mailboxAccounts, people, runs } from '../db/schema'
import { db } from '../db/client'

/**
 * What is actually broken right now.
 *
 * Every failure this app has had in practice was silent: a mailbox that errored
 * once and was never swept again, an agent whose provider ran out of credit
 * days ago, a file store nothing could reach, an approval that was granted and
 * then stranded its run. In each case the roster showed green and the work
 * simply stopped. None of these are hard to detect — nothing was looking.
 *
 * These checks are deliberately cheap: they read state the app already keeps
 * and make one short network probe. Nothing here calls a model or spends money,
 * so the page can be opened as often as an operator likes.
 */

export type HealthStatus = 'ok' | 'warn' | 'down'

export type HealthCheck = {
  key: string
  label: string
  status: HealthStatus
  /** What is true right now, in one line an operator can act on. */
  detail: string
  /** Where to go to fix it, when there is somewhere to go. */
  href?: string
}

const STORAGE_PROBE_MS = 2_500

function checkAgentProtocol(): HealthCheck {
  return {
    key: 'agent-protocol',
    label: 'Agent runtime protocol',
    status: 'ok',
    detail: `ACP v${ACP_PROTOCOL_VERSION} carries session text and governed tool activity across a replaceable client/runtime boundary (${BUNKHOUSE_ACP_CAPABILITIES.cancellation ? 'cancellation supported' : 'cancellation unavailable'}).`,
  }
}

function checkRelease(): HealthCheck {
  const version = process.env.BUNKHOUSE_VERSION?.trim() || 'development'
  const revision = process.env.BUNKHOUSE_REVISION?.trim()
  const identity = revision && revision !== 'unknown' ? `${version} · ${revision.slice(0, 12)}` : version
  return {
    key: 'release',
    label: 'Application release',
    status: 'ok',
    detail: `${identity} · ${process.platform}/${process.arch}`,
  }
}

/**
 * Provider errors are paragraphs; a health line is a line. Ending on a whole
 * sentence when one fits, and on a whole word otherwise, is what keeps the page
 * from showing an operator a severed half-word. The rest of the error is always
 * one click away on the run itself, which is where the check already points.
 */
function firstWords(text: string, limit: number): string {
  const trimmed = text.trim()
  if (trimmed.length <= limit) return trimmed
  const cut = trimmed.slice(0, limit)
  const sentence = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '))
  if (sentence > limit / 2) return cut.slice(0, sentence + 1)
  const word = cut.lastIndexOf(' ')
  return `${(word > limit / 2 ? cut.slice(0, word) : cut).replace(/[,;:—-]+$/, '')}…`
}

/** Reachability of the object store every document and attachment depends on. */
async function checkStorage(): Promise<HealthCheck> {
  const endpoint = process.env.APPKIT_STORAGE_ENDPOINT
  if (!endpoint) {
    return {
      key: 'storage',
      label: 'File storage',
      status: 'down',
      detail: 'No storage endpoint is configured, so documents and attachments cannot be saved.',
    }
  }
  try {
    // Any HTTP answer means the store is there; S3 refusing an unsigned request
    // is a healthy store. Only a failure to connect at all is a fault.
    await fetch(endpoint, { method: 'HEAD', signal: AbortSignal.timeout(STORAGE_PROBE_MS) })
    return { key: 'storage', label: 'File storage', status: 'ok', detail: `Reachable at ${endpoint}.` }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return {
      key: 'storage',
      label: 'File storage',
      status: 'down',
      detail: `Cannot reach ${endpoint} (${reason}). Every document, spreadsheet and attachment will fail until this is fixed.`,
    }
  }
}

/** Mailboxes are the product's front door; a quiet one is an agent gone deaf. */
async function checkMailboxes(tenantId: string): Promise<HealthCheck> {
  const app = db()
  const rows = await app.withTenantContext(tenantId, () =>
    app.db
      .select({
        address: mailboxAccounts.address,
        status: mailboxAccounts.status,
        lastError: mailboxAccounts.lastError,
        lastSyncAt: mailboxAccounts.lastSyncAt,
        name: people.name,
      })
      .from(mailboxAccounts)
      .innerJoin(people, eq(people.id, mailboxAccounts.personId)),
  )
  const broken = rows.filter((r) => r.status === 'error')
  const agents = await app.withTenantContext(tenantId, () =>
    app.db.select({ id: people.id }).from(people).where(and(eq(people.kind, 'agent'), eq(people.status, 'active'))),
  )
  const without = agents.length - rows.length
  if (broken.length > 0) {
    return {
      key: 'mailboxes',
      label: 'Mailboxes',
      status: 'down',
      detail: broken
        .map((r) => `${r.name} (${r.address}): ${r.lastError ?? 'not syncing'}`)
        .join(' · '),
      href: '/organization',
    }
  }
  if (without > 0) {
    return {
      key: 'mailboxes',
      label: 'Mailboxes',
      status: 'warn',
      detail: `${without} active agent${without === 1 ? '' : 's'} ${without === 1 ? 'has' : 'have'} no mailbox connected, so nobody can email ${without === 1 ? 'them' : 'them'}.`,
      href: '/organization',
    }
  }
  return {
    key: 'mailboxes',
    label: 'Mailboxes',
    status: 'ok',
    detail: rows.length === 0 ? 'No mailboxes connected yet.' : `${rows.length} connected and syncing.`,
  }
}

/**
 * Agents whose recent work is failing.
 *
 * An exhausted provider key or a wrong model name does not announce itself; it
 * shows up as every run of one agent failing while the roster still says
 * Active. Anything failing repeatedly in the last day is worth a sentence.
 */
async function checkAgentWork(tenantId: string): Promise<HealthCheck> {
  const app = db()
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000)
  const rows = await app.withTenantContext(tenantId, () =>
    app.db
      .select({
        name: people.name,
        failures: sql<number>`count(*) filter (where ${runs.status} = 'failed')`,
        total: sql<number>`count(*)`,
        lastError: sql<string | null>`max(${runs.summary}) filter (where ${runs.status} = 'failed')`,
      })
      .from(runs)
      .innerJoin(people, eq(people.id, runs.personId))
      .where(gt(runs.createdAt, since))
      .groupBy(people.name),
  )
  const failing = rows.filter((r) => Number(r.failures) >= 3 && Number(r.failures) === Number(r.total))
  if (failing.length > 0) {
    return {
      key: 'agent-work',
      label: 'Agent work',
      status: 'down',
      detail: failing
        .map((r) => `${r.name}: all ${r.total} runs failed in the last 24h — ${firstWords(r.lastError ?? '', 120)}`)
        .join(' · '),
      href: '/organization',
    }
  }
  const partial = rows.filter((r) => Number(r.failures) > 0)
  if (partial.length > 0) {
    return {
      key: 'agent-work',
      label: 'Agent work',
      status: 'warn',
      detail: partial.map((r) => `${r.name}: ${r.failures} of ${r.total} runs failed in the last 24h`).join(' · '),
      href: '/organization',
    }
  }
  return { key: 'agent-work', label: 'Agent work', status: 'ok', detail: 'No failed runs in the last 24 hours.' }
}

/** A decision that was made, applied, and then went nowhere. */
async function checkStrandedRuns(tenantId: string): Promise<HealthCheck> {
  const app = db()
  const rows = await app.withTenantContext(tenantId, () =>
    app.db
      .select({ id: runs.id, name: people.name })
      .from(runs)
      .innerJoin(approvals, eq(approvals.runId, runs.id))
      .innerJoin(people, eq(people.id, runs.personId))
      .where(
        and(eq(runs.status, 'waiting_approval'), ne(approvals.status, 'pending'), isNotNull(approvals.executedAt)),
      )
      .limit(20),
  )
  if (rows.length === 0) {
    return { key: 'stranded', label: 'Stranded work', status: 'ok', detail: 'Nothing is waiting on a decision that has already been made.' }
  }
  return {
    key: 'stranded',
    label: 'Stranded work',
    status: 'down',
    detail: `${rows.length} run${rows.length === 1 ? '' : 's'} still waiting on an approval that was already decided and applied (${rows
      .map((r) => r.name)
      .join(', ')}). They will never move on their own.`,
    href: '/approvals',
  }
}

/** Sign-offs nobody has looked at, while the work behind them waits. */
async function checkApprovalQueue(tenantId: string): Promise<HealthCheck> {
  const app = db()
  const day = new Date(Date.now() - 24 * 60 * 60 * 1000)
  const [row] = await app.withTenantContext(tenantId, () =>
    app.db
      .select({
        pending: sql<number>`count(*)`,
        stale: sql<number>`count(*) filter (where ${approvals.createdAt} < ${day})`,
        oldest: sql<Date | null>`min(${approvals.createdAt})`,
      })
      .from(approvals)
      .where(eq(approvals.status, 'pending')),
  )
  const pending = Number(row?.pending ?? 0)
  const stale = Number(row?.stale ?? 0)
  if (stale > 0) {
    return {
      key: 'approvals',
      label: 'Approval queue',
      status: 'warn',
      detail: `${stale} of ${pending} pending approval${pending === 1 ? '' : 's'} ${stale === 1 ? 'has' : 'have'} been waiting over a day. The work behind them is stopped.`,
      href: '/approvals',
    }
  }
  return {
    key: 'approvals',
    label: 'Approval queue',
    status: 'ok',
    detail: pending === 0 ? 'Queue is clear.' : `${pending} waiting, none older than a day.`,
  }
}

/** Whether the scheduler is actually running: due duties that never fired. */
async function checkScheduler(tenantId: string): Promise<HealthCheck> {
  const app = db()
  const rows = await app.withTenantContext(tenantId, () =>
    app.db
      .select({ title: duties.title, nextDueAt: duties.nextDueAt })
      .from(duties)
      .where(and(eq(duties.enabled, 'on'), isNotNull(duties.nextDueAt)))
      .orderBy(desc(duties.nextDueAt)),
  )
  // An hour past due is the scheduler being down, not a duty running late.
  const cutoff = new Date(Date.now() - 60 * 60 * 1000)
  const overdue = rows.filter((r) => r.nextDueAt && r.nextDueAt < cutoff)
  if (overdue.length > 0) {
    return {
      key: 'scheduler',
      label: 'Scheduler',
      status: 'down',
      detail: `${overdue.length} duty${overdue.length === 1 ? '' : ' schedules'} more than an hour past due (${overdue
        .slice(0, 3)
        .map((r) => r.title)
        .join(', ')}). The worker is probably not running.`,
      href: '/organization',
    }
  }
  return {
    key: 'scheduler',
    label: 'Scheduler',
    status: 'ok',
    detail: rows.length === 0 ? 'No scheduled duties.' : `${rows.length} scheduled duties, all on time.`,
  }
}

/** Every check, worst first, so the page opens on what matters. */
export async function runHealthChecks(tenantId: string): Promise<HealthCheck[]> {
  const checks = await Promise.all([
    checkAgentProtocol(),
    checkRelease(),
    checkStorage(),
    checkMailboxes(tenantId),
    checkAgentWork(tenantId),
    checkScheduler(tenantId),
    checkStrandedRuns(tenantId),
    checkApprovalQueue(tenantId),
  ])
  const rank: Record<HealthStatus, number> = { down: 0, warn: 1, ok: 2 }
  return checks.sort((a, b) => rank[a.status] - rank[b.status])
}
