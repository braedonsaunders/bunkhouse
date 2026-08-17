'use client'

import * as React from 'react'
import { Input, Label, Select, Switch } from '@braedonsaunders/appkit-ui'
import {
  cronToHuman,
  scheduleToHuman,
  scheduleToSpec,
  specToCron,
  specToSchedule,
  toLocalInput,
  type DutySchedule,
  type ScheduleSpec,
} from '../lib/schedule'

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** An hour out, rounded to the next five minutes — a sane one-time default. */
function defaultOnce(): string {
  const at = new Date(Date.now() + 60 * 60_000)
  at.setMinutes(Math.ceil(at.getMinutes() / 5) * 5, 0, 0)
  return toLocalInput(at)
}

/**
 * Structured schedule editing — operators pick a frequency (or a single date
 * and time), days, and a time; cron stays internal. The Advanced toggle
 * exposes raw cron for the rare recurrence the builder can't express, with a
 * live human-readable preview.
 *
 * Bounds — end date and run limit — apply only to recurring schedules; a
 * one-time duty is already bounded by definition.
 */
export function ScheduleBuilder({
  value,
  onChange,
  idPrefix,
  bounds,
  onBoundsChange,
  allowOnce = true,
}: {
  value: DutySchedule
  onChange: (next: DutySchedule) => void
  idPrefix: string
  bounds?: { endsAt: string; maxRuns: string }
  onBoundsChange?: (next: { endsAt: string; maxRuns: string }) => void
  /** Off for role templates, where every duty is by nature standing. */
  allowOnce?: boolean
}) {
  const [spec, setSpec] = React.useState<ScheduleSpec>(() => scheduleToSpec(value))
  const [advanced, setAdvanced] = React.useState(spec.mode === 'custom')
  const [error, setError] = React.useState<string | null>(null)

  const apply = (next: ScheduleSpec) => {
    setSpec(next)
    try {
      onChange(specToSchedule(next))
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  // Formatted from the `datetime-local` wall clock rather than the stored
  // instant, so server and client render the same string before hydration.
  const preview =
    spec.mode === 'once' && spec.at
      ? scheduleToHuman({ kind: 'once', schedule: spec.at })
      : 'Pick a date and time.'

  const time = spec.mode === 'custom' || spec.mode === 'once' ? null : { hour: spec.hour, minute: spec.minute }
  const setTime = (hour: number, minute: number) => {
    if (spec.mode === 'custom' || spec.mode === 'once') return
    apply({ ...spec, hour, minute } as ScheduleSpec)
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        {!advanced ? (
          <>
            <div className="space-y-1">
              <Label htmlFor={`${idPrefix}-freq`}>Repeats</Label>
              <Select
                id={`${idPrefix}-freq`}
                value={spec.mode}
                onChange={(e) => {
                  const mode = e.target.value as ScheduleSpec['mode']
                  const base = time ?? { hour: 8, minute: 0 }
                  if (mode === 'once') apply({ mode, at: defaultOnce() })
                  else if (mode === 'weekdays') apply({ mode, ...base })
                  else if (mode === 'daily') apply({ mode, ...base })
                  else if (mode === 'weekly') apply({ mode, days: [1], ...base })
                  else if (mode === 'monthly') apply({ mode, day: 1, ...base })
                }}
              >
                {allowOnce ? <option value="once">Once, at a set time</option> : null}
                <option value="weekdays">Every weekday</option>
                <option value="daily">Every day</option>
                <option value="weekly">Weekly</option>
                <option value="monthly">Monthly</option>
              </Select>
            </div>
            {spec.mode === 'once' ? (
              <div className="space-y-1">
                <Label htmlFor={`${idPrefix}-at`}>On</Label>
                <Input
                  id={`${idPrefix}-at`}
                  type="datetime-local"
                  value={spec.at}
                  onChange={(e) => apply({ mode: 'once', at: e.target.value })}
                  className="w-56"
                />
              </div>
            ) : null}
            {spec.mode === 'monthly' ? (
              <div className="space-y-1">
                <Label htmlFor={`${idPrefix}-dom`}>Day of month</Label>
                <Input
                  id={`${idPrefix}-dom`}
                  type="number"
                  min={1}
                  max={28}
                  value={spec.day}
                  onChange={(e) => apply({ ...spec, day: Math.min(28, Math.max(1, Number(e.target.value) || 1)) })}
                  className="w-24"
                />
              </div>
            ) : null}
            {time ? (
              <div className="space-y-1">
                <Label htmlFor={`${idPrefix}-time`}>At</Label>
                <Input
                  id={`${idPrefix}-time`}
                  type="time"
                  value={`${String(time.hour).padStart(2, '0')}:${String(time.minute).padStart(2, '0')}`}
                  onChange={(e) => {
                    const [h, m] = e.target.value.split(':').map(Number)
                    if (Number.isInteger(h) && Number.isInteger(m)) setTime(h!, m!)
                  }}
                  className="w-32"
                />
              </div>
            ) : null}
          </>
        ) : (
          <div className="space-y-1">
            <Label htmlFor={`${idPrefix}-cron`}>Cron expression (advanced)</Label>
            <Input
              id={`${idPrefix}-cron`}
              value={spec.mode === 'custom' ? spec.cron : specToCron(spec)}
              onChange={(e) => apply({ mode: 'custom', cron: e.target.value })}
              className="w-56 font-mono"
            />
          </div>
        )}
        {/* Cron has no way to express a single instant, so the advanced escape
            hatch only applies to recurring schedules. */}
        {spec.mode !== 'once' ? (
          <label className="flex items-center gap-2 pb-1 text-xs text-fg-muted">
            <Switch
              checked={advanced}
              onChange={(e) => {
                const checked = e.target.checked
                setAdvanced(checked)
                const cron = specToCron(spec)
                if (checked) apply({ mode: 'custom', cron })
                else apply(scheduleToSpec({ kind: 'cron', schedule: cron }))
              }}
            />
            Advanced
          </label>
        ) : null}
      </div>
      {spec.mode === 'weekly' ? (
        <div className="flex flex-wrap gap-1">
          {DAY_LABELS.map((label, day) => {
            const on = spec.days.includes(day)
            return (
              <button
                key={label}
                type="button"
                onClick={() => {
                  const days = on ? spec.days.filter((d) => d !== day) : [...spec.days, day]
                  apply({ ...spec, days: days.length ? days : [day] })
                }}
                className={
                  on
                    ? 'rounded-md border border-primary bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary'
                    : 'rounded-md border border-border px-2.5 py-1 text-xs text-fg-muted transition-colors hover:border-primary/50'
                }
              >
                {label}
              </button>
            )
          })}
        </div>
      ) : null}
      {/* Bounds are only meaningful for a recurrence — a one-time duty already
          stops after its single run. */}
      {bounds && onBoundsChange && spec.mode !== 'once' ? (
        <div className="flex flex-wrap items-end gap-3 border-t border-border pt-3">
          <div className="space-y-1">
            <Label htmlFor={`${idPrefix}-ends`}>Until (optional)</Label>
            <Input
              id={`${idPrefix}-ends`}
              type="datetime-local"
              value={bounds.endsAt}
              onChange={(e) => onBoundsChange({ ...bounds, endsAt: e.target.value })}
              className="w-56"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`${idPrefix}-max`}>Stop after (optional)</Label>
            <Input
              id={`${idPrefix}-max`}
              type="number"
              min={1}
              placeholder="runs"
              value={bounds.maxRuns}
              onChange={(e) => onBoundsChange({ ...bounds, maxRuns: e.target.value })}
              className="w-32"
            />
          </div>
        </div>
      ) : null}
      <p className="text-xs text-fg-muted">
        {spec.mode === 'once' ? preview : cronToHuman(specToCron(spec))}
      </p>
      {error ? <p className="text-xs text-danger">{error}</p> : null}
    </div>
  )
}
