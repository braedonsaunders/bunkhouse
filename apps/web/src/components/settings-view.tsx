'use client'

import * as React from 'react'
import Link from 'next/link'
import { Brain, CircleDollarSign, Mail } from 'lucide-react'
import {
  Badge,
  Button,
  Drawer,
  EmptyState,
  Input,
  Label,
  RecordList,
  SettingsRow,
  SettingsSection,
  SettingsShell,
  type LinkRender,
  type RecordColumn,
  type SettingsNavGroup,
} from '@appkit/ui'
import {
  refreshPricesAction,
  removeProviderAction,
  setManualPriceAction,
} from '../app/admin/settings/actions'
import { AddProviderForm, type ProviderKindOption } from './add-provider-form'

const nextLink: LinkRender = ({ href, children, className, title }) => (
  <Link href={href} className={className} title={title}>
    {children}
  </Link>
)

export type ProviderSummary = {
  slug: string
  label: string
  provider: string
  modelSmart?: string
  modelFast?: string
  baseUrl?: string
}

export type PriceRow = {
  id: string
  model: string
  inputUsdPerMtok: string
  outputUsdPerMtok: string
  source: string
  sourceRef?: string
  effectiveAt: string
}

export type MailboxRow = {
  id: string
  personId: string
  personName: string
  address: string
  status: string
  lastSyncAt?: string
  lastError?: string
}

export type HandWithoutMailbox = { id: string; name: string; title: string }

const NAV: SettingsNavGroup[] = [
  {
    label: 'Company',
    items: [
      { key: 'ai', label: 'Model providers', icon: <Brain /> },
      { key: 'pricing', label: 'Model pricing', icon: <CircleDollarSign /> },
      { key: 'mailboxes', label: 'Mailboxes', icon: <Mail /> },
    ],
  },
]

const PRICE_COLUMNS: RecordColumn<PriceRow>[] = [
  { key: 'model', label: 'Model', sortable: true },
  { key: 'inputUsdPerMtok', label: 'Input $/Mtok', kind: 'amount', sortable: true },
  { key: 'outputUsdPerMtok', label: 'Output $/Mtok', kind: 'amount', sortable: true },
  {
    key: 'source',
    label: 'Source',
    kind: 'status',
    statusVariant: (value) => (value === 'openrouter' ? 'secondary' : 'outline'),
  },
  { key: 'effectiveAt', label: 'Effective', sortable: true },
]

const MAILBOX_COLUMNS: RecordColumn<MailboxRow>[] = [
  { key: 'personName', label: 'Hand', kind: 'reference', sortable: true, href: (row) => `/people/${row.personId}` },
  { key: 'address', label: 'Address', sortable: true },
  {
    key: 'status',
    label: 'Status',
    kind: 'status',
    sortable: true,
    statusVariant: (value) => (value === 'active' ? 'default' : value === 'error' ? 'destructive' : 'outline'),
  },
  { key: 'lastSyncAt', label: 'Last sync' },
  { key: 'lastError', label: 'Last error' },
]

