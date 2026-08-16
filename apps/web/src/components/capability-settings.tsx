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
  SettingsSection,
  SubtabNav,
} from '@appkit/ui'
import { isSmsProvider, smsProviderSpec, SMS_PROVIDER_SPECS, type SmsProvider } from '@appkit/sms/providers'
import {
  killDeskJobAction,
  removeSearchProviderAction,
  removeSmsSettingsAction,
  saveDeskPolicyAction,
  saveDocumentBrandingAction,
  saveSmsSettingsAction,
  saveWorkspacePolicyAction,
  setSearchProviderAction,
} from '../app/admin/settings/actions'
import { RunDeskEventsTable, type RunDeskEventRow } from './run-tables'

/**
 * The capability half of Settings: how agents research the web, how their
 * documents present the company, where their workspaces are kept, and how they
 * text. The outside systems they work in live under Resources → Systems, with
 * the rest of what an agent is given.
 */

const SEARCH_PROVIDERS = [
  { value: 'brave', label: 'Brave Search' },
  { value: 'tavily', label: 'Tavily' },
] as const

/**
 * The search key agents research on. One provider at a time, connected in a
 * drawer — the page itself stays a status row an operator can read at a glance.
 */
export function ResearchSection({ provider }: { provider: string | null }) {
  const [open, setOpen] = React.useState(false)
  const [choice, setChoice] = React.useState<string>(provider ?? SEARCH_PROVIDERS[0].value)
  const [key, setKey] = React.useState('')
  const [error, setError] = React.useState<string | null>(null)
  const [busy, startBusy] = React.useTransition()

  return (
    <SettingsSection
      title="Research"
      description="Every agent can search the web and read pages — on a call, in an email run, anywhere they work. Searches run on your provider key; without one they fall back to a keyless engine with lower-quality results."
    >
      {provider ? (
        <SettingsRow
          title={SEARCH_PROVIDERS.find((p) => p.value === provider)?.label ?? provider}
          description="Agents search on this provider."
          control={
            <span className="flex items-center gap-2">
              <Badge variant="secondary">key sealed</Badge>
              <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
                Manage
              </Button>
            </span>
          }
        />
      ) : (
        <SettingsRow
          title="Keyless fallback"
          description="No provider configured — searches use a public engine. Connect a key for better, rate-stable results."
          control={
            <span className="flex items-center gap-2">
              <Badge variant="outline">active</Badge>
              <Button size="sm" onClick={() => setOpen(true)}>
                Connect a provider
              </Button>
            </span>
          }
        />
      )}

      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        title={provider ? 'Search provider' : 'Connect a search provider'}
        description="One provider powers every agent's research. The key is verified against the provider before it is sealed."
        size="md"
      >
        <div className="space-y-4">
          {provider ? (
            <div className="flex items-center justify-between rounded-md border border-border px-3 py-2 text-sm">
              <span className="flex items-center gap-2">
                <Badge>connected</Badge>
                <span className="text-fg-muted">
                  {SEARCH_PROVIDERS.find((p) => p.value === provider)?.label ?? provider} · key sealed at rest.
                </span>
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() =>
                  startBusy(async () => {
                    await removeSearchProviderAction()
                    setOpen(false)
                  })
                }
              >
                Remove
              </Button>
            </div>
          ) : null}
          <div className="space-y-1">
            <Label htmlFor="search-provider">Provider</Label>
            <Select id="search-provider" value={choice} onChange={(event) => setChoice(event.target.value)}>
              {SEARCH_PROVIDERS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="search-key">{provider ? 'Replacement API key' : 'API key'}</Label>
            <Input
              id="search-key"
              type="password"
              value={key}
              onChange={(event) => setKey(event.target.value)}
              placeholder="Verified against the provider before saving"
            />
          </div>
          <Button
            disabled={busy || !key.trim()}
            onClick={() =>
              startBusy(async () => {
                setError(null)
                const result = await setSearchProviderAction({ provider: choice, apiKey: key })
                if (!result.ok) {
                  setError(result.message)
                  return
                }
                setKey('')
                setOpen(false)
              })
            }
          >
            {busy ? 'Verifying…' : 'Verify & save'}
          </Button>
          {error ? <p className="text-sm text-danger">{error}</p> : null}
        </div>
      </Drawer>
    </SettingsSection>
  )
}

export type DocumentBrandingView = { companyName: string; accentColor: string; footerText: string }

/**
 * How agent-authored documents present the company: the letterhead line,
 * accent color, and footer on every generated .docx and .pdf deliverable.
 * The company is named once, under Company → Identity; the field here is only
 * for the rare case where documents carry a different name.
 */
