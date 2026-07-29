'use client'

import * as React from 'react'
import {
  Badge,
  Button,
  Drawer,
  Input,
  Label,
  Select,
  SettingsRow,
  SettingsSection,
} from '@appkit/ui'
import { isSmsProvider, smsProviderSpec, SMS_PROVIDER_SPECS, type SmsProvider } from '@appkit/sms/providers'
import {
  removeSearchProviderAction,
  removeSmsSettingsAction,
  saveDocumentBrandingAction,
  saveSmsSettingsAction,
  saveWorkspacePolicyAction,
  setSearchProviderAction,
} from '../app/admin/settings/actions'

/**
 * The capability half of Settings: how agents research the web, how their
 * documents present the company, where their workspaces are kept, and how they
 * text. The outside systems they work in live under Resources → Systems, with
 * the rest of what an agent is given.
 */

const SEARCH_PROVIDERS = [
  { value: 'brave', label: 'Brave Search' },
  { value: 'tavily', label: 'Tavily' },
] as const

/**
 * The search key agents research on. One provider at a time, connected in a
 * drawer — the page itself stays a status row an operator can read at a glance.
 */
export function ResearchSection({ provider }: { provider: string | null }) {
  const [open, setOpen] = React.useState(false)
  const [choice, setChoice] = React.useState<string>(provider ?? SEARCH_PROVIDERS[0].value)
  const [key, setKey] = React.useState('')
  const [error, setError] = React.useState<string | null>(null)
  const [busy, startBusy] = React.useTransition()

  return (
    <SettingsSection
      title="Research"
      description="Every agent can search the web and read pages — on a call, in an email run, anywhere they work. Searches run on your provider key; without one they fall back to a keyless engine with lower-quality results."
    >
      {provider ? (
        <SettingsRow
          title={SEARCH_PROVIDERS.find((p) => p.value === provider)?.label ?? provider}
          description="Agents search on this provider."
          control={
            <span className="flex items-center gap-2">
              <Badge variant="secondary">key sealed</Badge>
              <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
                Manage
              </Button>
            </span>
          }
        />
      ) : (
        <SettingsRow
          title="Keyless fallback"
          description="No provider configured — searches use a public engine. Connect a key for better, rate-stable results."
          control={
            <span className="flex items-center gap-2">
              <Badge variant="outline">active</Badge>
              <Button size="sm" onClick={() => setOpen(true)}>
                Connect a provider
              </Button>
            </span>
          }
        />
      )}

      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        title={provider ? 'Search provider' : 'Connect a search provider'}
        description="One provider powers every agent's research. The key is verified against the provider before it is sealed."
        size="md"
      >
        <div className="space-y-4">
          {provider ? (
            <div className="flex items-center justify-between rounded-md border border-border px-3 py-2 text-sm">
              <span className="flex items-center gap-2">
                <Badge>connected</Badge>
                <span className="text-fg-muted">
                  {SEARCH_PROVIDERS.find((p) => p.value === provider)?.label ?? provider} · key sealed at rest.
                </span>
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() =>
                  startBusy(async () => {
                    await removeSearchProviderAction()
                    setOpen(false)
                  })
                }
              >
                Remove
              </Button>
            </div>
          ) : null}
          <div className="space-y-1">
            <Label htmlFor="search-provider">Provider</Label>
            <Select id="search-provider" value={choice} onChange={(event) => setChoice(event.target.value)}>
              {SEARCH_PROVIDERS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="search-key">{provider ? 'Replacement API key' : 'API key'}</Label>
            <Input
              id="search-key"
              type="password"
              value={key}
              onChange={(event) => setKey(event.target.value)}
              placeholder="Verified against the provider before saving"
            />
          </div>
          <Button
            disabled={busy || !key.trim()}
            onClick={() =>
              startBusy(async () => {
                setError(null)
                const result = await setSearchProviderAction({ provider: choice, apiKey: key })
                if (!result.ok) {
                  setError(result.message)
                  return
                }
                setKey('')
                setOpen(false)
              })
            }
          >
            {busy ? 'Verifying…' : 'Verify & save'}
          </Button>
          {error ? <p className="text-sm text-danger">{error}</p> : null}
        </div>
      </Drawer>
    </SettingsSection>
  )
}

export type DocumentBrandingView = { companyName: string; accentColor: string; footerText: string }

/**
 * How agent-authored documents present the company: the letterhead line,
 * accent color, and footer on every generated .docx and .pdf deliverable.
 * The company is named once, under Company → Identity; the field here is only
 * for the rare case where documents carry a different name.
 */
