'use client'

import * as React from 'react'
import Link from 'next/link'
import {
  Badge,
  Button,
  Drawer,
  EmptyState,
  Input,
  Label,
  PagedTable,
  SearchSelect,
  SettingsRow,
  SettingsSection,
  SubtabNav,
  type PagedColumn,
} from '@appkit/ui'
import { AddProviderForm, type ProviderKindOption } from './add-provider-form'
import {
  loadModelsForProviderAction,
  refreshPricesAction,
  removeProviderAction,
  setManualPriceAction,
  updateProviderAction,
} from '../app/admin/settings/actions'

/**
 * Settings → Models: the company's own provider keys, and the effective-dated
 * price rows every spend record stamps itself against. Both subtabs are the
 * standard settings shape — a header row carrying the actions, one table under
 * it, and every add or edit in a drawer, so no form ever sits below a table.
 */

export type ProviderSummary = {
  slug: string
  label: string
  provider: string
  modelSmart?: string
  modelFast?: string
  baseUrl?: string
}

/** Which agent thinks on which provider — the cost of removing one, made visible. */
export type ProviderAssignment = {
  personId: string
  personName: string
  providerSlug: string
  model: string
}

export type PriceRow = {
  id: string
  model: string
  inputUsdPerMtok: string
  outputUsdPerMtok: string
  /** Raw dollars behind the formatted columns, so sorting is numeric. */
  inputUsd: number
  outputUsd: number
  source: string
  sourceRef?: string
  effectiveAt: string
}

type ProviderRow = ProviderSummary & { kindLabel: string; agentCount: number }

const PROVIDER_COLUMNS: PagedColumn<ProviderRow>[] = [
  {
    key: 'label',
    header: 'Provider',
    cell: (row) => (
      <span className="min-w-0">
        <span className="block truncate font-medium text-primary">{row.label}</span>
        <span className="block truncate text-xs text-fg-muted">{row.slug}</span>
      </span>
    ),
    search: (row) => `${row.label} ${row.slug}`,
    sortValue: (row) => row.label,
  },
  {
    key: 'kind',
    header: 'Service',
    cell: (row) => <Badge variant="secondary">{row.kindLabel}</Badge>,
    search: (row) => row.kindLabel,
    sortValue: (row) => row.kindLabel,
  },
  {
    key: 'modelSmart',
    header: 'Default model',
    cell: (row) => row.modelSmart ?? '—',
    search: (row) => row.modelSmart ?? '',
    sortValue: (row) => row.modelSmart ?? '',
  },
  {
    key: 'modelFast',
    header: 'Fast model',
    cell: (row) => row.modelFast ?? '—',
    search: (row) => row.modelFast ?? '',
    sortValue: (row) => row.modelFast ?? '',
  },
  {
    key: 'agents',
    header: 'Agents',
    align: 'right',
    cell: (row) => (row.agentCount === 0 ? <span className="text-fg-muted">none</span> : row.agentCount),
    sortValue: (row) => row.agentCount,
  },
  {
    key: 'key',
    header: 'Key',
    cell: () => <Badge variant="outline">sealed</Badge>,
  },
]

const PRICE_COLUMNS: PagedColumn<PriceRow>[] = [
  { key: 'model', header: 'Model', cell: (row) => row.model, search: (row) => row.model, sortValue: (row) => row.model },
  {
    key: 'input',
    header: 'Input $/Mtok',
    align: 'right',
    cell: (row) => row.inputUsdPerMtok,
    sortValue: (row) => row.inputUsd,
  },
  {
    key: 'output',
    header: 'Output $/Mtok',
    align: 'right',
    cell: (row) => row.outputUsdPerMtok,
    sortValue: (row) => row.outputUsd,
  },
  {
    key: 'source',
    header: 'Source',
    cell: (row) => <Badge variant={row.source === 'openrouter' ? 'secondary' : 'outline'}>{row.source}</Badge>,
    search: (row) => row.source,
    sortValue: (row) => row.source,
  },
  {
    key: 'effectiveAt',
    header: 'Effective',
    cell: (row) => row.effectiveAt,
    sortValue: (row) => row.effectiveAt,
  },
]

