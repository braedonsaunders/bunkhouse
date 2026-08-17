'use client'

import * as React from 'react'
import { Button, Input, Label, SearchSelect, Select } from '@braedonsaunders/appkit-ui'
import { addProviderAction, loadModelsAction } from '../app/admin/settings/actions'

export type ProviderKindOption = { value: string; label: string; needsBaseUrl: boolean }

type ModelOption = { id: string; label?: string }

/**
 * Two-step provider onboarding: verify the key by listing its live models,
 * then pick defaults from real dropdowns — no free-typed model ids. Lives in
 * the Add provider drawer, so the settings page under it stays a table.
 */
export function AddProviderForm({ kinds, onSaved }: { kinds: ProviderKindOption[]; onSaved?: () => void }) {
  const [provider, setProvider] = React.useState(kinds[0]?.value ?? 'anthropic')
  const [label, setLabel] = React.useState('')
  const [slug, setSlug] = React.useState('')
  const [slugTouched, setSlugTouched] = React.useState(false)
  const [apiKey, setApiKey] = React.useState('')
  const [baseUrl, setBaseUrl] = React.useState('')
  const [models, setModels] = React.useState<ModelOption[] | null>(null)
  const [modelSmart, setModelSmart] = React.useState('')
  const [modelFast, setModelFast] = React.useState('')
  const [error, setError] = React.useState<string | null>(null)
  const [loading, startLoading] = React.useTransition()
  const [saving, startSaving] = React.useTransition()

  const kind = kinds.find((k) => k.value === provider)
  const slugify = (v: string) =>
    v.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)

  const loadModels = () =>
    startLoading(async () => {
      setError(null)
      const result = await loadModelsAction({ provider, apiKey, ...(baseUrl ? { baseUrl } : {}) })
      if (!result.ok) {
        setModels(null)
        setError(result.message)
        return
      }
      setModels(result.models)
      if (result.models[0] && !modelSmart) setModelSmart(result.models[0].id)
      if (result.models[0] && !modelFast) setModelFast(result.models[0].id)
    })

  const save = () =>
    startSaving(async () => {
      setError(null)
      const form = new FormData()
      form.set('provider', provider)
      form.set('slug', slug || slugify(label) || provider)
      form.set('label', label || provider)
      form.set('apiKey', apiKey)
      form.set('baseUrl', baseUrl)
      form.set('modelSmart', modelSmart)
      form.set('modelFast', modelFast)
      const result = await addProviderAction(form)
      if (!result.ok) {
        setError(result.message)
        return
      }
      setLabel('')
      setSlug('')
      setSlugTouched(false)
      setApiKey('')
      setBaseUrl('')
      setModels(null)
      setModelSmart('')
      setModelFast('')
      onSaved?.()
    })

  const modelOptions = (models ?? []).map((m) => ({ value: m.id, label: m.label ? `${m.label} (${m.id})` : m.id }))

  return (
    <div className="space-y-4">
      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="provider-kind">Provider</Label>
          <Select
            id="provider-kind"
            value={provider}
            onChange={(e) => {
              setProvider(e.target.value)
              setModels(null)
              setModelSmart('')
              setModelFast('')
            }}
          >
            {kinds.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="provider-label">Label</Label>
          <Input
            id="provider-label"
            value={label}
            onChange={(e) => {
              setLabel(e.target.value)
              if (!slugTouched) setSlug(slugify(e.target.value))
            }}
            placeholder="Anthropic (company account)"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="provider-slug">Slug</Label>
          <Input
            id="provider-slug"
            value={slug}
            onChange={(e) => {
              setSlugTouched(true)
              setSlug(slugify(e.target.value))
            }}
            placeholder="anthropic-main"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="provider-key">API key</Label>
          <Input
            id="provider-key"
            type="password"
            value={apiKey}
            onChange={(e) => {
              setApiKey(e.target.value)
              setModels(null)
            }}
          />
        </div>
        {kind?.needsBaseUrl ? (
          <div className="space-y-2 md:col-span-2">
            <Label htmlFor="provider-base-url">Base URL</Label>
            <Input
              id="provider-base-url"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://…/v1"
            />
          </div>
        ) : null}
      </div>

      {models === null ? (
        <Button type="button" onClick={loadModels} disabled={loading || !apiKey}>
          {loading ? 'Checking key…' : 'Verify key & load models'}
        </Button>
      ) : (
        <div className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label>Default model (smart)</Label>
              <SearchSelect
                value={modelSmart}
                onChange={setModelSmart}
                options={modelOptions}
                placeholder="Pick the default model"
                ariaLabel="Default smart model"
              />
            </div>
            <div className="space-y-2">
              <Label>Fast model (cheap tasks)</Label>
              <SearchSelect
                value={modelFast}
                onChange={setModelFast}
                options={modelOptions}
                placeholder="Pick the fast model"
                ariaLabel="Default fast model"
              />
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Button type="button" onClick={save} disabled={saving || !modelSmart}>
              {saving ? 'Saving…' : 'Add provider'}
            </Button>
            <span className="text-xs text-fg-muted">{models.length} models available on this key.</span>
          </div>
        </div>
      )}

      {error ? <p className="text-sm text-danger">{error}</p> : null}
    </div>
  )
}
