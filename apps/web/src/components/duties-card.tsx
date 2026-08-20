'use client'

import * as React from 'react'
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Drawer,
  Input,
  Label,
  RecordList,
  type RecordColumn,
} from '@braedonsaunders/appkit-ui'
import { addDuty, deleteDuty, updateDuty } from '../app/organization/actions'
import { toLocalInput, type DutySchedule } from '../lib/schedule'
import { MarkdownEditor } from './markdown-editor'
import { ScheduleBuilder } from './schedule-builder'

export type DutyBounds = { endsAt: string; maxRuns: string }

export type DutyRow = {
  id: string
  title: string
  instruction: string
  scheduleKind: 'cron' | 'once'
  schedule: string
  scheduleHuman: string
  endsAt: string | null
  maxRuns: number | null
  enabled: 'on' | 'off'
  lastRunAt: string
}

const NEW_SCHEDULE: DutySchedule = { kind: 'cron', schedule: '0 8 * * 1-5' }
const NO_BOUNDS: DutyBounds = { endsAt: '', maxRuns: '' }

/**
 * The operator's own zone travels with the form: a recurring pattern is
 * resolved in it server-side, so "9am" means 9am where the operator is rather
 * than wherever the worker process happens to run.
 */
function applySchedule(form: FormData, schedule: DutySchedule, bounds: DutyBounds): void {
  form.set('scheduleKind', schedule.kind)
  form.set('schedule', schedule.schedule)
  form.set('timezone', Intl.DateTimeFormat().resolvedOptions().timeZone)
  form.set('endsAt', schedule.kind === 'once' ? '' : bounds.endsAt)
  form.set('maxRuns', schedule.kind === 'once' ? '' : bounds.maxRuns)
}

const COLUMNS: RecordColumn<DutyRow>[] = [
  { key: 'title', label: 'Duty', sortable: true },
  { key: 'scheduleHuman', label: 'Schedule' },
  {
    key: 'enabled',
    label: 'Status',
    kind: 'status',
    sortable: true,
    statusVariant: (value) => (value === 'on' ? 'default' : 'outline'),
  },
  { key: 'lastRunAt', label: 'Last run' },
]