export function ModelSettings({
  providers,
  kinds,
  prices,
  assignments,
  initialTab,
}: {
  providers: ProviderSummary[]
  kinds: ProviderKindOption[]
  prices: PriceRow[]
  /** Agents currently assigned to each provider slug. */
  assignments: ProviderAssignment[]
  initialTab: string
}) {
  const [tab, setTab] = React.useState(initialTab === 'pricing' ? 'pricing' : 'providers')
  const [adding, setAdding] = React.useState(false)
  const [editing, setEditing] = React.useState<ProviderSummary | null>(null)
  const [priceDrawer, setPriceDrawer] = React.useState<string | null>(null)
  const [notice, setNotice] = React.useState<string | null>(null)
  const [busy, startBusy] = React.useTransition()

  const rows: ProviderRow[] = providers.map((provider) => ({
    ...provider,
    kindLabel: kinds.find((kind) => kind.value === provider.provider)?.label ?? provider.provider,
    agentCount: assignments.filter((agent) => agent.providerSlug === provider.slug).length,
  }))
  const priceHistory = priceDrawer && priceDrawer !== '*new*' ? prices.filter((row) => row.model === priceDrawer) : []

  return (
    <div className="space-y-4">
      <SubtabNav
        ariaLabel="Models"
        active={tab}
        onSelect={setTab}
        tabs={[
          { key: 'providers', label: 'Providers', count: providers.length },
          { key: 'pricing', label: 'Pricing', count: prices.length },
        ]}
      />

      {tab === 'providers' ? (
        <SettingsSection
          title="Model providers"
          description="Your own API keys, sealed at rest and live-verified before saving. Each agent is assigned a provider and model on its profile — open a row to change a provider's defaults or rotate its key."
        >
          <SettingsRow
            title="Connected providers"
            description="A provider's default model is what an agent falls back to when its own record names none."
            control={
              <Button size="sm" onClick={() => setAdding(true)}>
                Add provider
              </Button>
            }
          />
          <div className="px-5 py-4">
            <PagedTable
              columns={PROVIDER_COLUMNS}
              rows={rows}
              rowKey={(row) => row.slug}
              pageSize={10}
              searchable
              defaultSort={{ key: 'label', dir: 'asc' }}
              onRowClick={(row) => setEditing(row)}
              labels={{ searchPlaceholder: 'Search providers…', searchLabel: 'Search providers' }}
              empty={
                <EmptyState
                  title="No providers yet"
                  description="Add one API key and your agents can start thinking. Keys are verified against the live API before they are sealed."
                  action={<Button onClick={() => setAdding(true)}>Add provider</Button>}
                />
              }
            />
          </div>
        </SettingsSection>
      ) : null}

      {tab === 'pricing' ? (
        <SettingsSection
          title="Model pricing"
          description="Effective-dated, append-only price rows — every spend record stamps the exact price it used, so costs are auditable forever. Refresh pulls live prices from the OpenRouter catalog for models your agents use; '*' is the company default."
        >
          <SettingsRow
            title="Keeping prices current"
            description="Refreshing appends a new effective row only where the price actually changed."
            control={
              <span className="flex items-center gap-2">
                <Button variant="outline" size="sm" onClick={() => setPriceDrawer('*new*')}>
                  Add manual price
                </Button>
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    startBusy(async () => {
                      setNotice(null)
                      try {
                        await refreshPricesAction()
                        setNotice('Prices refreshed.')
                      } catch (err) {
                        setNotice(err instanceof Error ? err.message : String(err))
                      }
                    })
                  }
                >
                  {busy ? 'Refreshing…' : 'Refresh from OpenRouter'}
                </Button>
              </span>
            }
          />
          {notice ? <p className="px-5 py-3 text-sm text-fg-muted">{notice}</p> : null}
          <div className="px-5 py-4">
            <PagedTable
              columns={PRICE_COLUMNS}
              rows={prices}
              rowKey={(row) => row.id}
              pageSize={15}
              searchable
              defaultSort={{ key: 'effectiveAt', dir: 'desc' }}
              onRowClick={(row) => setPriceDrawer(row.model)}
              labels={{ searchPlaceholder: 'Search prices…', searchLabel: 'Search prices' }}
              empty={
                <EmptyState
                  title="No prices yet"
                  description="Refresh from OpenRouter or add a manual price. Unpriced spend records cost $0 and are flagged."
                  action={<Button onClick={() => setPriceDrawer('*new*')}>Add manual price</Button>}
                />
              }
            />
          </div>
        </SettingsSection>
      ) : null}

      <Drawer
        open={adding}
        onClose={() => setAdding(false)}
        title="Add a provider"
        description="Verify the key, then pick the defaults from its live model list. The key is sealed at rest and only unsealed when an agent works."
        size="md"
      >
        {adding ? <AddProviderForm kinds={kinds} onSaved={() => setAdding(false)} /> : null}
      </Drawer>

      <Drawer
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing ? editing.label : ''}
        description={editing ? `${editing.slug} · ${kinds.find((k) => k.value === editing.provider)?.label ?? editing.provider}` : undefined}
        size="md"
      >
        {editing ? (
          <ProviderDrawerBody
            provider={editing}
            agents={assignments.filter((agent) => agent.providerSlug === editing.slug)}
            onDone={() => setEditing(null)}
          />
        ) : null}
      </Drawer>

      <Drawer
        open={priceDrawer !== null}
        onClose={() => setPriceDrawer(null)}
        title={priceDrawer === '*new*' ? 'Add manual price' : `Pricing — ${priceDrawer ?? ''}`}
        description={
          priceDrawer === '*new*'
            ? 'Model id, or * for the company default. Appends an effective-dated row.'
            : 'Full effective-dated history; the newest row is in force. Changes append, never edit.'
        }
        size="md"
      >
        <div className="space-y-6">
          {priceDrawer && priceDrawer !== '*new*' ? (
            <div className="space-y-1">
              {priceHistory.map((row) => (
                <div
                  key={row.id}
                  className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-sm"
                >
                  <span className="tabular-nums">
                    {row.inputUsdPerMtok} in · {row.outputUsdPerMtok} out
                  </span>
                  <span className="flex items-center gap-2 text-xs text-fg-muted">
                    <Badge variant={row.source === 'openrouter' ? 'secondary' : 'outline'}>{row.source}</Badge>
                    {row.effectiveAt}
                  </span>
                </div>
              ))}
            </div>
          ) : null}
          <form
            action={async (form: FormData) => {
              setNotice(null)
              await setManualPriceAction(form)
              setPriceDrawer(null)
            }}
            className="space-y-3"
          >
            <div className="space-y-1">
              <Label htmlFor="price-model">Model</Label>
              <Input
                id="price-model"
                name="model"
                defaultValue={priceDrawer === '*new*' ? '' : (priceDrawer ?? '')}
                placeholder="claude-sonnet-5 or *"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="price-in">Input $/Mtok</Label>
                <Input id="price-in" name="inputUsdPerMtok" type="number" step="0.0001" min="0" required />
              </div>
              <div className="space-y-1">
                <Label htmlFor="price-out">Output $/Mtok</Label>
                <Input id="price-out" name="outputUsdPerMtok" type="number" step="0.0001" min="0" required />
              </div>
            </div>
            <Button type="submit" size="sm">
              Append price row
            </Button>
          </form>
        </div>
      </Drawer>
    </div>
  )
}

