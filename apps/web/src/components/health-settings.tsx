'use client'

import Link from 'next/link'
import {
  Activity,
  ArrowRight,
  Bot,
  CalendarClock,
  Cable,
  CircleCheck,
  ClipboardCheck,
  HardDrive,
  Hourglass,
  Mail,
  OctagonAlert,
  PackageCheck,
  ShieldCheck,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react'
import { Badge, Button, SettingsSection, type BadgeProps } from '@braedonsaunders/appkit-ui'
import type { HealthCheck, HealthStatus } from '../lib/health'

/**
 * The one screen that answers "is anything wrong?".
 *
 * The answer has to survive a two-second glance, so severity is carried by the
 * layout rather than by a badge: a verdict banner states the count in words, a
 * fault gets a whole card with an accent edge and a way to go fix it, and the
 * things that are fine collapse into one quiet line each. An operator who sees
 * nothing but the quiet list has learned everything they came for.
 */

/** A fault is anything the operator still has to do something about. */
type Fault = HealthCheck & { status: Exclude<HealthStatus, 'ok'> }

const isFault = (check: HealthCheck): check is Fault => check.status !== 'ok'

/** The verdict banner speaks for the worst thing on the page, in its colour. */
const VERDICT: Record<HealthStatus, { Icon: LucideIcon; shell: string; medallion: string }> = {
  down: {
    Icon: OctagonAlert,
    shell: 'border-danger/30 bg-danger-subtle/50',
    medallion: 'bg-danger text-danger-fg',
  },
  warn: {
    Icon: TriangleAlert,
    shell: 'border-warning/30 bg-warning-subtle/50',
    medallion: 'bg-warning text-warning-fg',
  },
  ok: {
    Icon: ShieldCheck,
    shell: 'border-success/30 bg-success-subtle/50',
    medallion: 'bg-success text-success-fg',
  },
}

const FAULT: Record<Fault['status'], { label: string; badge: BadgeProps['variant']; card: string; chip: string }> = {
  down: {
    label: 'Broken',
    badge: 'destructive',
    card: 'border-danger/30 border-l-4 border-l-danger',
    chip: 'bg-danger-subtle text-danger',
  },
  warn: {
    label: 'Needs a look',
    badge: 'warning',
    card: 'border-warning/30 border-l-4 border-l-warning',
    chip: 'bg-warning-subtle text-warning',
  },
}

/**
 * A face for each thing that can break. The subject icon earns its place on
 * the fault card because severity is already told by the accent and the badge —
 * what an operator still needs at a glance is *which* system is down.
 */
const SUBJECT: Record<string, LucideIcon> = {
  'agent-protocol': Cable,
  release: PackageCheck,
  storage: HardDrive,
  mailboxes: Mail,
  'agent-work': Bot,
  scheduler: CalendarClock,
  stranded: Hourglass,
  approvals: ClipboardCheck,
}

/**
 * Checks that cover several offenders join them with a middle dot. One agent
 * per line is readable; four of them in a run-on sentence is not.
 */
function detailLines(detail: string): string[] {
  return detail.split(' · ').filter((line) => line.trim().length > 0)
}

function FaultCard({ check }: { check: Fault }) {
  const tone = FAULT[check.status]
  const Subject = SUBJECT[check.key] ?? Activity
  const lines = detailLines(check.detail)

  return (
    <article className={`rounded-lg border bg-surface p-4 shadow-sm ${tone.card}`}>
      <div className="flex items-start gap-3">
        <span className={`grid size-9 shrink-0 place-items-center rounded-md ${tone.chip}`}>
          <Subject className="size-5" aria-hidden />
        </span>
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h3 className="text-base font-semibold text-fg">{check.label}</h3>
            <Badge variant={tone.badge}>{tone.label}</Badge>
          </div>
          {lines.length > 1 ? (
            <ul className="space-y-1 text-sm text-fg-muted">
              {lines.map((line) => (
                <li key={line} className="flex gap-2">
                  <span className="select-none text-fg-subtle" aria-hidden>
                    •
                  </span>
                  <span className="min-w-0 break-words">{line}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm break-words text-fg-muted">{check.detail}</p>
          )}
          {check.href ? (
            <div className="pt-1">
              <Button asChild size="sm" variant="outline">
                <Link href={check.href}>
                  Open
                  <ArrowRight className="size-4" aria-hidden />
                </Link>
              </Button>
            </div>
          ) : null}
        </div>
      </div>
    </article>
  )
}

export function HealthSettings({ checks }: { checks: HealthCheck[] }) {
  const faults = checks.filter(isFault)
  const healthy = checks.filter((check) => check.status === 'ok')
  const down = faults.filter((check) => check.status === 'down').length
  const warn = faults.length - down
  // Reading the worst status rather than the first fault keeps a lone warning
  // from being dressed up in the same red as a dead file store.
  const worst: HealthStatus = down > 0 ? 'down' : warn > 0 ? 'warn' : 'ok'
  const tone = VERDICT[worst]
  const Verdict = tone.Icon

  const tally = [
    { key: 'down', count: down, label: 'broken', dot: 'bg-danger' },
    { key: 'warn', count: warn, label: 'needs a look', dot: 'bg-warning' },
    { key: 'ok', count: healthy.length, label: 'healthy', dot: 'bg-success' },
  ].filter((entry) => entry.count > 0)

  return (
    <SettingsSection
      title="Health"
      description="Everything your agents depend on, checked the moment this page loads."
    >
      <div className="space-y-6 p-5">
        <div className={`flex flex-wrap items-start gap-4 rounded-xl border p-5 ${tone.shell}`}>
          <span className={`grid size-11 shrink-0 place-items-center rounded-full ${tone.medallion}`}>
            <Verdict className="size-6" aria-hidden />
          </span>
          <div className="min-w-0 flex-1 space-y-1">
            <p className="text-lg leading-tight font-semibold text-fg">
              {faults.length === 0
                ? `All ${checks.length} checks are passing`
                : `${faults.length} of ${checks.length} checks need attention`}
            </p>
            <p className="text-sm text-fg-muted">
              {faults.length === 0
                ? 'Nothing your agents depend on is failing right now.'
                : 'Work stops quietly when these break, so this is the first place to look when an agent has gone silent.'}
            </p>
            {tally.length > 1 ? (
              <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 pt-1 text-xs text-fg-muted">
                {tally.map((entry) => (
                  <li key={entry.key} className="flex items-center gap-1.5">
                    <span className={`size-2 rounded-full ${entry.dot}`} aria-hidden />
                    <span className="tabular-nums">{entry.count}</span> {entry.label}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </div>

        {faults.length > 0 ? (
          <div className="space-y-3">
            {faults.map((check) => (
              <FaultCard key={check.key} check={check} />
            ))}
          </div>
        ) : null}

        {healthy.length > 0 ? (
          <div className="space-y-2">
            <h3 className="text-xs font-semibold tracking-wide text-fg-subtle uppercase">
              Healthy · {healthy.length}
            </h3>
            <ul className="divide-y divide-border-subtle overflow-hidden rounded-lg border border-border bg-bg-subtle/40">
              {healthy.map((check) => (
                <li key={check.key} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 px-4 py-2.5 text-sm">
                  <CircleCheck className="size-4 shrink-0 text-success" aria-hidden />
                  <span className="font-medium text-fg sm:w-40">{check.label}</span>
                  <span className="min-w-0 flex-1 text-fg-muted">{check.detail}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </SettingsSection>
  )
}