export function DocumentsSection({
  branding,
  identityName,
}: {
  branding: DocumentBrandingView
  /** The company name from Company → Identity, used when this is left blank. */
  identityName: string
}) {
  const [companyName, setCompanyName] = React.useState(branding.companyName)
  const [accentColor, setAccentColor] = React.useState(branding.accentColor)
  const [footerText, setFooterText] = React.useState(branding.footerText)
  const [notice, setNotice] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [busy, startBusy] = React.useTransition()

  return (
    <SettingsSection
      title="Documents"
      description="Agents produce real .docx, .xlsx, and .pdf files — attached to their emails and kept on the record. Letterhead settings here appear on every generated document."
    >
      <SettingsRow title="Letterhead" stacked>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="doc-company">Company name on documents</Label>
            <Input
              id="doc-company"
              value={companyName}
              onChange={(event) => setCompanyName(event.target.value)}
              placeholder={identityName || 'Set your company name under Company → Identity'}
            />
            <p className="text-xs text-fg-muted">
              {identityName
                ? `Leave blank and documents are headed "${identityName}" — your company name.`
                : 'Set your company name under Company → Identity; this field only overrides it on documents.'}
            </p>
          </div>
          <div className="space-y-1">
            <Label htmlFor="doc-accent">Accent color</Label>
            <Input
              id="doc-accent"
              value={accentColor}
              onChange={(event) => setAccentColor(event.target.value)}
              placeholder="#1a4d8f"
            />
          </div>
        </div>
        <div className="mt-3 space-y-1">
          <Label htmlFor="doc-footer">Footer line</Label>
          <Input
            id="doc-footer"
            value={footerText}
            onChange={(event) => setFooterText(event.target.value)}
            placeholder="e.g. 123 Main St · (555) 010-0000 · company.com"
          />
        </div>
        <div className="mt-3 flex items-center gap-3">
          <Button
            disabled={busy}
            onClick={() =>
              startBusy(async () => {
                setError(null)
                setNotice(null)
                const result = await saveDocumentBrandingAction({ companyName, accentColor, footerText })
                if (!result.ok) setError(result.message)
                else setNotice('Saved. New documents use this letterhead.')
              })
            }
          >
            Save letterhead
          </Button>
          {notice ? <p className="text-sm text-fg-muted">{notice}</p> : null}
          {error ? <p className="text-sm text-danger">{error}</p> : null}
        </div>
      </SettingsRow>
    </SettingsSection>
  )
}

export type WorkspacePolicyView = {
  retentionDays: number | null
  shell: {
    network: 'none' | 'host'
    timeoutSeconds: number
    replayRetentionMinutes: number
    outputLimitKb: number
    cpuSeconds: number
    memoryMb: number
    fileSizeMb: number
    processes: number
    openFiles: number
  }
  runtime: {
    mode: 'remote' | 'unavailable'
    available: boolean
    protocol: 'desk-v1' | null
    resident: number
    queued: number
    capacity: number
    suspended: number
    lastStartedAt: string | null
    lastSuspendedAt: string | null
    lastError: string | null
  }
  sessions: {
    id: string
    executionId: string | null
    personName: string
    command: string
    cwd: string
    status: 'completed' | 'failed' | 'timeout'
    exitCode: number | null
    output: string
    outputTruncated: boolean
    durationMs: number
    startedAt: string
    finishedAt: string | null
  }[]
}

export type DeskPolicyFields = {
  leaseMs: number
  idleSuspendMs: number
  concurrencyCap: number
  queueAlertDepth: number
  screenStepCeiling: number
  memoryMb: number
  vcpus: number
}

export type DeskSessionRow = {
  id: string
  personName: string
  runId: string
  status: 'active' | 'ended' | 'failed'
  screenReason: string | null
  startedAt: string
  endedAt: string | null
  eventCount: number
  events: RunDeskEventRow[]
  eventsTruncated: boolean
}

export type DeskJobRow = {
  id: string
  personName: string
  command: string
  status: 'running' | 'exited' | 'killed'
  startedAt: string
  exitedAt: string | null
  exitCode: number | null
}

export type DeskEscalationRow = {
  sessionId: string
  personName: string
  reason: string
  at: string
  stepsUsed: number
  stepCeiling: number
}

export type DeskOperationsView = {
  /** The Company → Features gate, resolved — the switchboard is authoritative. */
  enabled: boolean
  policy: DeskPolicyFields
  sessions: DeskSessionRow[]
  jobs: DeskJobRow[]
  escalations: DeskEscalationRow[]
}

const SESSION_VARIANT = (status: string) =>
  status === 'active' ? ('secondary' as const) : status === 'failed' ? ('destructive' as const) : ('outline' as const)

