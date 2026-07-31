'use client'

import * as React from 'react'
import {
  Alert,
  Button,
  Drawer,
  EmptyState,
  Input,
  Label,
  PagedTable,
  Select,
  Spinner,
  Switch,
  Textarea,
  type PagedColumn,
} from '@appkit/ui'
import { DoorOpen } from 'lucide-react'
import { BackdropStudio } from './backdrop-studio'
import {
  createDepartment,
  draftBackdrop,
  deleteDepartment,
  moveDepartment,
  renameDepartment,
  setWanderingEnabled,
} from '../app/organization/department-actions'

export type DepartmentRow = {
  id: string
  name: string
  sceneKind: string | null
  backdropSvg: string | null
  backdropPrompt: string | null
  headcount: number
}

/**
 * The company's places, as a list of records.
 *
 * The first version stacked a Card per department — the rename field, the
 * reorder buttons, the remove button and the entire backdrop studio, all open
 * at once, six times down the page. That is not a list, it is six forms
 * pretending to be one, and the preview it offered was too small and too
 * crowded to judge a picture by.
 *
 * Records belong in the table this app already uses everywhere. Editing one
 * opens a drawer, which is where the detail goes and where a backdrop can be
 * shown big enough to be worth looking at.
 */
export function DepartmentsSettings({
  departments,
  deskless,
  wander,
  sceneKinds,
}: {
  departments: DepartmentRow[]
  deskless: number
  wander: boolean
  sceneKinds: { value: string; label: string }[]
}) {
  const [editing, setEditing] = React.useState<DepartmentRow | null>(null)
  const [creating, setCreating] = React.useState(false)
  const labelOf = React.useMemo(
    () => Object.fromEntries(sceneKinds.map((kind) => [kind.value, kind.label])) as Record<string, string>,
    [sceneKinds],
  )

  const columns: PagedColumn<DepartmentRow>[] = [
    {
      key: 'name',
      header: 'Department',
      cell: (row) => <span className="font-medium text-fg">{row.name}</span>,
      search: (row) => row.name,
      sortValue: (row) => row.name.toLowerCase(),
    },
    {
      key: 'look',
      header: 'Backdrop',
      // The drawn backdrop gets a thumbnail; a built-in room gets its name.
      //
      // NOT the scene art itself: those components position their contents
      // absolutely and expect a full-size stage, so at 56x32 they escape the
      // cell and paint over the entire page. Seen, not guessed. The built-in
      // rooms are shown properly in the drawer, where there is a frame the
      // right shape to hold them.
      cell: (row) =>
        row.backdropSvg ? (
          <span className="flex items-center gap-2">
            <span
              className="h-8 w-14 shrink-0 overflow-hidden rounded border border-border [&>svg]:h-full [&>svg]:w-full"
              dangerouslySetInnerHTML={{ __html: row.backdropSvg }}
            />
            <span className="text-fg-muted">Drawn</span>
          </span>
        ) : (
          <span className="text-fg-muted">{labelOf[row.sceneKind ?? 'office'] ?? row.sceneKind}</span>
        ),
      search: (row) => (row.backdropSvg ? 'drawn' : (labelOf[row.sceneKind ?? ''] ?? '')),
    },
    {
      key: 'headcount',
      header: 'People',
      align: 'right',
      cell: (row) => <span className="tabular-nums text-fg-muted">{row.headcount}</span>,
      sortValue: (row) => row.headcount,
    },
    {
      key: 'order',
      header: '',
      align: 'right',
      cell: (row) => (
        // Reordering is a row action, so it must not also open the drawer.
        <span className="flex items-center justify-end gap-1" onClick={(event) => event.stopPropagation()}>
          <form action={moveDepartment}>
            <input type="hidden" name="id" value={row.id} />
            <input type="hidden" name="direction" value="up" />
            <Button type="submit" size="sm" variant="ghost" aria-label={`Move ${row.name} up`}>
              ↑
            </Button>
          </form>
          <form action={moveDepartment}>
            <input type="hidden" name="id" value={row.id} />
            <input type="hidden" name="direction" value="down" />
            <Button type="submit" size="sm" variant="ghost" aria-label={`Move ${row.name} down`}>
              ↓
            </Button>
          </form>
        </span>
      ),
    },
  ]

  return (
    // The same inset every other settings section uses; without it the
    // toolbar sits flush against the panel edge.
    <div className="space-y-4 px-5 py-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <form action={setWanderingEnabled} className="flex items-center gap-3">
          <Switch name="enabled" defaultChecked={wander} />
          <span className="text-sm text-fg">
            Let people wander
            <span className="ml-2 text-fg-muted">— they turn up in someone else&apos;s department now and then.</span>
          </span>
          <Button type="submit" size="sm" variant="outline">
            Save
          </Button>
        </form>
        <Button type="button" onClick={() => setCreating(true)}>
          Add department
        </Button>
      </div>

      {deskless > 0 ? (
        <p className="text-sm text-fg-muted">
          {deskless} {deskless === 1 ? 'person has' : 'people have'} no department, so they appear on every floor. Give
          them a desk from their record.
        </p>
      ) : null}

      <PagedTable
        columns={columns}
        rows={departments}
        rowKey={(row) => row.id}
        pageSize={10}
        searchable
        onRowClick={(row) => setEditing(row)}
        labels={{ searchPlaceholder: 'Search departments…', searchLabel: 'Search departments' }}
        empty={
          <EmptyState
            icon={<DoorOpen />}
            title="No departments yet"
            description="Add the places your company has — the floor on the home screen shows who is in each of them."
            action={<Button onClick={() => setCreating(true)}>Add department</Button>}
          />
        }
      />

      <CreateDepartmentDrawer open={creating} onClose={() => setCreating(false)} sceneKinds={sceneKinds} />
      <EditDepartmentDrawer
        department={editing}
        onClose={() => setEditing(null)}
        sceneKinds={sceneKinds}
        labelOf={labelOf}
      />
    </div>
  )
}

