'use client'

import * as React from 'react'
import Link from 'next/link'
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Drawer,
  EmptyState,
  Input,
  Label,
  PagedTable,
  Select,
  SettingsRow,
  SubtabNav,
  Textarea,
  type PagedColumn,
} from '@appkit/ui'
import {
  assignPhoneNumberAction,
  deleteBridgeExtensionAction,
  deleteSipTrunkAction,
  loadPhoneSystemDetailAction,
  probeAllTrunksAction,
  probeTrunkHealthAction,
  refreshBridgeRegistrationsAction,
  removePhoneNumberAction,
  republishBridgeAction,
  saveBridgeExtensionAction,
  saveSipTrunkAction,
  testTrunkCallAction,
  type BridgeExtensionView,
  type PhoneSystemDetail,
  type TrunkDetailView,
} from '../app/admin/settings/pbx-actions'

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

export type PhoneNumberRowView = {
  id: string
  /** Bare digits as stored; shown formatted with a leading '+'. */
  number: string
  label: string
  personName: string
}

export type AgentOption = { id: string; name: string; title: string }

export type AgentExtensionRow = {
  personId: string
  name: string
  title: string
  extension: string
}

type TestCallStep = { label: string; detail: string; ok: boolean }
type TestCallReport = { ok: boolean; steps: TestCallStep[]; summary: string }

const FLAVOR_LABELS: Record<SipTrunkSummary['flavor'], string> = {
  avaya_ip_office: 'Avaya IP Office',
  generic_sip: 'Generic SIP',
}

const STATUS_LABELS: Record<SipTrunkSummary['status'], string> = {
  unconfigured: 'not connected',
  active: 'active',
  error: 'error',
}

const MODE_LABELS: Record<TrunkDetailView['mode'], string> = {
  trunk: 'SIP line',
  extension: 'Registered extensions',
}

const HEALTH_LABELS: Record<TrunkDetailView['health'], string> = {
  unknown: 'not checked',
  ok: 'answering',
  unreachable: 'not answering',
}

const REG_LABELS: Record<BridgeExtensionView['regStatus'], string> = {
  unregistered: 'not registered',
  registered: 'registered',
  failed: 'failed',
}

type TrunkListRow = {
  id: string
  name: string
  flavorLabel: string
  modeLabel: string
  address: string
  range: string
  healthLabel: string
  statusLabel: string
}

const agentLink = (personId: string, label: string) => (
  <Link href={`/organization/agents?person=${personId}`} className="font-medium text-primary hover:underline">
    {label}
  </Link>
)

const TRUNK_COLUMNS: PagedColumn<TrunkListRow>[] = [
  { key: 'name', header: 'Name', cell: (row) => row.name, search: (row) => row.name, sortValue: (row) => row.name },
  {
    key: 'modeLabel',
    header: 'Connection',
    cell: (row) => row.modeLabel,
    search: (row) => row.modeLabel,
    sortValue: (row) => row.modeLabel,
  },
  { key: 'address', header: 'PBX address', cell: (row) => row.address, search: (row) => row.address },
  { key: 'range', header: 'Extensions', cell: (row) => row.range },
  {
    key: 'healthLabel',
    header: 'Line check',
    cell: (row) => (
      <Badge
        variant={
          row.healthLabel === 'answering'
            ? 'default'
            : row.healthLabel === 'not answering'
              ? 'destructive'
              : 'outline'
        }
      >
        {row.healthLabel}
      </Badge>
    ),
    sortValue: (row) => row.healthLabel,
  },
  {
    key: 'statusLabel',
    header: 'Status',
    cell: (row) => (
      <Badge
        variant={row.statusLabel === 'active' ? 'default' : row.statusLabel === 'error' ? 'destructive' : 'outline'}
      >
        {row.statusLabel}
      </Badge>
    ),
    sortValue: (row) => row.statusLabel,
  },
]

const EXTENSION_COLUMNS: PagedColumn<AgentExtensionRow>[] = [
  {
    key: 'extension',
    header: 'Extension',
    cell: (row) => <span className="tabular-nums">{row.extension}</span>,
    search: (row) => row.extension,
    sortValue: (row) => row.extension,
  },
  {
    key: 'name',
    header: 'Agent',
    cell: (row) => agentLink(row.personId, row.name),
    search: (row) => row.name,
    sortValue: (row) => row.name,
  },
  { key: 'title', header: 'Title', cell: (row) => row.title, search: (row) => row.title, sortValue: (row) => row.title },
]

const BRIDGE_COLUMNS: PagedColumn<BridgeExtensionView>[] = [
  {
    key: 'extension',
    header: 'Extension',
    cell: (row) => <span className="tabular-nums">{row.extension}</span>,
    search: (row) => row.extension,
    sortValue: (row) => row.extension,
  },
  {
    key: 'personName',
    header: 'Agent',
    cell: (row) => agentLink(row.personId, row.personName),
    search: (row) => row.personName,
    sortValue: (row) => row.personName,
  },
  {
    key: 'trunkName',
    header: 'Phone system',
    cell: (row) => row.trunkName,
    search: (row) => row.trunkName,
    sortValue: (row) => row.trunkName,
  },
  {
    key: 'regStatus',
    header: 'Registration',
    cell: (row) => (
      <Badge
        variant={row.regStatus === 'registered' ? 'default' : row.regStatus === 'failed' ? 'destructive' : 'outline'}
      >
        {REG_LABELS[row.regStatus]}
      </Badge>
    ),
    search: (row) => REG_LABELS[row.regStatus],
    sortValue: (row) => row.regStatus,
  },
  { key: 'regExpiresAt', header: 'Renews', cell: (row) => row.regExpiresAt || '—', sortValue: (row) => row.regExpiresAt ?? '' },
]