/** The desk policy numbers, edited in the units an operator thinks in. */
function DeskPolicyForm({ policy }: { policy: DeskPolicyFields }) {
  const [fields, setFields] = React.useState({
    leaseMinutes: String(Math.round(policy.leaseMs / 60_000)),
    idleSuspendSeconds: String(Math.round(policy.idleSuspendMs / 1_000)),
    concurrencyCap: String(policy.concurrencyCap),
    queueAlertDepth: String(policy.queueAlertDepth),
    screenStepCeiling: String(policy.screenStepCeiling),
    memoryMb: String(policy.memoryMb),
    vcpus: String(policy.vcpus),
  })
  const [notice, setNotice] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [busy, startBusy] = React.useTransition()

  return (
    <SettingsRow title="Desk machine policy" stacked>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {([
          ['leaseMinutes', 'Lease (minutes)', 1, 240],
          ['idleSuspendSeconds', 'Idle suspend (seconds)', 30, 3600],
          ['concurrencyCap', 'Concurrent desks', 1, 64],
          ['queueAlertDepth', 'Queue alert depth', 1, 64],
          ['screenStepCeiling', 'Screen steps per session', 5, 200],
          ['memoryMb', 'Memory per desk (MB)', 256, 16384],
          ['vcpus', 'vCPUs per desk', 1, 16],
        ] as const).map(([key, label, min, max]) => (
          <div key={key} className="space-y-1">
            <Label htmlFor={`desk-policy-${key}`}>{label}</Label>
            <Input
              id={`desk-policy-${key}`}
              type="number"
              min={min}
              max={max}
              value={fields[key]}
              onChange={(event) => setFields((current) => ({ ...current, [key]: event.target.value }))}
            />
          </div>
        ))}
      </div>
      <p className="mt-2 text-xs text-fg-muted">
        A desk suspends after the idle window and its disk persists; work past the concurrency cap queues rather than
        overcommitting the host. Size the cap against desks with a screen open — they cost several times a headless
        one. The screen-step ceiling is the cost governor for the expensive tier.
      </p>
      <div className="mt-3 flex items-center gap-3">
        <Button
          disabled={busy}
          onClick={() =>
            startBusy(async () => {
              setError(null)
              setNotice(null)
              const result = await saveDeskPolicyAction({
                leaseMs: Number(fields.leaseMinutes) * 60_000,
                idleSuspendMs: Number(fields.idleSuspendSeconds) * 1_000,
                concurrencyCap: Number(fields.concurrencyCap),
                queueAlertDepth: Number(fields.queueAlertDepth),
                screenStepCeiling: Number(fields.screenStepCeiling),
                memoryMb: Number(fields.memoryMb),
                vcpus: Number(fields.vcpus),
              })
              if (!result.ok) setError(result.message)
              else setNotice('Saved. New leases pick this up; resident desks keep theirs until renewal.')
            })
          }
        >
          Save desk policy
        </Button>
        {notice ? <p className="text-sm text-fg-muted">{notice}</p> : null}
        {error ? <p className="text-sm text-danger">{error}</p> : null}
      </div>
    </SettingsRow>
  )
}

/**
 * The desk: each agent's own machine, run from one operator surface. Status
 * (with the queue depth, the alert-worthy number), the tenant policy, recent
 * sessions with their interleaved replay, background jobs with a kill switch,
 * and the escalation record — every screen opened, with its stated reason.
 * The whole section follows the Company → Features switchboard: desks off
 * withholds the machine here as everywhere, while files and audit history
 * stay on the record.
 */
