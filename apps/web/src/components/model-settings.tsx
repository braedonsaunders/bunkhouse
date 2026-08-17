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
  type PagedColumn,
} from '@braedonsaunders/appkit-ui'
import { AddProviderForm, type ProviderKindOption } from './add-provider-form'
import {
  loadModelsForProviderAction,
  reconcileNowAction,
  refreshPricesAction,
  removeBillingKeyAction,
  removeProviderAction,
  setBillingKeyAction,
  setManualPriceAction,
  updateProviderAction,
} from '../app/admin/settings/actions'
import { SectionTabs } from './section-tabs'

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

/** One day's invoice against one day's ledger, as the last reading found it. */
export type ReconciliationView = {
  id: string
  provider: string
  day: string
  model: string
  reportedUsd: number
  ledgerUsd: number
  driftUsd: number
  fetchedAt: string
}

export type BillingView = {
  /** Providers whose cost report this company has a key for. */
  connected: { anthropic: boolean; openai: boolean }
  rows: ReconciliationView[]
}

/** Providers that publish a cost report, and what their admin key looks like. */
const BILLING_PROVIDERS = [
  { value: 'anthropic', label: 'Anthropic', hint: 'sk-ant-admin-…' },
  { value: 'openai', label: 'OpenAI', hint: 'sk-admin-…' },
] as const

const usd = (value: number): string => `${value < 0 ? '−' : ''}$${Math.abs(value).toFixed(2)}`

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

const RECONCILIATION_COLUMNS: PagedColumn<ReconciliationView>[] = [
  { key: 'day', header: 'Day', cell: (row) => row.day, search: (row) => row.day, sortValue: (row) => row.day },
  {
    key: 'provider',
    header: 'Provider',
    cell: (row) => <Badge variant="secondary">{row.provider}</Badge>,
    search: (row) => row.provider,
    sortValue: (row) => row.provider,
  },
  {
    key: 'model',
    header: 'Line',
    cell: (row) => (row.model === '*' ? <span className="text-fg-muted">unattributed</span> : row.model),
    search: (row) => row.model,
    sortValue: (row) => row.model,
  },
  {
    key: 'reported',
    header: 'Charged',
    align: 'right',
    cell: (row) => <span className="tabular-nums">{usd(row.reportedUsd)}</span>,
    sortValue: (row) => row.reportedUsd,
  },
  {
    key: 'ledger',
    header: 'Counted',
    align: 'right',
    cell: (row) => <span className="tabular-nums">{usd(row.ledgerUsd)}</span>,
    sortValue: (row) => row.ledgerUsd,
  },
  {
    key: 'drift',
    header: 'Gap',
    align: 'right',
    cell: (row) => (
      <span className={`tabular-nums ${Math.abs(row.driftUsd) >= 0.01 ? 'text-danger' : 'text-fg-muted'}`}>
        {usd(row.driftUsd)}
      </span>
    ),
    sortValue: (row) => Math.abs(row.driftUsd),
  },
]

const TABS = ['providers', 'pricing', 'reconciliation'] as const