export function DutiesCard({ personId, duties }: { personId: string; duties: DutyRow[] }) {
  const [selected, setSelected] = React.useState<DutyRow | null>(null)
  const [creating, setCreating] = React.useState(false)
  const [newSchedule, setNewSchedule] = React.useState<DutySchedule>(NEW_SCHEDULE)
  const [newBounds, setNewBounds] = React.useState<DutyBounds>(NO_BOUNDS)
  const [schedule, setSchedule] = React.useState<DutySchedule>(NEW_SCHEDULE)
  const [bounds, setBounds] = React.useState<DutyBounds>(NO_BOUNDS)
  const [enabled, setEnabled] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [saving, startSaving] = React.useTransition()

  const open = (duty: DutyRow) => {
    setSelected(duty)
    setSchedule({ kind: duty.scheduleKind, schedule: duty.schedule })
    setBounds({
      endsAt: duty.endsAt ? toLocalInput(new Date(duty.endsAt)) : '',
      maxRuns: duty.maxRuns === null ? '' : String(duty.maxRuns),
    })
    setEnabled(duty.enabled === 'on')
    setError(null)
  }

  const save = (form: FormData) =>
    startSaving(async () => {
      setError(null)
      form.set('personId', personId)
      form.set('dutyId', selected!.id)
      applySchedule(form, schedule, bounds)
      form.set('enabled', enabled ? 'on' : 'off')
      try {
        await updateDuty(form)
        setSelected(null)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    })

  return (
    <Card>
      <CardHeader>
        <CardTitle>Standing duties</CardTitle>
        <CardDescription>Work this agent initiates on schedule. Click a duty to adjust it.</CardDescription>
      </CardHeader>
      <CardContent>
        <RecordList
          columns={COLUMNS}
          rows={duties}
          getRowId={(row) => row.id}
          onRowClick={open}
          toolbarActions={
            <Button size="sm" variant="outline" onClick={() => setCreating(true)}>
              New duty
            </Button>
          }
          empty={{ title: 'No duties', description: 'This agent only reacts to inbound work. Add one to make it proactive.' }}
        />
        <Drawer
          open={creating}
          onClose={() => setCreating(false)}
          title="New duty"
          description="Standing work this agent initiates on schedule."
          size="md"
        >
          <form
            action={(form) =>
              startSaving(async () => {
                setError(null)
                form.set('personId', personId)
                applySchedule(form, newSchedule, newBounds)
                try {
                  await addDuty(form)
                  setCreating(false)
                  setNewSchedule(NEW_SCHEDULE)
                  setNewBounds(NO_BOUNDS)
                } catch (err) {
                  setError(err instanceof Error ? err.message : String(err))
                }
              })
            }
            className="space-y-4"
          >
            <div className="space-y-2">
              <Label htmlFor="new-duty-title">Title</Label>
              <Input id="new-duty-title" name="title" placeholder="Weekly vendor follow-up" required />
            </div>
            <div className="space-y-2">
              <Label htmlFor="new-duty-instruction">Instruction</Label>
              <MarkdownEditor name="instruction" placeholder="What to do, in the agent's own terms." />
            </div>
            <div className="space-y-2">
              <Label>Schedule</Label>
              <ScheduleBuilder
                value={newSchedule}
                onChange={setNewSchedule}
                idPrefix="new-duty"
                bounds={newBounds}
                onBoundsChange={setNewBounds}
              />
            </div>
            <Button type="submit" disabled={saving}>
              {saving ? 'Adding…' : 'Add duty'}
            </Button>
            {error ? <p className="text-sm text-danger">{error}</p> : null}
          </form>
        </Drawer>
        <Drawer
          open={selected !== null}
          onClose={() => setSelected(null)}
          title={selected ? `Duty — ${selected.title}` : ''}
          description={selected?.scheduleHuman}
          size="md"
        >
          {selected ? (
            <form action={save} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="duty-title">Title</Label>
                <Input id="duty-title" name="title" defaultValue={selected.title} required />
              </div>
              <div className="space-y-2">
                <Label htmlFor="duty-instruction">Instruction</Label>
                <MarkdownEditor name="instruction" defaultValue={selected.instruction} />
              </div>
              <div className="space-y-2">
                <Label>Schedule</Label>
                <ScheduleBuilder
                  key={selected.id}
                  value={{ kind: selected.scheduleKind, schedule: selected.schedule }}
                  onChange={setSchedule}
                  idPrefix="duty"
                  bounds={bounds}
                  onBoundsChange={setBounds}
                />
              </div>
              <div className="flex items-center justify-between rounded-md border border-border px-3 py-2">
                <div>
                  <p className="text-sm font-medium">{enabled ? 'Active' : 'Paused'}</p>
                  <p className="text-xs text-fg-muted">
                    {enabled ? 'Runs on schedule.' : 'Paused — keeps its configuration, does nothing.'}
                  </p>
                </div>
                <Button type="button" variant="outline" size="sm" onClick={() => setEnabled((v) => !v)}>
                  {enabled ? 'Pause' : 'Resume'}
                </Button>
              </div>
              <div className="flex items-center gap-3">
                <Button type="submit" disabled={saving}>
                  {saving ? 'Saving…' : 'Save duty'}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={saving}
                  onClick={() =>
                    startSaving(async () => {
                      const form = new FormData()
                      form.set('personId', personId)
                      form.set('dutyId', selected!.id)
                      try {
                        await deleteDuty(form)
                        setSelected(null)
                      } catch (err) {
                        setError(err instanceof Error ? err.message : String(err))
                      }
                    })
                  }
                >
                  Delete duty
                </Button>
                {selected.lastRunAt ? (
                  <Badge variant="outline">last ran {selected.lastRunAt}</Badge>
                ) : (
                  <Badge variant="outline">never run</Badge>
                )}
              </div>
              {error ? <p className="text-sm text-danger">{error}</p> : null}
            </form>
          ) : null}
        </Drawer>
      </CardContent>
    </Card>
  )
}