export function DeskSection({
  policy,
  desk,
  initialTab,
}: {
  policy: WorkspacePolicyView
  desk: DeskOperationsView
  /** Deep links (including the old ?section=workspace alias) land on a subtab. */
  initialTab?: string | undefined
}) {
  const [tab, setTab] = React.useState(initialTab ?? 'status')
  const [session, setSession] = React.useState<DeskSessionRow | null>(null)
  const [job, setJob] = React.useState<DeskJobRow | null>(null)
  const [jobError, setJobError] = React.useState<string | null>(null)
  const [busy, startBusy] = React.useTransition()

  const queueAlerting = desk.policy.queueAlertDepth <= policy.runtime.queued

  if (!desk.enabled) {
    return (
      <SettingsSection
        title="Desk"
        description="Each agent's own machine — terminal, filesystem, tools, and browser. Session replays stay on their run records in the observatory."
      >
        <SettingsRow
          title="Agent desks are off"
          description="The machine is withheld everywhere — abilities, navigation, and this panel — until the feature is switched on. Workspace files and every recorded session are preserved."
          control={
            <span className="flex items-center gap-2">
              <Badge variant="outline">off</Badge>
              <Button asChild size="sm">
                <Link href="/admin/settings?section=features">Open Features</Link>
              </Button>
            </span>
          }
        />
        <WorkspaceRetentionRow policy={policy} />
      </SettingsSection>
    )
  }

  return (
    <div className="space-y-4">
      <SubtabNav
        ariaLabel="Desk"
        active={tab}
        onSelect={setTab}
        tabs={[
          { key: 'status', label: 'Status' },
          { key: 'policy', label: 'Policy' },
          { key: 'sessions', label: 'Sessions', count: desk.sessions.length },
          { key: 'jobs', label: 'Background jobs', count: desk.jobs.filter((j) => j.status === 'running').length },
          { key: 'history', label: 'Shell history', count: policy.sessions.length },
        ]}
      />

      {tab === 'status' ? (
        <SettingsSection
          title="Desk runtime"
          description="The runner that boots each agent's machine, and the escalation record — every screen opened, with the agent's stated reason and what the session spent."
        >
          <SettingsRow
            title="Runner"
            description={
              policy.runtime.available
                ? 'Desk runner · each agent gets its own machine; shell work and replay are ready.'
                : 'The desk runner is unavailable. Agents have no machine until it is healthy.'
            }
            control={
              <Badge variant={policy.runtime.available ? 'success' : 'destructive'}>
                {policy.runtime.available ? 'ready' : 'unavailable'}
              </Badge>
            }
          />
          {policy.runtime.available ? (
            <>
              <SettingsRow
                title="Resident desks"
                description={`${policy.runtime.resident} of ${policy.runtime.capacity} in use · ${policy.runtime.suspended} suspended with disks parked.`}
                control={
                  <Badge variant="outline">
                    {policy.runtime.resident}/{policy.runtime.capacity}
                  </Badge>
                }
              />
              <SettingsRow
                title="Queue depth"
                description={
                  queueAlerting
                    ? `${policy.runtime.queued} waiting — at or past the alert depth of ${desk.policy.queueAlertDepth}. Agents are waiting for machines; consider raising the cap or the host's capacity.`
                    : `${policy.runtime.queued} waiting for a machine. Alerts at ${desk.policy.queueAlertDepth}.`
                }
                control={
                  <Badge variant={queueAlerting ? 'warning' : 'outline'}>{policy.runtime.queued} queued</Badge>
                }
              />
            </>
          ) : null}
          <SettingsRow
            title="Last runner activity"
            description={
              policy.runtime.lastStartedAt
                ? new Date(policy.runtime.lastStartedAt).toLocaleString()
                : 'No desk has started since this runner came up.'
            }
            control={policy.runtime.lastError ? <Badge variant="destructive">last desk error</Badge> : undefined}
          />
          {policy.runtime.lastError ? (
            <SettingsRow title="Last runner error" description={policy.runtime.lastError} />
          ) : null}
          <SettingsRow
            title="Screens opened"
            description="Opening a screen is the expensive tier, and every one is opened for a recorded reason. A pattern of reaching for the screen where a connector or the browser would do is what this list is for."
            stacked
          >
            <RecordList
              rows={desk.escalations}
              getRowId={(row) => row.sessionId}
              columns={[
                { key: 'personName', label: 'Agent' },
                {
                  key: 'reason',
                  label: 'Stated reason',
                  render: (row) => <span className="line-clamp-2 text-sm">{row.reason}</span>,
                },
                {
                  key: 'stepsUsed',
                  label: 'Screen steps',
                  render: (row) => (
                    <Badge variant={row.stepsUsed >= row.stepCeiling ? 'warning' : 'outline'}>
                      {row.stepsUsed} / {row.stepCeiling}
                    </Badge>
                  ),
                },
                {
                  key: 'at',
                  label: 'Opened',
                  format: (value) => new Date(String(value)).toLocaleString(),
                },
              ]}
              empty={{
                title: 'No screens opened',
                description: 'Agents have stayed on the cheaper tiers — the terminal, the browser, and their document abilities.',
              }}
            />
          </SettingsRow>
        </SettingsSection>
      ) : null}

      {tab === 'policy' ? (
        <SettingsSection
          title="Desk policy"
          description="The machine each agent gets, what a command may spend, and how long untouched workspace files are kept. Every number is tenant configuration — nothing here lives in code or environment."
        >
          <DeskPolicyForm policy={desk.policy} />
          <ShellPolicyRow policy={policy} />
          <WorkspaceRetentionRow policy={policy} />
        </SettingsSection>
      ) : null}

      {tab === 'sessions' ? (
        <SettingsSection
          title="Desk sessions"
          description="One session per run: terminal, browser, and screen as a single interleaved record. Open a session to replay it in order, frames inline — the same replay the run record shows."
        >
          <div className="px-5 py-4">
            <RecordList
              rows={desk.sessions}
              getRowId={(row) => row.id}
              onRowClick={(row) => setSession(row)}
              activeRowId={session?.id ?? null}
              columns={[
                { key: 'personName', label: 'Agent' },
                {
                  key: 'status',
                  label: 'Status',
                  kind: 'status',
                  statusVariant: (status) =>
                    status === 'active' ? 'secondary' : status === 'failed' ? 'destructive' : 'outline',
                },
                {
                  key: 'screenReason',
                  label: 'Screen',
                  render: (row) =>
                    row.screenReason ? (
                      <span className="line-clamp-1 text-xs">{row.screenReason}</span>
                    ) : (
                      <span className="text-xs text-fg-muted">headless</span>
                    ),
                },
                { key: 'eventCount', label: 'Events', align: 'right' },
                {
                  key: 'startedAt',
                  label: 'Started',
                  format: (value) => new Date(String(value)).toLocaleString(),
                },
              ]}
              empty={{
                title: 'No desk sessions yet',
                description: 'When an agent works at its desk, the session lands here and on its run record.',
              }}
            />
          </div>
        </SettingsSection>
      ) : null}

      {tab === 'jobs' ? (
        <SettingsSection
          title="Background jobs"
          description="Processes that outlive a command on an agent's desk. A running process nobody can see is the failure mode this list exists to prevent — open a job to stop it."
        >
          <div className="px-5 py-4">
            <RecordList
              rows={desk.jobs}
              getRowId={(row) => row.id}
              onRowClick={(row) => {
                setJobError(null)
                setJob(row)
              }}
              activeRowId={job?.id ?? null}
              columns={[
                { key: 'personName', label: 'Agent' },
                {
                  key: 'command',
                  label: 'Command',
                  render: (row) => <span className="line-clamp-1 font-mono text-xs">{row.command}</span>,
                },
                {
                  key: 'status',
                  label: 'Status',
                  kind: 'status',
                  statusVariant: (status) =>
                    status === 'running' ? 'secondary' : status === 'killed' ? 'warning' : 'outline',
                },
                {
                  key: 'startedAt',
                  label: 'Started',
                  format: (value) => new Date(String(value)).toLocaleString(),
                },
              ]}
              empty={{
                title: 'No background jobs',
                description: 'Long-running processes agents start on their desks appear here, running first.',
              }}
            />
          </div>
        </SettingsSection>
      ) : null}

      {tab === 'history' ? (
        <SettingsSection
          title="Shell history"
          description="Commands recorded before shell work moved onto the desk ledger. This history stops growing but stays readable — corrections are new records, never edits."
        >
          <ShellHistoryList sessions={policy.sessions} />
        </SettingsSection>
      ) : null}

      <Drawer
        open={session !== null}
        onClose={() => setSession(null)}
        title={session ? `${session.personName} · desk session` : 'Desk session'}
        description={session ? new Date(session.startedAt).toLocaleString() : undefined}
        size="lg"
      >
        {session ? (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={SESSION_VARIANT(session.status)}>{session.status}</Badge>
              <Badge variant="outline">{session.eventCount} events</Badge>
              {session.screenReason ? <Badge variant="default">screen opened</Badge> : null}
              {session.endedAt ? (
                <span className="text-xs text-fg-muted">ended {new Date(session.endedAt).toLocaleString()}</span>
              ) : null}
            </div>
            {session.screenReason ? (
              <div className="rounded-md border border-border bg-bg-subtle px-3 py-2 text-sm">
                <p className="text-xs text-fg-muted">Stated reason for opening the screen</p>
                <p className="font-medium">{session.screenReason}</p>
              </div>
            ) : null}
            {session.eventsTruncated ? (
              <p className="text-xs text-fg-muted">
                Showing the first {session.events.length} events — the run record carries the full stream.
              </p>
            ) : null}
            <RunDeskEventsTable rows={session.events} />
          </div>
        ) : null}
      </Drawer>

      <Drawer
        open={job !== null}
        onClose={() => setJob(null)}
        title={job ? `${job.personName} · background job` : 'Background job'}
        description={job ? `Started ${new Date(job.startedAt).toLocaleString()}` : undefined}
        size="md"
      >
        {job ? (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={job.status === 'running' ? 'secondary' : job.status === 'killed' ? 'warning' : 'outline'}>
                {job.status}
              </Badge>
              {job.exitCode !== null ? <Badge variant="outline">exit {job.exitCode}</Badge> : null}
              {job.exitedAt ? (
                <span className="text-xs text-fg-muted">ended {new Date(job.exitedAt).toLocaleString()}</span>
              ) : null}
            </div>
            <div className="space-y-1">
              <p className="text-sm font-medium">Command</p>
              <pre className="overflow-x-auto rounded-md border border-border bg-bg-subtle p-3 text-xs whitespace-pre-wrap">{job.command}</pre>
            </div>
            {job.status === 'running' ? (
              <div className="space-y-2">
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    startBusy(async () => {
                      setJobError(null)
                      const result = await killDeskJobAction(job.id)
                      if (!result.ok) setJobError(result.message)
                      else setJob(null)
                    })
                  }
                >
                  {busy ? 'Stopping…' : 'Stop this job'}
                </Button>
                <p className="text-xs text-fg-muted">
                  The process is terminated on the agent&apos;s machine. Its files and the rest of the desk are untouched.
                </p>
                {jobError ? <p className="text-sm text-danger">{jobError}</p> : null}
              </div>
            ) : null}
          </div>
        ) : null}
      </Drawer>
    </div>
  )
}

