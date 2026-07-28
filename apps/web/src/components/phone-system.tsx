'use client'

import * as React from 'react'
import Link from 'next/link'
import {
  Badge,
  Button,
  Drawer,
  Input,
  Label,
  RecordList,
  Select,
  SettingsRow,
  SubtabNav,
  type LinkRender,
  type RecordColumn,
} from '@appkit/ui'
import { deleteSipTrunkAction, saveSipTrunkAction } from '../app/admin/settings/pbx-actions'

const nextLink: LinkRender = ({ href, children, className, title }) => (
  <Link href={href} className={className} title={title}>
    {children}
  </Link>
)

export type SipTrunkSummary = {
  id: string
  name: string
  flavor: 'avaya_ip_office' | 'generic_sip'
  pbxHost: string
  pbxPort: number
  transport: 'udp' | 'tcp' | 'tls'
  authUsername: string
  hasPassword: boolean
  extensionRange: string
  status: 'unconfigured' | 'active' | 'error'
  lastError: string
}

export type HandExtensionRow = {
  personId: string
  name: string
  title: string
  extension: string
}

const FLAVOR_LABELS: Record<SipTrunkSummary['flavor'], string> = {
  avaya_ip_office: 'Avaya IP Office',
  generic_sip: 'Generic SIP',
}

const STATUS_LABELS: Record<SipTrunkSummary['status'], string> = {
  unconfigured: 'not connected',
  active: 'active',
  error: 'error',
}

type TrunkListRow = {
  id: string
  name: string
  flavorLabel: string
  address: string
  range: string
  status: SipTrunkSummary['status']
  statusLabel: string
}

const TRUNK_COLUMNS: RecordColumn<TrunkListRow>[] = [
  { key: 'name', label: 'Name', sortable: true },
  { key: 'flavorLabel', label: 'Type', sortable: true },
  { key: 'address', label: 'PBX address' },
  { key: 'range', label: 'Extensions' },
  {
    key: 'statusLabel',
    label: 'Status',
    kind: 'status',
    statusVariant: (value) => (value === 'active' ? 'default' : value === 'error' ? 'destructive' : 'outline'),
  },
]

const EXTENSION_COLUMNS: RecordColumn<HandExtensionRow>[] = [
  { key: 'extension', label: 'Extension', sortable: true },
  { key: 'name', label: 'Hand', kind: 'reference', sortable: true, href: (row) => `/people?person=${row.personId}` },
  { key: 'title', label: 'Title' },
]

const AVAYA_CHECKLIST = [
  'Confirm capacity: your SIP Trunk Channels licenses cover the concurrent calls you expect, and System → Telephony → Maximum SIP Sessions is greater than zero.',
  'Create a SIP Line whose ITSP / gateway address is the connection address shown under Connection details (port 5060, UDP or TCP). Limit codecs to G.711 ULAW and ALAW, set DTMF to RFC2833 payload 101, turn Re-invite Supported on, turn direct media off, turn Check OOS on, set the Session Timer to On-Demand, and leave REFER Incoming and Outgoing on Auto.',
  'Add a SIP URI channel on the line with matching Incoming and Outgoing Group IDs and enough Max Sessions for your concurrent calls.',
  'Add a short code that routes the hand extension range out the line — for example Code 7XX, Feature Dial, Number 7N"@<connection address>", Line Group set to the URI channel’s group.',
  'Add an Incoming Call Route for the same Line Group with Destination "." (a single period) so the dialed digits pass through.',
  'Confirm the phone system can reach the connection address on the SIP port and the published media port range in both directions, then dial a hand’s extension from a desk phone.',
]

type TrunkDraft = {
  id?: string
  name: string
  flavor: SipTrunkSummary['flavor']
  pbxHost: string
  pbxPort: string
  transport: SipTrunkSummary['transport']
  authUsername: string
  authPassword: string
  clearPassword: boolean
  extensionRange: string
}

const emptyDraft = (): TrunkDraft => ({
  name: '',
  flavor: 'avaya_ip_office',
  pbxHost: '',
  pbxPort: '5060',
  transport: 'udp',
  authUsername: '',
  authPassword: '',
  clearPassword: false,
  extensionRange: '',
})