export function DocumentsSection({
  branding,
  identityName,
}: {
  branding: DocumentBrandingView
  /** The company name from Company → Identity, used when this is left blank. */
  identityName: string
}) {
  const [companyName, setCompanyName] = React.useState(branding.companyName)
  const [accentColor, setAccentColor] = React.useState(branding.accentColor)
  const [footerText, setFooterText] = React.useState(branding.footerText)
  const [notice, setNotice] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [busy, startBusy] = React.useTransition()

  return (
    <SettingsSection
      title="Documents"
      description="Agents produce real .docx, .xlsx, and .pdf files — attached to their emails and kept on the record. Letterhead settings here appear on every generated document."
    >
      <SettingsRow title="Letterhead" stacked>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="doc-company">Company name on documents</Label>
            <Input
              id="doc-company"
              value={companyName}
              onChange={(event) => setCompanyName(event.target.value)}
              placeholder={identityName || 'Set your company name under Company → Identity'}
            />
            <p className="text-xs text-fg-muted">
              {identityName
                ? `Leave blank and documents are headed "${identityName}" — your company name.`
                : 'Set your company name under Company → Identity; this field only overrides it on documents.'}
            </p>
          </div>
          <div className="space-y-1">
            <Label htmlFor="doc-accent">Accent color</Label>
            <Input
              id="doc-accent"
              value={accentColor}
              onChange={(event) => setAccentColor(event.target.value)}
              placeholder="#1a4d8f"
            />
          </div>
        </div>
        <div className="mt-3 space-y-1">
          <Label htmlFor="doc-footer">Footer line</Label>
          <Input
            id="doc-footer"
            value={footerText}
            onChange={(event) => setFooterText(event.target.value)}
            placeholder="e.g. 123 Main St · (555) 010-0000 · company.com"
          />
        </div>
        <div className="mt-3 flex items-center gap-3">
          <Button
            disabled={busy}
            onClick={() =>
              startBusy(async () => {
                setError(null)
                setNotice(null)
                const result = await saveDocumentBrandingAction({ companyName, accentColor, footerText })
                if (!result.ok) setError(result.message)
                else setNotice('Saved. New documents use this letterhead.')
              })
            }
          >
            Save letterhead
          </Button>
          {notice ? <p className="text-sm text-fg-muted">{notice}</p> : null}
          {error ? <p className="text-sm text-danger">{error}</p> : null}
        </div>
      </SettingsRow>
    </SettingsSection>
  )
}

export type WorkspacePolicyView = { retentionDays: number | null }

/**
 * Housekeeping for agents' persistent workspaces. Retention is off by default:
 * nothing an agent keeps on its desk is deleted unless an operator turns this
 * on, and turning it off again stops the sweep without touching anything.
 */
export function WorkspaceSection({ policy }: { policy: WorkspacePolicyView }) {
  const [enabled, setEnabled] = React.useState(policy.retentionDays !== null)
  const [days, setDays] = React.useState(String(policy.retentionDays ?? 90))
  const [notice, setNotice] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [busy, startBusy] = React.useTransition()

  return (
    <SettingsSection
      title="Workspace"
      description="Each agent has a persistent workspace — its own desk. Files it saves there stay across runs and calls; shell work inside it is sandboxed and recorded. Retention keeps the desk tidy by retiring files that have not been touched in a while."
    >
      <SettingsRow
        title="Keep everything"
        description="With retention off, workspace files are never deleted."
        control={<Badge variant={enabled ? 'outline' : 'secondary'}>{enabled ? 'off' : 'active'}</Badge>}
      />
      <SettingsRow title="Retire untouched files" stacked>
        <div className="grid gap-3 sm:grid-cols-[12rem_1fr]">
          <div className="space-y-1">
            <Label htmlFor="workspace-retention-mode">Retention</Label>
            <Select
              id="workspace-retention-mode"
              value={enabled ? 'on' : 'off'}
              onChange={(event) => setEnabled(event.target.value === 'on')}
            >
              <option value="off">Keep everything</option>
              <option value="on">Retire old files</option>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="workspace-retention-days">Days a file may sit untouched</Label>
            <Input
              id="workspace-retention-days"
              type="number"
              min={7}
              value={days}
              onChange={(event) => setDays(event.target.value)}
              disabled={!enabled}
            />
          </div>
        </div>
        <p className="mt-2 text-xs text-fg-muted">
          The sweep runs daily and removes only files whose last change is older than the window — published
          deliverables, mail attachments, and everything else in the company file record are never touched.
        </p>
        <div className="mt-3 flex items-center gap-3">
          <Button
            disabled={busy}
            onClick={() =>
              startBusy(async () => {
                setError(null)
                setNotice(null)
                const result = await saveWorkspacePolicyAction({
                  retentionEnabled: enabled,
                  retentionDays: Number(days),
                })
                if (!result.ok) setError(result.message)
                else setNotice(enabled ? `Saved — files untouched for ${days} days are retired daily.` : 'Saved — nothing is deleted.')
              })
            }
          >
            Save policy
          </Button>
          {notice ? <p className="text-sm text-fg-muted">{notice}</p> : null}
          {error ? <p className="text-sm text-danger">{error}</p> : null}
        </div>
      </SettingsRow>
    </SettingsSection>
  )
}

export type SmsSettingsView = { provider: string | null; fromNumber: string | null }