/** The per-command execution limits, unchanged in substance from the pre-desk form. */
function ShellPolicyRow({ policy }: { policy: WorkspacePolicyView }) {
  const [shell, setShell] = React.useState({
    network: policy.shell.network,
    timeoutSeconds: String(policy.shell.timeoutSeconds),
    replayRetentionMinutes: String(policy.shell.replayRetentionMinutes),
    outputLimitKb: String(policy.shell.outputLimitKb),
    cpuSeconds: String(policy.shell.cpuSeconds),
    memoryMb: String(policy.shell.memoryMb),
    fileSizeMb: String(policy.shell.fileSizeMb),
    processes: String(policy.shell.processes),
    openFiles: String(policy.shell.openFiles),
  })
  const [notice, setNotice] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [busy, startBusy] = React.useTransition()

  return (
    <SettingsRow title="Shell execution policy" stacked>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <div className="space-y-1">
          <Label htmlFor="workspace-shell-network">Network access</Label>
          <Select
            id="workspace-shell-network"
            value={shell.network}
            onChange={(event) => setShell((current) => ({
              ...current,
              network: event.target.value === 'none' ? 'none' : 'host',
            }))}
          >
            <option value="host">Allow internet and connected systems</option>
            <option value="none">No network access</option>
          </Select>
        </div>
        {([
          ['timeoutSeconds', 'Wall time (seconds)', 10, 600],
          ['cpuSeconds', 'CPU time (seconds)', 10, 600],
          ['memoryMb', 'Memory (MB)', 256, 8192],
          ['fileSizeMb', 'Largest file (MB)', 16, 2048],
          ['processes', 'Processes and threads', 8, 512],
          ['openFiles', 'Open files', 32, 2048],
          ['outputLimitKb', 'Recorded output (KB)', 16, 1024],
          ['replayRetentionMinutes', 'Replay retention (minutes)', 1, 1440],
        ] as const).map(([key, label, min, max]) => (
          <div key={key} className="space-y-1">
            <Label htmlFor={`workspace-shell-${key}`}>{label}</Label>
            <Input
              id={`workspace-shell-${key}`}
              type="number"
              min={min}
              max={max}
              value={shell[key]}
              onChange={(event) => setShell((current) => ({ ...current, [key]: event.target.value }))}
            />
          </div>
        ))}
      </div>
      <p className="mt-2 text-xs text-fg-muted">
        Limits apply to each command and every process it starts. Completed output stays reattachable for the replay window and is then kept in the append-only company record.
      </p>
      <div className="mt-3 flex items-center gap-3">
        <Button
          disabled={busy}
          onClick={() =>
            startBusy(async () => {
              setError(null)
              setNotice(null)
              const result = await saveWorkspacePolicyAction({
                retentionEnabled: policy.retentionDays !== null,
                retentionDays: policy.retentionDays ?? 90,
                shell: {
                  network: shell.network,
                  timeoutSeconds: Number(shell.timeoutSeconds),
                  replayRetentionMinutes: Number(shell.replayRetentionMinutes),
                  outputLimitKb: Number(shell.outputLimitKb),
                  cpuSeconds: Number(shell.cpuSeconds),
                  memoryMb: Number(shell.memoryMb),
                  fileSizeMb: Number(shell.fileSizeMb),
                  processes: Number(shell.processes),
                  openFiles: Number(shell.openFiles),
                },
              })
              if (!result.ok) setError(result.message)
              else setNotice('Saved. New commands run under these limits.')
            })
          }
        >
          Save shell policy
        </Button>
        {notice ? <p className="text-sm text-fg-muted">{notice}</p> : null}
        {error ? <p className="text-sm text-danger">{error}</p> : null}
      </div>
    </SettingsRow>
  )
}