export function ModelSettings({
  providers,
  kinds,
  prices,
  unpricedModels,
  billing,
  assignments,
  initialTab,
}: {
  providers: ProviderSummary[]
  kinds: ProviderKindOption[]
  prices: PriceRow[]
  /** Models agents can spend on that no price row covers — the $0 spend. */
  unpricedModels: string[]
  billing: BillingView
  /** Agents currently assigned to each provider slug. */
  assignments: ProviderAssignment[]
  initialTab: string
}) {
  const [tab, setTab] = React.useState<string>(
    (TABS as readonly string[]).includes(initialTab) ? initialTab : 'providers',
  )
  const [adding, setAdding] = React.useState(false)
  const [editing, setEditing] = React.useState<ProviderSummary | null>(null)
  const [priceDrawer, setPriceDrawer] = React.useState<string | null>(null)
  const [billingDrawer, setBillingDrawer] = React.useState<string | null>(null)
  const [notice, setNotice] = React.useState<string | null>(null)
  const [busy, startBusy] = React.useTransition()

  const totalDrift = billing.rows.reduce((total, row) => total + row.driftUsd, 0)
  const connectedCount = Object.values(billing.connected).filter(Boolean).length

  const rows: ProviderRow[] = providers.map((provider) => ({
    ...provider,
    kindLabel: kinds.find((kind) => kind.value === provider.provider)?.label ?? provider.provider,
    agentCount: assignments.filter((agent) => agent.providerSlug === provider.slug).length,
  }))
  const priceHistory = priceDrawer && priceDrawer !== '*new*' ? prices.filter((row) => row.model === priceDrawer) : []

  return (
    <div className="space-y-4">
      <SectionTabs
        ariaLabel="Models"
        active={tab}
        onSelect={setTab}
        tabs={[
          { key: 'providers', label: 'Providers', count: providers.length },
          { key: 'pricing', label: 'Pricing', count: prices.length },
          { key: 'reconciliation', label: 'Reconciliation', count: billing.rows.length },
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
          description="What a token costs where the provider does not say. OpenRouter reports the exact cost of every request, and those charges are banked as-is; the rows here price the providers that bill in tokens and leave the arithmetic to you. Effective-dated and append-only, so every spend record keeps the price it was charged at."
        >
          <SettingsRow
            title="Keeping prices current"
            description="Prices refresh from the OpenRouter catalog nightly, appending a new effective row only where a price actually changed. '*' is the company default for any model with no row of its own."
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
                      const result = await refreshPricesAction()
                      if (!result.ok) {
                        setNotice(result.message)
                        return
                      }
                      const changed =
                        result.updated.length === 0
                          ? 'Every price is already current.'
                          : `Updated ${result.updated.length} price${result.updated.length === 1 ? '' : 's'}.`
                      setNotice(
                        result.unmatched.length === 0
                          ? changed
                          : `${changed} The catalog lists no price for ${result.unmatched.join(', ')} — add ${result.unmatched.length === 1 ? 'it' : 'them'} by hand.`,
                      )
                    })
                  }
                >
                  {busy ? 'Refreshing…' : 'Refresh now'}
                </Button>
              </span>
            }
          />
          {unpricedModels.length > 0 ? (
            <SettingsRow
              title="Models with no price"
              description={`${unpricedModels.join(', ')} — work on ${unpricedModels.length === 1 ? 'this model' : 'these models'} is recorded against salary at $0 until a price exists for ${unpricedModels.length === 1 ? 'it' : 'them'}.`}
              control={
                <Button size="sm" variant="outline" onClick={() => setPriceDrawer(unpricedModels[0] ?? '*new*')}>
                  Price {unpricedModels.length === 1 ? 'it' : 'them'}
                </Button>
              }
            />
          ) : null}
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
                  description="Refresh the catalog or add a price by hand. Work on a model with no price is recorded at $0 and flagged as unpriced."
                  action={<Button onClick={() => setPriceDrawer('*new*')}>Add manual price</Button>}
                />
              }
            />
          </div>
        </SettingsSection>
      ) : null}

      {tab === 'reconciliation' ? (
        <SettingsSection
          title="Reconciliation"
          description="Anthropic and OpenAI will tell you what they actually charged, a day in arrears, for the organization as a whole. That is too coarse to bill an agent with, and exactly right for checking the books: each night their invoice is compared against what this company counted, and the gap is recorded here. Salary figures are never rewritten from it — a gap that persists means a price above needs correcting."
        >
          <SettingsRow
            title="Invoice access"
            description={
              connectedCount === 0
                ? 'No provider is connected, so nothing is being checked. Each provider issues a separate administration key for billing — an agent key cannot read invoices.'
                : `${connectedCount === 2 ? 'Both providers are' : 'One provider is'} connected. Invoices are read nightly.`
            }
            control={
              <Button size="sm" variant="outline" onClick={() => setBillingDrawer('*keys*')}>
                Manage keys
              </Button>
            }
          />
          <SettingsRow
            title="Last 30 days"
            description={
              billing.rows.length === 0
                ? 'Nothing has been compared yet.'
                : `Charged ${usd(billing.rows.reduce((total, row) => total + row.reportedUsd, 0))} against ${usd(billing.rows.reduce((total, row) => total + row.ledgerUsd, 0))} counted — a gap of ${usd(totalDrift)}.`
            }
            control={
              <Button
                size="sm"
                disabled={busy || connectedCount === 0}
                title={connectedCount === 0 ? 'Connect an administration key first.' : undefined}
                onClick={() =>
                  startBusy(async () => {
                    setNotice(null)
                    const result = await reconcileNowAction()
                    if (!result.ok) {
                      setNotice(result.message)
                      return
                    }
                    const summary =
                      result.recorded === 0
                        ? 'Checked — nothing has moved since the last reading.'
                        : `Checked — ${result.recorded} figure${result.recorded === 1 ? '' : 's'} updated, a gap of ${usd(result.driftUsd)}.`
                    setNotice([summary, ...result.notes].join(' '))
                  })
                }
              >
                {busy ? 'Checking…' : 'Check now'}
              </Button>
            }
          />
          {notice ? <p className="px-5 py-3 text-sm text-fg-muted">{notice}</p> : null}
          <div className="px-5 py-4">
            <PagedTable
              columns={RECONCILIATION_COLUMNS}
              rows={billing.rows}
              rowKey={(row) => row.id}
              pageSize={15}
              searchable
              defaultSort={{ key: 'day', dir: 'desc' }}
              labels={{ searchPlaceholder: 'Search days…', searchLabel: 'Search reconciliation' }}
              empty={
                <EmptyState
                  title="Nothing checked yet"
                  description="Connect an administration key and the nightly pass will start comparing what you were charged against what was counted."
                  action={<Button onClick={() => setBillingDrawer('*keys*')}>Manage keys</Button>}
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
        open={billingDrawer !== null}
        onClose={() => setBillingDrawer(null)}
        title="Invoice access"
        description="One administration key per provider, sealed at rest and used only to read what you were charged."
        size="md"
      >
        {billingDrawer ? <BillingKeysBody connected={billing.connected} /> : null}
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
 * The keys that read invoices. Deliberately not the keys agents think on: both
 * providers refuse billing endpoints to an inference key, and the separation is
 * worth keeping anyway — whatever can read the company's spending should not be
 * the credential handed to every agent.
 */
function BillingKeysBody({ connected }: { connected: BillingView['connected'] }) {
  const [entered, setEntered] = React.useState<Record<string, string>>({})
  const [error, setError] = React.useState<string | null>(null)
  const [notice, setNotice] = React.useState<string | null>(null)
  const [busy, startBusy] = React.useTransition()

  return (
    <div className="space-y-6">
      {BILLING_PROVIDERS.map((provider) => {
        const isConnected = connected[provider.value]
        return (
          <div key={provider.value} className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor={`billing-${provider.value}`}>{provider.label}</Label>
              <Badge variant={isConnected ? 'secondary' : 'outline'}>{isConnected ? 'connected' : 'not connected'}</Badge>
            </div>
            <Input
              id={`billing-${provider.value}`}
              type="password"
              value={entered[provider.value] ?? ''}
              onChange={(event) => setEntered((current) => ({ ...current, [provider.value]: event.target.value }))}
              placeholder={isConnected ? 'Leave blank to keep the sealed key' : provider.hint}
            />
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                disabled={busy || !(entered[provider.value] ?? '').trim()}
                onClick={() =>
                  startBusy(async () => {
                    setError(null)
                    setNotice(null)
                    const result = await setBillingKeyAction({
                      provider: provider.value,
                      adminKey: entered[provider.value] ?? '',
                    })
                    if (!result.ok) {
                      setError(result.message)
                      return
                    }
                    setEntered((current) => ({ ...current, [provider.value]: '' }))
                    setNotice(`${provider.label} answered — its invoices are now being read.`)
                  })
                }
              >
                {busy ? 'Checking…' : isConnected ? 'Replace key' : 'Connect'}
              </Button>
              {isConnected ? (
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={busy}
                  onClick={() =>
                    startBusy(async () => {
                      setError(null)
                      setNotice(null)
                      const result = await removeBillingKeyAction(provider.value)
                      if (!result.ok) setError(result.message)
                      else setNotice(`${provider.label} spend is no longer being checked.`)
                    })
                  }
                >
                  Disconnect
                </Button>
              ) : null}
            </div>
          </div>
        )
      })}
      <p className="text-xs text-fg-muted">
        A key is proved against the provider&apos;s own cost report before it is saved, so a mistyped or under-privileged
        key fails here rather than quietly every night. Google and OpenRouter publish no equivalent report — OpenRouter
        prices every request as it serves it, so there is nothing left to reconcile.
      </p>
      {notice ? <p className="text-sm text-fg-muted">{notice}</p> : null}
      {error ? <p className="text-sm text-danger">{error}</p> : null}
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
                href={`/organization?person=${agent.personId}`}
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
