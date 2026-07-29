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
  Textarea,
} from '@appkit/ui'
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
import { setAutonomy } from './actions'

type Person = typeof people.$inferSelect

/** Overview: every field an operator owns, editable in place. */
export function OverviewSection({
  person,
  roster,
}: {
  person: Person
  roster: { id: string; name: string; title: string }[]
}) {
  const isAgent = person.kind === 'agent'
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
 * Which brain this agent thinks with. Its own tab rather than a card under the
 * record: the provider and model are a standing decision about how the agent
 * works and what it costs, not another field on the personnel form.
 */
export function ModelSection({
  person,
  providers,
}: {
  person: Person
  providers: { slug: string; label: string }[]
}) {
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Assigned model</CardTitle>
          <CardDescription>
            {person.modelConfig
              ? `${person.modelConfig.provider} / ${person.modelConfig.model}`
              : 'Not assigned yet — this agent cannot work without a brain.'}
          </CardDescription>
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
                ? { currentProvider: person.modelConfig.provider, currentModel: person.modelConfig.model }
                : {})}
            />
          )}
        </CardContent>
      </Card>
      <p className="text-xs text-fg-muted">
        Every agent runs on whichever provider and model you assign it — a cheap model for routine mail, a stronger one
        for work that has to be right. Spend is metered against this agent&apos;s salary at the price on record.
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
}: {
  person: Person
  notes: (typeof memories.$inferSelect)[]
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Memory</CardTitle>
        <CardDescription>
          This agent&apos;s logbook — human-readable, append-only. Corrections keep history; forgetting closes validity.
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