const numberColumns = (
  busy: boolean,
  remove: (id: string) => void,
): PagedColumn<PhoneNumberRowView>[] => [
  {
    key: 'number',
    header: 'Number',
    cell: (row) => <span className="font-medium tabular-nums">+{row.number}</span>,
    search: (row) => row.number,
    sortValue: (row) => row.number,
  },
  { key: 'label', header: 'Label', cell: (row) => row.label, search: (row) => row.label, sortValue: (row) => row.label },
  {
    key: 'personName',
    header: 'Answered by',
    cell: (row) => row.personName,
    search: (row) => row.personName,
    sortValue: (row) => row.personName,
  },
  {
    key: 'actions',
    header: '',
    align: 'right',
    cell: (row) => (
      <Button variant="outline" size="sm" disabled={busy} onClick={() => remove(row.id)}>
        Remove
      </Button>
    ),
  },
]

const AVAYA_CHECKLIST = [
  'Confirm capacity: your SIP Trunk Channels licenses cover the concurrent calls you expect, and System → Telephony → Maximum SIP Sessions is greater than zero.',
  'Create a SIP Line whose ITSP / gateway address is the connection address shown under Connection details (port 5060, UDP or TCP). Limit codecs to G.711 ULAW and ALAW, set DTMF to RFC2833 payload 101, turn Re-invite Supported on, turn direct media off, turn Check OOS on, set the Session Timer to On-Demand, and leave REFER Incoming and Outgoing on Auto.',
  'Add a SIP URI channel on the line with matching Incoming and Outgoing Group IDs and enough Max Sessions for your concurrent calls.',
  'Add a short code that routes the agent extension range out the line — for example Code 7XX, Feature Dial, Number 7N"@<connection address>", Line Group set to the URI channel’s group.',
  'Add an Incoming Call Route for the same Line Group with Destination "." (a single period) so the dialed digits pass through.',
  'Confirm the phone system can reach the connection address on the SIP port and the published media port range in both directions, then dial an agent’s extension from a desk phone.',
]

const AVAYA_EXTENSION_CHECKLIST = [
  'Turn the SIP registrar on: LAN1 or LAN2 → VoIP → SIP Registrar Enable, with a registrar domain. IP Office restarts when registrar settings change.',
  'One 3rd Party IP Endpoint license per agent, reserved on the extension record (Reserve 3rd Party IP Endpoint License).',
  'Per agent: a SIP Extension record with the extension number as its base extension, and a User record whose Telephony → Supervisor Settings → Login Code is the password entered here.',
  'Narrow each extension’s enabled codecs to G.711 ULAW or ALAW, and leave DTMF on RFC2833 payload 101.',
  'Confirm the phone system can reach this deployment’s bridge on the SIP port and the published media port range in both directions, then dial the agent’s extension from a desk phone.',
]

type TrunkDraft = {
  id?: string
  name: string
  flavor: TrunkDetailView['flavor']
  mode: TrunkDetailView['mode']
  pbxHost: string
  pbxPort: string
  transport: TrunkDetailView['transport']
  srtp: TrunkDetailView['srtp']
  sessionTimerSeconds: string
  allowedAddresses: string
  testExtension: string
  authUsername: string
  authPassword: string
  clearPassword: boolean
  extensionRange: string
}

const emptyTrunkDraft = (): TrunkDraft => ({
  name: '',
  flavor: 'avaya_ip_office',
  mode: 'trunk',
  pbxHost: '',
  pbxPort: '5060',
  transport: 'udp',
  srtp: 'disabled',
  sessionTimerSeconds: '',
  allowedAddresses: '',
  testExtension: '',
  authUsername: '',
  authPassword: '',
  clearPassword: false,
  extensionRange: '',
})

const trunkDraftFrom = (trunk: TrunkDetailView): TrunkDraft => ({
  id: trunk.id,
  name: trunk.name,
  flavor: trunk.flavor,
  mode: trunk.mode,
  pbxHost: trunk.pbxHost,
  pbxPort: String(trunk.pbxPort),
  transport: trunk.transport,
  srtp: trunk.srtp,
  sessionTimerSeconds: trunk.sessionTimerSeconds,
  allowedAddresses: trunk.allowedAddresses,
  testExtension: trunk.testExtension,
  authUsername: trunk.authUsername,
  authPassword: '',
  clearPassword: false,
  extensionRange: trunk.extensionRange,
})

type BridgeDraft = {
  id?: string
  trunkId: string
  extension: string
  personId: string
  authUsername: string
  authPassword: string
  clearPassword: boolean
}