export function SettingsView({
  providers,
  kinds,
  prices,
  mailboxes,
  handsWithoutMailbox,
}: {
  providers: ProviderSummary[]
  kinds: ProviderKindOption[]
  prices: PriceRow[]
  mailboxes: MailboxRow[]
  handsWithoutMailbox: HandWithoutMailbox[]
}) {
  const [active, setActive] = React.useState('ai')
  const [busy, startBusy] = React.useTransition()
  const [notice, setNotice] = React.useState<string | null>(null)
  const [priceDrawer, setPriceDrawer] = React.useState<string | null>(null)
  const [mailboxDrawer, setMailboxDrawer] = React.useState<MailboxRow | null>(null)
  const priceHistory = priceDrawer && priceDrawer !== '*new*' ? prices.filter((row) => row.model === priceDrawer) : []

  return (
    <SettingsShell
      title="Settings"
      description="Company-level configuration. Everything lives here, nothing in env."
      back={{ href: '/admin', label: 'Admin' }}
      nav={NAV}
      activeKey={active}
      onSelect={(key) => {
        setActive(key)
        setNotice(null)
      }}
      linkRender={nextLink}
    >
      {active === 'ai' ? (
        <SettingsSection
          title="Model providers"
          description="Your own API keys, sealed at rest and live-verified before saving. Each hand is assigned a provider and model on its profile."
        >
          {providers.length === 0 ? (
            <EmptyState title="No providers yet" description="Add one API key and your hands can start thinking." />
          ) : (
            providers.map((entry) => (
              <SettingsRow
                key={entry.slug}
                title={`${entry.label} · ${entry.slug}`}
                description={`${entry.provider}${entry.modelSmart ? ` · default ${entry.modelSmart}` : ''}${entry.modelFast ? ` · fast ${entry.modelFast}` : ''}${entry.baseUrl ? ` · ${entry.baseUrl}` : ''}`}
                control={
                  <span className="flex items-center gap-2">
                    <Badge variant="secondary">key sealed</Badge>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        startBusy(async () => {
                          const form = new FormData()
                          form.set('slug', entry.slug)
                          await removeProviderAction(form)
                        })
                      }
                    >
                      Remove
                    </Button>
                  </span>
                }
              />
            ))
          )}
          <SettingsRow title="Add a provider" description="Verify the key, pick defaults from its live model list." stacked>
            <AddProviderForm kinds={kinds} />
          </SettingsRow>
        </SettingsSection>
      ) : null}

      {active === 'pricing' ? (
        <SettingsSection
          title="Model pricing"
          description="Effective-dated, append-only price rows — every spend record stamps the exact price it used, so costs are auditable forever. Refresh pulls live prices from the OpenRouter catalog for models your hands use; '*' is the company default."
        >
          <SettingsRow
            title="Refresh from OpenRouter"
            description="Appends a new effective row only where the price actually changed."
            control={
              <Button
                variant="outline"
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
                {busy ? 'Refreshing…' : 'Refresh prices'}
              </Button>
            }
          />
          {notice ? <p className="text-sm text-fg-muted">{notice}</p> : null}
          <RecordList
            columns={PRICE_COLUMNS}
            rows={prices}
            getRowId={(row) => row.id}
            linkRender={nextLink}
            onRowClick={(row) => setPriceDrawer(row.model)}
            toolbarActions={
              <Button variant="outline" size="sm" onClick={() => setPriceDrawer('*new*')}>
                Add manual price
              </Button>
            }
            empty={{
              title: 'No prices yet',
              description: 'Refresh from OpenRouter or add a manual price. Unpriced spend records cost $0 and is flagged.',
            }}
          />

        </SettingsSection>
      ) : null}

      {active === 'mailboxes' ? (
        <SettingsSection
          title="Mailboxes"
          description="Every hand's connected email account: status, sync health, and errors. Connect a mailbox from the hand's profile."
        >
          <RecordList
            columns={MAILBOX_COLUMNS}
            rows={mailboxes}
            getRowId={(row) => row.id}
            linkRender={nextLink}
            onRowClick={(row) => setMailboxDrawer(row)}
            empty={{
              title: 'No mailboxes connected',
              description: 'Open a hand’s profile and connect their address to bring them online.',
            }}
          />
          {handsWithoutMailbox.length > 0 ? (
            <SettingsRow
              title="Hands without a mailbox"
              description="These hands cannot receive work until an address is connected."
              stacked
            >
              <div className="flex flex-wrap gap-2">
                {handsWithoutMailbox.map((hand) => (
                  <Link
                    key={hand.id}
                    href={`/people/${hand.id}`}
                    className="rounded-md border border-border px-3 py-1.5 text-sm text-fg-muted transition-colors hover:border-primary/50 hover:text-fg"
                  >
                    {hand.name} · {hand.title}
                  </Link>
                ))}
              </div>
            </SettingsRow>
          ) : null}
        </SettingsSection>
      ) : null}
      <Drawer
        open={priceDrawer !== null}
        onClose={() => setPriceDrawer(null)}
        title={priceDrawer === '*new*' ? 'Add manual price' : `Pricing — ${priceDrawer ?? ''}`}
        description={
          priceDrawer === '*new*'
            ? "Model id, or * for the company default. Appends an effective-dated row."
            : 'Full effective-dated history; the newest row is in force. Changes append, never edit.'
        }
        size="md"
      >
        <div className="space-y-6">
          {priceDrawer && priceDrawer !== '*new*' ? (
            <div className="space-y-1">
              {priceHistory.map((row) => (
                <div key={row.id} className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-sm">
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

      <Drawer
        open={mailboxDrawer !== null}
        onClose={() => setMailboxDrawer(null)}
        title={mailboxDrawer ? `Mailbox — ${mailboxDrawer.address}` : ''}
        description={mailboxDrawer ? `Connected to ${mailboxDrawer.personName}` : undefined}
        size="md"
      >
        {mailboxDrawer ? (
          <div className="space-y-4 text-sm">
            <div className="space-y-2">
              <div className="flex items-center justify-between rounded-md border border-border px-3 py-2">
                <span className="text-fg-muted">Status</span>
                <Badge variant={mailboxDrawer.status === 'active' ? 'default' : mailboxDrawer.status === 'error' ? 'destructive' : 'outline'}>
                  {mailboxDrawer.status}
                </Badge>
              </div>
              <div className="flex items-center justify-between rounded-md border border-border px-3 py-2">
                <span className="text-fg-muted">Last sync</span>
                <span>{mailboxDrawer.lastSyncAt || 'never'}</span>
              </div>
              {mailboxDrawer.lastError ? (
                <div className="rounded-md border border-danger/40 bg-danger-subtle px-3 py-2">
                  <p className="text-xs text-fg-muted">Last error</p>
                  <p>{mailboxDrawer.lastError}</p>
                </div>
              ) : null}
            </div>
            <Button asChild variant="outline" size="sm">
              <Link href={`/people/${mailboxDrawer.personId}`}>Open hand profile</Link>
            </Button>
          </div>
        ) : null}
      </Drawer>
    </SettingsShell>
  )
}
