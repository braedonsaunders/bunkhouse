'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { eq } from 'drizzle-orm'
import { getRolePack } from '@bunkhouse/roles'
import { autonomySettings, duties, memories, people, procedures, procedureRevisions } from '../../db/schema'
import { db } from '../../db/client'
import { resolveTenantId } from '../../lib/tenant'
import { connectMailbox, syncPersonMailbox } from '../../lib/mailbox'
import { listAiProviders } from '../../lib/ai'

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
  const pack = getRolePack(packSlug)
  if (!pack) throw new Error(`Unknown role pack: ${packSlug}`)

  const name = String(formData.get('name') ?? '').trim()
  const email = String(formData.get('email') ?? '').trim().toLowerCase()
  const bio = String(formData.get('bio') ?? '').trim() || pack.personality.bio
  const salaryUsd = Number(formData.get('salaryUsd') ?? pack.suggestedSalaryUsd)
  const reportsToId = String(formData.get('reportsToId') ?? '') || null
  if (!name || !email) throw new Error('A hand needs a name and an email address.')
  if (!Number.isFinite(salaryUsd) || salaryUsd <= 0) throw new Error('Salary must be a positive monthly USD amount.')

  const tenantId = await resolveTenantId()
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

/** Add a human-authored note to a hand's memory. */
export async function addMemoryNote(formData: FormData): Promise<void> {
  const personId = String(formData.get('personId') ?? '')
  const title = String(formData.get('title') ?? '').trim()
  const body = String(formData.get('body') ?? '').trim()
  if (!personId || !title || !body) throw new Error('A note needs a title and a body.')

  const tenantId = await resolveTenantId()
  const app = db()
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  await app.withTenant(tenantId, async () => {
    await app.db
      .insert(memories)
      .values({ tenantId, scope: 'hand', personId, slug: slug || 'note', title, body })
      .onConflictDoUpdate({
        target: [memories.tenantId, memories.scope, memories.personId, memories.slug],
        set: { title, body, status: 'active', updatedAt: new Date() },
      })
  })
  revalidatePath(`/people/${personId}`)
}

/** Remove a memory note — the human-editable-memory doctrine in action. */
export async function deleteMemoryNote(formData: FormData): Promise<void> {
  const personId = String(formData.get('personId') ?? '')
  const memoryId = String(formData.get('memoryId') ?? '')
  if (!memoryId) throw new Error('memoryId is required')

  const tenantId = await resolveTenantId()
  const app = db()
  await app.withTenant(tenantId, async () => {
    await app.db.delete(memories).where(eq(memories.id, memoryId))
  })
  revalidatePath(`/people/${personId}`)
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
    imapSecure: imapPort !== 143,
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