/**
 * Workspace file retention. Off by default: nothing an agent keeps on its desk
 * is deleted unless an operator turns this on, and turning it off again stops
 * the sweep without touching anything. Available whether or not desks are on —
 * turning the feature off preserves the files, and this stays their dial.
 */
function WorkspaceRetentionRow({ policy }: { policy: WorkspacePolicyView }) {
  const [enabled, setEnabled] = React.useState(policy.retentionDays !== null)
  const [days, setDays] = React.useState(String(policy.retentionDays ?? 90))
  const [notice, setNotice] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [busy, startBusy] = React.useTransition()

  return (
    <SettingsRow title="Retire untouched workspace files" stacked>
      <div className="grid gap-3 sm:grid-cols-[12rem_1fr]">
        <div className="space-y-1">
          <Label htmlFor="workspace-retention-mode">Retention</Label>
          <Select
            id="workspace-retention-mode"
            value={enabled ? 'on' : 'off'}
            onChange={(event) => setEnabled(event.target.value === 'on')}
          >
            <option value="off">Keep everything</option>
            <option value="on">Retire old files</option>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="workspace-retention-days">Days a file may sit untouched</Label>
          <Input
            id="workspace-retention-days"
            type="number"
            min={7}
            value={days}
            onChange={(event) => setDays(event.target.value)}
            disabled={!enabled}
          />
        </div>
      </div>
      <p className="mt-2 text-xs text-fg-muted">
        The sweep runs daily and removes only files whose last change is older than the window — published
        deliverables, mail attachments, and everything else in the company file record are never touched.
      </p>
      <div className="mt-3 flex items-center gap-3">
        <Button
          disabled={busy}
          onClick={() =>
            startBusy(async () => {
              setError(null)
              setNotice(null)
              const result = await saveWorkspacePolicyAction({
                retentionEnabled: enabled,
                retentionDays: Number(days),
                shell: policy.shell,
              })
              if (!result.ok) setError(result.message)
              else setNotice(enabled ? `Saved — files untouched for ${days} days are retired daily.` : 'Saved — nothing is deleted.')
            })
          }
        >
          Save retention
        </Button>
        {notice ? <p className="text-sm text-fg-muted">{notice}</p> : null}
        {error ? <p className="text-sm text-danger">{error}</p> : null}
      </div>
    </SettingsRow>
  )
}