type SmsDynamicFields = {
  twilioAccountSid?: string
  vonageApiKey?: string
  plivoAuthId?: string
  telnyxMessagingProfileId?: string
}

/**
 * Outbound text messaging: an operator connects one of five SMS providers,
 * whose single credential is sealed at rest and only unsealed at send time.
 * Every agent texts through the one connected provider — nothing to assign
 * per agent, unlike Model providers. Connecting happens in a drawer.
 */
export function SmsSection({ settings }: { settings: SmsSettingsView }) {
  const configuredProvider = settings.provider && isSmsProvider(settings.provider) ? settings.provider : null
  const [open, setOpen] = React.useState(false)
  const [provider, setProvider] = React.useState<SmsProvider>(configuredProvider ?? SMS_PROVIDER_SPECS[0]!.value)
  const [fromNumber, setFromNumber] = React.useState(settings.fromNumber ?? '')
  const [secret, setSecret] = React.useState('')
  const [fields, setFields] = React.useState<SmsDynamicFields>({})
  const [error, setError] = React.useState<string | null>(null)
  const [busy, startBusy] = React.useTransition()

  const spec = smsProviderSpec(provider)
  const providerLabel = configuredProvider ? smsProviderSpec(configuredProvider).label : null

  const setField = (key: string, value: string) =>
    setFields((prev) => ({ ...prev, [key]: value }) as SmsDynamicFields)

  return (
    <SettingsSection
      title="Text messaging"
      description="Send SMS from your agents — reminders, confirmations, quick replies. Connect one provider and every agent can text through it; the credential is sealed at rest and unsealed only when a message goes out."
    >
      {providerLabel ? (
        <SettingsRow
          title={providerLabel}
          description={settings.fromNumber ? `Sending from ${settings.fromNumber}` : 'Sender configured'}
          control={
            <span className="flex items-center gap-2">
              <Badge variant="secondary">key sealed</Badge>
              <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
                Manage
              </Button>
            </span>
          }
        />
      ) : (
        <SettingsRow
          title="Not configured"
          description="Agents cannot send text messages until a provider is connected."
          control={
            <span className="flex items-center gap-2">
              <Badge variant="outline">off</Badge>
              <Button size="sm" onClick={() => setOpen(true)}>
                Connect a provider
              </Button>
            </span>
          }
        />
      )}

      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        title={providerLabel ? 'Text messaging' : 'Connect a text provider'}
        description="One provider carries every agent's messages. The credential is checked against the provider before it is sealed."
        size="md"
      >
        <div className="space-y-4">
          {providerLabel ? (
            <div className="flex items-center justify-between rounded-md border border-border px-3 py-2 text-sm">
              <span className="flex items-center gap-2">
                <Badge>connected</Badge>
                <span className="text-fg-muted">{providerLabel} · key sealed at rest.</span>
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() =>
                  startBusy(async () => {
                    await removeSmsSettingsAction()
                    setOpen(false)
                  })
                }
              >
                Remove
              </Button>
            </div>
          ) : null}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="sms-provider">Provider</Label>
              <Select
                id="sms-provider"
                value={provider}
                onChange={(event) => {
                  const next = event.target.value
                  if (isSmsProvider(next)) {
                    setProvider(next)
                    setFields({})
                  }
                }}
              >
                {SMS_PROVIDER_SPECS.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="sms-from">Sender (number or ID)</Label>
              <Input
                id="sms-from"
                value={fromNumber}
                onChange={(event) => setFromNumber(event.target.value)}
                placeholder="+15551234567"
              />
            </div>
            {spec.fields.map((field) => (
              <div key={field.key} className="space-y-1">
                <Label htmlFor={`sms-field-${field.key}`}>{field.label}</Label>
                <Input
                  id={`sms-field-${field.key}`}
                  value={fields[field.key as keyof SmsDynamicFields] ?? ''}
                  onChange={(event) => setField(field.key, event.target.value)}
                  placeholder={field.placeholder}
                />
              </div>
            ))}
            <div className="space-y-1 sm:col-span-2">
              <Label htmlFor="sms-secret">{spec.secretLabel}</Label>
              <Input
                id="sms-secret"
                type="password"
                value={secret}
                onChange={(event) => setSecret(event.target.value)}
                placeholder={spec.keyHint}
              />
            </div>
          </div>
          {spec.docsHint ? <p className="text-xs text-fg-muted">{spec.docsHint}</p> : null}
          <Button
            disabled={busy || !fromNumber.trim() || !secret.trim()}
            onClick={() =>
              startBusy(async () => {
                setError(null)
                const result = await saveSmsSettingsAction({
                  provider,
                  fromNumber,
                  secret,
                  ...fields,
                })
                if (!result.ok) {
                  setError(result.message)
                  return
                }
                setSecret('')
                setOpen(false)
              })
            }
          >
            {busy ? 'Verifying…' : 'Verify & save'}
          </Button>
          {error ? <p className="text-sm text-danger">{error}</p> : null}
        </div>
      </Drawer>
    </SettingsSection>
  )
}
