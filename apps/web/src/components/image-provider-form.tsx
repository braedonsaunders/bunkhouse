'use client'

import * as React from 'react'
import { Button, Label, SearchSelect, Select } from '@appkit/ui'
import { listImageModelsForProviderAction, setImageProviderAction } from '../app/admin/settings/actions'

/**
 * Provider + image-model picker for avatar generation. Models are listed live
 * from the selected provider's model API (keys stay sealed server-side) — the
 * static catalog is only offered as a fallback when the live fetch fails.
 */
export function ImageProviderForm({
  providers,
  current,
  fallbackModels,
}: {
  providers: { slug: string; label: string; provider: string }[]
  current: { providerSlug: string; model: string } | null
  fallbackModels: { id: string; name: string; provider: string }[]
}) {
  const [providerSlug, setProviderSlug] = React.useState(current?.providerSlug ?? providers[0]?.slug ?? '')
  const [models, setModels] = React.useState<{ id: string; name?: string }[] | null>(null)
  const [model, setModel] = React.useState(current?.model ?? '')
  const [liveError, setLiveError] = React.useState<string | null>(null)
  const [saveError, setSaveError] = React.useState<string | null>(null)
  const [usingFallback, setUsingFallback] = React.useState(false)
  const [loading, startLoading] = React.useTransition()
  const [saving, startSaving] = React.useTransition()

  const kind = providers.find((p) => p.slug === providerSlug)?.provider

  React.useEffect(() => {
    if (!providerSlug) return
    startLoading(async () => {
      setLiveError(null)
      setSaveError(null)
      setUsingFallback(false)
      const result = await listImageModelsForProviderAction(providerSlug)
      if (!result.ok) {
        setModels(null)
        setLiveError(result.message)
        return
      }
      setModels(result.models)
      setModel((cur) => (cur && result.models.some((m) => m.id === cur) ? cur : (result.models[0]?.id ?? '')))
    })
  }, [providerSlug])

  const useFallbackCatalog = () => {
    const catalog = fallbackModels
      .filter((m) => m.provider === kind)
      .map((m) => ({ id: m.id, name: m.name }))
    setModels(catalog)
    setUsingFallback(true)
    setModel((cur) => (cur && catalog.some((m) => m.id === cur) ? cur : (catalog[0]?.id ?? '')))
  }

  const save = () =>
    startSaving(async () => {
      setSaveError(null)
      const form = new FormData()
      form.set('imageProviderSlug', providerSlug)
      form.set('imageModel', model)
      try {
        await setImageProviderAction(form)
      } catch (error) {
        setSaveError(error instanceof Error ? error.message : String(error))
      }
    })

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label htmlFor="image-provider">Provider</Label>
          <Select
            id="image-provider"
            value={providerSlug}
            onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setProviderSlug(e.target.value)}
          >
            {providers.map((p) => (
              <option key={p.slug} value={p.slug}>
                {p.label} ({p.provider})
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-1">
          <Label>Image model</Label>
          <SearchSelect
            value={model}
            onChange={setModel}
            options={(models ?? []).map((m) => ({ value: m.id, label: m.name ? `${m.name} (${m.id})` : m.id }))}
            placeholder={loading ? 'Loading models…' : 'Pick a model'}
            disabled={loading || models === null}
            ariaLabel="Image model"
            className="min-w-56"
          />
        </div>
        <Button type="button" size="sm" onClick={save} disabled={saving || loading || !model}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </div>
      {usingFallback ? (
        <p className="text-xs text-fg-muted">
          Showing the standard catalog because the live model list was unavailable
          {liveError ? ` (${liveError})` : ''}. Some entries may have been retired by the provider.
        </p>
      ) : liveError ? (
        <div className="space-y-1">
          <p className="text-xs text-danger">Could not load the provider&apos;s model list: {liveError}</p>
          <Button type="button" variant="outline" size="sm" onClick={useFallbackCatalog}>
            Choose from the standard catalog instead
          </Button>
        </div>
      ) : null}
      {saveError ? <p className="text-xs text-danger">{saveError}</p> : null}
    </div>
  )
}
