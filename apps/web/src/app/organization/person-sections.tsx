import Link from 'next/link'
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

function RunList({ runs: recentRuns }: { runs: RecentRun[] }) {
  if (recentRuns.length === 0) {
    return <p className="text-sm text-fg-muted">No runs yet — work appears here once this agent starts.</p>
  }
  return (
    <div className="space-y-1">
      {recentRuns.map((run) => (
        <Link
          key={run.id}
          href={`/runs/${run.id}?from=person`}
          className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2 transition-colors hover:border-primary/50"
        >
          <span className="min-w-0 truncate">{run.summary ?? 'Working…'}</span>
          <Badge variant={run.status === 'completed' ? 'default' : run.status === 'failed' ? 'destructive' : 'outline'}>
            {run.status.replace('_', ' ')}
          </Badge>
        </Link>
      ))}
    </div>
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
  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Card>
          <CardContent className="pt-5">
            <p className="text-xs font-medium uppercase tracking-wide text-fg-muted">Status</p>
            <p className="mt-2 text-xl font-semibold capitalize text-fg">{person.status}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-5">
            <p className="text-xs font-medium uppercase tracking-wide text-fg-muted">Right now</p>
            <p className="mt-2 truncate text-xl font-semibold text-fg">
              {activeRun ? activeRun.status.replace('_', ' ') : 'Available'}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-5">
            <p className="text-xs font-medium uppercase tracking-wide text-fg-muted">Approvals waiting</p>
            <p className="mt-2 text-xl font-semibold tabular-nums text-fg">{pendingApprovals}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-5">
            <p className="text-xs font-medium uppercase tracking-wide text-fg-muted">Salary used</p>
            <p className="mt-2 text-xl font-semibold tabular-nums text-fg">
              ${monthSpend.toFixed(2)} <span className="text-sm font-normal text-fg-muted">of ${salary}/mo</span>
            </p>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Current focus</CardTitle>
            <CardDescription>What this employee is doing now.</CardDescription>
          </CardHeader>
          <CardContent>
            {activeRun ? (
              <Link href={`/runs/${activeRun.id}`} className="text-sm font-medium text-primary hover:underline">
                {activeRun.summary ?? activeRun.status.replace('_', ' ')}
              </Link>
            ) : (
              <p className="text-sm text-fg-muted">No work is running right now.</p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Next duty</CardTitle>
            <CardDescription>The next piece of standing work on their schedule.</CardDescription>
          </CardHeader>
          <CardContent>
            {nextDuty ? (
              <div className="space-y-1 text-sm">
                <p className="font-medium text-fg">{nextDuty.title}</p>
                <p className="text-fg-muted">{nextDuty.schedule}</p>
                {nextDuty.dueAt ? <p className="text-xs text-fg-muted">Next due {nextDuty.dueAt}</p> : null}
              </div>
            ) : (
              <p className="text-sm text-fg-muted">No enabled duties are scheduled.</p>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Recent activity</CardTitle>
          <CardDescription>The latest governed runs on this employee’s record.</CardDescription>
        </CardHeader>
        <CardContent>
          <RunList runs={recentRuns.slice(0, 4)} />
        </CardContent>
      </Card>
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
