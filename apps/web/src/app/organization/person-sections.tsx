import Link from 'next/link'
import {
  Activity,
  ArrowUpRight,
  CalendarClock,
  CheckCircle2,
  CircleDollarSign,
  Clock3,
  MessageSquare,
  ShieldAlert,
  Sparkles,
} from 'lucide-react'
import {
  Badge,
  Button,
  Label,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Progress,
  Select,
  SettingsRow,
  SettingsSection,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
} from '@braedonsaunders/appkit-ui'
import type { ReactNode } from 'react'
import type { autonomySettings, memories, people, runs } from '../../db/schema'
import { AssignModelForm } from '../../components/assign-model-form'
import { NotesView } from '../../components/notes-view'
import { PersonRecordForm } from '../../components/person-record-form'
import {
  ACTION_CATEGORIES,
  AUTONOMY_LEVELS,
  CATEGORY_LABELS,
  DEFAULT_AUTONOMY_LEVEL,
  LEVEL_BADGES,
} from '../../lib/autonomy'
import { assignedModelsSummary } from '../../lib/model-assignment'
import { setAutonomy } from './actions'
import { PersonAccountForm } from '../../components/person-account-form'
import type { PersonAccountAccess } from '../../lib/person-accounts'

type Person = typeof people.$inferSelect

type RecentRun = Pick<typeof runs.$inferSelect, 'id' | 'status' | 'summary' | 'startedAt'>

function runStatusVariant(status: string): 'default' | 'destructive' | 'outline' | 'secondary' {
  if (status === 'completed') return 'default'
  if (status === 'failed' || status === 'cancelled') return 'destructive'
  if (status === 'waiting_approval' || status === 'waiting_reply') return 'secondary'
  return 'outline'
}

