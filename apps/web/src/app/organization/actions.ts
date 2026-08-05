'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { and, eq, inArray } from 'drizzle-orm'
import { schema as identity } from '@appkit/db'
import { listRealtimeCapableProviders } from '../../lib/voice'
import { getRole, installRoleProcedures } from '../../lib/roles'
import {
  autonomySettings,
  approvals,
  assignments,
  callSessions,
  departments,
  duties,
  mailboxAccounts,
  meetingLinks,
  memories,
  people,
  type BunkhouseVoiceConfig,
} from '../../db/schema'
import { db } from '../../db/client'
import { requireTenantPermission, resolveTenantId as resolveTenant } from '../../lib/tenant'
const resolveTenantId = () => resolveTenant('people.manage')
import { connectMailbox, syncPersonMailbox } from '../../lib/mailbox'
import { listAiProviders } from '../../lib/ai'
import { firstOccurrence } from '../../lib/duties'
import { correctNote, createNote, expireNote, proposePromotion } from '../../lib/memory'
import { ACTION_CATEGORIES, DEFAULT_AUTONOMY_LEVEL, isActionCategory, isAutonomyLevel } from '../../lib/autonomy'
import { assertValidManager } from '../../lib/org'

/** Everything the roster and the org chart re-read after a personnel change. */
function revalidateOrganization(): void {
  revalidatePath('/organization/people')
  revalidatePath('/organization')
  revalidatePath('/organization/chart')
}

/**
 * Add a real human to the organization. Humans are colleagues, not employees
 * of the runtime: no model, no salary, no mailbox to provision. They exist so
 * agents can route work to them, so escalation has somewhere to go, and so the
 * org chart shows the whole company rather than only its AI half.
 */
export async function addPerson(formData: FormData): Promise<void> {
  const name = String(formData.get('name') ?? '').trim()
  const title = String(formData.get('title') ?? '').trim()
  const email = String(formData.get('email') ?? '').trim().toLowerCase()
  const phone = String(formData.get('phone') ?? '').trim() || null
  const timezone = String(formData.get('timezone') ?? '').trim() || null
  const responsibilities = String(formData.get('responsibilities') ?? '').trim() || null
  const reportsToId = String(formData.get('reportsToId') ?? '') || null
  const startedOn = String(formData.get('startedOn') ?? '').trim() || null
  const status = String(formData.get('status') ?? 'active')
  if (!name || !title || !email) throw new Error('Name, title, and email are required.')
  if (!['onboarding', 'active', 'offboarded'].includes(status)) throw new Error('Invalid status.')

  const tenantId = await resolveTenantId()
  const app = db()
  const personId = await app.withTenant(tenantId, async () => {
    const roster = await app.db
      .select({ id: people.id, name: people.name, reportsToId: people.reportsToId })
      .from(people)
    if (reportsToId && !roster.some((entry) => entry.id === reportsToId)) {
      throw new Error('That manager is not in this organization.')
    }
    const [person] = await app.db
      .insert(people)
      .values({
        tenantId,
        kind: 'human',
        status: status as 'onboarding' | 'active' | 'offboarded',
        name,
        title,
        email,
        phone,
        timezone,
        responsibilities,
        reportsToId,
        startedOn: startedOn ?? new Date().toISOString().slice(0, 10),
      })
      .returning({ id: people.id })
    if (!person) throw new Error('Could not add this person.')
    return person.id
  })

  revalidateOrganization()
  redirect(`/organization/people?person=${personId}`)
}

/**
 * Move one record under a new manager (or to the top level). This is what the
 * org chart's drag gesture commits; the tree invariant is re-checked here
 * because the chart's own guard runs on a snapshot the client may have held
 * while somebody else reorganized.
 */