/**
 * One saved provider: what agents fall back to, who is working on it, and the
 * key rotation. The slug never changes — every agent's record points at it.
 */
function ProviderDrawerBody({
  provider,
  agents,
  onDone,
}: {
  provider: ProviderSummary
  agents: ProviderAssignment[]
  onDone: () => void
}) {
  const [label, setLabel] = React.useState(provider.label)
  const [modelSmart, setModelSmart] = React.useState(provider.modelSmart ?? '')
  const [modelFast, setModelFast] = React.useState(provider.modelFast ?? '')
  const [apiKey, setApiKey] = React.useState('')
  const [models, setModels] = React.useState<{ id: string; label?: string }[] | null>(null)
  const [modelsError, setModelsError] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [loading, startLoading] = React.useTransition()
  const [busy, startBusy] = React.useTransition()

  // The live catalog for this key, so defaults are picked rather than typed.
  React.useEffect(() => {
    startLoading(async () => {
      const result = await loadModelsForProviderAction(provider.slug)
      if (!result.ok) {
        setModels(null)
        setModelsError(result.message)
        return
      }
      setModelsError(null)
      setModels(result.models)
    })
  }, [provider.slug])

  const listed = (models ?? []).map((model) => ({
    value: model.id,
    label: model.label ? `${model.label} (${model.id})` : model.id,
  }))
  // A saved default the provider no longer lists stays selectable, so opening
  // the drawer never silently drops a model an agent is working on today.
  const retired = [...new Set([modelSmart, modelFast])]
    .filter((chosen) => chosen && !listed.some((option) => option.value === chosen))
    .map((chosen) => ({ value: chosen, label: `${chosen} (no longer listed)` }))
  const options = [...retired, ...listed]

  return (
    <div className="space-y-5">
      <div className="space-y-1">
        <Label htmlFor="provider-edit-label">Label</Label>
        <Input id="provider-edit-label" value={label} onChange={(event) => setLabel(event.target.value)} />
      </div>

      {provider.baseUrl ? (
        <div className="space-y-1">
          <Label htmlFor="provider-edit-base">Endpoint</Label>
          <Input id="provider-edit-base" value={provider.baseUrl} readOnly />
          <p className="text-xs text-fg-muted">
            The endpoint is fixed once saved. Connect a second provider to work against a different gateway.
          </p>
        </div>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label>Default model (smart)</Label>
          <SearchSelect
            value={modelSmart}
            onChange={setModelSmart}
            options={options}
            placeholder={loading ? 'Reading the model list…' : 'Pick the default model'}
            disabled={loading}
            ariaLabel="Default smart model"
          />
        </div>
        <div className="space-y-1">
          <Label>Fast model (cheap tasks)</Label>
          <SearchSelect
            value={modelFast}
            onChange={setModelFast}
            options={options}
            placeholder={loading ? 'Reading the model list…' : 'Pick the fast model'}
            disabled={loading}
            ariaLabel="Default fast model"
          />
        </div>
      </div>
      {modelsError ? (
        <p className="text-xs text-danger">
          The saved key could not list models — {modelsError} Rotate the key below to fix it.
        </p>
      ) : null}

      <div className="space-y-1">
        <Label htmlFor="provider-edit-key">Replace API key</Label>
        <Input
          id="provider-edit-key"
          type="password"
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          placeholder="Leave blank to keep the sealed key"
        />
        <p className="text-xs text-fg-muted">
          A replacement is verified against the live API before it displaces the working key.
        </p>
      </div>

      <div className="space-y-2">
        <p className="text-sm font-medium">
          {agents.length === 0
            ? 'No agents are assigned to this provider'
            : `${agents.length} agent${agents.length === 1 ? '' : 's'} thinking on this provider`}
        </p>
        {agents.length > 0 ? (
          <div className="space-y-1">
            {agents.map((agent) => (
              <Link
                key={agent.personId}
                href={`/organization/agents?person=${agent.personId}`}
                className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-sm transition-colors hover:border-primary/50"
              >
                <span className="font-medium text-primary">{agent.personName}</span>
                <span className="text-xs text-fg-muted">{agent.model}</span>
              </Link>
            ))}
            <p className="text-xs text-fg-muted">
              Removing this provider leaves them without a brain until they are reassigned.
            </p>
          </div>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button
          disabled={busy || !label.trim()}
          onClick={() =>
            startBusy(async () => {
              setError(null)
              const result = await updateProviderAction({
                slug: provider.slug,
                label,
                ...(modelSmart ? { modelSmart } : {}),
                ...(modelFast ? { modelFast } : {}),
                ...(apiKey.trim() ? { apiKey } : {}),
              })
              if (!result.ok) {
                setError(result.message)
                return
              }
              onDone()
            })
          }
        >
          {busy ? 'Verifying…' : 'Save changes'}
        </Button>
        <Button
          variant="destructive"
          disabled={busy}
          onClick={() =>
            startBusy(async () => {
              const form = new FormData()
              form.set('slug', provider.slug)
              await removeProviderAction(form)
              onDone()
            })
          }
        >
          Remove provider
        </Button>
        {error ? <p className="text-sm text-danger">{error}</p> : null}
      </div>
    </div>
  )
}
