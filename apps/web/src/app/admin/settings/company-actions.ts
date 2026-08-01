'use server'

import { revalidatePath } from 'next/cache'
import { db } from '../../../db/client'
import { resolveTenantId as resolveTenant } from '../../../lib/tenant'
const resolveTenantId = () => resolveTenant('settings.manage')
import {
  captureCompanyIdentity,
  saveCompanyIdentity,
  type CompanyIdentityDraft,
} from '../../../lib/company-identity'
import type { CompanyIdentitySettings } from '../../../db/schema'

/**
 * Company → Identity. The profile is operator-owned: the capture only ever
 * returns a draft for review, and this file is the only path that writes it.
 */

export type CompanyIdentityInput = {
  name: string
  legalName: string
  tagline: string
  websiteUrl: string
  industry: string
  /** Markdown from the rich-text editor. */
  description: string
  services: string[]
  serviceArea: string
  customers: string[]
  differentiators: string[]
  values: string[]
  brandVoice: string
  hours: string
  contact: { phone: string; email: string; address: string }
  socialLinks: Record<string, string>
  /** Markdown from the rich-text editor. */
  notes: string
  /** Carried through untouched so provenance survives a manual edit. */
  capture?: CompanyIdentitySettings['capture']
}

const clean = (value: string): string => value.trim()
const cleanList = (values: string[]): string[] =>
  Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)))

/** Normalize a typed-in address to something an agent can actually cite. */
function normalizeWebsite(raw: string): { ok: true; value: string } | { ok: false; message: string } {
  const trimmed = raw.trim()
  if (!trimmed) return { ok: true, value: '' }
  try {
    const url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return { ok: false, message: 'The website address must start with http:// or https://.' }
    }
    return { ok: true, value: url.toString().replace(/\/$/, '') }
  } catch {
    return { ok: false, message: 'That does not look like a website address.' }
  }
}

export async function saveCompanyIdentityAction(
  input: CompanyIdentityInput,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const name = clean(input.name)
  if (!name) return { ok: false, message: 'Give the company a name — every agent introduces itself with it.' }

  const website = normalizeWebsite(input.websiteUrl)
  if (!website.ok) return website

  const email = clean(input.contact.email)
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { ok: false, message: 'That contact email address is not valid.' }
  }

  const socialLinks = Object.fromEntries(
    Object.entries(input.socialLinks)
      .map(([network, url]) => [network.trim().toLowerCase(), url.trim()] as const)
      .filter(([network, url]) => network && url),
  )

  const value: CompanyIdentitySettings = {
    name,
    ...(clean(input.legalName) ? { legalName: clean(input.legalName) } : {}),
    ...(clean(input.tagline) ? { tagline: clean(input.tagline) } : {}),
    ...(website.value ? { websiteUrl: website.value } : {}),
    ...(clean(input.industry) ? { industry: clean(input.industry) } : {}),
    ...(clean(input.description) ? { description: clean(input.description) } : {}),
    ...(cleanList(input.services).length > 0 ? { services: cleanList(input.services) } : {}),
    ...(clean(input.serviceArea) ? { serviceArea: clean(input.serviceArea) } : {}),
    ...(cleanList(input.customers).length > 0 ? { customers: cleanList(input.customers) } : {}),
    ...(cleanList(input.differentiators).length > 0
      ? { differentiators: cleanList(input.differentiators) }
      : {}),
    ...(cleanList(input.values).length > 0 ? { values: cleanList(input.values) } : {}),
    ...(clean(input.brandVoice) ? { brandVoice: clean(input.brandVoice) } : {}),
    ...(clean(input.hours) ? { hours: clean(input.hours) } : {}),
    ...(clean(input.contact.phone) || email || clean(input.contact.address)
      ? {
          contact: {
            ...(clean(input.contact.phone) ? { phone: clean(input.contact.phone) } : {}),
            ...(email ? { email } : {}),
            ...(clean(input.contact.address) ? { address: clean(input.contact.address) } : {}),
          },
        }
      : {}),
    ...(Object.keys(socialLinks).length > 0 ? { socialLinks } : {}),
    ...(clean(input.notes) ? { notes: clean(input.notes) } : {}),
    ...(input.capture ? { capture: input.capture } : {}),
  }

  const tenantId = await resolveTenantId()
  const app = db()
  await app.withTenant(tenantId, () => saveCompanyIdentity(tenantId, value))
  revalidatePath('/admin/settings')
  return { ok: true }
}

export type CaptureIdentityResult =
  | {
      ok: true
      draft: CompanyIdentityDraft
      capture: NonNullable<CompanyIdentitySettings['capture']>
      /** The pages that were actually read, shown back as the evidence. */
      pages: string[]
    }
  | { ok: false; message: string }

/**
 * Read the company website and draft a profile from it. Nothing is saved —
 * the operator reviews every field and presses save themselves.
 */
export async function captureCompanyIdentityAction(input: {
  websiteUrl: string
  providerSlug?: string
}): Promise<CaptureIdentityResult> {
  const website = normalizeWebsite(input.websiteUrl)
  if (!website.ok) return website
  if (!website.value) return { ok: false, message: 'Enter the company website address first.' }

  const tenantId = await resolveTenantId()
  return captureCompanyIdentity({
    tenantId,
    websiteUrl: website.value,
    ...(input.providerSlug ? { providerSlug: input.providerSlug } : {}),
  })
}