/** The pre-desk shell ledger, with its drawer — preserved audit history. */
function ShellHistoryList({ sessions }: { sessions: WorkspacePolicyView['sessions'] }) {
  const [selected, setSelected] = React.useState<WorkspacePolicyView['sessions'][number] | null>(null)
  const [sessionTab, setSessionTab] = React.useState('overview')

  return (
    <div className="px-5 py-4">
      <RecordList
        rows={sessions}
        getRowId={(session) => session.id}
        onRowClick={(session) => {
          setSelected(session)
          setSessionTab('overview')
        }}
        activeRowId={selected?.id ?? null}
        columns={[
          { key: 'personName', label: 'Agent' },
          {
            key: 'command',
            label: 'Command',
            render: (session) => <span className="line-clamp-1 font-mono text-xs">{session.command}</span>,
          },
          {
            key: 'status',
            label: 'Status',
            kind: 'status',
            statusVariant: (status) => status === 'completed' ? 'success' : status === 'timeout' ? 'warning' : 'destructive',
          },
          {
            key: 'startedAt',
            label: 'Started',
            format: (value) => new Date(String(value)).toLocaleString(),
          },
        ]}
        empty={{
          title: 'No shell history',
          description: 'This deployment has no commands from before the desk — everything is on the desk ledger.',
        }}
      />
      <Drawer
        open={selected !== null}
        onClose={() => setSelected(null)}
        title={selected ? `${selected.personName} · shell session` : 'Shell session'}
        description={selected ? new Date(selected.startedAt).toLocaleString() : undefined}
        size="lg"
        subtabs={
          <SubtabNav
            tabs={[
              { key: 'overview', label: 'Overview' },
              { key: 'output', label: 'Recorded output' },
            ]}
            active={sessionTab}
            onSelect={setSessionTab}
            ariaLabel="Shell session sections"
          />
        }
      >
        {selected ? (
          <div className="space-y-4">
            {sessionTab === 'overview' ? (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={selected.status === 'completed' ? 'success' : selected.status === 'timeout' ? 'warning' : 'destructive'}>
                    {selected.status}
                  </Badge>
                  <Badge variant="outline">exit {selected.exitCode ?? 'none'}</Badge>
                  <Badge variant="outline">{Math.round(selected.durationMs / 100) / 10}s</Badge>
                  {selected.outputTruncated ? <Badge variant="warning">output capped</Badge> : null}
                </div>
                <div className="grid gap-3 text-sm sm:grid-cols-2">
                  <div><span className="text-fg-muted">Working folder</span><p className="font-mono">{selected.cwd}</p></div>
                  <div><span className="text-fg-muted">Execution ID</span><p className="break-all font-mono">{selected.executionId ?? 'Legacy session'}</p></div>
                </div>
                <div className="space-y-1">
                  <p className="text-sm font-medium">Command</p>
                  <pre className="overflow-x-auto rounded-md border border-border bg-bg-subtle p-3 text-xs whitespace-pre-wrap">{selected.command}</pre>
                </div>
              </>
            ) : (
              <pre className="max-h-[32rem] overflow-auto rounded-md border border-border bg-bg-subtle p-3 text-xs whitespace-pre-wrap">{selected.output || 'No output.'}</pre>
            )}
          </div>
        ) : null}
      </Drawer>
    </div>
  )
}

export type SmsSettingsView = { provider: string | null; fromNumber: string | null }

type SmsDynamicFields = {
  twilioAccountSid?: string
  vonageApiKey?: string
  plivoAuthId?: string
  telnyxMessagingProfileId?: string
}

