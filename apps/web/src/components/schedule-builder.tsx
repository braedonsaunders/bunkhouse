'use client'

import * as React from 'react'
import { Input, Label, Select, Switch } from '@appkit/ui'
import { cronToHuman, cronToSpec, specToCron, type ScheduleSpec } from '../lib/schedule'

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/**
 * Structured schedule editing — operators pick frequency, days, and a time;
 * cron stays internal. The Advanced toggle exposes raw cron for the rare
 * schedule the builder can't express, with a live human-readable preview.
 */
export function ScheduleBuilder({
  value,
  onChange,
  idPrefix,
}: {
  value: string
  onChange: (cron: string) => void
  idPrefix: string
}) {
  const [spec, setSpec] = React.useState<ScheduleSpec>(() => cronToSpec(value))
  const [advanced, setAdvanced] = React.useState(spec.mode === 'custom')

  const apply = (next: ScheduleSpec) => {
    setSpec(next)
    onChange(specToCron(next))
  }

  const time = spec.mode === 'custom' ? null : { hour: spec.hour, minute: spec.minute }
  const setTime = (hour: number, minute: number) => {
    if (spec.mode === 'custom') return
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
                  if (mode === 'weekdays') apply({ mode, ...base })
                  else if (mode === 'daily') apply({ mode, ...base })
                  else if (mode === 'weekly') apply({ mode, days: [1], ...base })
                  else if (mode === 'monthly') apply({ mode, day: 1, ...base })
                }}
              >
                <option value="weekdays">Every weekday</option>
                <option value="daily">Every day</option>
                <option value="weekly">Weekly</option>
                <option value="monthly">Monthly</option>
              </Select>
            </div>
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
        <label className="flex items-center gap-2 pb-1 text-xs text-fg-muted">
          <Switch
            checked={advanced}
            onChange={(e) => {
              const checked = e.target.checked
              setAdvanced(checked)
              if (checked) apply({ mode: 'custom', cron: specToCron(spec) })
              else setSpec(cronToSpec(specToCron(spec)))
            }}
          />
          Advanced
        </label>
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
      <p className="text-xs text-fg-muted">{cronToHuman(specToCron(spec))}</p>
    </div>
  )
}
