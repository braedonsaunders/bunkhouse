'use server'

import { revalidatePath } from 'next/cache'
import type { ProcedureAssignment } from '../../db/schema'
import { resolveTenantId as resolveTenant } from '../../lib/tenant'
const resolveTenantId = () => resolveTenant('resources.manage')
import { parseRepoInput } from '../../lib/skill-source'
import { SKILL_LIBRARY } from '../../lib/skill-library'
import {
  installSkillsFromRepo,
  removeSkill,
  setSkillAssignment,
  setSkillStatus,
  updateInstalledSkill,
} from '../../lib/skills'

/**
 * Installing and governing skills. Every action returns its failure rather than
 * throwing: a thrown server-action error reaches the browser as an opaque
 * digest, which tells an operator nothing about why a repository was refused.
 */

/** The same assignment shape procedures use, read off the drawer's form. */
function parseAssignment(formData: FormData): ProcedureAssignment {
  if (String(formData.get('everyone') ?? '') === 'on') return { everyone: true }
  const rolePacks = String(formData.get('rolePacks') ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean)
  const personIds = String(formData.get('personIds') ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean)
  return { ...(rolePacks.length ? { rolePacks } : {}), ...(personIds.length ? { personIds } : {}) }
}

export type InstallResult =
  | { ok: true; installed: string[]; updated: string[] }
  | { ok: false; message: string }

/** Install one entry from the curated library. */
export async function installLibrarySkillAction(slug: string): Promise<InstallResult> {
  const entry = SKILL_LIBRARY.find((candidate) => candidate.slug === slug)
  if (!entry) return { ok: false, message: 'That skill is no longer in the library.' }
  const tenantId = await resolveTenantId()
  const outcome = await installSkillsFromRepo({
    tenantId,
    ref: { repo: entry.repo, path: entry.path },
    catalogSlug: entry.slug,
  })
  revalidatePath('/resources')
  return outcome
}

/**
 * Install from any repository address an operator pastes. A folder holding one
 * skill installs one; a repository of them installs the lot, which is what
 * pasting a collection's address plainly means.
 */
export async function installSkillFromRepoAction(input: {
  address: string
  ref?: string
}): Promise<InstallResult> {
  const parsed = parseRepoInput(input.address)
  if (!parsed.ok) return parsed
  const tenantId = await resolveTenantId()
  const outcome = await installSkillsFromRepo({
    tenantId,
    ref: {
      ...parsed.ref,
      // An explicitly typed branch wins over one read out of a pasted URL.
      ...(input.ref?.trim() ? { ref: input.ref.trim() } : {}),
    },
  })
  revalidatePath('/resources')
  return outcome
}

/** Pull the newest published version of an installed skill. */
export async function updateSkillAction(
  skillId: string,
): Promise<{ ok: true; changed: boolean; version: number } | { ok: false; message: string }> {
  const tenantId = await resolveTenantId()
  const outcome = await updateInstalledSkill({ tenantId, skillId })
  revalidatePath('/resources')
  return outcome
}

/** Rebind who the skill is available to. */
export async function setSkillAssignmentAction(formData: FormData): Promise<void> {
  const skillId = String(formData.get('skillId') ?? '')
  if (!skillId) throw new Error('skillId is required.')
  const tenantId = await resolveTenantId()
  await setSkillAssignment({ tenantId, skillId, assignment: parseAssignment(formData) })
  revalidatePath('/resources')
}

/** Turn a skill off (or back on) without losing it or its assignment. */
export async function setSkillStatusAction(input: {
  skillId: string
  status: 'active' | 'disabled'
}): Promise<{ ok: true } | { ok: false; message: string }> {
  const tenantId = await resolveTenantId()
  await setSkillStatus({ tenantId, skillId: input.skillId, status: input.status })
  revalidatePath('/resources')
  return { ok: true }
}

/** Remove a skill and its files for good. */
export async function removeSkillAction(formData: FormData): Promise<void> {
  const skillId = String(formData.get('skillId') ?? '')
  if (!skillId) throw new Error('skillId is required.')
  const tenantId = await resolveTenantId()
  await removeSkill(tenantId, skillId)
  revalidatePath('/resources')
}
