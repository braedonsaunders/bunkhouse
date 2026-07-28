import { notFound } from 'next/navigation'
import { and, asc, eq } from 'drizzle-orm'
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
import { desc, sql } from 'drizzle-orm'
import Link from 'next/link'
import { Progress } from '@appkit/ui'
import { autonomySettings, duties, memories, people, runs, tokenSpend } from '../../../db/schema'
import { db } from '../../../db/client'
import { resolveTenantId } from '../../../lib/tenant'
import { listAiProviders } from '../../../lib/ai'
import { AssignModelForm } from '../../../components/assign-model-form'
import { DutiesCard } from '../../../components/duties-card'
import { AvatarStudio } from '../../../components/avatar-studio'
import { avatarImages } from '../../../db/schema'
import { getImageProviderSetting } from '../../../lib/avatars'
import { cronToHuman } from '../../../lib/schedule'
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
    const monthStart = new Date()
    monthStart.setUTCDate(1)
    monthStart.setUTCHours(0, 0, 0, 0)
    const [spend] = await app.db
      .select({ cost: sql<string>`coalesce(sum(${tokenSpend.costUsd}), 0)` })
      .from(tokenSpend)
      .where(and(eq(tokenSpend.personId, person.id), sql`${tokenSpend.createdAt} >= ${monthStart}`))
    const recentRuns = await app.db
      .select({ id: runs.id, status: runs.status, summary: runs.summary, startedAt: runs.startedAt })
      .from(runs)
      .where(eq(runs.personId, person.id))
      .orderBy(desc(runs.startedAt))
      .limit(6)
    const [avatar] = await app.db
      .select({ id: avatarImages.id })
      .from(avatarImages)
      .where(eq(avatarImages.personId, person.id))
    return { person, manager: manager ?? null, personDuties, dial, notes, monthSpend: Number(spend?.cost ?? 0), recentRuns, hasAvatar: !!avatar }
  })

  if (!data) notFound()
  const { person, manager, personDuties, dial, notes, monthSpend, recentRuns, hasAvatar } = data
  const isHand = person.kind === 'hand'
  const providers = isHand ? await listAiProviders(tenantId) : []
  const imageSetting = isHand ? await getImageProviderSetting(tenantId) : null

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
        actions={
          isHand ? (
            <AvatarStudio personId={person.id} name={person.name} hasAvatar={hasAvatar} model={imageSetting?.model ?? 'unconfigured'} />
          ) : (
            <Avatar name={person.name} size={44} />
          )
        }
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
              <div className="space-y-1">
                <p>
                  Model:{' '}
                  <span className="font-medium">
                    {person.modelConfig ? `${person.modelConfig.provider} / ${person.modelConfig.model}` : 'not assigned yet'}
                  </span>
                </p>
                {providers.length === 0 ? (
                  <p className="text-xs text-fg-muted">Add a model provider in Settings to assign a brain.</p>
                ) : (
                  <AssignModelForm
                    personId={person.id}
                    providers={providers.map((p) => ({ slug: p.slug, label: p.label }))}
                    {...(person.modelConfig ? { currentProvider: person.modelConfig.provider, currentModel: person.modelConfig.model } : {})}
                  />
                )}
              </div>
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
              <CardTitle>Payroll & work</CardTitle>
              <CardDescription>This month's model spend against salary, and recent runs.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4 text-sm">
              <div className="space-y-1">
                <p className="tabular-nums">
                  <span className="text-2xl font-semibold">${monthSpend.toFixed(2)}</span>
                  <span className="text-fg-muted"> of ${person.salary?.monthlyUsd ?? 0}/mo</span>
                </p>
                <Progress value={person.salary?.monthlyUsd ? Math.min(100, (monthSpend / person.salary.monthlyUsd) * 100) : 0} />
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
                      <Badge variant={run.status === 'completed' ? 'default' : run.status === 'failed' ? 'destructive' : 'outline'}>
                        {run.status.replace('_', ' ')}
                      </Badge>
                    </Link>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
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

          <DutiesCard
            personId={person.id}
            duties={personDuties.map((duty) => ({
              id: duty.id,
              title: duty.title,
              instruction: duty.instruction,
              schedule: duty.schedule,
              scheduleHuman: cronToHuman(duty.schedule),
              enabled: duty.enabled,
              lastRunAt: duty.lastRunAt ? duty.lastRunAt.toISOString().slice(0, 16).replace('T', ' ') : '',
            }))}
          />

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
