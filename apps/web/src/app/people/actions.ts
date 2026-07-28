'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { eq } from 'drizzle-orm'
import { getRole } from '../../lib/roles'
import { autonomySettings, duties, mailboxAccounts, memories, people, procedures, procedureRevisions } from '../../db/schema'
import { db } from '../../db/client'
import { resolveTenantId } from '../../lib/tenant'
import { connectMailbox, syncPersonMailbox } from '../../lib/mailbox'
import { listAiProviders } from '../../lib/ai'
import { CronExpressionParser } from 'cron-parser'
import { generateHandAvatarCandidates, saveHandAvatar } from '../../lib/avatars'
import { correctNote, createNote, expireNote, proposePromotion } from '../../lib/memory'

const ACTION_CATEGORIES = [
  'external_email',
  'internal_email',
  'record_write',
  'money_adjacent',
  'file_write',
  'computer_use',
  'shell',
] as const

/**
 * Hire a hand from a role pack: person + day-one autonomy dial + standing
 * duties + the pack's starter procedures (versioned, assigned to the role),
 * atomically. The hand starts in 'onboarding' — activation happens when a
 * mailbox is connected.
 */
export async function hireHand(formData: FormData): Promise<void> {
  const packSlug = String(formData.get('rolePack') ?? '')
  const tenantIdEarly = await resolveTenantId()
  const pack = await getRole(tenantIdEarly, packSlug)
  if (!pack) throw new Error(`Unknown role: ${packSlug}`)

  const name = String(formData.get('name') ?? '').trim()
  const email = String(formData.get('email') ?? '').trim().toLowerCase()
  const bio = String(formData.get('bio') ?? '').trim() || pack.personality.bio
  const salaryUsd = Number(formData.get('salaryUsd') ?? pack.suggestedSalaryUsd)
  const reportsToId = String(formData.get('reportsToId') ?? '') || null
  if (!name || !email) throw new Error('A hand needs a name and an email address.')
  if (!Number.isFinite(salaryUsd) || salaryUsd <= 0) throw new Error('Salary must be a positive monthly USD amount.')

  const tenantId = tenantIdEarly
  const app = db()

  const personId = await app.withTenant(tenantId, async () => {
    const [person] = await app.db
      .insert(people)
      .values({
        tenantId,
        kind: 'hand',
        status: 'onboarding',
        name,
        title: pack.title,
        email,
        reportsToId,
        rolePackSlug: pack.slug,
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
        level: pack.autonomyDefaults[category] ?? ('approval' as const),
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
          fromRolePackDuty: duty.slug,
        })),
      )
    }

    for (const procedure of pack.procedures) {
      const [head] = await app.db
        .insert(procedures)
        .values({
          tenantId,
          slug: `${pack.slug}-${procedure.slug}`,
          title: procedure.title,
          status: 'active',
          currentVersion: 1,
          assignment: { rolePacks: [pack.slug] },
          source: { type: 'role-pack', pack: pack.slug, procedure: procedure.slug },
        })
        .onConflictDoNothing()
        .returning({ id: procedures.id })
      if (head) {
        await app.db.insert(procedureRevisions).values({
          tenantId,
          procedureId: head.id,
          version: 1,
          body: procedure.body,
          changeNote: `Installed with the ${pack.title} role pack.`,
        })
      }
    }

    await app.db.insert(memories).values({
      tenantId,
      scope: 'hand',
      personId: person.id,
      slug: 'first-day',
      title: 'First day',
      body: `Hired as ${pack.title}. My standing duties and procedures came with the role; I have not connected to my mailbox yet.`,
    })

    return person.id
  })

  redirect(`/people/${personId}`)
}

/** Set one category on a hand's autonomy dial. Upsert keeps the dial complete. */
export async function setAutonomy(formData: FormData): Promise<void> {
  const personId = String(formData.get('personId') ?? '')
  const category = String(formData.get('category') ?? '') as (typeof ACTION_CATEGORIES)[number]
  const level = String(formData.get('level') ?? '') as 'forbidden' | 'approval' | 'notify' | 'trusted'
  if (!personId || !ACTION_CATEGORIES.includes(category)) throw new Error('Invalid dial update.')
  if (!['forbidden', 'approval', 'notify', 'trusted'].includes(level)) throw new Error('Invalid level.')

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
  revalidatePath(`/people/${personId}`)
}