/**
 * A new department, with its backdrop chosen at the same time.
 *
 * Making somebody create a department, reopen it and only then describe the
 * room was a two-step where one would do — and it read as though drawing were
 * an afterthought rather than the point.
 *
 * The draw call is invoked directly rather than through a nested form, because
 * a form inside a form is not a thing: the create form owns the submit, and the
 * drawing arrives as state that rides along in a hidden field.
 */
function CreateDepartmentDrawer({
  open,
  onClose,
  sceneKinds,
}: {
  open: boolean
  onClose: () => void
  sceneKinds: { value: string; label: string }[]
}) {
  const [mode, setMode] = React.useState<'builtin' | 'drawn'>('builtin')
  const [description, setDescription] = React.useState('')
  const [theme, setTheme] = React.useState('dark')
  const [draft, setDraft] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [drawing, startDrawing] = React.useTransition()

  const reset = () => {
    setMode('builtin')
    setDescription('')
    setDraft(null)
    setError(null)
  }

  const drawIt = () => {
    setError(null)
    startDrawing(async () => {
      const payload = new FormData()
      payload.set('description', description)
      payload.set('theme', theme)
      const result = await draftBackdrop(null, payload)
      if (result.error) setError(result.error)
      setDraft(result.svg ?? null)
    })
  }

  return (
    <Drawer
      open={open}
      onClose={() => {
        reset()
        onClose()
      }}
      title="Add a department"
      description="A place in the company. Use one of the built-in rooms, or describe one and have it drawn."
      size="lg"
    >
      <form
        action={createDepartment}
        className="space-y-5"
        onSubmit={() => {
          onClose()
          reset()
        }}
      >
        <div>
          <Label htmlFor="dept-name">Name</Label>
          <Input id="dept-name" name="name" placeholder="Workshop" maxLength={60} required autoFocus />
        </div>

        <div className="space-y-3">
          <Label>Backdrop</Label>
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              variant={mode === 'builtin' ? 'default' : 'outline'}
              onClick={() => setMode('builtin')}
            >
              Use a built-in room
            </Button>
            <Button
              type="button"
              size="sm"
              variant={mode === 'drawn' ? 'default' : 'outline'}
              onClick={() => setMode('drawn')}
            >
              Draw one
            </Button>
          </div>

          {mode === 'builtin' ? (
            <Select name="sceneKind" defaultValue="office" aria-label="Built-in room">
              {sceneKinds.map((kind) => (
                <option key={kind.value} value={kind.value}>
                  {kind.label}
                </option>
              ))}
            </Select>
          ) : (
            <div className="space-y-3">
              <div className="relative aspect-[16/9] w-full overflow-hidden rounded-xl border border-border bg-canvas">
                {draft ? (
                  <div
                    className="h-full w-full [&>svg]:h-full [&>svg]:w-full"
                    dangerouslySetInnerHTML={{ __html: draft }}
                  />
                ) : (
                  <div className="flex h-full w-full items-center justify-center px-6 text-center text-sm text-fg-muted">
                    Describe the room below and it will be drawn here.
                  </div>
                )}
                {drawing ? (
                  <div className="absolute inset-0 flex items-center justify-center gap-3 bg-canvas/70 backdrop-blur-sm">
                    <Spinner />
                    <span className="text-sm text-fg">Drawing the room…</span>
                  </div>
                ) : null}
              </div>

              {error ? <Alert variant="destructive">{error}</Alert> : null}

              <Textarea
                aria-label="Describe the room"
                rows={2}
                maxLength={400}
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="a warm workshop with a pegboard of tools, a roller door and a workbench"
              />
              <div className="flex flex-wrap items-end gap-2">
                <Select
                  value={theme}
                  onChange={(event) => setTheme(event.target.value)}
                  aria-label="Light"
                  className="w-32"
                >
                  <option value="dark">Dim</option>
                  <option value="light">Bright</option>
                </Select>
                <Button type="button" variant="outline" onClick={drawIt} disabled={drawing || description.trim().length < 3}>
                  {drawing ? 'Drawing…' : draft ? 'Draw another' : 'Draw it'}
                </Button>
              </div>

              {/* The drawing rides along with the create submit. */}
              {draft ? <input type="hidden" name="backdropSvg" value={draft} /> : null}
              <input type="hidden" name="backdropPrompt" value={description} />
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-border pt-4">
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              reset()
              onClose()
            }}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={mode === 'drawn' && !draft}>
            Add department
          </Button>
        </div>
      </form>
    </Drawer>
  )
}

