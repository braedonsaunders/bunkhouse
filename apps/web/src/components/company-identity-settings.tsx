'use client'

import * as React from 'react'
import { Globe, X } from 'lucide-react'
import { Badge, Button, Drawer, Input, Label, Select, SettingsRow, SettingsSection } from '@braedonsaunders/appkit-ui'
import { MarkdownEditor } from './markdown-editor'
import { normalizeDomain } from '../lib/internal-domains'
import {
  captureCompanyIdentityAction,
  saveCompanyIdentityAction,
  type CompanyIdentityInput,
} from '../app/admin/settings/company-actions'
import { SectionTabs } from './section-tabs'

/**
 * Settings → Company → Identity. Agents are staff, so they need to know whose
 * name is on the door: what the business does, who it serves, how it sounds,
 * and how to reach it. Everything here is written by an operator — the website
 * draft is a head start that must still be read and corrected before it saves.
 */

export type CompanyIdentityView = CompanyIdentityInput & {
  capture?: {
    websiteUrl: string
    capturedAt: string
    provider: string
    model: string
    pagesRead: number
  }
}

export type IdentityProviderOption = { slug: string; label: string }

const SOCIAL_NETWORKS = ['linkedin', 'facebook', 'instagram', 'youtube', 'x'] as const

const TABS = [
  { key: 'profile', label: 'Profile' },
  { key: 'work', label: 'What we do' },
  { key: 'voice', label: 'Voice & contact' },
]

