'use client'

import * as React from 'react'
import { Button, SearchSelect, Select } from '@appkit/ui'
import { loadModelsForProviderAction } from '../app/settings/actions'
import { setHandModel } from '../app/people/actions'

/** Assign a hand's brain from live model lists — provider keys stay sealed. */
export function AssignModelForm({
  personId,
  providers,
  currentProvider,
  currentModel,
}: {
  personId: string
  providers: { slug: string; label: string }[]
  currentProvider?: string
  currentModel?: string
}) {
  const [providerSlug, setProviderSlug] = React.useState(currentProvider ?? providers[0]?.slug ?? '')
  const [models, setModels] = React.useState<{ id: string; label?: string }[] | null>(null)
  const [model, setModel] = React.useState(currentModel ?? '')
  const [error, setError] = React.useState<string | null>(null)
  const [loading, startLoading] = React.useTransition()
  const [saving, startSaving] = React.useTransition()

  React.useEffect(() => {
    if (!providerSlug) return
    startLoading(async () => {
      setError(null)
      const result = await loadModelsForProviderAction(providerSlug)
      if (!result.ok) {
        setModels(null)
        setError(result.message)
        return
      }
      setModels(result.models)
      setModel((current) => (current && result.models.some((m) => m.id === current) ? current : (result.models[0]?.id ?? '')))
    })
  }, [providerSlug])

  const assign = () =>
    startSaving(async () => {
      setError(null)
      const form = new FormData()
      form.set('personId', personId)
      form.set('providerSlug', providerSlug)
      form.set('model', model)
      try {
        await setHandModel(form)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    })

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={providerSlug} onChange={(e) => setProviderSlug(e.target.value)} aria-label="Provider">
          {providers.map((p) => (
            <option key={p.slug} value={p.slug}>
              {p.label}
            </option>
          ))}
        </Select>
        <SearchSelect
          value={model}
          onChange={setModel}
          options={(models ?? []).map((m) => ({ value: m.id, label: m.label ? `${m.label} (${m.id})` : m.id }))}
          placeholder={loading ? 'Loading models…' : 'Pick a model'}
          disabled={loading || models === null}
          ariaLabel="Model"
          className="min-w-56"
        />
        <Button type="button" onClick={assign} disabled={saving || !model} variant="outline" size="sm">
          {saving ? 'Assigning…' : 'Assign'}
        </Button>
      </div>
      {error ? <p className="text-xs text-danger">{error}</p> : null}
    </div>
  )
}