/**
 * Outbound text messaging: an operator connects one of five SMS providers,
 * whose single credential is sealed at rest and only unsealed at send time.
 * Every agent texts through the one connected provider — nothing to assign
 * per agent, unlike Model providers. Connecting happens in a drawer.
 */
export function SmsSection({ settings }: { settings: SmsSettingsView }) {
  const configuredProvider = settings.provider && isSmsProvider(settings.provider) ? settings.provider : null
  const [open, setOpen] = React.useState(false)
  const [provider, setProvider] = React.useState<SmsProvider>(configuredProvider ?? SMS_PROVIDER_SPECS[0]!.value)
  const [fromNumber, setFromNumber] = React.useState(settings.fromNumber ?? '')
  const [secret, setSecret] = React.useState('')
  const [fields, setFields] = React.useState<SmsDynamicFields>({})
  const [error, setError] = React.useState<string | null>(null)
  const [busy, startBusy] = React.useTransition()

  const spec = smsProviderSpec(provider)
  const providerLabel = configuredProvider ? smsProviderSpec(configuredProvider).label : null

  const setField = (key: string, value: string) =>
    setFields((prev) => ({ ...prev, [key]: value }) as SmsDynamicFields)

  return (
    <SettingsSection
      title="Text messaging"
      description="Send SMS from your agents — reminders, confirmations, quick replies. Connect one provider and every agent can text through it; the credential is sealed at rest and unsealed only when a message goes out."
    >
      {providerLabel ? (
        <SettingsRow
          title={providerLabel}
          description={settings.fromNumber ? `Sending from ${settings.fromNumber}` : 'Sender configured'}
          control={
            <span className="flex items-center gap-2">
              <Badge variant="secondary">key sealed</Badge>
              <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
                Manage
              </Button>
            </span>
          }
        />
      ) : (
        <SettingsRow
          title="Not configured"
          description="Agents cannot send text messages until a provider is connected."
          control={
            <span className="flex items-center gap-2">
              <Badge variant="outline">off</Badge>
              <Button size="sm" onClick={() => setOpen(true)}>
                Connect a provider
              </Button>
            </span>
          }
        />
      )}

      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        title={providerLabel ? 'Text messaging' : 'Connect a text provider'}
        description="One provider carries every agent's messages. The credential is checked against the provider before it is sealed."
        size="md"
      >
        <div className="space-y-4">
          {providerLabel ? (
            <div className="flex items-center justify-between rounded-md border border-border px-3 py-2 text-sm">
              <span className="flex items-center gap-2">
                <Badge>connected</Badge>
                <span className="text-fg-muted">{providerLabel} · key sealed at rest.</span>
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() =>
                  startBusy(async () => {
                    await removeSmsSettingsAction()
                    setOpen(false)
                  })
                }
              >
                Remove
              </Button>
            </div>
          ) : null}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="sms-provider">Provider</Label>
              <Select
                id="sms-provider"
                value={provider}
                onChange={(event) => {
                  const next = event.target.value
                  if (isSmsProvider(next)) {
                    setProvider(next)
                    setFields({})
                  }
                }}
              >
                {SMS_PROVIDER_SPECS.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="sms-from">Sender (number or ID)</Label>
              <Input
                id="sms-from"
                value={fromNumber}
                onChange={(event) => setFromNumber(event.target.value)}
                placeholder="+15551234567"
              />
            </div>
            {spec.fields.map((field) => (
              <div key={field.key} className="space-y-1">
                <Label htmlFor={`sms-field-${field.key}`}>{field.label}</Label>
                <Input
                  id={`sms-field-${field.key}`}
                  value={fields[field.key as keyof SmsDynamicFields] ?? ''}
                  onChange={(event) => setField(field.key, event.target.value)}
                  placeholder={field.placeholder}
                />
              </div>
            ))}
            <div className="space-y-1 sm:col-span-2">
              <Label htmlFor="sms-secret">{spec.secretLabel}</Label>
              <Input
                id="sms-secret"
                type="password"
                value={secret}
                onChange={(event) => setSecret(event.target.value)}
                placeholder={spec.keyHint}
              />
            </div>
          </div>
          {spec.docsHint ? <p className="text-xs text-fg-muted">{spec.docsHint}</p> : null}
          <Button
            disabled={busy || !fromNumber.trim() || !secret.trim()}
            onClick={() =>
              startBusy(async () => {
                setError(null)
                const result = await saveSmsSettingsAction({
                  provider,
                  fromNumber,
                  secret,
                  ...fields,
                })
                if (!result.ok) {
                  setError(result.message)
                  return
                }
                setSecret('')
                setOpen(false)
              })
            }
          >
            {busy ? 'Verifying…' : 'Verify & save'}
          </Button>
          {error ? <p className="text-sm text-danger">{error}</p> : null}
        </div>
      </Drawer>
    </SettingsSection>
  )
}