/** Add a human-authored note to a hand's logbook. */
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
    await createNote({ tenantId, scope: 'hand', personId, kind, title, body, author: 'human', importance })
  })
  revalidatePath('/people')
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
  revalidatePath('/people')
  revalidatePath('/admin/knowledge')
}

/** Pin/unpin: the pinned tier is always in the hand's prompt, budgeted. */
export async function togglePinNote(formData: FormData): Promise<void> {
  const memoryId = String(formData.get('memoryId') ?? '')
  const pinned = String(formData.get('pinned') ?? '') === 'true'
  if (!memoryId) throw new Error('memoryId is required')
  const tenantId = await resolveTenantId()
  const app = db()
  await app.withTenant(tenantId, async () => {
    await app.db.update(memories).set({ pinned, updatedAt: new Date() }).where(eq(memories.id, memoryId))
  })
  revalidatePath('/people')
  revalidatePath('/admin/knowledge')
}

/** Nominate a hand note for company knowledge (approval-gated). */
export async function promoteNoteAction(formData: FormData): Promise<void> {
  const memoryId = String(formData.get('memoryId') ?? '')
  const rationale = String(formData.get('rationale') ?? '').trim() || 'Proposed from the hand profile.'
  if (!memoryId) throw new Error('memoryId is required')
  const tenantId = await resolveTenantId()
  const app = db()
  await app.withTenant(tenantId, async () => {
    await proposePromotion({ tenantId, noteId: memoryId, rationale })
  })
  revalidatePath('/admin/knowledge')
}

/** Connect an IMAP/SMTP mailbox to a hand — verifies both endpoints first. */
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
  revalidatePath(`/people/${personId}`)
}

/** Pull new mail for a hand right now (the worker also does this on schedule). */
export async function syncMailboxAction(formData: FormData): Promise<void> {
  const personId = String(formData.get('personId') ?? '')
  if (!personId) throw new Error('personId is required')
  const tenantId = await resolveTenantId()
  await syncPersonMailbox(tenantId, personId)
  revalidatePath(`/people/${personId}`)
}

/** Assign which brain this hand runs on: a tenant provider slug + model id. */
export async function setHandModel(formData: FormData): Promise<void> {
  const personId = String(formData.get('personId') ?? '')
  const providerSlug = String(formData.get('providerSlug') ?? '')
  const model = String(formData.get('model') ?? '').trim()
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
      .set({ modelConfig: { provider: providerSlug, model }, updatedAt: new Date() })
      .where(eq(people.id, personId))
  })
  revalidatePath(`/people/${personId}`)
}

/** Update a duty from its drawer: instruction, schedule (cron internal), on/off. */
export async function updateDuty(formData: FormData): Promise<void> {
  const personId = String(formData.get('personId') ?? '')
  const dutyId = String(formData.get('dutyId') ?? '')
  const title = String(formData.get('title') ?? '').trim()
  const instruction = String(formData.get('instruction') ?? '').trim()
  const schedule = String(formData.get('schedule') ?? '').trim()
  const enabled = String(formData.get('enabled') ?? 'on') === 'on' ? ('on' as const) : ('off' as const)
  if (!dutyId || !title || !instruction || !schedule) throw new Error('Title, instruction, and schedule are required.')
  CronExpressionParser.parse(schedule)

  const tenantId = await resolveTenantId()
  const app = db()
  await app.withTenant(tenantId, async () => {
    await app.db
      .update(duties)
      .set({ title, instruction, schedule, enabled, nextDueAt: null, updatedAt: new Date() })
      .where(eq(duties.id, dutyId))
  })
  revalidatePath(`/people/${personId}`)
}

/** Generate avatar portrait candidates for a hand. */
export async function generateAvatarsAction(personId: string): Promise<
  { ok: true; images: string[] } | { ok: false; message: string }
