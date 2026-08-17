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
  Input,
  Label,
  Progress,
  Select,
} from '@braedonsaunders/appkit-ui'
import { setAgentCallMinutes } from '../app/organization/actions'

/**
 * Call minutes, on the agent's Payroll section. Money is the primary budget;
 * minutes are the second line, because a phone line costs by the minute
 * whatever the model spent. An agent that reaches its ceiling stops answering
 * and placing calls for the rest of the month — inbound callers are offered a
 * voicemail instead, and the message still reaches the agent by email.
 */

export type CallBudgetView = {
  personId: string
  /** First name is enough here; the card sits on that person's record. */
  personName: string
  /** The monthly ceiling in minutes, or null when the agent has none. */
  limitMinutes: number | null
  /** Minutes used since the month began. */
  usedMinutes: number
}

const roundMinutes = (minutes: number): string =>
  minutes >= 10 ? String(Math.round(minutes)) : minutes.toFixed(1).replace(/\.0$/, '')

export function CallBudgetCard({ budget }: { budget: CallBudgetView }) {
  const [capped, setCapped] = React.useState(budget.limitMinutes !== null)
  const [limit, setLimit] = React.useState(String(budget.limitMinutes ?? 300))
  const [notice, setNotice] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [saving, startSaving] = React.useTransition()

  const first = budget.personName.split(' ')[0] ?? budget.personName
  const used = budget.usedMinutes
  const ceiling = budget.limitMinutes
  const remaining = ceiling === null ? null : Math.max(0, ceiling - used)
  const exhausted = ceiling !== null && used >= ceiling

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between gap-2">
          <span>Call minutes</span>
          {ceiling === null ? (
            <Badge variant="outline">no ceiling</Badge>
          ) : exhausted ? (
            <Badge variant="destructive">used up</Badge>
          ) : (
            <Badge variant="secondary">{roundMinutes(remaining ?? 0)} left</Badge>
          )}
        </CardTitle>
        <CardDescription>
          {ceiling === null
            ? `This month's time on calls. ${first} has no minute ceiling — call time is limited by the salary budget alone.`
            : exhausted
              ? `${first} has used this month's call minutes and will not take or place calls until next month. Callers are answered and their messages are emailed through.`
              : `This month's time on calls against ${first}'s monthly ceiling.`}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <div className="space-y-1">
          <p className="tabular-nums">
            <span className="text-2xl font-semibold">{roundMinutes(used)}</span>
            <span className="text-fg-muted">
              {ceiling === null ? ' minutes this month' : ` of ${ceiling} minutes/mo`}
            </span>
          </p>
          <Progress value={ceiling ? Math.min(100, (used / ceiling) * 100) : 0} />
        </div>

        <div className="grid gap-3 sm:grid-cols-[12rem_1fr]">
          <div className="space-y-1">
            <Label htmlFor="call-minutes-mode">Monthly ceiling</Label>
            <Select
              id="call-minutes-mode"
              value={capped ? 'on' : 'off'}
              onChange={(event) => {
                setCapped(event.target.value === 'on')
                setNotice(null)
              }}
            >
              <option value="off">No ceiling</option>
              <option value="on">Cap call minutes</option>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="call-minutes-limit">Minutes a month</Label>
            <Input
              id="call-minutes-limit"
              type="number"
              min={1}
              step={10}
              value={limit}
              disabled={!capped}
              onChange={(event) => {
                setLimit(event.target.value)
                setNotice(null)
              }}
            />
          </div>
        </div>
        <p className="text-xs text-fg-muted">
          Minutes reset at the start of each calendar month. What those minutes cost is set once for the company under
          Settings → Voice.
        </p>

        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            disabled={saving}
            onClick={() =>
              startSaving(async () => {
                setError(null)
                setNotice(null)
                const result = await setAgentCallMinutes({
                  personId: budget.personId,
                  monthlyCallMinutes: capped ? Number(limit) : null,
                })
                if (!result.ok) setError(result.message)
                else {
                  setNotice(
                    capped ? `Saved — ${first} may spend ${limit} minutes a month on calls.` : 'Saved — no ceiling.',
                  )
                }
              })
            }
          >
            {saving ? 'Saving…' : 'Save ceiling'}
          </Button>
          {notice ? <p className="text-sm text-fg-muted">{notice}</p> : null}
          {error ? <p className="text-sm text-danger">{error}</p> : null}
        </div>
      </CardContent>
    </Card>
  )
}