export async function setReportsTo(
  personId: string,
  managerId: string | null,
): Promise<{ ok: true } | { ok: false; message: string }> {
  if (!personId) return { ok: false, message: 'personId is required.' }
  const tenantId = await resolveTenantId()
  const app = db()
  try {
    await app.withTenant(tenantId, async () => {
      const roster = await app.db
        .select({ id: people.id, name: people.name, reportsToId: people.reportsToId })
        .from(people)
      if (!roster.some((entry) => entry.id === personId)) throw new Error('Person not found.')
      assertValidManager(roster, personId, managerId)
      await app.db
        .update(people)
        .set({ reportsToId: managerId, updatedAt: new Date() })
        .where(eq(people.id, personId))
    })
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
  revalidateOrganization()
  return { ok: true }
}

/**
 * Hire an agent into a role: person + day-one autonomy dial + standing duties,
 * atomically, plus the role's starter procedures if they are not in the library
 * yet. Everything else the role carries — procedures, skills, knowledge,
 * systems — is linked to the role, so this agent picks it up by holding the
 * role rather than by being given a copy of it. The agent starts in
 * 'onboarding'; activation happens when a mailbox is connected.
 */
export async function hireAgent(formData: FormData): Promise<void> {
  const packSlug = String(formData.get('rolePack') ?? '')
  const tenantIdEarly = await resolveTenantId()
  const pack = await getRole(tenantIdEarly, packSlug)
  if (!pack) throw new Error(`Unknown role: ${packSlug}`)

  const name = String(formData.get('name') ?? '').trim()
  const email = String(formData.get('email') ?? '').trim().toLowerCase()
  const bio = String(formData.get('bio') ?? '').trim() || pack.personality.bio
  const salaryUsd = Number(formData.get('salaryUsd') ?? pack.suggestedSalaryUsd)
  const reportsToId = String(formData.get('reportsToId') ?? '') || null
  const timezone = String(formData.get('timezone') ?? '').trim() || null
  if (!name || !email) throw new Error('An agent needs a name and an email address.')
  if (!Number.isFinite(salaryUsd) || salaryUsd <= 0) throw new Error('Salary must be a positive monthly USD amount.')

  const tenantId = tenantIdEarly
  const app = db()

  const personId = await app.withTenant(tenantId, async () => {
    if (reportsToId) {
      const roster = await app.db.select({ id: people.id }).from(people)
      if (!roster.some((entry) => entry.id === reportsToId)) {
        throw new Error('That manager is not in this organization.')
      }
    }
    const [person] = await app.db
      .insert(people)
      .values({
        tenantId,
        kind: 'agent',
        status: 'onboarding',
        name,
        title: pack.title,
        email,
        timezone,
        reportsToId,
        roleSlug: pack.slug,
        responsibilities: pack.pitch,
        personality: { bio, tone: pack.personality.tone, signoff: `Best,\n${name.split(' ')[0]}` },
        salary: { monthlyUsd: salaryUsd, overagePolicy: 'ask' },
        proactivity: 'duties',
        inboundPolicy: pack.inboundPolicy,
        startedOn: new Date().toISOString().slice(0, 10),
      })
      .returning({ id: people.id })
    if (!person) throw new Error('Hire failed: person row not created.')

    await app.db.insert(autonomySettings).values(
      ACTION_CATEGORIES.map((category) => ({
        tenantId,
        personId: person.id,
        category,
        level: pack.autonomyDefaults[category] ?? DEFAULT_AUTONOMY_LEVEL,
      })),
    )

    if (pack.duties.length > 0) {
      await app.db.insert(duties).values(
        pack.duties.map((duty) => ({
          tenantId,
          personId: person.id,
          slug: duty.slug,
          title: duty.title,
          instruction: duty.instruction,
          scheduleKind: 'cron' as const,
          schedule: duty.cron,
          // A pack's cron is written in the company's working day ("0 8" is
          // eight in the morning), so it has to be pinned to a real zone; left
          // null it would resolve against the worker process's clock and a
          // morning sweep would land in the middle of the night.
          timezone,
          // Armed on hire so the pack's duties fire at their first real
          // occurrence instead of being skipped by the worker's anchoring pass.
          nextDueAt: firstOccurrence({ scheduleKind: 'cron', schedule: duty.cron, timezone }),
          fromRolePackDuty: duty.slug,
        })),
      )
    }

    // The role's starter procedures, if nobody has installed them yet. Every
    // other resource the role carries is already linked to it, so this agent
    // picks them up by holding the role — nothing is copied per hire.
    await installRoleProcedures(tenantId, pack)

    await app.db.insert(memories).values({
      tenantId,
      scope: 'agent',
      personId: person.id,
      slug: 'first-day',
      title: 'First day',
      body: `Hired as ${pack.title}. My standing duties and procedures came with the role; I have not connected to my mailbox yet.`,
    })

    return person.id
  })

  redirect(`/organization?person=${personId}`)
}

/**
 * Set one category on an agent's autonomy dial. Upsert keeps the dial complete.
 * Editable from the agent's profile and from the company Autonomy settings —
 * both write here, so the dial has one source of truth.
 */
export async function setAutonomy(formData: FormData): Promise<void> {
  const personId = String(formData.get('personId') ?? '')
  const category = String(formData.get('category') ?? '')
  const level = String(formData.get('level') ?? '')
  if (!personId || !isActionCategory(category)) throw new Error('Invalid dial update.')
  if (!isAutonomyLevel(level)) throw new Error('Invalid level.')

  const tenantId = await resolveTenantId()
  const app = db()
  await app.withTenant(tenantId, async () => {
    await app.db
      .insert(autonomySettings)
      .values({ tenantId, personId, category, level })
      .onConflictDoUpdate({
        target: [autonomySettings.tenantId, autonomySettings.personId, autonomySettings.category],
        set: { level, updatedAt: new Date() },
      })
  })
  revalidatePath('/organization')
  revalidatePath('/admin/settings')
}

/** Add a human-authored note to an agent's logbook. */
export async function addMemoryNote(formData: FormData): Promise<void> {
  const personId = String(formData.get('personId') ?? '')
  const title = String(formData.get('title') ?? '').trim()
  const body = String(formData.get('body') ?? '').trim()
  const kind = String(formData.get('kind') ?? 'fact') as 'fact' | 'episode' | 'procedure' | 'reflection'
  const importance = Number(formData.get('importance') ?? 3)
  if (!personId || !title || !body) throw new Error('A note needs a title and a body.')
  const tenantId = await resolveTenantId()
  const app = db()
  await app.withTenant(tenantId, async () => {
    await createNote({ tenantId, scope: 'agent', personId, kind, title, body, author: 'human', importance })
  })
  revalidatePath('/organization')
}

/** Forget = expire, never delete: the note closes its validity window. */
export async function deleteMemoryNote(formData: FormData): Promise<void> {
  const memoryId = String(formData.get('memoryId') ?? '')
  if (!memoryId) throw new Error('memoryId is required')
  const tenantId = await resolveTenantId()
  const app = db()
  await app.withTenant(tenantId, async () => {
    await expireNote(tenantId, memoryId)
  })
  revalidatePath('/organization')
  revalidatePath('/resources')
}

/** Pin/unpin: the pinned tier is always in the agent's prompt, budgeted. */
export async function togglePinNote(formData: FormData): Promise<void> {
  const memoryId = String(formData.get('memoryId') ?? '')
  const pinned = String(formData.get('pinned') ?? '') === 'true'
  if (!memoryId) throw new Error('memoryId is required')
  const tenantId = await resolveTenantId()
  const app = db()
  await app.withTenant(tenantId, async () => {
    await app.db.update(memories).set({ pinned, updatedAt: new Date() }).where(eq(memories.id, memoryId))
  })
  revalidatePath('/organization')
  revalidatePath('/resources')
}

/** Nominate an agent note for company knowledge (approval-gated). */
export async function promoteNoteAction(formData: FormData): Promise<void> {
  const memoryId = String(formData.get('memoryId') ?? '')
  const rationale = String(formData.get('rationale') ?? '').trim() || 'Proposed from the agent profile.'
  if (!memoryId) throw new Error('memoryId is required')
  const tenantId = await resolveTenantId()
  const app = db()
  await app.withTenant(tenantId, async () => {
    await proposePromotion({ tenantId, noteId: memoryId, rationale })
  })
  revalidatePath('/resources')
}

/** Connect an IMAP/SMTP mailbox to an agent — verifies both endpoints first. */
export async function connectMailboxAction(formData: FormData): Promise<void> {
  const personId = String(formData.get('personId') ?? '')
  const address = String(formData.get('address') ?? '').trim().toLowerCase()
  const username = String(formData.get('username') ?? '').trim() || address
  const password = String(formData.get('password') ?? '')
  const imapHost = String(formData.get('imapHost') ?? '').trim()
  const smtpHost = String(formData.get('smtpHost') ?? '').trim()
  const imapPort = Number(formData.get('imapPort') ?? 993)
  const smtpPort = Number(formData.get('smtpPort') ?? 465)
  if (!personId || !address || !password || !imapHost || !smtpHost) {
    throw new Error('Address, password, IMAP host, and SMTP host are required.')
  }
  const tenantId = await resolveTenantId()
  await connectMailbox({
    tenantId,
    personId,
    address,
    username,
    password,
    imapHost,
    imapPort,
    imapSecure: imapPort === 993,
    smtpHost,
    smtpPort,
    smtpSecure: smtpPort === 465,
  })
  // Fetch once now, for the same reason the OAuth callback does: a mailbox that
  // has just been connected should not read as empty while the scheduled sweep
  // catches up, with a refresh that cannot help because nothing has been
  // fetched yet. Bounded, and the sweep finishes whatever is left.
  await Promise.race([
    syncPersonMailbox(tenantId, personId).catch(() => undefined),
    new Promise((resolve) => setTimeout(resolve, FIRST_SYNC_BUDGET_MS)),
  ])
  revalidatePath('/organization')
}

/** How long a connect waits on the first fetch before returning. */
const FIRST_SYNC_BUDGET_MS = 20_000

/** Pull new mail for an agent right now (the worker also does this on schedule). */
export async function syncMailboxAction(formData: FormData): Promise<void> {
  const personId = String(formData.get('personId') ?? '')
  if (!personId) throw new Error('personId is required')
  const tenantId = await resolveTenantId()
  await syncPersonMailbox(tenantId, personId)
  revalidatePath('/organization')
}

/**
 * Assign which brains this agent runs on: a tenant provider slug, the thinking
 * model that does the work, and — optionally — the fast model that answers
 * while someone is on the phone. Both models come from the same provider.
 * A blank fast model is a real choice, not an error: it is stored absent, and
 * resolution falls back to the provider's fast model, then to the thinking
 * model. An empty string is never written.
 */
export async function setAgentModel(formData: FormData): Promise<void> {
  const personId = String(formData.get('personId') ?? '')
  const providerSlug = String(formData.get('providerSlug') ?? '')
  const model = String(formData.get('model') ?? '').trim()
  const modelFast = String(formData.get('modelFast') ?? '').trim()
  if (!personId || !providerSlug || !model) throw new Error('Provider and model are required.')

  const tenantId = await resolveTenantId()
  const providers = await listAiProviders(tenantId)
  if (!providers.some((p) => p.slug === providerSlug)) {
    throw new Error(`No provider with slug "${providerSlug}" is configured.`)
  }
  const app = db()
  await app.withTenant(tenantId, async () => {
    await app.db
      .update(people)
      .set({
        modelConfig: { provider: providerSlug, model, ...(modelFast ? { modelFast } : {}) },
        updatedAt: new Date(),
      })
      .where(eq(people.id, personId))
  })
  revalidatePath('/organization')
}

/** Set (or clear) how an agent sounds on a call. Mode-specific fields validated. */
export async function setAgentVoiceConfig(input: {
  personId: string
  config: BunkhouseVoiceConfig | null
}): Promise<{ ok: true } | { ok: false; message: string }> {
  const { personId, config } = input
  if (!personId) return { ok: false, message: 'personId is required.' }
  const tenantId = await resolveTenantId()

  if (config !== null) {
    if (config.mode === 'cascade') {
      const c = config.cascade
      if (!c || c.sttProvider !== 'deepgram' || !c.sttModel || c.ttsProvider !== 'elevenlabs' || !c.ttsVoiceId || !c.ttsModel) {
        return { ok: false, message: 'Cascade mode needs an STT model, a TTS voice, and a TTS model.' }
      }
    } else if (config.mode === 'realtime') {
      const r = config.realtime
      if (!r || !r.model || !r.voice) {
        return { ok: false, message: 'Realtime mode needs a provider, model, and voice.' }
      }
      const capable = await listRealtimeCapableProviders(tenantId)
      if (!capable.some((p) => p.kind === r.provider)) {
        return {
          ok: false,
          message: `No ${r.provider === 'openai' ? 'OpenAI' : 'Google'} provider is configured under Settings → Model providers — realtime voice runs on those keys.`,
        }
      }
    } else {
      return { ok: false, message: 'Voice mode must be cascade or realtime.' }
    }
  }

  const app = db()
  await app.withTenant(tenantId, async () => {
    const [person] = await app.db.select().from(people).where(eq(people.id, personId))
    if (!person || person.kind !== 'agent') throw new Error('Voice can only be configured on an agent.')
    await app.db.update(people).set({ voiceConfig: config, updatedAt: new Date() }).where(eq(people.id, personId))
  })
  revalidatePath('/organization')
  return { ok: true }
}

/**
 * Read the schedule fields the builder posts, validating before any write so a
 * bad pattern surfaces in the drawer rather than stalling the worker. Returns
 * the row shape plus the first fire time, so a duty is armed the moment it is
 * saved instead of waiting for the worker's anchoring pass.
 */
async function readSchedule(formData: FormData, tenantId: string, personId: string) {
  const kind = String(formData.get('scheduleKind') ?? 'cron')
  if (kind !== 'cron' && kind !== 'once') throw new Error('Unknown schedule type.')
  const schedule = String(formData.get('schedule') ?? '').trim()
  if (!schedule) throw new Error('A schedule is required.')

  const endsAtRaw = String(formData.get('endsAt') ?? '').trim()
  const endsAt = endsAtRaw ? new Date(endsAtRaw) : null
  if (endsAt && Number.isNaN(endsAt.getTime())) throw new Error('That end date could not be read.')

  const maxRunsRaw = String(formData.get('maxRuns') ?? '').trim()
  const maxRuns = maxRunsRaw ? Number(maxRunsRaw) : null
  if (maxRuns !== null && (!Number.isInteger(maxRuns) || maxRuns < 1)) {
    throw new Error('A run limit must be a whole number of at least 1.')
  }

  // A recurring pattern needs a zone to resolve "9am" in; the operator's own
  // zone is the intent, with the agent's as the fallback. A one-time duty is
  // already an absolute instant, so a zone would mean nothing.
  let timezone: string | null = null
  if (kind === 'cron') {
    timezone = String(formData.get('timezone') ?? '').trim() || null
    if (!timezone && personId) {
      const app = db()
      const [person] = await app.withTenantContext(tenantId, () =>
        app.db.select({ timezone: people.timezone }).from(people).where(eq(people.id, personId)).limit(1),
      )
      timezone = person?.timezone ?? null
    }
  }

  const spec = { scheduleKind: kind as 'cron' | 'once', schedule, timezone, startsAt: null, endsAt }
  const nextDueAt = firstOccurrence(spec)
  if (!nextDueAt) throw new Error('That schedule has no upcoming run — check the end date.')
  if (kind === 'once' && nextDueAt.getTime() <= Date.now()) {
    throw new Error('A one-time duty needs a date and time in the future.')
  }
  return { ...spec, maxRuns, nextDueAt }
}

/** Update a duty from its drawer: instruction, schedule, bounds, on/off. */
export async function updateDuty(formData: FormData): Promise<void> {
  const personId = String(formData.get('personId') ?? '')
  const dutyId = String(formData.get('dutyId') ?? '')
  const title = String(formData.get('title') ?? '').trim()
  const instruction = String(formData.get('instruction') ?? '').trim()
  const enabled = String(formData.get('enabled') ?? 'on') === 'on' ? ('on' as const) : ('off' as const)
  if (!dutyId || !title || !instruction) throw new Error('Title and instruction are required.')

  const tenantId = await resolveTenantId()
  const { nextDueAt, ...schedule } = await readSchedule(formData, tenantId, personId)
  const app = db()
  await app.withTenant(tenantId, async () => {
    await app.db
      .update(duties)
      .set({ title, instruction, ...schedule, enabled, nextDueAt, updatedAt: new Date() })
      .where(eq(duties.id, dutyId))
  })
  revalidatePath('/organization')
}

/** Full record edit from the person drawer — every field an operator owns. */
export type PersonUpdateResult = { ok: true } | { ok: false; message: string }

/**
 * Full record edit from the person drawer — every field an operator owns.
 * Returns rather than throws: a rejected edit here is an everyday mis-click
 * (a reporting line that would loop, a status that no longer applies), and the
 * form shows the reason in place instead of dropping the operator on an error
 * page with their unsaved work gone.
 */
export async function updatePerson(formData: FormData): Promise<PersonUpdateResult> {
  const personId = String(formData.get('personId') ?? '')
  const name = String(formData.get('name') ?? '').trim()
  const title = String(formData.get('title') ?? '').trim()
  const email = String(formData.get('email') ?? '').trim().toLowerCase()
  const status = String(formData.get('status') ?? '') as 'onboarding' | 'active' | 'offboarded'
  const reportsToId = String(formData.get('reportsToId') ?? '') || null
  const responsibilities = String(formData.get('responsibilities') ?? '').trim() || null
  if (!personId || !name || !title || !email) return { ok: false, message: 'Name, title, and email are required.' }
  if (!['onboarding', 'active', 'offboarded'].includes(status)) return { ok: false, message: 'Invalid status.' }

  const access = await requireTenantPermission('people.manage')
  const tenantId = access.tenantId
  const app = db()
  // The desk is a field of the record now, so moving somebody also redraws the
  // floor they were on and the headcount beside their department.
  const deskEdited = formData.has('departmentId')
  try {
    await app.withTenant(tenantId, async () => {
      const roster = await app.db
        .select({ id: people.id, name: people.name, reportsToId: people.reportsToId })
        .from(people)
      assertValidManager(roster, personId, reportsToId)
      const [person] = await app.db.select().from(people).where(eq(people.id, personId))
      if (!person) throw new Error('Person not found.')

      if (status !== person.status) {
        const allowed =
          (person.status === 'onboarding' && (status === 'active' || status === 'offboarded')) ||
          (person.status === 'active' && status === 'offboarded') ||
          (person.status === 'offboarded' && status === 'onboarding')
        if (!allowed) {
          throw new Error(`Status cannot move directly from ${person.status} to ${status}.`)
        }
      }

      const update: Partial<typeof people.$inferInsert> = {
        name, title, email, status, reportsToId, responsibilities, updatedAt: new Date(),
      }
      // Only when the form carried the field: a record rendered without a desk
      // picker — a human, or a company with no places yet — must not clear one.
      // A department id in a form is a request, so it is matched against this
      // tenant's own places before it is written.
      if (deskEdited) {
        const departmentId = String(formData.get('departmentId') ?? '') || null
        if (departmentId) {
          const [place] = await app.db
            .select({ id: departments.id })
            .from(departments)
            .where(eq(departments.id, departmentId))
          if (!place) throw new Error('That department is not part of this organization.')
        }
        update.departmentId = departmentId
      }
      if (person.kind === 'human') {
        update.phone = String(formData.get('phone') ?? '').trim() || null
        update.timezone = String(formData.get('timezone') ?? '').trim() || null
        update.startedOn = String(formData.get('startedOn') ?? '').trim() || null
        update.endedOn = String(formData.get('endedOn') ?? '').trim() || null
      }
      if (person.kind === 'agent') {
        const bio = String(formData.get('bio') ?? '').trim()
        const tone = String(formData.get('tone') ?? '').split(',').map((t) => t.trim()).filter(Boolean)
        const signoff = String(formData.get('signoff') ?? '').trim()
        const salaryUsd = Number(formData.get('salaryUsd'))
        const overagePolicy = String(formData.get('overagePolicy') ?? 'ask') as 'pause' | 'overtime' | 'ask'
        const proactivity = String(formData.get('proactivity') ?? 'duties') as 'reactive' | 'duties' | 'autonomous'
        if (!Number.isFinite(salaryUsd) || salaryUsd <= 0) throw new Error('Salary must be a positive monthly amount.')
        if (!['pause', 'overtime', 'ask'].includes(overagePolicy)) throw new Error('Invalid overage policy.')
        if (!['reactive', 'duties', 'autonomous'].includes(proactivity)) throw new Error('Invalid proactivity mode.')
        update.personality = {
          bio: bio || person.personality?.bio || `I am the ${title}.`,
          tone: tone.length ? tone : (person.personality?.tone ?? ['professional']),
          signoff: signoff || person.personality?.signoff || `Best,\n${name.split(' ')[0]}`,
        }
        update.salary = {
          monthlyUsd: salaryUsd,
          overagePolicy,
          // The call-minutes ceiling is set on Payroll, not on this form —
          // carry it through so saving the record never quietly removes it.
          ...(person.salary?.monthlyCallMinutes !== undefined
            ? { monthlyCallMinutes: person.salary.monthlyCallMinutes }
            : {}),
        }
        update.proactivity = proactivity
        const inbound = String(formData.get('inboundPolicy') ?? 'staff_only') as 'staff_only' | 'known_contacts' | 'anyone'
        if (!['staff_only', 'known_contacts', 'anyone'].includes(inbound)) throw new Error('Invalid inbound policy.')
        update.inboundPolicy = inbound
        const hoursMode = String(formData.get('workingHoursMode') ?? 'always')
        if (hoursMode === 'always') {
          update.workingHours = null
        } else if (hoursMode === 'weekdays' || hoursMode === 'everyday') {
          const start = String(formData.get('workStart') ?? '').trim()
          const end = String(formData.get('workEnd') ?? '').trim()
          const tz = String(formData.get('workTimezone') ?? '').trim()
          if (!/^\d{2}:\d{2}$/.test(start) || !/^\d{2}:\d{2}$/.test(end)) {
            throw new Error('Working hours need start and end times.')
          }
          if (!tz) throw new Error('Working hours need a time zone (e.g. America/New_York).')
          try {
            new Intl.DateTimeFormat('en-US', { timeZone: tz })
          } catch {
            throw new Error(`"${tz}" is not a recognized time zone.`)
          }
          update.workingHours = {
            days: hoursMode === 'weekdays' ? [1, 2, 3, 4, 5] : [0, 1, 2, 3, 4, 5, 6],
            start,
            end,
            timezone: tz,
          }
        }
      }
      if (status === 'offboarded' && person.status !== 'offboarded') {
        const now = new Date()
        update.endedOn = String(formData.get('endedOn') ?? '').trim() || now.toISOString().slice(0, 10)
        if (person.kind === 'agent') {
          await Promise.all([
            app.db
              .update(mailboxAccounts)
              .set({ status: 'disabled', lastError: null, updatedAt: now })
              .where(eq(mailboxAccounts.personId, person.id)),
            app.db
              .update(duties)
              .set({ enabled: 'off', nextDueAt: null, updatedAt: now })
              .where(eq(duties.personId, person.id)),
            app.db
              .update(autonomySettings)
              .set({ level: 'forbidden', updatedAt: now })
              .where(eq(autonomySettings.personId, person.id)),
            app.db
              .update(assignments)
              .set({ status: 'cancelled', lastError: 'Cancelled when the agent was offboarded.', updatedAt: now })
              .where(
                and(
                  eq(assignments.personId, person.id),
                  inArray(assignments.status, ['pending', 'working', 'waiting_approval']),
                ),
              ),
            app.db
              .update(approvals)
              .set({ status: 'expired', decidedById: access.user.id, decidedAt: now, decisionNote: 'Expired when the agent was offboarded.' })
              .where(and(eq(approvals.personId, person.id), eq(approvals.status, 'pending'))),
            app.db
              .update(callSessions)
              .set({ status: 'ended', endedAt: now, updatedAt: now })
              .where(and(eq(callSessions.personId, person.id), eq(callSessions.status, 'active'))),
            app.db
              .update(meetingLinks)
              .set({ expiresAt: now, updatedAt: now })
              .where(eq(meetingLinks.createdByPersonId, person.id)),
          ])
        }
      }

      await app.db.update(people).set(update).where(eq(people.id, personId))
      if (status !== person.status) {
        await app.db.insert(identity.auditLog).values({
          tenantId,
          actorUserId: access.user.id,
          action: 'status_transition',
          entityType: 'person',
          entityId: person.id,
          summary: `${person.name}: ${person.status} → ${status}`,
          before: { status: person.status, endedOn: person.endedOn },
          after: { status, endedOn: update.endedOn ?? person.endedOn },
          metadata: { kind: person.kind },
        })
      }
    })
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
  revalidateOrganization()
  if (deskEdited) {
    // The floor, and the per-department headcount on company settings.
    revalidatePath('/')
    revalidatePath('/admin/settings')
  }
  return { ok: true }
}

/** Add a standing duty to an agent. */
export async function addDuty(formData: FormData): Promise<void> {
  const personId = String(formData.get('personId') ?? '')
  const title = String(formData.get('title') ?? '').trim()
  const instruction = String(formData.get('instruction') ?? '').trim()
  if (!personId || !title || !instruction) throw new Error('Title and instruction are required.')
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'duty'

  const tenantId = await resolveTenantId()
  const { nextDueAt, ...schedule } = await readSchedule(formData, tenantId, personId)
  const app = db()
  await app.withTenant(tenantId, async () => {
    await app.db.insert(duties).values({
      tenantId,
      personId,
      slug,
      title,
      instruction,
      ...schedule,
      nextDueAt,
    })
  })
  revalidatePath('/organization')
}

/** Remove a duty entirely (runs it produced stay in the ledger). */
export async function deleteDuty(formData: FormData): Promise<void> {
  const dutyId = String(formData.get('dutyId') ?? '')
  if (!dutyId) throw new Error('dutyId is required.')
  const tenantId = await resolveTenantId()
  const app = db()
  await app.withTenant(tenantId, async () => {
    await app.db.delete(duties).where(eq(duties.id, dutyId))
  })
  revalidatePath('/organization')
}

/** Correct a memory note in place — the prior head is snapshotted. */
export async function updateMemoryNote(formData: FormData): Promise<void> {
  const memoryId = String(formData.get('memoryId') ?? '')
  const title = String(formData.get('title') ?? '').trim()
  const body = String(formData.get('body') ?? '').trim()
  if (!memoryId || !title || !body) throw new Error('A note needs a title and a body.')
  const tenantId = await resolveTenantId()
  const app = db()
  const importance = Number(formData.get('importance') ?? 0)
  await app.withTenant(tenantId, async () => {
    await correctNote({
      tenantId,
      noteId: memoryId,
      title,
      body,
      editedBy: 'human',
      ...(importance >= 1 && importance <= 5 ? { importance } : {}),
    })
  })
  revalidatePath('/organization')
  revalidatePath('/resources')
}

/** Disconnect an agent's mailbox: config is deletable, the mail ledger is not. */
export async function disconnectMailboxAction(formData: FormData): Promise<void> {
  const personId = String(formData.get('personId') ?? '')
  if (!personId) throw new Error('personId is required.')
  const tenantId = await resolveTenantId()
  const app = db()
  await app.withTenant(tenantId, async () => {
    await app.db.delete(mailboxAccounts).where(eq(mailboxAccounts.personId, personId))
    await app.db.update(people).set({ status: 'onboarding', updatedAt: new Date() }).where(eq(people.id, personId))
  })
  revalidatePath('/organization')
}

/**
 * Set (or lift) an agent's monthly call-minutes ceiling. It lives inside the
 * salary record because it is part of the same bargain: what this employee may
 * spend in a month. Null lifts the ceiling — the money budget alone applies.
 */
export async function setAgentCallMinutes(input: {
  personId: string
  monthlyCallMinutes: number | null
}): Promise<{ ok: true } | { ok: false; message: string }> {
  const { personId, monthlyCallMinutes } = input
  if (!personId) return { ok: false, message: 'personId is required.' }
  if (monthlyCallMinutes !== null && (!Number.isFinite(monthlyCallMinutes) || monthlyCallMinutes < 1)) {
    return { ok: false, message: 'A call-minutes ceiling must be at least one minute, or left unset.' }
  }
  const tenantId = await resolveTenantId()
  const app = db()
  try {
    await app.withTenant(tenantId, async () => {
      const [person] = await app.db.select().from(people).where(eq(people.id, personId))
      if (!person || person.kind !== 'agent') throw new Error('Call minutes can only be set on an agent.')
      const salary = person.salary ?? { monthlyUsd: 50, overagePolicy: 'ask' as const }
      const next =
        monthlyCallMinutes === null
          ? { monthlyUsd: salary.monthlyUsd, overagePolicy: salary.overagePolicy }
          : { ...salary, monthlyCallMinutes: Math.floor(monthlyCallMinutes) }
      await app.db.update(people).set({ salary: next, updatedAt: new Date() }).where(eq(people.id, personId))
    })
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
  revalidatePath('/organization')
  return { ok: true }
}
