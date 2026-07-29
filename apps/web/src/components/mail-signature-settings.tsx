'use client'

import * as React from 'react'
import dynamic from 'next/dynamic'
import { Button, Input, Label, SettingsRow, SettingsSection, Spinner, Switch } from '@appkit/ui'
import {
  compileEmailDesign,
  renderEmailDesign,
  sampleMergeValues,
  starterHtml,
} from '@appkit/email-designer'
import '@appkit/email-designer/styles.css'
import { SIGNATURE_MERGE_FIELDS } from '../lib/mail-signature-fields'
import { saveMailSignatureAction } from '../app/admin/settings/actions'

// GrapesJS touches window, so the designer only ever loads in the browser.
const EmailDesigner = dynamic(
  () => import('@appkit/email-designer/react').then((m) => m.EmailDesigner),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-fg-muted">
        <Spinner /> Loading the designer…
      </div>
    ),
  },
)

export type MailSignatureView = {
  enabled: boolean
  sourceHtml: string
  accentColor: string
}

/** Preview values: the real catalog samples, so tokens read like a real sender. */
const PREVIEW_VALUES = sampleMergeValues(SIGNATURE_MERGE_FIELDS)

export function MailSignatureSettings({ signature }: { signature: MailSignatureView }) {
  const [enabled, setEnabled] = React.useState(signature.enabled)
  const [accentColor, setAccentColor] = React.useState(signature.accentColor)
  const [draft, setDraft] = React.useState(signature.sourceHtml)
  const [notice, setNotice] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [busy, startBusy] = React.useTransition()

  // The accent is baked into blocks as they are dragged in, so the designer is
  // remounted when it changes — otherwise new blocks would carry the old color.
  const accent = /^#[0-9a-fA-F]{6}$/.test(accentColor.trim()) ? accentColor.trim() : undefined
  const theme = React.useMemo(() => (accent ? { accent } : undefined), [accent])

  // Preview without the CSS inliner: juice is server-only, and a browser honors
  // the <style> block the designer serializes anyway.
  const preview = React.useMemo(() => {
    const source = draft.trim() || starterHtml('signature', theme)
    const compiled = compileEmailDesign(source, { fragment: true })
    if (compiled.errors.length > 0) return { html: '', error: compiled.errors[0] ?? null }
    return { html: renderEmailDesign(compiled.compiledHtml, PREVIEW_VALUES).html, error: null }
  }, [draft, theme])

  const save = () =>
    startBusy(async () => {
      setError(null)
      setNotice(null)
      const result = await saveMailSignatureAction({
        enabled,
        accentColor,
        rawHtml: draft.trim() || starterHtml('signature', theme),
      })
      if (!result.ok) setError(result.message)
      else setNotice(enabled ? 'Saved. Agents send with this signature.' : 'Saved. The signature is off.')
    })

  return (
    <SettingsSection
      title="Signature"
      description="One signature for the whole company, personalized per sender. Drag a field in and it resolves to that agent's own name, title, and contact details when the message goes out."
    >
      <SettingsRow
        title="Append to outbound mail"
        description="While this is off, agents sign off in their own words and nothing is appended."
      >
        <Switch checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
      </SettingsRow>

      <SettingsRow title="Accent color" description="Seeds rules, links, and buttons on newly added blocks.">
        <Input
          id="sig-accent"
          value={accentColor}
          onChange={(event) => setAccentColor(event.target.value)}
          placeholder="#F5A623"
          className="w-40"
        />
      </SettingsRow>

      <SettingsRow title="Design" stacked>
        <div className="h-[30rem] overflow-hidden rounded-lg border border-border">
          <EmailDesigner
            key={accent ?? 'default'}
            preset="signature"
            theme={theme}
            initialHtml={signature.sourceHtml || null}
            mergeFields={SIGNATURE_MERGE_FIELDS}
            onChange={setDraft}
          />
        </div>

        <div className="mt-4 space-y-1">
          <Label>Preview</Label>
          <div className="rounded-lg border border-border bg-white p-5">
            {preview.error ? (
              <p className="text-sm text-danger">{preview.error}</p>
            ) : (
              <div dangerouslySetInnerHTML={{ __html: preview.html }} />
            )}
          </div>
          <p className="text-xs text-fg-muted">
            Shown with sample values. Every agent sends the same design with their own details.
          </p>
        </div>

        <div className="mt-4 flex items-center gap-3">
          <Button disabled={busy} onClick={save}>
            Save signature
          </Button>
          {notice ? <p className="text-sm text-fg-muted">{notice}</p> : null}
          {error ? <p className="text-sm text-danger">{error}</p> : null}
        </div>
      </SettingsRow>
    </SettingsSection>
  )
}
