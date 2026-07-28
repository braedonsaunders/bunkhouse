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
import { setAutonomy, updatePerson } from './actions'

type Person = typeof people.$inferSelect

const AUTONOMY_LEVELS = ['forbidden', 'approval', 'notify', 'trusted'] as const

const CATEGORY_LABELS: Record<string, string> = {
  external_email: 'External email',
  internal_email: 'Internal email',
  record_write: 'Record changes',
  money_adjacent: 'Money-adjacent',
  file_write: 'File writes',
  computer_use: 'Computer use',
  shell: 'Terminal / shell',
  phone_call: 'Phone calls',
}

const LEVEL_BADGES: Record<string, 'default' | 'secondary' | 'outline' | 'destructive'> = {
  trusted: 'default',
  notify: 'secondary',
  approval: 'outline',
  forbidden: 'destructive',
}

/** Overview: every field an operator owns, editable in place. */
export function OverviewSection({
  person,
  providers,
  roster,
}: {
  person: Person
  providers: { slug: string; label: string }[]
  roster: { id: string; name: string; title: string }[]
}) {
  const isHand = person.kind === 'hand'
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Record</CardTitle>
          <CardDescription>Everything here saves in one go.</CardDescription>
        </CardHeader>
        <CardContent>
          <form action={updatePerson} className="grid gap-4 sm:grid-cols-2">
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
                <option value="">— Nobody —</option>
                {roster
                  .filter((r) => r.id !== person.id)
                  .map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name} — {r.title}
                    </option>
                  ))}
              </Select>
            </div>
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="p-resp">Responsibilities (hands route work using this)</Label>
              <Textarea id="p-resp" name="responsibilities" rows={2} defaultValue={person.responsibilities ?? ''} />
            </div>
            {isHand ? (
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
              </>
            ) : null}
            <div className="sm:col-span-2">
              <Button type="submit">Save record</Button>
            </div>
          </form>
        </CardContent>
      </Card>
      {isHand ? (
        <Card>
          <CardHeader>
            <CardTitle>Model</CardTitle>
            <CardDescription>
              {person.modelConfig
                ? `${person.modelConfig.provider} / ${person.modelConfig.model}`
                : 'Not assigned yet — this hand cannot work without a brain.'}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {providers.length === 0 ? (
              <p className="text-xs text-fg-muted">Add a model provider in Settings to assign a brain.</p>
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
      ) : null}
    </div>
  )
}

/** The autonomy dial, editable per category — enforced by the runtime. */
export function AutonomySection({
  person,
  dial,
}: {
  person: Person
  dial: (typeof autonomySettings.$inferSelect)[]
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Autonomy dial</CardTitle>
        <CardDescription>Enforced by the runtime, per action category.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3 sm:grid-cols-2">
        {Object.entries(CATEGORY_LABELS).map(([category, label]) => {
          const current = dial.find((s) => s.category === category)?.level ?? 'approval'
          return (
            <form key={category} action={setAutonomy} className="space-y-1">
              <input type="hidden" name="personId" value={person.id} />
              <input type="hidden" name="category" value={category} />
              <p className="flex items-center gap-2 text-xs text-fg-muted">
                {label}
                <Badge variant={LEVEL_BADGES[current] ?? 'outline'}>{current}</Badge>
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

/** The hand's logbook: RecordList + drawers via the shared NotesView. */
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
          This hand&apos;s logbook — human-readable, append-only. Corrections keep history; forgetting closes validity.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <NotesView
          scope="hand"
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
          <p className="text-fg-muted">No runs yet — work appears here once this hand starts.</p>
        ) : (
          <div className="space-y-1">
            {recentRuns.map((run) => (
              <Link
                key={run.id}
                href={`/runs/${run.id}`}
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
