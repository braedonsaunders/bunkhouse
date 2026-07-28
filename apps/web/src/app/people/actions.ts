'use server'

import { redirect } from 'next/navigation'
import { getRolePack } from '@bunkhouse/roles'
import { autonomySettings, duties, memories, people, procedures, procedureRevisions } from '../../db/schema'
import { db } from '../../db/client'
import { resolveTenantId } from '../../lib/tenant'

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
