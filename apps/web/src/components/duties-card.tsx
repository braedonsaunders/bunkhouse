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
  EmptyState,
  Input,
  Label,
  RecordList,
  Textarea,
  type RecordColumn,
} from '@appkit/ui'
import { updateDuty } from '../app/people/actions'
import { cronToHuman } from '../lib/schedule'
import { ScheduleBuilder } from './schedule-builder'

export type DutyRow = {
  id: string
  title: string
  instruction: string
  schedule: string
  scheduleHuman: string
  enabled: 'on' | 'off'
  lastRunAt: string
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
  const [schedule, setSchedule] = React.useState('')
  const [enabled, setEnabled] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [saving, startSaving] = React.useTransition()

  const open = (duty: DutyRow) => {
    setSelected(duty)
    setSchedule(duty.schedule)
    setEnabled(duty.enabled === 'on')
    setError(null)
  }

  const save = (form: FormData) =>
    startSaving(async () => {
      setError(null)
      form.set('personId', personId)
      form.set('dutyId', selected!.id)
      form.set('schedule', schedule)
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
        <CardDescription>Work this hand initiates on schedule. Click a duty to adjust it.</CardDescription>
      </CardHeader>
      <CardContent>
        {duties.length === 0 ? (
          <EmptyState title="No duties" description="This hand only reacts to inbound work." />
        ) : (
          <RecordList
            columns={COLUMNS}
            rows={duties}
            getRowId={(row) => row.id}
            onRowClick={open}
            empty={{ title: 'No duties' }}
          />
        )}
        <Drawer
          open={selected !== null}
          onClose={() => setSelected(null)}
          title={selected ? `Duty — ${selected.title}` : ''}
          description={selected ? cronToHuman(selected.schedule) : undefined}
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
                <Textarea id="duty-instruction" name="instruction" rows={5} defaultValue={selected.instruction} required />
              </div>
              <div className="space-y-2">
                <Label>Schedule</Label>
                <ScheduleBuilder value={selected.schedule} onChange={setSchedule} idPrefix="duty" />
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