function runStamp(value: Date): string {
  return value.toLocaleString('en-CA', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function RunList({ runs: recentRuns, embedded = false }: { runs: RecentRun[]; embedded?: boolean }) {
  if (recentRuns.length === 0) {
    return <p className="text-sm text-fg-muted">No runs yet — work appears here once this agent starts.</p>
  }
  return (
    <Table containerClassName={embedded ? 'rounded-none border-x-0 border-b-0 shadow-none' : undefined}>
      <TableHeader>
        <TableRow noAnimate>
          <TableHead>Work</TableHead>
          <TableHead className="hidden w-36 sm:table-cell">Started</TableHead>
          <TableHead className="w-32">Outcome</TableHead>
          <TableHead className="w-10"><span className="sr-only">Open</span></TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {recentRuns.map((run) => (
          <TableRow key={run.id}>
            <TableCell className="min-w-0 font-medium">
              <Link href={`/runs/${run.id}?from=person`} className="line-clamp-2 text-fg hover:text-primary">
                {run.summary ?? 'Work in progress'}
              </Link>
            </TableCell>
            <TableCell className="hidden whitespace-nowrap text-xs text-fg-muted sm:table-cell">
              {runStamp(run.startedAt)}
            </TableCell>
            <TableCell>
              <Badge variant={runStatusVariant(run.status)}>{run.status.replaceAll('_', ' ')}</Badge>
            </TableCell>
            <TableCell className="px-2 text-right">
              <Button asChild size="sm" variant="ghost" className="size-7 p-0">
                <Link href={`/runs/${run.id}?from=person`} aria-label="Open run record">
                  <ArrowUpRight aria-hidden className="size-4" />
                </Link>
              </Button>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

/** The employee landing view: current state and the few facts needed at a glance. */
export function AgentOverviewSection({
  person,
  monthSpend,
  pendingApprovals,
  activeRun,
  nextDuty,
  recentRuns,
}: {
  person: Person
  monthSpend: number
  pendingApprovals: number
  activeRun: RecentRun | null
  nextDuty: { title: string; schedule: string; dueAt: string | null } | null
  recentRuns: RecentRun[]
}) {
  const salary = person.salary?.monthlyUsd ?? 0
  const budgetPercent = salary > 0 ? Math.min(100, (monthSpend / salary) * 100) : 0
  const currentLabel = !activeRun
    ? 'Ready for work'
    : activeRun.status === 'waiting_approval'
      ? 'Waiting for your decision'
      : activeRun.status === 'waiting_reply'
        ? 'Waiting for a reply'
        : 'Working now'
  const workingPattern = !person.workingHours
    ? 'Always available'
    : `${person.workingHours.start}–${person.workingHours.end} · ${
        person.workingHours.days.length === 5 ? 'weekdays' : `${person.workingHours.days.length} days a week`
      }`
  const model = person.modelConfig
    ? `${person.modelConfig.provider} · ${person.modelConfig.model}`
    : 'No model assigned'
  const overage =
    person.salary?.overagePolicy === 'overtime'
      ? 'May work overtime'
      : person.salary?.overagePolicy === 'pause'
        ? 'Pauses at budget'
        : 'Asks before overtime'

  return (
    <div className="space-y-4">
      <Card className="overflow-hidden">
        <CardContent className="p-0">
          <div className="bg-linear-to-br from-primary-subtle via-surface to-bg-subtle p-5 sm:p-6">
            <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
              <div className="flex min-w-0 gap-4">
                <span className="flex size-11 shrink-0 items-center justify-center rounded-xl border border-primary/20 bg-surface text-primary shadow-sm">
                  {activeRun ? <Activity aria-hidden className="size-5" /> : <Sparkles aria-hidden className="size-5" />}
                </span>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-xs font-semibold uppercase tracking-wider text-primary">{currentLabel}</p>
                    {activeRun ? <Badge variant={runStatusVariant(activeRun.status)}>{activeRun.status.replaceAll('_', ' ')}</Badge> : null}
                  </div>
                  <h2 className="mt-1 max-w-3xl text-xl font-semibold text-fg sm:text-2xl">
                    {activeRun?.summary ?? `Ready for ${person.title.toLowerCase()} work`}
                  </h2>
                  <p className="mt-2 max-w-3xl text-sm text-fg-muted">
                    {activeRun
                      ? `Started ${runStamp(activeRun.startedAt)}. The complete evidence trail is available on the run record.`
                      : nextDuty
                        ? `Next scheduled responsibility: ${nextDuty.title}.`
                        : 'No work is running and no standing duty is currently due.'}
                  </p>
                </div>
              </div>
              <div className="flex shrink-0 flex-wrap gap-2">
                {activeRun ? (
                  <Button asChild size="sm">
                    <Link href={`/runs/${activeRun.id}`}>
                      Open run <ArrowUpRight aria-hidden className="size-4" />
                    </Link>
                  </Button>
                ) : null}
                <Button asChild size="sm" variant={activeRun ? 'outline' : 'default'}>
                  <Link href={`/organization/${person.id}?section=chat`}>
                    <MessageSquare aria-hidden className="size-4" />
                    Message
                  </Link>
                </Button>
              </div>
            </div>
          </div>

          <div className="grid divide-y divide-border sm:grid-cols-3 sm:divide-x sm:divide-y-0">
            <div className="flex min-w-0 gap-3 p-4">
              <span className="mt-0.5 text-fg-muted"><CalendarClock aria-hidden className="size-4" /></span>
              <div className="min-w-0">
                <p className="text-xs font-medium uppercase tracking-wide text-fg-muted">Next duty</p>
                <p className="mt-1 truncate text-sm font-medium text-fg">{nextDuty?.title ?? 'Nothing scheduled'}</p>
                <p className="mt-0.5 truncate text-xs text-fg-muted">
                  {nextDuty ? (nextDuty.dueAt ? `Due ${nextDuty.dueAt}` : nextDuty.schedule) : 'No enabled standing duties'}
                </p>
              </div>
            </div>

            <div className="flex min-w-0 gap-3 p-4">
              <span className={pendingApprovals > 0 ? 'mt-0.5 text-warning' : 'mt-0.5 text-success'}>
                {pendingApprovals > 0 ? <ShieldAlert aria-hidden className="size-4" /> : <CheckCircle2 aria-hidden className="size-4" />}
              </span>
              <div className="min-w-0">
                <p className="text-xs font-medium uppercase tracking-wide text-fg-muted">Needs attention</p>
                {pendingApprovals > 0 ? (
                  <Link href="/approvals" className="mt-1 inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline">
                    {pendingApprovals} {pendingApprovals === 1 ? 'decision' : 'decisions'} waiting
                    <ArrowUpRight aria-hidden className="size-3.5" />
                  </Link>
                ) : (
                  <p className="mt-1 text-sm font-medium text-fg">Nothing waiting</p>
                )}
                <p className="mt-0.5 text-xs text-fg-muted">
                  {pendingApprovals > 0 ? 'Review before work can continue' : 'No approvals are blocking work'}
                </p>
              </div>
            </div>

            <div className="min-w-0 p-4">
              <div className="flex items-center gap-3">
                <CircleDollarSign aria-hidden className="size-4 shrink-0 text-fg-muted" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <p className="text-xs font-medium uppercase tracking-wide text-fg-muted">Monthly budget</p>
                    <p className="text-xs tabular-nums text-fg-muted">{budgetPercent.toFixed(0)}%</p>
                  </div>
                  <p className="mt-1 text-sm font-medium tabular-nums text-fg">${monthSpend.toFixed(2)} of ${salary.toFixed(2)}</p>
                </div>
              </div>
              <Progress value={budgetPercent} className="mt-2" />
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(20rem,0.8fr)]">
        <Card className="overflow-hidden">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <CardTitle>Recent work</CardTitle>
                <CardDescription>The latest governed runs and their outcomes.</CardDescription>
              </div>
              <Button asChild size="sm" variant="ghost">
                <Link href={`/organization/${person.id}?section=work&work=activity`}>
                  All work <ArrowUpRight aria-hidden className="size-4" />
                </Link>
              </Button>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            {recentRuns.length === 0 ? (
              <p className="px-5 pb-5 text-sm text-fg-muted">No runs yet — work appears here once this agent starts.</p>
            ) : (
              <RunList runs={recentRuns.slice(0, 5)} embedded />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle>Operating brief</CardTitle>
            <CardDescription>The practical context behind this employee.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-fg-muted">Responsible for</p>
              <p className="mt-1 line-clamp-3 leading-5 text-fg">
                {person.responsibilities?.trim() || `Work assigned to the ${person.title} role.`}
              </p>
            </div>
            <dl className="divide-y divide-border-subtle rounded-lg border border-border bg-bg-subtle px-3">
              <div className="flex items-start gap-3 py-3">
                <Sparkles aria-hidden className="mt-0.5 size-4 shrink-0 text-fg-muted" />
                <div className="min-w-0">
                  <dt className="text-xs text-fg-muted">Model</dt>
                  <dd className="mt-0.5 truncate font-medium text-fg">{model}</dd>
                </div>
              </div>
              <div className="flex items-start gap-3 py-3">
                <Clock3 aria-hidden className="mt-0.5 size-4 shrink-0 text-fg-muted" />
                <div className="min-w-0">
                  <dt className="text-xs text-fg-muted">Working pattern</dt>
                  <dd className="mt-0.5 font-medium text-fg">{workingPattern}</dd>
                </div>
              </div>
              <div className="flex items-start gap-3 py-3">
                <CircleDollarSign aria-hidden className="mt-0.5 size-4 shrink-0 text-fg-muted" />
                <div className="min-w-0">
                  <dt className="text-xs text-fg-muted">At the budget limit</dt>
                  <dd className="mt-0.5 font-medium text-fg">{overage}</dd>
                </div>
              </div>
            </dl>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

/** Work history without compensation, for the Work section. */
export function AgentActivitySection({ recentRuns }: { recentRuns: RecentRun[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Activity</CardTitle>
        <CardDescription>Recent runs and their full audit records.</CardDescription>
      </CardHeader>
      <CardContent>
        <RunList runs={recentRuns} />
      </CardContent>
    </Card>
  )
}

/** The job this employee holds and the governed resources that reach it. */
export function AgentRoleSection({
  roleLabel,
  resourceCounts,
}: {
  roleLabel: string | null
  resourceCounts: { procedures: number; skills: number; notes: number; systems: number }
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Role & resources</CardTitle>
        <CardDescription>
          The job this employee holds and the company resources that reach them through that role or a direct assignment.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-fg-muted">Role</p>
          <p className="mt-1 text-lg font-semibold text-fg">{roleLabel ?? 'No role assigned'}</p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {(
            [
              ['Procedures', resourceCounts.procedures],
              ['Skills', resourceCounts.skills],
              ['Knowledge', resourceCounts.notes],
              ['Systems', resourceCounts.systems],
            ] as const
          ).map(([label, count]) => (
            <div key={label} className="rounded-lg border border-border bg-bg-subtle px-3 py-3">
              <p className="text-xs text-fg-muted">{label}</p>
              <p className="mt-1 text-xl font-semibold tabular-nums text-fg">{count}</p>
            </div>
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button asChild size="sm" variant="outline">
            <Link href="/roles">Manage roles</Link>
          </Button>
          <Button asChild size="sm" variant="outline">
            <Link href="/resources">Open company resources</Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

/** The human record's link to the platform account that can sign in. */
export function AccountSection({ person, access }: { person: Person; access: PersonAccountAccess }) {
  const status = !access.current
    ? 'Not linked'
    : !access.current.isActive
      ? 'Account inactive'
      : access.current.membershipStatus === 'active'
        ? 'Active'
        : access.current.membershipStatus === 'invited'
          ? 'Invited'
          : access.current.membershipStatus === 'suspended'
            ? 'Workspace access suspended'
            : 'No workspace access'

  return (
    <div className="space-y-4">
      <SettingsSection
        title="Login access"
        description="Connect this employee record to the account they use to sign in to Bunkhouse."
      >
        <SettingsRow
          title="Status"
          description={access.current ? status : 'This person cannot sign in as this employee record.'}
          control={<Badge>{status}</Badge>}
        />
        <SettingsRow
          title="Work email"
          description="Agents use this address to reach the person."
          control={<span className="text-sm text-fg">{person.email}</span>}
        />
        {access.current ? (
          <SettingsRow
            title="Sign-in email"
            description={`Platform account for ${access.current.name}.`}
            control={<span className="text-sm text-fg">{access.current.email}</span>}
          />
        ) : null}
        <SettingsRow title="Linked account" stacked>
          <PersonAccountForm
            personId={person.id}
            currentUserId={access.current?.userId ?? null}
            accounts={access.options}
          />
        </SettingsRow>
      </SettingsSection>
    </div>
  )
}

/** Overview: every field an operator owns, editable in place. */
export function OverviewSection({
  person,
  roster,
  departments,
}: {
  person: Person
  roster: { id: string; name: string; title: string }[]
  /** The company's places, for the desk field in the record. */
  departments?: { id: string; name: string }[]
}) {
  const isAgent = person.kind === 'agent'
  const hasDesks = isAgent && Boolean(departments && departments.length > 0)
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Record</CardTitle>
          <CardDescription>Everything here saves in one go.</CardDescription>
        </CardHeader>
        <CardContent>
          <PersonRecordForm>
            <input type="hidden" name="personId" value={person.id} />
            <div className="space-y-2">
              <Label htmlFor="p-name">Name</Label>
              <Input id="p-name" name="name" defaultValue={person.name} required />
            </div>
            <div className="space-y-2">
              <Label htmlFor="p-title">Title</Label>
              <Input id="p-title" name="title" defaultValue={person.title} required />
            </div>
            <div className="space-y-2">
              <Label htmlFor="p-email">Email</Label>
              <Input id="p-email" name="email" type="email" defaultValue={person.email} required />
            </div>
            <div className="space-y-2">
              <Label htmlFor="p-status">Status</Label>
              <Select id="p-status" name="status" defaultValue={person.status}>
                <option value="onboarding">Onboarding</option>
                <option value="active">Active</option>
                <option value="offboarded">Offboarded</option>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="p-reports">Reports to</Label>
              <Select id="p-reports" name="reportsToId" defaultValue={person.reportsToId ?? ''}>
                <option value="">— Top level —</option>
                {roster
                  .filter((r) => r.id !== person.id)
                  .map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name} — {r.title}
                    </option>
                  ))}
              </Select>
              <p className="text-xs text-fg-muted">Sets their place on the org chart and where work escalates to.</p>
            </div>
            {hasDesks ? (
              <div className="space-y-2">
                <Label htmlFor="p-desk">Desk</Label>
                <Select id="p-desk" name="departmentId" defaultValue={person.departmentId ?? ''}>
                  <option value="">No fixed desk</option>
                  {departments!.map((department) => (
                    <option key={department.id} value={department.id}>
                      {department.name}
                    </option>
                  ))}
                </Select>
                <p className="text-xs text-fg-muted">
                  The floor they normally work on — and, if wandering is on, occasionally somewhere else. Without a
                  desk they appear on every floor.
                </p>
              </div>
            ) : null}
            {isAgent ? null : (
              <>
                <div className="space-y-2">
                  <Label htmlFor="p-phone">Phone</Label>
                  <Input id="p-phone" name="phone" type="tel" defaultValue={person.phone ?? ''} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="p-timezone">Time zone</Label>
                  <Input
                    id="p-timezone"
                    name="timezone"
                    placeholder="America/New_York"
                    defaultValue={person.timezone ?? ''}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="p-started">Start date</Label>
                  <Input id="p-started" name="startedOn" type="date" defaultValue={person.startedOn ?? ''} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="p-ended">Last day</Label>
                  <Input id="p-ended" name="endedOn" type="date" defaultValue={person.endedOn ?? ''} />
                </div>
              </>
            )}
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="p-resp">Responsibilities (agents route work using this)</Label>
              <Textarea id="p-resp" name="responsibilities" rows={2} defaultValue={person.responsibilities ?? ''} />
            </div>
            {isAgent ? (
              <>
                <div className="space-y-2 sm:col-span-2">
                  <Label htmlFor="p-bio">Personality bio</Label>
                  <Textarea id="p-bio" name="bio" rows={3} defaultValue={person.personality?.bio ?? ''} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="p-tone">Tone (comma-separated)</Label>
                  <Input id="p-tone" name="tone" defaultValue={person.personality?.tone.join(', ') ?? ''} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="p-signoff">Mail sign-off</Label>
                  <Input id="p-signoff" name="signoff" defaultValue={person.personality?.signoff ?? ''} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="p-salary">Monthly salary (USD token budget)</Label>
                  <Input id="p-salary" name="salaryUsd" type="number" min="1" step="1" defaultValue={person.salary?.monthlyUsd ?? 50} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="p-overage">Overage policy</Label>
                  <Select id="p-overage" name="overagePolicy" defaultValue={person.salary?.overagePolicy ?? 'ask'}>
                    <option value="ask">Ask before overtime</option>
                    <option value="overtime">Keep working (overtime)</option>
                    <option value="pause">Pause at budget</option>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="p-inbound">Who may email them work</Label>
                  <Select id="p-inbound" name="inboundPolicy" defaultValue={person.inboundPolicy ?? 'staff_only'}>
                    <option value="staff_only">Staff only</option>
                    <option value="known_contacts">Staff + known contacts</option>
                    <option value="anyone">Anyone (customer-facing)</option>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="p-proactivity">Proactivity</Label>
                  <Select id="p-proactivity" name="proactivity" defaultValue={person.proactivity ?? 'duties'}>
                    <option value="reactive">Reactive only</option>
                    <option value="duties">Proactive within duties</option>
                    <option value="autonomous">Fully autonomous</option>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="p-hours-mode">Working hours</Label>
                  <Select
                    id="p-hours-mode"
                    name="workingHoursMode"
                    defaultValue={
                      !person.workingHours ? 'always' : person.workingHours.days.length === 7 ? 'everyday' : 'weekdays'
                    }
                  >
                    <option value="always">Always on</option>
                    <option value="weekdays">Weekdays</option>
                    <option value="everyday">Every day</option>
                  </Select>
                  <p className="text-xs text-fg-muted">
                    Outside their hours, new email work waits for the next window. Scheduled duties and incoming calls
                    are unaffected.
                  </p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="p-hours-start">Hours (start / end / time zone)</Label>
                  <div className="grid grid-cols-[6rem_6rem_1fr] gap-2">
                    <Input
                      id="p-hours-start"
                      name="workStart"
                      type="time"
                      defaultValue={person.workingHours?.start ?? '08:00'}
                    />
                    <Input name="workEnd" type="time" defaultValue={person.workingHours?.end ?? '18:00'} />
                    <Input
                      name="workTimezone"
                      placeholder="America/New_York"
                      defaultValue={person.workingHours?.timezone ?? ''}
                    />
                  </div>
                </div>
              </>
            ) : null}
          </PersonRecordForm>
        </CardContent>
      </Card>
    </div>
  )
}

/**
 * Which brains this agent thinks with. Its own tab rather than a card under
 * the record: the provider and models are a standing decision about how the
 * agent works and what it costs, not another field on the personnel form.
 */
export function ModelSection({
  person,
  providers,
}: {
  person: Person
  providers: { slug: string; label: string; modelFast?: string | undefined }[]
}) {
  const assignedProviderFast = providers.find((p) => p.slug === person.modelConfig?.provider)?.modelFast
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Assigned models</CardTitle>
          <CardDescription>{assignedModelsSummary(person.modelConfig, assignedProviderFast)}</CardDescription>
        </CardHeader>
        <CardContent>
          {providers.length === 0 ? (
            <p className="text-sm text-fg-muted">
              No model providers connected yet. Add one under Settings → Intelligence → Models, and it becomes
              assignable here.
            </p>
          ) : (
            <AssignModelForm
              personId={person.id}
              providers={providers}
              {...(person.modelConfig
                ? {
                    currentProvider: person.modelConfig.provider,
                    currentModel: person.modelConfig.model,
                    ...(person.modelConfig.modelFast ? { currentModelFast: person.modelConfig.modelFast } : {}),
                  }
                : {})}
            />
          )}
        </CardContent>
      </Card>
      <p className="text-xs text-fg-muted">
        Every agent runs on whichever provider and models you assign it — a cheap model for routine mail, a stronger
        one for work that has to be right, and a quick one so nobody waits on the phone. Spend is metered against this
        agent&apos;s salary at the price on record, whichever model earned it.
      </p>
    </div>
  )
}

/** The autonomy dial, editable per category — enforced by the runtime. */
export function AutonomySection({
  person,
  dial,
  suggestions = [],
}: {
  person: Person
  dial: (typeof autonomySettings.$inferSelect)[]
  /** Categories whose last five decisions were all approvals — promotion-ready. */
  suggestions?: string[]
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Autonomy dial</CardTitle>
        <CardDescription>Enforced by the runtime, per action category.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3 sm:grid-cols-2">
        {ACTION_CATEGORIES.map((category) => {
          const current = dial.find((s) => s.category === category)?.level ?? DEFAULT_AUTONOMY_LEVEL
          const promotionReady = suggestions.includes(category)
          return (
            <form key={category} action={setAutonomy} className="space-y-1">
              <input type="hidden" name="personId" value={person.id} />
              <input type="hidden" name="category" value={category} />
              <p className="flex items-center gap-2 text-xs text-fg-muted">
                {CATEGORY_LABELS[category]}
                <Badge variant={LEVEL_BADGES[current]}>{current}</Badge>
                {promotionReady ? (
                  <Badge variant="secondary" title="The last five requests here were all approved — consider raising the dial.">
                    ready for more trust
                  </Badge>
                ) : null}
              </p>
              <div className="flex items-center gap-1">
                <Select name="level" defaultValue={current}>
                  {AUTONOMY_LEVELS.map((level) => (
                    <option key={level} value={level}>
                      {level}
                    </option>
                  ))}
                </Select>
                <Button type="submit" variant="outline" size="sm">
                  Set
                </Button>
              </div>
            </form>
          )
        })}
      </CardContent>
    </Card>
  )
}

/** The agent's logbook: RecordList + drawers via the shared NotesView. */
export function MemorySection({
  person,
  notes,
  pagination,
}: {
  person: Person
  notes: (typeof memories.$inferSelect)[]
  /** The page control, rendered under the list — a logbook only grows. */
  pagination?: ReactNode
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Memory</CardTitle>
        <CardDescription>
          This agent&apos;s logbook. Newest first, and paged — a logbook only grows, and one agent wrote 195 notes in a
          day. Raw entries are consolidated into what they amount to and then closed; nothing is deleted, so the history
          is all still here.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <NotesView
          scope="agent"
          personId={person.id}
          rows={notes.map((note) => ({
            id: note.id,
            slug: note.slug,
            kind: note.kind,
            title: note.title,
            body: note.body,
            importance: note.importance,
            pinned: note.pinned,
            author: note.author,
            updatedAt: note.updatedAt.toISOString().slice(0, 16).replace('T', ' '),
          }))}
        />
        {pagination}
      </CardContent>
    </Card>
  )
}

/** Month spend vs salary and the recent work feed. */
export function PayrollSection({
  person,
  monthSpend,
  recentRuns,
}: {
  person: Person
  monthSpend: number
  recentRuns: Pick<typeof runs.$inferSelect, 'id' | 'status' | 'summary' | 'startedAt'>[]
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Payroll & work</CardTitle>
        <CardDescription>This month&apos;s model spend against salary, and recent runs.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <div className="space-y-1">
          <p className="tabular-nums">
            <span className="text-2xl font-semibold">${monthSpend.toFixed(2)}</span>
            <span className="text-fg-muted"> of ${person.salary?.monthlyUsd ?? 0}/mo</span>
          </p>
          <Progress
            value={person.salary?.monthlyUsd ? Math.min(100, (monthSpend / person.salary.monthlyUsd) * 100) : 0}
          />
        </div>
        {recentRuns.length === 0 ? (
          <p className="text-fg-muted">No runs yet — work appears here once this agent starts.</p>
        ) : (
          <div className="space-y-1">
            {recentRuns.map((run) => (
              <Link
                key={run.id}
                href={`/runs/${run.id}?from=person`}
                className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2 transition-colors hover:border-primary/50"
              >
                <span className="min-w-0 truncate">{run.summary ?? 'Working…'}</span>
                <Badge
                  variant={run.status === 'completed' ? 'default' : run.status === 'failed' ? 'destructive' : 'outline'}
                >
                  {run.status.replace('_', ' ')}
                </Badge>
              </Link>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