export function CompanyIdentitySettings({
  identity,
  providers,
}: {
  identity: CompanyIdentityView
  providers: IdentityProviderOption[]
}) {
  const [tab, setTab] = React.useState('profile')
  const [form, setForm] = React.useState<CompanyIdentityView>(identity)
  // The rich-text editors are uncontrolled; remount them when a draft lands.
  const [revision, setRevision] = React.useState(0)
  const [captureOpen, setCaptureOpen] = React.useState(false)
  const [notice, setNotice] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [busy, startBusy] = React.useTransition()

  const set = <K extends keyof CompanyIdentityView>(key: K, value: CompanyIdentityView[K]) => {
    setForm((previous) => ({ ...previous, [key]: value }))
    setNotice(null)
  }

  const save = () =>
    startBusy(async () => {
      setError(null)
      setNotice(null)
      const result = await saveCompanyIdentityAction(form)
      if (!result.ok) {
        setError(result.message)
        return
      }
      setNotice('Saved. Every agent works from this profile on its next run.')
    })

  const applyDraft = (draft: DraftValues, mode: 'replace' | 'fill') => {
    setForm((previous) => {
      const pick = (next: string, current: string) =>
        mode === 'replace' ? next || current : current || next
      const pickList = (next: string[], current: string[]) =>
        mode === 'replace' ? (next.length > 0 ? next : current) : current.length > 0 ? current : next
      return {
        ...previous,
        name: pick(draft.values.name, previous.name),
        legalName: pick(draft.values.legalName, previous.legalName),
        tagline: pick(draft.values.tagline, previous.tagline),
        websiteUrl: pick(draft.capture.websiteUrl, previous.websiteUrl),
        industry: pick(draft.values.industry, previous.industry),
        description: pick(draft.values.description, previous.description),
        services: pickList(draft.values.services, previous.services),
        serviceArea: pick(draft.values.serviceArea, previous.serviceArea),
        customers: pickList(draft.values.customers, previous.customers),
        differentiators: pickList(draft.values.differentiators, previous.differentiators),
        values: pickList(draft.values.values, previous.values),
        brandVoice: pick(draft.values.brandVoice, previous.brandVoice),
        hours: pick(draft.values.hours, previous.hours),
        contact: {
          phone: pick(draft.values.contact.phone, previous.contact.phone),
          email: pick(draft.values.contact.email, previous.contact.email),
          address: pick(draft.values.contact.address, previous.contact.address),
        },
        socialLinks: mode === 'replace' ? { ...previous.socialLinks, ...draft.values.socialLinks } : { ...draft.values.socialLinks, ...previous.socialLinks },
        capture: draft.capture,
      }
    })
    setRevision((n) => n + 1)
    setCaptureOpen(false)
    setError(null)
    setNotice('Draft loaded from the website. Read it through, correct anything wrong, then save.')
  }

  const captureLine = form.capture
    ? `Drafted from ${form.capture.websiteUrl} on ${form.capture.capturedAt.slice(0, 10)} — ${form.capture.pagesRead} page${form.capture.pagesRead === 1 ? '' : 's'} read by ${form.capture.model}.`
    : 'Point it at your website and it will draft the profile for you to correct — or write everything by hand.'

  return (
    <SettingsSection
      title="Identity"
      description="Who your agents work for. Every agent carries this into every email, call, and document: what the business does, who it serves, and how it sounds. Nothing an agent tells a customer about the company comes from anywhere else."
    >
      <SettingsRow
        title="Draft from your website"
        description={captureLine}
        control={
          <span className="flex items-center gap-2">
            {form.capture ? <Badge variant="secondary">drafted</Badge> : null}
            <Button variant={form.capture ? 'outline' : 'default'} size="sm" onClick={() => setCaptureOpen(true)}>
              <Globe className="mr-1.5 size-4" />
              {form.capture ? 'Draft again' : 'Read my website'}
            </Button>
          </span>
        }
      />

      <div className="px-5 py-3">
        <SectionTabs ariaLabel="Company identity" active={tab} onSelect={setTab} tabs={TABS} />
      </div>

      {tab === 'profile' ? (
        <div className="space-y-4 px-5 py-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              id="company-name"
              label="Company name"
              hint="What agents call the company when they introduce themselves."
              value={form.name}
              onChange={(value) => set('name', value)}
              placeholder="Northbridge Mechanical"
            />
            <Field
              id="company-legal"
              label="Legal name"
              hint="Only when the registered entity differs from the trading name."
              value={form.legalName}
              onChange={(value) => set('legalName', value)}
              placeholder="Northbridge Mechanical Services Ltd."
            />
            <Field
              id="company-tagline"
              label="Tagline"
              value={form.tagline}
              onChange={(value) => set('tagline', value)}
              placeholder="Heating and cooling done right the first time"
            />
            <Field
              id="company-industry"
              label="Industry"
              value={form.industry}
              onChange={(value) => set('industry', value)}
              placeholder="Commercial HVAC"
            />
            <Field
              id="company-website"
              label="Website"
              value={form.websiteUrl}
              onChange={(value) => set('websiteUrl', value)}
              placeholder="northbridgemech.com"
            />
          </div>
          <ListField
            id="company-internal-domains"
            label="Your email domains"
            hint="Anyone writing from these is treated as a colleague, even if they are not on the roster: agents answer them on the internal autonomy dial instead of asking for sign-off to reply, and accept their mail. Subdomains count. Leave empty and only the addresses on the roster are internal."
            placeholder="yourcompany.com"
            values={form.internalDomains}
            // Normalized as it is added, with the same function the action
            // stores it through, so the chip is never a different string from
            // the one that ends up in the setting. Anything unparseable is
            // kept verbatim — the save then names it as the typo it is.
            onChange={(values) =>
              set(
                'internalDomains',
                Array.from(new Set(values.map((value) => normalizeDomain(value) ?? value))),
              )
            }
          />
          <div className="space-y-1">
            <Label htmlFor="company-description">What the business does</Label>
            <MarkdownEditor
              key={`description-${revision}`}
              defaultValue={form.description}
              onChange={(markdown) => set('description', markdown)}
              placeholder="A few sentences an agent could repeat to a customer who asks what you do."
              minHeight="8rem"
            />
          </div>
        </div>
      ) : null}

      {tab === 'work' ? (
        <div className="space-y-4 px-5 py-4">
          <ListField
            id="company-services"
            label="Services & products"
            hint="What you sell. Agents quote from this list rather than inventing an offering."
            placeholder="Rooftop unit replacement"
            values={form.services}
            onChange={(values) => set('services', values)}
          />
          <Field
            id="company-area"
            label="Where you work"
            value={form.serviceArea}
            onChange={(value) => set('serviceArea', value)}
            placeholder="Southwestern Ontario, within 90 minutes of London"
          />
          <ListField
            id="company-customers"
            label="Who you serve"
            hint="Segments, industries, or customer types."
            placeholder="Property managers"
            values={form.customers}
            onChange={(values) => set('customers', values)}
          />
          <ListField
            id="company-differentiators"
            label="What sets you apart"
            hint="Claims an agent may repeat truthfully. Leave out anything you would not put in writing."
            placeholder="Same-day emergency service"
            values={form.differentiators}
            onChange={(values) => set('differentiators', values)}
          />
          <ListField
            id="company-values"
            label="What you stand for"
            placeholder="Fix it properly or don't charge for it"
            values={form.values}
            onChange={(values) => set('values', values)}
          />
        </div>
      ) : null}

      {tab === 'voice' ? (
        <div className="space-y-4 px-5 py-4">
          <Field
            id="company-voice"
            label="How the company sounds"
            hint="Sits under each agent's own tone — house style, not personality."
            value={form.brandVoice}
            onChange={(value) => set('brandVoice', value)}
            placeholder="Plain, direct, no jargon. Warm with regulars."
          />
          <Field
            id="company-hours"
            label="Business hours"
            value={form.hours}
            onChange={(value) => set('hours', value)}
            placeholder="Monday to Friday, 7:00 AM – 5:00 PM. On-call after hours."
          />
          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              id="company-phone"
              label="Main phone"
              value={form.contact.phone}
              onChange={(value) => set('contact', { ...form.contact, phone: value })}
              placeholder="(519) 555-0142"
            />
            <Field
              id="company-email"
              label="General email"
              value={form.contact.email}
              onChange={(value) => set('contact', { ...form.contact, email: value })}
              placeholder="office@northbridgemech.com"
            />
          </div>
          <Field
            id="company-address"
            label="Address"
            value={form.contact.address}
            onChange={(value) => set('contact', { ...form.contact, address: value })}
            placeholder="14 Bathurst St, London, ON N6B 1P1"
          />
          <div className="space-y-2">
            <Label>Public profiles</Label>
            <div className="grid gap-3 sm:grid-cols-2">
              {SOCIAL_NETWORKS.map((network) => (
                <div key={network} className="space-y-1">
                  <Label htmlFor={`company-social-${network}`} className="text-xs capitalize text-fg-muted">
                    {network === 'x' ? 'X' : network}
                  </Label>
                  <Input
                    id={`company-social-${network}`}
                    value={form.socialLinks[network] ?? ''}
                    onChange={(event) => {
                      const next = { ...form.socialLinks }
                      if (event.target.value.trim()) next[network] = event.target.value
                      else delete next[network]
                      set('socialLinks', next)
                    }}
                    placeholder="https://…"
                  />
                </div>
              ))}
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="company-notes">Anything else agents should know</Label>
            <MarkdownEditor
              key={`notes-${revision}`}
              defaultValue={form.notes}
              onChange={(markdown) => set('notes', markdown)}
              placeholder="Standing facts about the company that don't fit above — parking, billing terms, who signs off on quotes."
              minHeight="8rem"
            />
          </div>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-3 px-5 py-4">
        <Button onClick={save} disabled={busy}>
          {busy ? 'Saving…' : 'Save profile'}
        </Button>
        {notice ? <p className="text-sm text-fg-muted">{notice}</p> : null}
        {error ? <p className="text-sm text-danger">{error}</p> : null}
      </div>

      {captureOpen ? (
        <CaptureDrawer
          key={form.websiteUrl}
          onClose={() => setCaptureOpen(false)}
          defaultUrl={form.websiteUrl}
          providers={providers}
          onApply={applyDraft}
        />
      ) : null}
    </SettingsSection>
  )
}

// --- The website draft ------------------------------------------------------

type DraftValues = {
  // `internalDomains` is deliberately not draftable: it decides who counts as
  // a colleague, and a page read off the open web must never be able to widen
  // that. An operator types those in themselves.
  values: Omit<CompanyIdentityInput, 'capture' | 'notes' | 'websiteUrl' | 'internalDomains'>
  capture: NonNullable<CompanyIdentityView['capture']>
  pages: string[]
}

/**
 * Read the company website and hand back a draft. The operator chooses whether
 * it replaces what is there or only fills the gaps — a capture never silently
 * overwrites something a person wrote.
 */
function CaptureDrawer({
  onClose,
  defaultUrl,
  providers,
  onApply,
}: {
  onClose: () => void
  defaultUrl: string
  providers: IdentityProviderOption[]
  onApply: (draft: DraftValues, mode: 'replace' | 'fill') => void
}) {
  // Keyed on the current website by the caller, so reopening it starts from
  // whatever is in the form rather than syncing state in an effect.
  const [url, setUrl] = React.useState(defaultUrl)
  const [providerSlug, setProviderSlug] = React.useState(providers[0]?.slug ?? '')
  const [draft, setDraft] = React.useState<DraftValues | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [busy, startBusy] = React.useTransition()

  const read = () =>
    startBusy(async () => {
      setError(null)
      setDraft(null)
      const result = await captureCompanyIdentityAction({
        websiteUrl: url,
        ...(providerSlug ? { providerSlug } : {}),
      })
      if (!result.ok) {
        setError(result.message)
        return
      }
      setDraft({
        values: {
          name: result.draft.name,
          legalName: result.draft.legalName,
          tagline: result.draft.tagline,
          industry: result.draft.industry,
          description: result.draft.description,
          services: result.draft.services,
          serviceArea: result.draft.serviceArea,
          customers: result.draft.customers,
          differentiators: result.draft.differentiators,
          values: result.draft.values,
          brandVoice: result.draft.brandVoice,
          hours: result.draft.hours,
          contact: result.draft.contact,
          socialLinks: result.draft.socialLinks,
        },
        capture: result.capture,
        pages: result.pages,
      })
    })

  return (
    <Drawer
      open
      onClose={onClose}
      title="Draft from your website"
      description="Reads the public pages of your site and drafts a profile from them. Nothing is saved until you review it — treat every line as a suggestion."
      size="lg"
    >
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
          <div className="space-y-1">
            <Label htmlFor="capture-url">Website address</Label>
            <Input
              id="capture-url"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="northbridgemech.com"
            />
          </div>
          {providers.length > 1 ? (
            <div className="space-y-1">
              <Label htmlFor="capture-provider">Read with</Label>
              <Select
                id="capture-provider"
                value={providerSlug}
                onChange={(event) => setProviderSlug(event.target.value)}
              >
                {providers.map((provider) => (
                  <option key={provider.slug} value={provider.slug}>
                    {provider.label}
                  </option>
                ))}
              </Select>
            </div>
          ) : null}
        </div>
        <p className="text-xs text-fg-muted">
          {providers.length === 0
            ? 'Add a model provider under Intelligence → Models first — reading the site runs on your own key.'
            : 'Reading the site runs on your own provider key, and costs what a few pages of text cost.'}
        </p>

        <Button onClick={read} disabled={busy || !url.trim() || providers.length === 0}>
          {busy ? 'Reading the site…' : draft ? 'Read it again' : 'Read the site'}
        </Button>
        {error ? <p className="text-sm text-danger">{error}</p> : null}

        {draft ? (
          <div className="space-y-4">
            <div className="rounded-md border border-border bg-bg-subtle p-3 text-sm">
              <p className="font-medium text-fg">{draft.values.name || 'No company name found'}</p>
              {draft.values.tagline ? <p className="text-fg-muted">{draft.values.tagline}</p> : null}
              {draft.values.description ? <p className="mt-2 text-fg">{draft.values.description}</p> : null}
              <dl className="mt-3 space-y-1 text-xs text-fg-muted">
                <DraftLine label="Industry" value={draft.values.industry} />
                <DraftLine label="Services" value={draft.values.services.join(', ')} />
                <DraftLine label="Where" value={draft.values.serviceArea} />
                <DraftLine label="Customers" value={draft.values.customers.join(', ')} />
                <DraftLine label="Sets us apart" value={draft.values.differentiators.join(', ')} />
                <DraftLine label="Values" value={draft.values.values.join(', ')} />
                <DraftLine label="Voice" value={draft.values.brandVoice} />
                <DraftLine label="Hours" value={draft.values.hours} />
                <DraftLine label="Phone" value={draft.values.contact.phone} />
                <DraftLine label="Email" value={draft.values.contact.email} />
                <DraftLine label="Address" value={draft.values.contact.address} />
              </dl>
            </div>
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-fg-muted">
                Read {draft.pages.length} page{draft.pages.length === 1 ? '' : 's'}
              </p>
              <ul className="mt-1 space-y-0.5 text-xs text-fg-muted">
                {draft.pages.map((page) => (
                  <li key={page} className="truncate">
                    {page}
                  </li>
                ))}
              </ul>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button onClick={() => onApply(draft, 'replace')}>Use this draft</Button>
              <Button variant="outline" onClick={() => onApply(draft, 'fill')}>
                Only fill what&apos;s empty
              </Button>
            </div>
            <p className="text-xs text-fg-muted">
              Either way the profile opens for editing and is not saved until you press Save profile.
            </p>
          </div>
        ) : null}
      </div>
    </Drawer>
  )
}

function DraftLine({ label, value }: { label: string; value: string }) {
  if (!value.trim()) return null
  return (
    <div className="flex gap-2">
      <dt className="w-28 shrink-0">{label}</dt>
      <dd className="min-w-0 flex-1 text-fg">{value}</dd>
    </div>
  )
}

// --- Small field primitives -------------------------------------------------

function Field({
  id,
  label,
  hint,
  value,
  onChange,
  placeholder,
}: {
  id: string
  label: string
  hint?: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} />
      {hint ? <p className="text-xs text-fg-muted">{hint}</p> : null}
    </div>
  )
}

/** A short, ordered list of plain strings — services, customers, values. */
function ListField({
  id,
  label,
  hint,
  placeholder,
  values,
  onChange,
}: {
  id: string
  label: string
  hint?: string
  placeholder?: string
  values: string[]
  onChange: (values: string[]) => void
}) {
  const [entry, setEntry] = React.useState('')

  const add = () => {
    const trimmed = entry.trim()
    if (!trimmed || values.includes(trimmed)) {
      setEntry('')
      return
    }
    onChange([...values, trimmed])
    setEntry('')
  }

  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      {values.length > 0 ? (
        <ul className="flex flex-wrap gap-2">
          {values.map((value) => (
            <li key={value}>
              <Badge variant="outline" className="gap-1.5 py-1 pr-1">
                {value}
                <button
                  type="button"
                  aria-label={`Remove ${value}`}
                  className="rounded-sm p-0.5 text-fg-muted transition-colors hover:text-danger"
                  onClick={() => onChange(values.filter((kept) => kept !== value))}
                >
                  <X className="size-3" />
                </button>
              </Badge>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex gap-2">
        <Input
          id={id}
          value={entry}
          onChange={(event) => setEntry(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              add()
            }
          }}
          placeholder={placeholder}
        />
        <Button type="button" variant="outline" onClick={add} disabled={!entry.trim()}>
          Add
        </Button>
      </div>
      {hint ? <p className="text-xs text-fg-muted">{hint}</p> : null}
    </div>
  )
}
