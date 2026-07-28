import { notFound } from 'next/navigation'
import { asc, eq } from 'drizzle-orm'
import {
  Avatar,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  DetailHeader,
  EmptyState,
  Input,
  PageContainer,
  Select,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
} from '@appkit/ui'
import { autonomySettings, duties, memories, people } from '../../../db/schema'
import { db } from '../../../db/client'
import { resolveTenantId } from '../../../lib/tenant'
import { addMemoryNote, deleteMemoryNote, setAutonomy } from '../actions'
import { MailboxSection } from './mailbox-section'

const AUTONOMY_LEVELS = ['forbidden', 'approval', 'notify', 'trusted'] as const

export const dynamic = 'force-dynamic'

const CATEGORY_LABELS: Record<string, string> = {
  external_email: 'External email',
  internal_email: 'Internal email',
  record_write: 'Record changes',
  money_adjacent: 'Money-adjacent',
  file_write: 'File writes',
  computer_use: 'Computer use',
  shell: 'Terminal / shell',
}

const LEVEL_BADGES: Record<string, 'default' | 'secondary' | 'outline' | 'destructive'> = {
  trusted: 'default',
  notify: 'secondary',
  approval: 'outline',
  forbidden: 'destructive',
}

export default async function PersonPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const tenantId = await resolveTenantId()
  const app = db()

  const data = await app.withTenantContext(tenantId, async () => {
    const [person] = await app.db.select().from(people).where(eq(people.id, id))
    if (!person) return null
    const [manager] = person.reportsToId
      ? await app.db
          .select({ id: people.id, name: people.name, title: people.title })
          .from(people)
          .where(eq(people.id, person.reportsToId))
      : []
    const personDuties = await app.db
      .select()
      .from(duties)
      .where(eq(duties.personId, person.id))
      .orderBy(asc(duties.title))
    const dial = await app.db
      .select()
      .from(autonomySettings)
      .where(eq(autonomySettings.personId, person.id))
    const notes = await app.db
      .select()
      .from(memories)
      .where(eq(memories.personId, person.id))
      .orderBy(asc(memories.createdAt))
    return { person, manager: manager ?? null, personDuties, dial, notes }
  })

  if (!data) notFound()
  const { person, manager, personDuties, dial, notes } = data
  const isHand = person.kind === 'hand'

  return (
    <PageContainer className="space-y-6">
      <DetailHeader
        back={{ href: '/people', label: 'Directory' }}
        title={person.name}
        subtitle={`${person.title}${manager ? ` · reports to ${manager.name}` : ''}`}
        badge={
          <span className="flex items-center gap-2">
            <Badge variant={isHand ? 'default' : 'secondary'}>{isHand ? 'Hand' : 'Human'}</Badge>
            <Badge variant={person.status === 'active' ? 'default' : 'outline'}>{person.status}</Badge>
          </span>
        }
        actions={<Avatar name={person.name} size={44} />}
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>About</CardTitle>
            <CardDescription>{person.email}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {person.personality ? (
              <>
                <p>{person.personality.bio}</p>
                <p className="text-fg-muted">Tone: {person.personality.tone.join(', ')}</p>
              </>
            ) : (
              <p className="text-fg-muted">{person.responsibilities ?? 'No profile notes yet.'}</p>
            )}
          </CardContent>
        </Card>

        {isHand ? (
          <Card>
            <CardHeader>
              <CardTitle>Employment</CardTitle>
              <CardDescription>Salary is the monthly model-token budget.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <p>
                Role pack: <span className="font-medium">{person.rolePackSlug ?? '—'}</span>
              </p>
              <p>
                Salary:{' '}
                <span className="font-medium">
                  {person.salary ? `$${person.salary.monthlyUsd}/mo · overage: ${person.salary.overagePolicy}` : '—'}
                </span>
              </p>
              <p>
                Proactivity: <span className="font-medium">{person.proactivity ?? '—'}</span>
              </p>
              <p>
                Model:{' '}
                <span className="font-medium">
                  {person.modelConfig ? `${person.modelConfig.provider} / ${person.modelConfig.model}` : 'not assigned yet'}
                </span>
              </p>
              <p>
                Started: <span className="font-medium">{person.startedOn ?? '—'}</span>
              </p>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardHeader>
              <CardTitle>Responsibilities</CardTitle>
              <CardDescription>What hands route to this person.</CardDescription>
            </CardHeader>
            <CardContent className="text-sm">
              <p>{person.responsibilities ?? 'Not recorded yet — hands can only route well if this is filled in.'}</p>
            </CardContent>
          </Card>
        )}
      </div>

      {isHand ? (
        <>
          <MailboxSection tenantId={tenantId} personId={person.id} />
          <Card>
            <CardHeader>
              <CardTitle>Autonomy dial</CardTitle>
              <CardDescription>Enforced by the runtime, per action category.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
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

          <Card>
            <CardHeader>
              <CardTitle>Standing duties</CardTitle>
              <CardDescription>Work this hand initiates on schedule.</CardDescription>
            </CardHeader>
            <CardContent>
              {personDuties.length === 0 ? (
                <EmptyState title="No duties" description="This hand only reacts to inbound work." />
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Duty</TableHead>
                      <TableHead>Schedule</TableHead>
                      <TableHead>Enabled</TableHead>
                      <TableHead>Last run</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {personDuties.map((duty) => (
                      <TableRow key={duty.id}>
                        <TableCell className="font-medium">{duty.title}</TableCell>
                        <TableCell className="text-fg-muted">{duty.schedule}</TableCell>
                        <TableCell>
                          <Badge variant={duty.enabled === 'on' ? 'default' : 'outline'}>{duty.enabled}</Badge>
                        </TableCell>
                        <TableCell className="text-fg-muted">
                          {duty.lastRunAt ? duty.lastRunAt.toISOString().slice(0, 16).replace('T', ' ') : 'never'}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Memory</CardTitle>
              <CardDescription>Human-readable notes — open, correct, or delete anything.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {notes.length === 0 ? (
                <EmptyState title="Nothing remembered yet" description="Notes appear here as this hand works." />
              ) : (
                notes.map((note) => (
                  <div key={note.id} className="flex items-start justify-between gap-3 rounded-md border border-border p-3">
                    <div>
                      <p className="text-sm font-medium">{note.title}</p>
                      <p className="text-sm text-fg-muted">{note.body}</p>
                    </div>
                    <form action={deleteMemoryNote}>
                      <input type="hidden" name="personId" value={person.id} />
                      <input type="hidden" name="memoryId" value={note.id} />
                      <Button type="submit" variant="outline" size="sm">
                        Forget
                      </Button>
                    </form>
                  </div>
                ))
              )}
              <form action={addMemoryNote} className="space-y-2 rounded-md border border-dashed border-border p-3">
                <input type="hidden" name="personId" value={person.id} />
                <Input name="title" placeholder="Note title (e.g. Preferred vendor for tires)" required />
                <Textarea name="body" rows={2} placeholder="Something this hand should always know." required />
                <Button type="submit" variant="outline" size="sm">
                  Add to memory
                </Button>
              </form>
            </CardContent>
          </Card>
        </>
      ) : null}
    </PageContainer>
  )
}