> {
  try {
    const tenantId = await resolveTenantId()
    const images = await generateHandAvatarCandidates(tenantId, personId)
    return { ok: true, images }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

/** Save the chosen avatar for a hand. */
export async function chooseAvatarAction(formData: FormData): Promise<void> {
  const personId = String(formData.get('personId') ?? '')
  const dataUri = String(formData.get('dataUri') ?? '')
  const model = String(formData.get('model') ?? 'unknown')
  if (!personId || !dataUri) throw new Error('personId and image are required.')
  const tenantId = await resolveTenantId()
  await saveHandAvatar({ tenantId, personId, dataUri, model })
  revalidatePath(`/people/${personId}`)
  revalidatePath('/people')
}

/** Full record edit from the person drawer — every field an operator owns. */
export async function updatePerson(formData: FormData): Promise<void> {
  const personId = String(formData.get('personId') ?? '')
  const name = String(formData.get('name') ?? '').trim()
  const title = String(formData.get('title') ?? '').trim()
  const email = String(formData.get('email') ?? '').trim().toLowerCase()
  const status = String(formData.get('status') ?? '') as 'onboarding' | 'active' | 'offboarded'
  const reportsToId = String(formData.get('reportsToId') ?? '') || null
  const responsibilities = String(formData.get('responsibilities') ?? '').trim() || null
  if (!personId || !name || !title || !email) throw new Error('Name, title, and email are required.')
  if (!['onboarding', 'active', 'offboarded'].includes(status)) throw new Error('Invalid status.')

  const tenantId = await resolveTenantId()
  const app = db()
  await app.withTenant(tenantId, async () => {
    const [person] = await app.db.select().from(people).where(eq(people.id, personId))
    if (!person) throw new Error('Person not found.')

    const update: Partial<typeof people.$inferInsert> = {
      name, title, email, status, reportsToId, responsibilities, updatedAt: new Date(),
    }
    if (person.kind === 'hand') {
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
      update.salary = { monthlyUsd: salaryUsd, overagePolicy }
      update.proactivity = proactivity
      const inbound = String(formData.get('inboundPolicy') ?? 'staff_only') as 'staff_only' | 'known_contacts' | 'anyone'
      if (!['staff_only', 'known_contacts', 'anyone'].includes(inbound)) throw new Error('Invalid inbound policy.')
      update.inboundPolicy = inbound
    }
    await app.db.update(people).set(update).where(eq(people.id, personId))
  })
  revalidatePath('/people')
}

/** Add a standing duty to a hand. */
export async function addDuty(formData: FormData): Promise<void> {
  const personId = String(formData.get('personId') ?? '')
  const title = String(formData.get('title') ?? '').trim()
  const instruction = String(formData.get('instruction') ?? '').trim()
  const schedule = String(formData.get('schedule') ?? '').trim()
  if (!personId || !title || !instruction || !schedule) throw new Error('Title, instruction, and schedule are required.')
  CronExpressionParser.parse(schedule)
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'duty'

  const tenantId = await resolveTenantId()
  const app = db()
  await app.withTenant(tenantId, async () => {
    await app.db.insert(duties).values({
      tenantId,
      personId,
      slug,
      title,
      instruction,
      scheduleKind: 'cron',
      schedule,
    })
  })
  revalidatePath('/people')
}

/** Remove a duty entirely (runs it produced stay in the ledger). */
export async function deleteDuty(formData: FormData): Promise<void> {
  const personId = String(formData.get('personId') ?? '')
  const dutyId = String(formData.get('dutyId') ?? '')
  if (!dutyId) throw new Error('dutyId is required.')
  const tenantId = await resolveTenantId()
  const app = db()
  await app.withTenant(tenantId, async () => {
    await app.db.delete(duties).where(eq(duties.id, dutyId))
  })
  revalidatePath('/people')
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
  revalidatePath('/people')
  revalidatePath('/admin/knowledge')
}

/** Disconnect a hand's mailbox: config is deletable, the mail ledger is not. */
export async function disconnectMailboxAction(formData: FormData): Promise<void> {
  const personId = String(formData.get('personId') ?? '')
  if (!personId) throw new Error('personId is required.')
  const tenantId = await resolveTenantId()
  const app = db()
  await app.withTenant(tenantId, async () => {
    await app.db.delete(mailboxAccounts).where(eq(mailboxAccounts.personId, personId))
    await app.db.update(people).set({ status: 'onboarding', updatedAt: new Date() }).where(eq(people.id, personId))
  })
  revalidatePath('/people')
}