const draftFrom = (trunk: SipTrunkSummary): TrunkDraft => ({
  id: trunk.id,
  name: trunk.name,
  flavor: trunk.flavor,
  pbxHost: trunk.pbxHost,
  pbxPort: String(trunk.pbxPort),
  transport: trunk.transport,
  authUsername: trunk.authUsername,
  authPassword: '',
  clearPassword: false,
  extensionRange: trunk.extensionRange,
})

/**
 * Settings → Voice → Phone system. One SettingsRow whose drawer manages the
 * company's PBX trunks (rows mirrored to the SIP ingress), the hands'
 * extension directory, and the connection details a PBX administrator
 * enters on their side.
 */
export function PhoneSystemRow({
  trunks,
  extensions,
  ingress,
}: {
  trunks: SipTrunkSummary[]
  extensions: HandExtensionRow[]
  ingress: { host: string; port: number } | null
}) {
  const [open, setOpen] = React.useState(false)
  const [tab, setTab] = React.useState('trunks')
  const [draft, setDraft] = React.useState<TrunkDraft | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [busy, startBusy] = React.useTransition()

  const editing = draft?.id ? trunks.find((t) => t.id === draft.id) : undefined
  const localIngress = ingress !== null && ['localhost', '127.0.0.1'].includes(ingress.host)

  const rows: TrunkListRow[] = trunks.map((trunk) => ({
    id: trunk.id,
    name: trunk.name,
    flavorLabel: FLAVOR_LABELS[trunk.flavor],
    address: trunk.pbxHost ? `${trunk.pbxHost}:${trunk.pbxPort} (${trunk.transport.toUpperCase()})` : '—',
    range: trunk.extensionRange || '—',
    status: trunk.status,
    statusLabel: STATUS_LABELS[trunk.status],
  }))

  const activeCount = trunks.filter((t) => t.status === 'active').length
  const summary =
    trunks.length === 0
      ? 'Connect your office phone system so hands answer real desk-phone extensions.'
      : `${trunks.length} trunk${trunks.length === 1 ? '' : 's'} · ${activeCount} active · ${extensions.length} extension${extensions.length === 1 ? '' : 's'} assigned`

  const save = () => {
    if (!draft) return
    startBusy(async () => {
      setError(null)
      const result = await saveSipTrunkAction({
        ...(draft.id ? { id: draft.id } : {}),
        name: draft.name,
        flavor: draft.flavor,
        pbxHost: draft.pbxHost,
        pbxPort: draft.pbxPort,
        transport: draft.transport,
        authUsername: draft.authUsername,
        // Typed password replaces; "clear" removes; otherwise leave sealed.
        ...(draft.authPassword.trim()
          ? { authPassword: draft.authPassword }
          : draft.clearPassword
            ? { authPassword: '' }
            : {}),
        extensionRange: draft.extensionRange,
      })
      if (!result.ok) {
        setError(result.message)
        return
      }
      setDraft(null)
    })
  }

  const remove = () => {
    if (!draft?.id) return
    const id = draft.id
    startBusy(async () => {
      setError(null)
      await deleteSipTrunkAction(id)
      setDraft(null)
    })
  }

  return (
    <>
      <SettingsRow
        title="Phone system"
        description={summary}
        control={
          <span className="flex items-center gap-2">
            {trunks.length > 0 ? (
              <Badge variant={activeCount > 0 ? 'default' : 'outline'}>
                {activeCount > 0 ? 'connected' : 'not connected'}
              </Badge>
            ) : null}
            <Button variant={trunks.length > 0 ? 'outline' : 'default'} size="sm" onClick={() => setOpen(true)}>
              {trunks.length > 0 ? 'Manage' : 'Set up'}
            </Button>
          </span>
        }
      />

      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        title="Phone system"
        description="Point your PBX at bunkhouse and desk phones can dial hands by extension."
        size="lg"
      >
        <div className="space-y-4">
          <SubtabNav
            ariaLabel="Phone system"
            active={tab}
            onSelect={setTab}
            tabs={[
              { key: 'trunks', label: 'Trunks', count: trunks.length },
              { key: 'extensions', label: 'Extensions', count: extensions.length },
              { key: 'connection', label: 'Connection details' },
            ]}
          />

          {tab === 'trunks' ? (
            <RecordList
              columns={TRUNK_COLUMNS}
              rows={rows}
              getRowId={(row) => row.id}
              linkRender={nextLink}
              onRowClick={(row) => {
                const trunk = trunks.find((t) => t.id === row.id)
                if (!trunk) return
                setError(null)
                setDraft(draftFrom(trunk))
              }}
              toolbarActions={
                <Button
                  size="sm"
                  onClick={() => {
                    setError(null)
                    setDraft(emptyDraft())
                  }}
                >
                  Add trunk
                </Button>
              }
              empty={{
                title: 'No trunks yet',
                description:
                  'A trunk is the SIP line your PBX points at bunkhouse. Add one, then route an extension range to it from the PBX.',
              }}
            />
          ) : null}

          {tab === 'extensions' ? (
            <div className="space-y-3">
              <RecordList
                columns={EXTENSION_COLUMNS}
                rows={extensions}
                getRowId={(row) => row.personId}
                linkRender={nextLink}
                empty={{
                  title: 'No extensions assigned',
                  description: 'Give each hand a short code on the Voice tab of its profile — that is the number desk phones dial.',
                }}
              />
              <p className="text-xs text-fg-muted">
                Extensions are assigned on each hand&apos;s profile, under Voice. Each code is unique across the
                company.
              </p>
            </div>
          ) : null}

          {tab === 'connection' ? (
            <div className="space-y-3 text-sm">
              <p className="text-fg-muted">
                Enter these values on the PBX side — they identify this bunkhouse deployment&apos;s SIP ingress.
              </p>
              <div className="space-y-2">
                <div className="flex items-center justify-between rounded-md border border-border px-3 py-2">
                  <span className="text-fg-muted">SIP address</span>
                  <span className="font-medium tabular-nums">{ingress ? ingress.host : 'Unavailable'}</span>
                </div>
                <div className="flex items-center justify-between rounded-md border border-border px-3 py-2">
                  <span className="text-fg-muted">Port</span>
                  <span className="font-medium tabular-nums">{ingress ? ingress.port : '—'}</span>
                </div>
                <div className="flex items-center justify-between rounded-md border border-border px-3 py-2">
                  <span className="text-fg-muted">Transport</span>
                  <span className="font-medium">UDP or TCP</span>
                </div>
                <div className="flex items-center justify-between rounded-md border border-border px-3 py-2">
                  <span className="text-fg-muted">Audio</span>
                  <span className="font-medium">G.711 ULAW / ALAW · DTMF RFC2833</span>
                </div>
              </div>
              {localIngress ? (
                <p className="text-xs text-fg-muted">
                  This is the development address of the current deployment — a PBX must reach it on the same machine
                  or network. A production deployment shows its public host here.
                </p>
              ) : (
                <p className="text-xs text-fg-muted">
                  Allow two-way traffic from the PBX to this address on the SIP port and the deployment&apos;s
                  published media port range.
                </p>
              )}
            </div>
          ) : null}
        </div>
      </Drawer>

      <Drawer
        open={draft !== null}
        onClose={() => setDraft(null)}
        title={draft?.id ? `Trunk — ${editing?.name ?? ''}` : 'Add trunk'}
        description="The SIP line your PBX points at bunkhouse. Saving reconnects the trunk with the latest details."
        size="md"
      >
        {draft ? (
          <div className="space-y-4">
            {draft.id && editing ? (
              <div className="flex items-center justify-between rounded-md border border-border px-3 py-2 text-sm">
                <span className="text-fg-muted">Status</span>
                <Badge
                  variant={
                    editing.status === 'active' ? 'default' : editing.status === 'error' ? 'destructive' : 'outline'
                  }
                >
                  {STATUS_LABELS[editing.status]}
                </Badge>
              </div>
            ) : null}
            {draft.id && editing?.lastError ? (
              <div className="rounded-md border border-danger/40 bg-danger-subtle px-3 py-2 text-sm">
                <p className="text-xs text-fg-muted">Last error</p>
                <p>{editing.lastError}</p>
              </div>
            ) : null}

            <div className="space-y-1">
              <Label htmlFor="trunk-name">Name</Label>
              <Input
                id="trunk-name"
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                placeholder="Head office IP Office"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="trunk-flavor">Phone system</Label>
              <Select
                id="trunk-flavor"
                value={draft.flavor}
                onChange={(e) => setDraft({ ...draft, flavor: e.target.value as SipTrunkSummary['flavor'] })}
              >
                <option value="avaya_ip_office">Avaya IP Office</option>
                <option value="generic_sip">Generic SIP</option>
              </Select>
            </div>
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="space-y-1 sm:col-span-2">
                <Label htmlFor="trunk-host">PBX address</Label>
                <Input
                  id="trunk-host"
                  value={draft.pbxHost}
                  onChange={(e) => setDraft({ ...draft, pbxHost: e.target.value })}
                  placeholder="10.0.0.20"
                />
                <p className="text-xs text-fg-muted">Calls are only accepted from this address when set.</p>
              </div>
              <div className="space-y-1">
                <Label htmlFor="trunk-port">Port</Label>
                <Input
                  id="trunk-port"
                  value={draft.pbxPort}
                  onChange={(e) => setDraft({ ...draft, pbxPort: e.target.value })}
                  placeholder="5060"
                />
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="trunk-transport">Transport</Label>
                <Select
                  id="trunk-transport"
                  value={draft.transport}
                  onChange={(e) => setDraft({ ...draft, transport: e.target.value as SipTrunkSummary['transport'] })}
                >
                  <option value="udp">UDP</option>
                  <option value="tcp">TCP</option>
                  <option value="tls">TLS</option>
                </Select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="trunk-range">Extension range</Label>
                <Input
                  id="trunk-range"
                  value={draft.extensionRange}
                  onChange={(e) => setDraft({ ...draft, extensionRange: e.target.value })}
                  placeholder="7XX"
                />
                <p className="text-xs text-fg-muted">The range the PBX routes here — a note for your team.</p>
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="trunk-auth-user">Auth username</Label>
                <Input
                  id="trunk-auth-user"
                  value={draft.authUsername}
                  onChange={(e) => setDraft({ ...draft, authUsername: e.target.value })}
                  placeholder="Optional"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="trunk-auth-pass">Auth password</Label>
                <Input
                  id="trunk-auth-pass"
                  type="password"
                  value={draft.authPassword}
                  onChange={(e) => setDraft({ ...draft, authPassword: e.target.value })}
                  placeholder={draft.id && editing?.hasPassword ? 'Unchanged' : 'Optional'}
                />
                {draft.id && editing?.hasPassword ? (
                  <label className="flex items-center gap-2 text-xs text-fg-muted">
                    <input
                      type="checkbox"
                      checked={draft.clearPassword}
                      onChange={(e) => setDraft({ ...draft, clearPassword: e.target.checked })}
                    />
                    Remove the stored password
                  </label>
                ) : (
                  <p className="text-xs text-fg-muted">Sealed at rest.</p>
                )}
              </div>
            </div>

            {draft.flavor === 'avaya_ip_office' ? (
              <details className="rounded-md border border-border px-3 py-2">
                <summary className="cursor-pointer text-sm font-medium">Avaya IP Office setup</summary>
                <ol className="mt-2 list-decimal space-y-2 pl-5 text-sm text-fg-muted">
                  {AVAYA_CHECKLIST.map((step, index) => (
                    <li key={index}>{step}</li>
                  ))}
                </ol>
              </details>
            ) : null}

            {error ? <p className="text-sm text-danger">{error}</p> : null}
            <div className="flex items-center justify-between gap-2">
              <Button onClick={save} disabled={busy || !draft.name.trim()}>
                {busy ? 'Saving…' : draft.id ? 'Save & reconnect' : 'Add trunk'}
              </Button>
              {draft.id ? (
                <Button variant="outline" onClick={remove} disabled={busy}>
                  Delete trunk
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}
      </Drawer>
    </>
  )
}
