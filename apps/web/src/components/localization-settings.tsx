'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { Badge, Button, Select, SettingsRow, SettingsSection, Switch } from '@braedonsaunders/appkit-ui'
import { LOCALE_OPTIONS, type AppLocale } from '../lib/product-locales'
import type { LocaleSettingsView } from '../lib/localization'
import { saveLocaleSettingsAction } from '../app/admin/settings/actions'

export function LocalizationSettings({ settings }: { settings: LocaleSettingsView }) {
  const router = useRouter()
  const [defaultLocale, setDefaultLocale] = React.useState(settings.defaultLocale)
  const [enabledLocales, setEnabledLocales] = React.useState<AppLocale[]>(settings.enabledLocales)
  const [notice, setNotice] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [busy, startBusy] = React.useTransition()

  const setEnabled = (locale: AppLocale, enabled: boolean) => {
    setEnabledLocales((current) => {
      const next = enabled ? [...new Set([...current, locale])] : current.filter((item) => item !== locale)
      return next.includes(defaultLocale) ? next : [...next, defaultLocale]
    })
  }

  const save = () =>
    startBusy(async () => {
      setNotice(null)
      setError(null)
      const result = await saveLocaleSettingsAction({ defaultLocale, enabledLocales })
      if (!result.ok) {
        setError(result.message)
        return
      }
      setDefaultLocale(result.settings.defaultLocale)
      setEnabledLocales(result.settings.enabledLocales)
      setNotice('Saved. Members receive the new default on their next page load.')
      router.refresh()
    })

  return (
    <SettingsSection
      title="Language & region"
      description="The company default and the languages members may choose for Bunkhouse. Core navigation is translated; interface text without a translation falls back to English."
    >
      <SettingsRow
        title="Default language"
        description="Used when a member has not chosen a personal language. It also sets the document language for assistive technology and browser translation."
        control={
          <Select
            aria-label="Default language"
            value={defaultLocale}
            disabled={busy}
            onChange={(event) => {
              const locale = event.target.value as AppLocale
              setDefaultLocale(locale)
              setEnabledLocales((current) => (current.includes(locale) ? current : [...current, locale]))
            }}
          >
            {LOCALE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.nativeLabel}</option>
            ))}
          </Select>
        }
      />
      {LOCALE_OPTIONS.map((option) => {
        const enabled = enabledLocales.includes(option.value)
        const locked = option.value === defaultLocale
        return (
          <SettingsRow
            key={option.value}
            title={option.nativeLabel}
            description={locked ? 'Company default; it must remain available.' : `Allow members to choose ${option.label}.`}
            control={
              <span className="flex items-center gap-2">
                <Badge variant={enabled ? 'secondary' : 'outline'}>{enabled ? 'available' : 'off'}</Badge>
                <Switch
                  checked={enabled}
                  disabled={busy || locked}
                  aria-label={`Allow ${option.label}`}
                  onChange={(event) => setEnabled(option.value, event.target.checked)}
                />
              </span>
            }
          />
        )
      })}
      <SettingsRow
        title="Language policy"
        description={settings.updatedAt ? `Last updated ${new Intl.DateTimeFormat(defaultLocale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(settings.updatedAt))}.` : 'Using the installation default; no company change has been recorded yet.'}
        control={<Button size="sm" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save languages'}</Button>}
      />
      {notice ? <SettingsRow title="Languages saved" description={notice} control={<Badge>saved</Badge>} /> : null}
      {error ? <SettingsRow title="Languages were not saved" description={error} control={<Badge variant="destructive">error</Badge>} /> : null}
    </SettingsSection>
  )
}
