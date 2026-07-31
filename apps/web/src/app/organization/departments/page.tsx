import { asc, eq } from 'drizzle-orm'
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  PageContainer,
  PageHeader,
  Select,
} from '@appkit/ui'
import { departments, people } from '../../../db/schema'
import { db } from '../../../db/client'
import { resolveTenantId } from '../../../lib/tenant'
import { wanderingEnabled } from '../../../lib/departments'
import { SCENE_KINDS, SCENE_LABELS } from '../../../components/scene-art'
import { BackdropStudio } from './backdrop-studio'
import {
  createDepartment,
  deleteDepartment,
  moveDepartment,
  renameDepartment,
  setWanderingEnabled,
} from '../department-actions'

export const dynamic = 'force-dynamic'

/**
 * The company's places.
 *
 * The floor used to be a wallpaper — six hardcoded rooms in a browser
 * preference, every agent drawn on all of them. This is where it becomes a
 * floor plan: the rooms are the company's, people belong to them, and the
 * switcher on the home screen moves between them.
 */
export default async function DepartmentsPage() {
  const tenantId = await resolveTenantId()
  const app = db()
  const [rows, staff, wander] = await Promise.all([
    app.withTenantContext(tenantId, () =>
      app.db.select().from(departments).orderBy(asc(departments.position), asc(departments.name)),
    ),
    app.withTenantContext(tenantId, () =>
      app.db
        .select({ id: people.id, name: people.name, departmentId: people.departmentId })
        .from(people)
        .where(eq(people.status, 'active')),
    ),
    wanderingEnabled(tenantId),
  ])

  const headcount = new Map<string, number>()
  for (const person of staff) {
    if (!person.departmentId) continue
    headcount.set(person.departmentId, (headcount.get(person.departmentId) ?? 0) + 1)
  }
  const deskless = staff.filter((person) => !person.departmentId).length
  const kinds = SCENE_KINDS.map((kind) => ({ value: kind, label: SCENE_LABELS[kind] }))

  return (
    <PageContainer className="space-y-6">
      <PageHeader
        title="Departments"
        description="The places your company has. Everyone works somewhere, and the floor on the home screen shows who is where."
      />

      <Card>
        <CardHeader>
          <CardTitle>Wandering</CardTitle>
          <CardDescription>
            With this on, people occasionally turn up in a department that is not their own — the way anybody drifts
            into someone else&apos;s doorway to ask a question. Nobody moves more than once every few minutes, and the
            same moment always looks the same to everyone.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form action={setWanderingEnabled} className="flex items-center gap-3">
            <label className="flex items-center gap-2 text-sm text-fg">
              <input type="checkbox" name="enabled" defaultChecked={wander} className="size-4 accent-[var(--color-primary)]" />
              Let people wander
            </label>
            <Button type="submit" size="sm" variant="outline">
              Save
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Add a department</CardTitle>
        </CardHeader>
        <CardContent>
          <form action={createDepartment} className="flex flex-wrap items-end gap-2">
            <label className="min-w-[220px] flex-1 space-y-1">
              <span className="text-xs text-fg-muted">Name</span>
              <Input name="name" placeholder="Workshop" maxLength={60} required />
            </label>
            <label className="space-y-1">
              <span className="text-xs text-fg-muted">Looks like</span>
              <Select name="sceneKind" defaultValue="office" className="w-44">
                {kinds.map((kind) => (
                  <option key={kind.value} value={kind.value}>
                    {kind.label}
                  </option>
                ))}
              </Select>
            </label>
            <Button type="submit">Add</Button>
          </form>
        </CardContent>
      </Card>

      {deskless > 0 ? (
        <p className="text-sm text-fg-muted">
          {deskless} {deskless === 1 ? 'person has' : 'people have'} no department yet, so they appear on every floor.
          Give them a desk from their record.
        </p>
      ) : null}

      <div className="space-y-4">
        {rows.map((row, index) => (
          <Card key={row.id}>
            <CardHeader>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <form action={renameDepartment} className="flex items-center gap-2">
                  <input type="hidden" name="id" value={row.id} />
                  <Input name="name" defaultValue={row.name} maxLength={60} className="w-56" />
                  <Button type="submit" size="sm" variant="outline">
                    Rename
                  </Button>
                </form>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-fg-muted">
                    {headcount.get(row.id) ?? 0} {(headcount.get(row.id) ?? 0) === 1 ? 'person' : 'people'}
                  </span>
                  <form action={moveDepartment}>
                    <input type="hidden" name="id" value={row.id} />
                    <input type="hidden" name="direction" value="up" />
                    <Button type="submit" size="sm" variant="ghost" disabled={index === 0} aria-label="Move up">
                      ↑
                    </Button>
                  </form>
                  <form action={moveDepartment}>
                    <input type="hidden" name="id" value={row.id} />
                    <input type="hidden" name="direction" value="down" />
                    <Button
                      type="submit"
                      size="sm"
                      variant="ghost"
                      disabled={index === rows.length - 1}
                      aria-label="Move down"
                    >
                      ↓
                    </Button>
                  </form>
                  <form action={deleteDepartment}>
                    <input type="hidden" name="id" value={row.id} />
                    <Button type="submit" size="sm" variant="ghost" className="text-danger">
                      Remove
                    </Button>
                  </form>
                </div>
              </div>
              <CardDescription>
                {row.backdropSvg
                  ? 'Drawn backdrop'
                  : `Built-in room — ${SCENE_LABELS[(row.sceneKind ?? 'office') as keyof typeof SCENE_LABELS] ?? row.sceneKind}`}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <BackdropStudio
                departmentId={row.id}
                currentSvg={row.backdropSvg}
                currentPrompt={row.backdropPrompt}
                sceneKinds={kinds}
              />
            </CardContent>
          </Card>
        ))}
      </div>
    </PageContainer>
  )
}
