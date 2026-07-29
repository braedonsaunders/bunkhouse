'use client'

import * as React from 'react'
import { Button, Label, SearchSelect, Select } from '@appkit/ui'
import { loadModelsForProviderAction } from '../app/admin/settings/actions'
import { setAgentModel } from '../app/organization/actions'

/**
 * Assign an agent's two brains from live model lists — provider keys stay
 * sealed. One provider, two choices: the model that does the work, and the
 * model that answers while someone is on the phone.
 */
export function AssignModelForm({
  personId,
  providers,
  currentProvider,
  currentModel,
  currentModelFast,
}: {
  personId: string
  /** `modelFast` is the provider's own quick model — what an unset agent falls back to. */
  providers: { slug: string; label: string; modelFast?: string | undefined }[]
  currentProvider?: string
  currentModel?: string
  currentModelFast?: string
}) {
  const [providerSlug, setProviderSlug] = React.useState(currentProvider ?? providers[0]?.slug ?? '')
  const [models, setModels] = React.useState<{ id: string; label?: string }[] | null>(null)
  const [model, setModel] = React.useState(currentModel ?? '')
  const [modelFast, setModelFast] = React.useState(currentModelFast ?? '')
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
      // An unset fast model is a legitimate choice, so it stays unset rather
      // than defaulting to whatever the list happens to open with.
      setModelFast((current) => (current && result.models.some((m) => m.id === current) ? current : ''))
    })
  }, [providerSlug])

  const assign = () =>
    startSaving(async () => {
      setError(null)
      const form = new FormData()
      form.set('personId', personId)
      form.set('providerSlug', providerSlug)
      form.set('model', model)
      form.set('modelFast', modelFast)
      try {
        await setAgentModel(form)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    })

  const modelOptions = (models ?? []).map((m) => ({
    value: m.id,
    label: m.label ? `${m.label} (${m.id})` : m.id,
  }))
  const providerFast = providers.find((p) => p.slug === providerSlug)?.modelFast
  const fallbackNote = providerFast
    ? `they answer on ${providerFast}, this provider's quick model`
    : 'they answer on the model they work with'

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="assign-model-provider">Provider</Label>
        <Select
          id="assign-model-provider"
          value={providerSlug}
          onChange={(e) => setProviderSlug(e.target.value)}
          className="max-w-sm"
        >
          {providers.map((p) => (
            <option key={p.slug} value={p.slug}>
              {p.label}
            </option>
          ))}
        </Select>
        <p className="text-xs text-fg-muted">
          Both models below come from this provider, on the company key it was connected with.
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="assign-model-work">Model they work with</Label>
        <SearchSelect
          id="assign-model-work"
          value={model}
          onChange={setModel}
          options={modelOptions}
          placeholder={loading ? 'Loading models…' : 'Pick a model'}
          disabled={loading || models === null}
          ariaLabel="Model they work with"
          className="max-w-sm"
        />
        <p className="text-xs text-fg-muted">
          Every email they write, every assignment and duty they carry out, and anything a caller is waiting on the
          line for. This is where the quality of the work comes from — assign the strongest model the company is
          willing to pay for.
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="assign-model-call">Model they answer with on a call</Label>
        <SearchSelect
          id="assign-model-call"
          value={modelFast}
          onChange={setModelFast}
          options={modelOptions}
          placeholder={loading ? 'Loading models…' : 'Same as the model they work with'}
          disabled={loading || models === null}
          clearable
          noneLabel={providerFast ? `Leave unset — use ${providerFast}` : 'Leave unset — use the model above'}
          ariaLabel="Model they answer with on a call"
          className="max-w-sm"
        />
        <p className="text-xs text-fg-muted">
          How quickly they answer while someone is on the phone. A small model replies in about half a second where a
          large reasoning model takes several, and on a call that gap is the whole conversation. The work itself still
          runs on the model above, so a quick answer costs nothing in quality. Leave this unset and {fallbackNote}.
        </p>
      </div>

      <div className="flex items-center gap-2">
        <Button type="button" onClick={assign} disabled={saving || !model} variant="outline" size="sm">
          {saving ? 'Assigning…' : 'Assign'}
        </Button>
      </div>
      {error ? <p className="text-xs text-danger">{error}</p> : null}
    </div>
  )
}
