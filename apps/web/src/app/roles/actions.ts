'use server'

import { revalidatePath } from 'next/cache'
import { eq } from 'drizzle-orm'
import { CronExpressionParser } from 'cron-parser'
import { roleDefs, type RoleAutonomyDefaults, type RoleDuty, type RoleProcedure } from '../../db/schema'
import { db } from '../../db/client'
import { resolveTenantId as resolveTenant } from '../../lib/tenant'
const resolveTenantId = () => resolveTenant('roles.manage')

const CATEGORIES = ['external_email', 'internal_email', 'record_write', 'money_adjacent', 'file_write', 'computer_use', 'shell'] as const
const LEVELS = ['forbidden', 'approval', 'notify', 'trusted'] as const
const POLICIES = ['staff_only', 'known_contacts', 'anyone'] as const

const slugify = (v: string) => v.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)

/** Create or update a tenant role definition from the role builder. */
export async function saveRoleDef(formData: FormData): Promise<void> {
  const id = String(formData.get('roleId') ?? '')
  const title = String(formData.get('title') ?? '').trim()
  const pitch = String(formData.get('pitch') ?? '').trim()
  const description = String(formData.get('description') ?? '').trim()
  const bio = String(formData.get('bio') ?? '').trim()
  const tone = String(formData.get('tone') ?? '').split(',').map((t) => t.trim()).filter(Boolean)
  const inboundPolicy = String(formData.get('inboundPolicy') ?? 'staff_only') as (typeof POLICIES)[number]
  const suggestedSalaryUsd = Number(formData.get('suggestedSalaryUsd') ?? 50)
  if (!title || !pitch || !description || !bio) throw new Error('Title, pitch, description, and personality are required.')
  if (!POLICIES.includes(inboundPolicy)) throw new Error('Invalid inbound policy.')
  if (!Number.isInteger(suggestedSalaryUsd) || suggestedSalaryUsd <= 0) throw new Error('Salary must be a positive whole number.')

  const duties = JSON.parse(String(formData.get('duties') ?? '[]')) as RoleDuty[]
  for (const duty of duties) {
    if (!duty.title?.trim() || !duty.instruction?.trim()) throw new Error('Every duty needs a title and an instruction.')
    CronExpressionParser.parse(duty.cron)
    duty.slug = slugify(duty.title)
  }
  const procedures = JSON.parse(String(formData.get('procedures') ?? '[]')) as RoleProcedure[]
  for (const procedure of procedures) {
    if (!procedure.title?.trim() || !procedure.body?.trim()) throw new Error('Every procedure needs a title and a body.')
    procedure.slug = slugify(procedure.title)
  }
  const autonomyDefaults = JSON.parse(String(formData.get('autonomyDefaults') ?? '{}')) as RoleAutonomyDefaults
  for (const [category, level] of Object.entries(autonomyDefaults)) {
    if (!CATEGORIES.includes(category as (typeof CATEGORIES)[number]) || !LEVELS.includes(level as (typeof LEVELS)[number])) {
      throw new Error('Invalid autonomy defaults.')
    }
  }

  const tenantId = await resolveTenantId()
  const app = db()
  await app.withTenant(tenantId, async () => {
    const values = {
      tenantId,
      slug: slugify(title),
      title,
      pitch,
      description,
      personality: { bio, tone: tone.length ? tone : ['professional'] },
      duties,
      procedures,
      autonomyDefaults,
      inboundPolicy,
      suggestedSalaryUsd,
      updatedAt: new Date(),
    }
    if (id) {
      await app.db.update(roleDefs).set(values).where(eq(roleDefs.id, id))
    } else {
      const inserted = await app.db.insert(roleDefs).values(values).onConflictDoNothing().returning({ id: roleDefs.id })
      if (inserted.length === 0) throw new Error(`A custom role with slug "${values.slug}" already exists.`)
    }
  })
  revalidatePath('/roles')
}

/** Remove a custom role definition (agents already onboarded keep working). */
export async function deleteRoleDef(formData: FormData): Promise<void> {
  const id = String(formData.get('roleId') ?? '')
  if (!id) throw new Error('roleId is required.')
  const tenantId = await resolveTenantId()
  const app = db()
  await app.withTenant(tenantId, async () => {
    await app.db.delete(roleDefs).where(eq(roleDefs.id, id))
  })
  revalidatePath('/roles')
}