/**
 * Settings → Voice → Phone system. One SettingsRow whose drawer manages the
 * company's PBX trunks (rows mirrored to the SIP ingress), the agents'
 * extension directory, the registered-extension map the bridge holds open,
 * and the connection details a PBX administrator enters on their side.
 *
 * The list on the page is the summary; the drawer reads live state — line
 * health, registration status, last errors — whenever it opens or a change
 * lands, so what an operator sees is what the phone system is doing now.
 */
export function PhoneSystemRow({
  trunks,
  extensions,
  numbers,
  agents,
  ingress,
}: {
  trunks: SipTrunkSummary[]
  extensions: AgentExtensionRow[]
  /** Provisioned carrier numbers, mapped to the agents who answer them. */
  numbers: PhoneNumberRowView[]
  /** Active agents offered when pointing a number at someone. */
  agents: AgentOption[]
  ingress: { host: string; port: number } | null
}) {
  const [open, setOpen] = React.useState(false)
  const [tab, setTab] = React.useState('trunks')
  const [detail, setDetail] = React.useState<PhoneSystemDetail | null>(null)
  const [draft, setDraft] = React.useState<TrunkDraft | null>(null)
  const [trunkTab, setTrunkTab] = React.useState('connection')
  const [error, setError] = React.useState<string | null>(null)
  const [busy, startBusy] = React.useTransition()
  const [numberDraft, setNumberDraft] = React.useState({ number: '', label: '', personId: agents[0]?.id ?? '' })
  const [numberError, setNumberError] = React.useState<string | null>(null)
  const [testReport, setTestReport] = React.useState<TestCallReport | null>(null)
  const [bridgeDraft, setBridgeDraft] = React.useState<BridgeDraft | null>(null)
  const [bridgeError, setBridgeError] = React.useState<string | null>(null)
  const [bridgeNotice, setBridgeNotice] = React.useState<string | null>(null)

  const refresh = React.useCallback(async () => {
    setDetail(await loadPhoneSystemDetailAction())
  }, [])

  React.useEffect(() => {
    if (!open) return
    let cancelled = false
    loadPhoneSystemDetailAction().then((next) => {
      if (!cancelled) setDetail(next)
    })
    return () => {
      cancelled = true
    }
  }, [open])

  const detailTrunks = detail?.trunks ?? []
  const bridgeExtensions = detail?.bridgeExtensions ?? []
  const agentOptions = detail?.agents ?? agents
  const editing = draft?.id ? detailTrunks.find((t) => t.id === draft.id) : undefined
  const localIngress = ingress !== null && ['localhost', '127.0.0.1'].includes(ingress.host)
  const bridgeTrunks = detailTrunks.filter((trunk) => trunk.mode === 'extension')

  const rows: TrunkListRow[] = detailTrunks.map((trunk) => ({
    id: trunk.id,
    name: trunk.name,
    flavorLabel: FLAVOR_LABELS[trunk.flavor],
    modeLabel: MODE_LABELS[trunk.mode],
    address: trunk.pbxHost ? `${trunk.pbxHost}:${trunk.pbxPort} (${trunk.transport.toUpperCase()})` : '—',
    range: trunk.extensionRange || '—',
    healthLabel: HEALTH_LABELS[trunk.health],
    statusLabel: STATUS_LABELS[trunk.status],
  }))

  const activeCount = trunks.filter((t) => t.status === 'active').length
  const summary =
    trunks.length === 0
      ? 'Connect your office phone system so agents answer real desk-phone extensions.'
      : `${trunks.length} trunk${trunks.length === 1 ? '' : 's'} · ${activeCount} active · ${extensions.length} extension${extensions.length === 1 ? '' : 's'} · ${numbers.length} number${numbers.length === 1 ? '' : 's'}`

  const saveTrunk = () => {
    if (!draft) return
    startBusy(async () => {
      setError(null)
      const result = await saveSipTrunkAction({
        ...(draft.id ? { id: draft.id } : {}),
        name: draft.name,
        flavor: draft.flavor,
        mode: draft.mode,
        pbxHost: draft.pbxHost,
        pbxPort: draft.pbxPort,
        transport: draft.transport,
        srtp: draft.srtp,
        sessionTimerSeconds: draft.sessionTimerSeconds,
        allowedAddresses: draft.allowedAddresses,
        testExtension: draft.testExtension,
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
      await refresh()
      setDraft(null)
      setTestReport(null)
    })
  }

  const removeTrunk = () => {
    if (!draft?.id) return
    const id = draft.id
    startBusy(async () => {
      setError(null)
      await deleteSipTrunkAction(id)
      await refresh()
      setDraft(null)
      setTestReport(null)
    })
  }

  const saveBridgeExtension = () => {
    if (!bridgeDraft) return
    startBusy(async () => {
      setBridgeError(null)
      const result = await saveBridgeExtensionAction({
        ...(bridgeDraft.id ? { id: bridgeDraft.id } : {}),
        trunkId: bridgeDraft.trunkId,
        extension: bridgeDraft.extension,
        personId: bridgeDraft.personId,
        authUsername: bridgeDraft.authUsername,
        ...(bridgeDraft.authPassword.trim()
          ? { authPassword: bridgeDraft.authPassword }
          : bridgeDraft.clearPassword
            ? { authPassword: '' }
            : {}),
      })
      if (!result.ok) {
        setBridgeError(result.message)
        return
      }
      await refresh()
      setBridgeDraft(null)
    })
  }

  const editingBridge = bridgeDraft?.id ? bridgeExtensions.find((row) => row.id === bridgeDraft.id) : undefined

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
        description="Two ways to call an agent, both SIP lines into this deployment: your PBX routes an extension range (desk phones dial a short code), or a carrier like Twilio or Telnyx delivers a real provisioned number."
        size="lg"
      >
        <div className="space-y-4">
          <SubtabNav
            ariaLabel="Phone system"
            active={tab}
            onSelect={setTab}
            tabs={[
              { key: 'trunks', label: 'Trunks', count: detail === null ? trunks.length : detailTrunks.length },
              { key: 'extensions', label: 'Extensions', count: extensions.length },
              { key: 'bridge', label: 'Registered extensions', count: bridgeExtensions.length },
              { key: 'numbers', label: 'Numbers', count: numbers.length },
              { key: 'connection', label: 'Connection details' },
            ]}
          />

          {tab === 'trunks' && detail === null ? (
            <p className="text-sm text-fg-muted">Reading the current state of your trunks…</p>
          ) : null}

          {tab === 'trunks' && detail !== null ? (
            <div className="space-y-3">
              <div className="flex items-center justify-end gap-2">
                {detailTrunks.length > 0 ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      startBusy(async () => {
                        await probeAllTrunksAction()
                        await refresh()
                      })
                    }
                  >
                    Check lines
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  onClick={() => {
                    setError(null)
                    setTestReport(null)
                    setTrunkTab('connection')
                    setDraft(emptyTrunkDraft())
                  }}
                >
                  Add trunk
                </Button>
              </div>
              <PagedTable
                columns={TRUNK_COLUMNS}
                rows={rows}
                rowKey={(row) => row.id}
                pageSize={10}
                defaultSort={{ key: 'name', dir: 'asc' }}
                onRowClick={(row) => {
                  const trunk = detailTrunks.find((t) => t.id === row.id)
                  if (!trunk) return
                  setError(null)
                  setTestReport(null)
                  setTrunkTab('connection')
                  setDraft(trunkDraftFrom(trunk))
                }}
                empty={
                  <EmptyState
                    title="No trunks yet"
                    description="A trunk is the SIP line your PBX points at bunkhouse. Add one, then route an extension range to it from the PBX."
                  />
                }
              />
            </div>
          ) : null}

          {tab === 'extensions' ? (
            <div className="space-y-3">
              <PagedTable
                columns={EXTENSION_COLUMNS}
                rows={extensions}
                rowKey={(row) => row.personId}
                pageSize={10}
                searchable
                defaultSort={{ key: 'extension', dir: 'asc' }}
                labels={{ searchPlaceholder: 'Search extensions…', searchLabel: 'Search extensions' }}
                empty={
                  <EmptyState
                    title="No extensions assigned"
                    description="Give each agent a short code on the Voice tab of its profile — that is the number desk phones dial."
                  />
                }
              />
              <p className="text-xs text-fg-muted">
                Extensions are assigned on each agent&apos;s profile, under Voice. Each code is unique across the
                company.
              </p>
            </div>
          ) : null}

          {tab === 'bridge' && detail === null ? (
            <p className="text-sm text-fg-muted">Reading the current registration state…</p>
          ) : null}

          {tab === 'bridge' && detail !== null ? (
            <div className="space-y-3">
              <div className="flex items-center justify-end gap-2">
                {bridgeExtensions.length > 0 ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      startBusy(async () => {
                        setBridgeNotice(null)
                        const result = await refreshBridgeRegistrationsAction()
                        setBridgeNotice(result.detail)
                        await refresh()
                      })
                    }
                  >
                    Check registrations
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  disabled={bridgeTrunks.length === 0 || agentOptions.length === 0}
                  onClick={() => {
                    setBridgeError(null)
                    setBridgeDraft({
                      trunkId: bridgeTrunks[0]?.id ?? '',
                      extension: '',
                      personId: agentOptions[0]?.id ?? '',
                      authUsername: '',
                      authPassword: '',
                      clearPassword: false,
                    })
                  }}
                >
                  Add extension
                </Button>
              </div>
              <PagedTable
                columns={BRIDGE_COLUMNS}
                rows={bridgeExtensions}
                rowKey={(row) => row.id}
                pageSize={10}
                searchable
                defaultSort={{ key: 'extension', dir: 'asc' }}
                labels={{ searchPlaceholder: 'Search extensions…', searchLabel: 'Search extensions' }}
                onRowClick={(row) => {
                  setBridgeError(null)
                  setBridgeDraft({
                    id: row.id,
                    trunkId: row.trunkId,
                    extension: row.extension,
                    personId: row.personId,
                    authUsername: row.authUsername,
                    authPassword: '',
                    clearPassword: false,
                  })
                }}
                empty={
                  <EmptyState
                    title="No registered extensions"
                    description="Set a trunk to Registered extensions, then map an agent to each extension the phone system has been given. This deployment signs in as those extensions and answers when a desk phone dials them."
                  />
                }
              />
              {bridgeExtensions.some((row) => row.lastError) ? (
                <div className="space-y-2">
                  {bridgeExtensions
                    .filter((row) => row.lastError)
                    .map((row) => (
                      <div key={row.id} className="rounded-md border border-danger/40 bg-danger-subtle px-3 py-2 text-sm">
                        <p className="text-xs text-fg-muted">Extension {row.extension}</p>
                        <p>{row.lastError}</p>
                      </div>
                    ))}
                </div>
              ) : null}
              {bridgeNotice ? <p className="text-xs text-fg-muted">{bridgeNotice}</p> : null}
              <div className="flex items-center justify-between gap-3">
                <p className="text-xs text-fg-muted">
                  Each mapped extension signs in to the phone system with its own credentials, and consumes one
                  third-party endpoint license there.
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    startBusy(async () => {
                      setBridgeNotice(null)
                      const result = await republishBridgeAction()
                      setBridgeNotice(result.detail)
                      await refresh()
                    })
                  }
                >
                  Sign in again
                </Button>
              </div>
            </div>
          ) : null}

          {tab === 'numbers' ? (
            <div className="space-y-4">
              <PagedTable
                columns={numberColumns(busy, (id) => startBusy(async () => removePhoneNumberAction(id)))}
                rows={numbers}
                rowKey={(row) => row.id}
                pageSize={10}
                searchable
                defaultSort={{ key: 'number', dir: 'asc' }}
                labels={{ searchPlaceholder: 'Search numbers…', searchLabel: 'Search numbers' }}
                empty={
                  <EmptyState
                    title="No numbers yet"
                    description="Buy a number from your carrier, point its SIP trunk at the connection details, and map it to an agent here — calls to it ring that agent from any phone."
                  />
                }
              />
              <div className="space-y-3 rounded-md border border-border p-3">
                <p className="text-sm font-medium">Add a number</p>
                <div className="grid gap-3 sm:grid-cols-3">
                  <div className="space-y-1">
                    <Label htmlFor="pn-number">Number</Label>
                    <Input
                      id="pn-number"
                      value={numberDraft.number}
                      onChange={(e) => setNumberDraft((d) => ({ ...d, number: e.target.value }))}
                      placeholder="+1 555 123 4567"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="pn-label">Label</Label>
                    <Input
                      id="pn-label"
                      value={numberDraft.label}
                      onChange={(e) => setNumberDraft((d) => ({ ...d, label: e.target.value }))}
                      placeholder="Main line"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="pn-agent">Answered by</Label>
                    <Select
                      id="pn-agent"
                      value={numberDraft.personId}
                      onChange={(e) => setNumberDraft((d) => ({ ...d, personId: e.target.value }))}
                    >
                      {agents.map((agent) => (
                        <option key={agent.id} value={agent.id}>
                          {agent.name} — {agent.title}
                        </option>
                      ))}
                    </Select>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <Button
                    size="sm"
                    disabled={busy || !numberDraft.number.trim() || !numberDraft.personId}
                    onClick={() =>
                      startBusy(async () => {
                        setNumberError(null)
                        const result = await assignPhoneNumberAction(numberDraft)
                        if (!result.ok) {
                          setNumberError(result.message)
                          return
                        }
                        setNumberDraft((d) => ({ ...d, number: '', label: '' }))
                      })
                    }
                  >
                    Add number
                  </Button>
                  {numberError ? <p className="text-sm text-danger">{numberError}</p> : null}
                </div>
              </div>
              <p className="text-xs text-fg-muted">
                Carrier side: create a SIP trunk (Twilio Elastic SIP Trunking, Telnyx SIP Connection, or your
                provider&apos;s equivalent), set its origination to the SIP address under Connection details, and
                route the number to that trunk. The dialed number arrives as the callee and rings the mapped agent.
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
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-sm">
                <span className="text-fg-muted">Status</span>
                <span className="flex items-center gap-2">
                  <Badge
                    variant={
                      editing.status === 'active' ? 'default' : editing.status === 'error' ? 'destructive' : 'outline'
                    }
                  >
                    {STATUS_LABELS[editing.status]}
                  </Badge>
                  <Badge
                    variant={
                      editing.health === 'ok' ? 'default' : editing.health === 'unreachable' ? 'destructive' : 'outline'
                    }
                  >
                    {HEALTH_LABELS[editing.health]}
                  </Badge>
                </span>
              </div>
            ) : null}
            {draft.id && editing?.lastError ? (
              <div className="rounded-md border border-danger/40 bg-danger-subtle px-3 py-2 text-sm">
                <p className="text-xs text-fg-muted">Last error</p>
                <p>{editing.lastError}</p>
              </div>
            ) : null}

            <SubtabNav
              ariaLabel="Trunk settings"
              active={trunkTab}
              onSelect={setTrunkTab}
              tabs={[
                { key: 'connection', label: 'Connection' },
                { key: 'media', label: 'Media & timers' },
                { key: 'access', label: 'Access' },
                { key: 'diagnostics', label: 'Diagnostics' },
              ]}
            />

            {trunkTab === 'connection' ? (
              <div className="space-y-4">
                <div className="space-y-1">
                  <Label htmlFor="trunk-name">Name</Label>
                  <Input
                    id="trunk-name"
                    value={draft.name}
                    onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                    placeholder="Head office IP Office"
                  />
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-1">
                    <Label htmlFor="trunk-flavor">Phone system</Label>
                    <Select
                      id="trunk-flavor"
                      value={draft.flavor}
                      onChange={(e) => setDraft({ ...draft, flavor: e.target.value as TrunkDetailView['flavor'] })}
                    >
                      <option value="avaya_ip_office">Avaya IP Office</option>
                      <option value="generic_sip">Generic SIP</option>
                    </Select>
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="trunk-mode">How agents are reached</Label>
                    <Select
                      id="trunk-mode"
                      value={draft.mode}
                      onChange={(e) => setDraft({ ...draft, mode: e.target.value as TrunkDetailView['mode'] })}
                    >
                      <option value="trunk">SIP line</option>
                      <option value="extension">Registered extensions</option>
                    </Select>
                  </div>
                </div>
                <p className="text-xs text-fg-muted">
                  {draft.mode === 'trunk'
                    ? 'The phone system points a SIP line here and routes an extension range down it. Concurrent calls draw on your SIP trunk channel licenses — nothing is licensed per agent.'
                    : 'This deployment signs in to the phone system as one extension per agent, so no trunk configuration is needed there. Each extension consumes one third-party endpoint license on the phone system.'}
                </p>
                <div className="grid gap-4 sm:grid-cols-3">
                  <div className="space-y-1 sm:col-span-2">
                    <Label htmlFor="trunk-host">PBX address</Label>
                    <Input
                      id="trunk-host"
                      value={draft.pbxHost}
                      onChange={(e) => setDraft({ ...draft, pbxHost: e.target.value })}
                      placeholder="10.0.0.20"
                    />
                    <p className="text-xs text-fg-muted">
                      {draft.mode === 'trunk'
                        ? 'Calls are only accepted from this address when set.'
                        : 'The registrar this deployment signs in to.'}
                    </p>
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
                      onChange={(e) =>
                        setDraft({ ...draft, transport: e.target.value as TrunkDetailView['transport'] })
                      }
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
              </div>
            ) : null}

            {trunkTab === 'media' ? (
              <div className="space-y-4">
                <div className="space-y-1">
                  <Label htmlFor="trunk-srtp">Media encryption</Label>
                  <Select
                    id="trunk-srtp"
                    value={draft.srtp}
                    onChange={(e) => setDraft({ ...draft, srtp: e.target.value as TrunkDetailView['srtp'] })}
                  >
                    <option value="disabled">Off — audio is carried unencrypted</option>
                    <option value="best_effort">Best effort — encrypt when the phone system agrees</option>
                    <option value="required">Required — refuse calls that cannot be encrypted</option>
                  </Select>
                  <p className="text-xs text-fg-muted">
                    Encryption is negotiated per call. Signalling stays on the transport chosen under Connection —
                    encrypted media over an unencrypted signalling transport still exposes call metadata.
                  </p>
                </div>
                {draft.flavor === 'avaya_ip_office' && draft.srtp !== 'disabled' ? (
                  <Alert variant="warning">
                    <AlertTitle>Before you turn this on with IP Office</AlertTitle>
                    <AlertDescription>
                      IP Office supports SRTP on lines and extensions, and Avaya recommends the best-effort setting
                      rather than requiring encryption. Third-party TLS interoperability is less dependable: on some
                      releases a TLS SIP line listens on an ephemeral port above 4096 instead of 5061, so the phone
                      system and this deployment never complete the handshake. Commission the line on UDP or TCP over
                      a private network or VPN, confirm calls are steady, then move to encryption — and keep the
                      Test call on this tab handy while you do.
                    </AlertDescription>
                  </Alert>
                ) : null}
                {draft.srtp === 'required' ? (
                  <p className="text-xs text-fg-muted">
                    With encryption required, a phone system that offers plain audio gets its call rejected rather
                    than carried in the clear.
                  </p>
                ) : null}
                <div className="space-y-1">
                  <Label htmlFor="trunk-timer">Session timer (seconds)</Label>
                  <Input
                    id="trunk-timer"
                    value={draft.sessionTimerSeconds}
                    onChange={(e) => setDraft({ ...draft, sessionTimerSeconds: e.target.value })}
                    placeholder="1800"
                  />
                  <p className="text-xs text-fg-muted">
                    Match the session expiry configured on the phone system&apos;s line — on IP Office that is the
                    line&apos;s Session Timer. When the two ends disagree, long calls are torn down at the shorter
                    interval, which is what shows up as calls dropping at 15 or 30 minutes. Leave blank to let the
                    phone system set the interval.
                  </p>
                </div>
              </div>
            ) : null}

            {trunkTab === 'access' ? (
              <div className="space-y-4">
                <div className="space-y-1">
                  <Label htmlFor="trunk-allowlist">Accept calls from</Label>
                  <Textarea
                    id="trunk-allowlist"
                    rows={5}
                    value={draft.allowedAddresses}
                    onChange={(e) => setDraft({ ...draft, allowedAddresses: e.target.value })}
                    placeholder={'10.0.0.20\n10.0.0.21'}
                  />
                  <p className="text-xs text-fg-muted">
                    One address or CIDR range per line. Saving applies the list to this deployment&apos;s SIP ingress,
                    which then answers this trunk only from those addresses.
                  </p>
                </div>
                {draft.mode === 'trunk' ? (
                  <p className="text-xs text-fg-muted">
                    The PBX address on the Connection tab is always accepted. Add anything else that signals on the
                    phone system&apos;s behalf — a second LAN interface, or a session border controller in front of it.
                  </p>
                ) : (
                  <Alert variant="info">
                    <AlertTitle>Registered extensions reach this deployment from the bridge</AlertTitle>
                    <AlertDescription>
                      In this mode the phone system never contacts the SIP ingress directly — calls arrive from this
                      deployment&apos;s own bridge. List the bridge&apos;s address here, not the phone system&apos;s.
                    </AlertDescription>
                  </Alert>
                )}
                {draft.allowedAddresses.trim() === '' && draft.mode === 'extension' ? (
                  <p className="text-xs text-fg-muted">
                    With the list empty, calls on this trunk are accepted from any address that authenticates.
                  </p>
                ) : null}
              </div>
            ) : null}

            {trunkTab === 'diagnostics' ? (
              <div className="space-y-4">
                {draft.id && editing ? (
                  <div className="space-y-2 rounded-md border border-border px-3 py-2 text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-fg-muted">Line check</span>
                      <Badge
                        variant={
                          editing.health === 'ok'
                            ? 'default'
                            : editing.health === 'unreachable'
                              ? 'destructive'
                              : 'outline'
                        }
                      >
                        {HEALTH_LABELS[editing.health]}
                      </Badge>
                    </div>
                    {editing.healthDetail ? <p className="text-fg-muted">{editing.healthDetail}</p> : null}
                    <p className="text-xs text-fg-muted">
                      {editing.lastSeenAt
                        ? `The phone system last answered at ${editing.lastSeenAt}.`
                        : 'The phone system has not answered a check yet.'}
                    </p>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => {
                        const id = draft.id
                        if (!id) return
                        startBusy(async () => {
                          await probeTrunkHealthAction(id)
                          await refresh()
                        })
                      }}
                    >
                      {busy ? 'Checking…' : 'Check the line'}
                    </Button>
                  </div>
                ) : (
                  <p className="text-sm text-fg-muted">
                    Save the trunk first — checks and test calls run against the saved connection.
                  </p>
                )}

                {draft.id && draft.mode === 'trunk' ? (
                  <div className="space-y-3 rounded-md border border-border p-3">
                    <div>
                      <p className="text-sm font-medium">Test call</p>
                      <p className="text-xs text-fg-muted">
                        Dials a real extension over this trunk and reports what the phone system answered. Pick a desk
                        phone you can hear ring; the call is hung up as soon as it is answered.
                      </p>
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="trunk-test-ext">Extension to dial</Label>
                      <Input
                        id="trunk-test-ext"
                        value={draft.testExtension}
                        onChange={(e) => setDraft({ ...draft, testExtension: e.target.value })}
                        placeholder="201"
                      />
                      <p className="text-xs text-fg-muted">Saved with the trunk, so the next check is one click.</p>
                    </div>
                    <Button
                      size="sm"
                      disabled={busy || !draft.testExtension.trim()}
                      onClick={() => {
                        const id = draft.id
                        if (!id) return
                        startBusy(async () => {
                          setTestReport(null)
                          const report = await testTrunkCallAction({ trunkId: id, extension: draft.testExtension })
                          setTestReport(report)
                        })
                      }}
                    >
                      {busy ? 'Dialing…' : 'Place test call'}
                    </Button>
                    {testReport ? (
                      <div className="space-y-2">
                        <ol className="space-y-1 text-sm">
                          {testReport.steps.map((step, index) => (
                            <li key={index} className="flex gap-2">
                              <Badge variant={step.ok ? 'default' : 'destructive'}>{step.ok ? 'ok' : 'failed'}</Badge>
                              <span className="min-w-0">
                                <span className="font-medium">{step.label}</span>
                                <span className="block text-xs text-fg-muted">{step.detail}</span>
                              </span>
                            </li>
                          ))}
                        </ol>
                        <p className={testReport.ok ? 'text-sm text-fg-muted' : 'text-sm text-danger'}>
                          {testReport.summary}
                        </p>
                      </div>
                    ) : null}
                  </div>
                ) : null}

                {draft.id && draft.mode === 'extension' ? (
                  <p className="text-sm text-fg-muted">
                    This trunk reaches the phone system by signing in as each agent&apos;s extension, so there is no
                    line to place a test call over. The Registered extensions tab shows each extension&apos;s live
                    sign-in state and re-runs it on demand.
                  </p>
                ) : null}

                {draft.flavor === 'avaya_ip_office' ? (
                  <details className="rounded-md border border-border px-3 py-2">
                    <summary className="cursor-pointer text-sm font-medium">Avaya IP Office setup</summary>
                    <ol className="mt-2 list-decimal space-y-2 pl-5 text-sm text-fg-muted">
                      {(draft.mode === 'trunk' ? AVAYA_CHECKLIST : AVAYA_EXTENSION_CHECKLIST).map((step, index) => (
                        <li key={index}>{step}</li>
                      ))}
                    </ol>
                  </details>
                ) : null}
              </div>
            ) : null}

            {error ? <p className="text-sm text-danger">{error}</p> : null}
            <div className="flex items-center justify-between gap-2">
              <Button onClick={saveTrunk} disabled={busy || !draft.name.trim()}>
                {busy ? 'Saving…' : draft.id ? 'Save & reconnect' : 'Add trunk'}
              </Button>
              {draft.id ? (
                <Button variant="outline" onClick={removeTrunk} disabled={busy}>
                  Delete trunk
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}
      </Drawer>

      <Drawer
        open={bridgeDraft !== null}
        onClose={() => setBridgeDraft(null)}
        title={bridgeDraft?.id ? `Extension ${editingBridge?.extension ?? ''}` : 'Add registered extension'}
        description="The credentials this deployment signs in to the phone system with, and the agent who answers that extension."
        size="md"
      >
        {bridgeDraft ? (
          <div className="space-y-4">
            {editingBridge ? (
              <div className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-sm">
                <span className="text-fg-muted">Registration</span>
                <Badge
                  variant={
                    editingBridge.regStatus === 'registered'
                      ? 'default'
                      : editingBridge.regStatus === 'failed'
                        ? 'destructive'
                        : 'outline'
                  }
                >
                  {REG_LABELS[editingBridge.regStatus]}
                </Badge>
              </div>
            ) : null}
            {editingBridge?.lastError ? (
              <div className="rounded-md border border-danger/40 bg-danger-subtle px-3 py-2 text-sm">
                <p className="text-xs text-fg-muted">Last error</p>
                <p>{editingBridge.lastError}</p>
              </div>
            ) : null}

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="bridge-trunk">Phone system</Label>
                <Select
                  id="bridge-trunk"
                  value={bridgeDraft.trunkId}
                  onChange={(e) => setBridgeDraft({ ...bridgeDraft, trunkId: e.target.value })}
                >
                  {bridgeTrunks.map((trunk) => (
                    <option key={trunk.id} value={trunk.id}>
                      {trunk.name}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="bridge-extension">Extension</Label>
                <Input
                  id="bridge-extension"
                  value={bridgeDraft.extension}
                  onChange={(e) => setBridgeDraft({ ...bridgeDraft, extension: e.target.value })}
                  placeholder="701"
                />
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="bridge-agent">Answered by</Label>
              <Select
                id="bridge-agent"
                value={bridgeDraft.personId}
                onChange={(e) => setBridgeDraft({ ...bridgeDraft, personId: e.target.value })}
              >
                {agentOptions.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name} — {agent.title}
                  </option>
                ))}
              </Select>
              <p className="text-xs text-fg-muted">
                The agent&apos;s own extension is set to match, so a desk phone reaches the same agent whichever way
                the call is routed.
              </p>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="bridge-auth-user">Auth name</Label>
                <Input
                  id="bridge-auth-user"
                  value={bridgeDraft.authUsername}
                  onChange={(e) => setBridgeDraft({ ...bridgeDraft, authUsername: e.target.value })}
                  placeholder="Defaults to the extension number"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="bridge-auth-pass">Password</Label>
                <Input
                  id="bridge-auth-pass"
                  type="password"
                  value={bridgeDraft.authPassword}
                  onChange={(e) => setBridgeDraft({ ...bridgeDraft, authPassword: e.target.value })}
                  placeholder={editingBridge?.hasPassword ? 'Unchanged' : 'The extension’s login code'}
                />
                {editingBridge?.hasPassword ? (
                  <label className="flex items-center gap-2 text-xs text-fg-muted">
                    <input
                      type="checkbox"
                      checked={bridgeDraft.clearPassword}
                      onChange={(e) => setBridgeDraft({ ...bridgeDraft, clearPassword: e.target.checked })}
                    />
                    Remove the stored password
                  </label>
                ) : (
                  <p className="text-xs text-fg-muted">Sealed at rest. On IP Office this is the user&apos;s login code.</p>
                )}
              </div>
            </div>

            {bridgeError ? <p className="text-sm text-danger">{bridgeError}</p> : null}
            <div className="flex items-center justify-between gap-2">
              <Button
                onClick={saveBridgeExtension}
                disabled={busy || !bridgeDraft.extension.trim() || !bridgeDraft.trunkId || !bridgeDraft.personId}
              >
                {busy ? 'Saving…' : bridgeDraft.id ? 'Save & sign in' : 'Add extension'}
              </Button>
              {bridgeDraft.id ? (
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    const id = bridgeDraft.id
                    if (!id) return
                    startBusy(async () => {
                      await deleteBridgeExtensionAction(id)
                      await refresh()
                      setBridgeDraft(null)
                    })
                  }}
                >
                  Remove extension
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}
      </Drawer>
    </>
  )
}