/** One department, with room to actually judge its backdrop. */
function EditDepartmentDrawer({
  department,
  onClose,
  sceneKinds,
  labelOf,
}: {
  department: DepartmentRow | null
  onClose: () => void
  sceneKinds: { value: string; label: string }[]
  labelOf: Record<string, string>
}) {
  return (
    <Drawer
      open={department !== null}
      onClose={onClose}
      title={department?.name ?? 'Department'}
      description={
        department
          ? department.backdropSvg
            ? 'Drawn backdrop'
            : `Built-in room — ${labelOf[department.sceneKind ?? 'office'] ?? department.sceneKind}`
          : ''
      }
      size="xl"
    >
      {department ? (
        <div className="space-y-6">
          <form action={renameDepartment} className="flex items-end gap-2">
            <div className="flex-1">
              <Label htmlFor="dept-rename">Name</Label>
              <input type="hidden" name="id" value={department.id} />
              <Input id="dept-rename" name="name" defaultValue={department.name} maxLength={60} />
            </div>
            <Button type="submit" variant="outline">
              Rename
            </Button>
          </form>

          {/* Keyed by department so opening a different one does not inherit
              the last one's draft preview. */}
          <BackdropStudio
            key={department.id}
            departmentId={department.id}
            currentSvg={department.backdropSvg}
            currentPrompt={department.backdropPrompt}
            sceneKind={department.sceneKind}
            sceneKinds={sceneKinds}
          />

          <div className="flex items-center justify-between border-t border-border pt-4">
            <span className="text-sm text-fg-muted">
              {department.headcount === 0
                ? 'Nobody works here yet.'
                : `${department.headcount} ${department.headcount === 1 ? 'person works' : 'people work'} here.`}
            </span>
            <form action={deleteDepartment} onSubmit={() => onClose()}>
              <input type="hidden" name="id" value={department.id} />
              <Button type="submit" variant="outline" className="text-danger">
                Remove department
              </Button>
            </form>
          </div>
        </div>
      ) : null}
    </Drawer>
  )
}
