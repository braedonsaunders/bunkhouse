import 'server-only'
import { and, eq } from 'drizzle-orm'
import { compileEmailDesign, renderEmailDesign } from '@braedonsaunders/appkit-email-designer'
import { inlineEmailCss } from '@braedonsaunders/appkit-email-designer/inline'
import { escapeHtml } from '@braedonsaunders/appkit-email-render'
import { people, tenantSettings, MAIL_SIGNATURE_KEY, type MailSignatureSettings } from '../db/schema'
import { db } from '../db/client'
import { getCompanyIdentity, companyDisplayName, type CompanyIdentity } from './company-identity'

/**
 * The company signature: designed once, personalized per sender.
 *
 * One design serves the whole roster because it is written in `{{agent.*}}`
 * tokens that resolve against whichever person is sending. Rendering happens on
 * the send path, so the same signature reaches mail from agent tools, the human
 * compose box, voicemail notices, meeting invites, and approval escalations
 * without any of them knowing it exists.
 */

type PersonRow = typeof people.$inferSelect

const EMPTY: MailSignatureSettings = { enabled: false, sourceHtml: '', compiledHtml: '' }

export async function getMailSignature(tenantId: string): Promise<MailSignatureSettings> {
  const app = db()
  const [row] = await app.withTenantContext(tenantId, () =>
    app.db
      .select({ value: tenantSettings.value })
      .from(tenantSettings)
      .where(and(eq(tenantSettings.tenantId, tenantId), eq(tenantSettings.key, MAIL_SIGNATURE_KEY))),
  )
  return (row?.value as MailSignatureSettings | undefined) ?? EMPTY
}

export async function saveMailSignature(
  tenantId: string,
  value: MailSignatureSettings,
): Promise<void> {
  const app = db()
  await app.db
    .insert(tenantSettings)
    .values({ tenantId, key: MAIL_SIGNATURE_KEY, value })
    .onConflictDoUpdate({
      target: [tenantSettings.tenantId, tenantSettings.key],
      set: { value, updatedAt: new Date() },
    })
}

/**
 * Compile a designer snapshot into the pair that gets stored. CSS is inlined
 * here, once, at save time — never per send. Fragment mode because a signature
 * is spliced into a message body rather than being a document of its own.
 */
export function compileMailSignature(rawHtml: string): {
  sourceHtml: string
  compiledHtml: string
  errors: string[]
} {
  return compileEmailDesign(rawHtml, { inlineCss: inlineEmailCss, fragment: true })
}

/** Everything needed to render for any sender, fetched once per send. */
export type SignatureContext = {
  settings: MailSignatureSettings
  identity: CompanyIdentity
}

/**
 * Load the signature and the company profile it interpolates against. Call
 * before entering a tenant transaction — the result is reused for every
 * recipient of the same send.
 */
export async function loadSignatureContext(tenantId: string): Promise<SignatureContext | null> {
  const settings = await getMailSignature(tenantId)
  if (!settings.enabled || !settings.compiledHtml.trim()) return null
  return { settings, identity: await getCompanyIdentity(tenantId) }
}

/** Token values for one sender. Absent fields resolve to '' rather than a gap. */
export function signatureValues(
  person: Pick<PersonRow, 'name' | 'title' | 'email' | 'phone' | 'extension'> | undefined,
  identity: CompanyIdentity,
): Record<string, unknown> {
  const name = person?.name ?? ''
  return {
    agent: {
      name,
      firstName: name.split(' ')[0] ?? '',
      title: person?.title ?? '',
      email: person?.email ?? '',
      phone: person?.phone ?? '',
      extension: person?.extension ?? '',
    },
    company: {
      name: companyDisplayName(identity),
      legalName: identity.legalName,
      tagline: identity.tagline,
      website: identity.websiteUrl,
      phone: identity.contact.phone,
      email: identity.contact.email,
      address: identity.contact.address,
    },
  }
}

export type RenderedSignature = { html: string; text: string }

/** Render the signature as this sender. Returns null when nothing is configured. */
export function renderSignature(
  context: SignatureContext | null,
  person: PersonRow | undefined,
): RenderedSignature | null {
  if (!context) return null
  const rendered = renderEmailDesign(
    context.settings.compiledHtml,
    signatureValues(person, context.identity),
  )
  return rendered.html.trim() ? rendered : null
}

const BODY_STYLE =
  "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;font-size:14px;line-height:1.6;color:#0f172a;white-space:normal;"

/**
 * Build the HTML part for an outbound message. Agents author plain text, so the
 * body is escaped and its newlines become real breaks — email clients ignore
 * `white-space` CSS — and the signature is appended below.
 */
export function outboundHtmlBody(text: string, signatureHtml: string): string {
  const body = escapeHtml(text).replace(/\r?\n/g, '<br />')
  return (
    `<div style="${BODY_STYLE}">${body}</div>` +
    `<div style="margin-top:20px;">${signatureHtml}</div>`
  )
}

/**
 * Append the signature to the plain-text part, behind the RFC 3676 separator
 * ("-- ") that mail clients use to fold a signature away from the message.
 */
export function outboundTextBody(text: string, signatureText: string): string {
  const signature = signatureText.trim()
  return signature ? `${text}\n\n-- \n${signature}` : text
}
