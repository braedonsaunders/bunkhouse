'use client'

import * as React from 'react'
import Link from 'next/link'
import {
  Badge,
  Button,
  Drawer,
  EmptyState,
  Label,
  PagedTable,
  Textarea,
  type PagedColumn,
} from '@appkit/ui'
import { approveAction, rejectAction } from '../app/approvals/actions'
import { SectionTabs, type SectionTabItem } from './section-tabs'

/**
 * The exact wording an approver signed off on: the queued action's own
 * arguments, extracted on the server so this stays a dumb renderer.
 */
export type ApprovalDraft = { fields: { label: string; value: string }[]; text: string | null }

export type ApprovalRow = {
  id: string
  runId: string
  personId: string
  personName: string
  personTitle: string
  /** Enum value as stored, e.g. `external_email`. */
  category: string
  /** The same value in prose, for the badge and for search. */
  categoryLabel: string
  description: string
  draft: ApprovalDraft
  createdAt: string
  status: 'pending' | 'approved' | 'rejected' | 'expired'
  decidedAt: string | null
  decisionNote: string | null
}

const DECISION_VARIANT = {
  approved: 'default',
  rejected: 'destructive',
  expired: 'outline',
  pending: 'secondary',
} as const

const AGENT_COLUMN: PagedColumn<ApprovalRow> = {
  key: 'personName',
  header: 'Agent',
  cell: (row) => (
    <span className="min-w-0">
      <span className="block truncate font-medium text-primary">{row.personName}</span>
      <span className="block truncate text-xs text-fg-muted">{row.personTitle}</span>
    </span>
  ),
  search: (row) => `${row.personName} ${row.personTitle}`,
  sortValue: (row) => row.personName,
}

const ACTION_COLUMN: PagedColumn<ApprovalRow> = {
  key: 'description',
  header: 'Action',
  cell: (row) => <span className="block max-w-lg truncate">{row.description}</span>,
  search: (row) => row.description,
  sortValue: (row) => row.description,
}

const CATEGORY_COLUMN: PagedColumn<ApprovalRow> = {
  key: 'category',
  header: 'Category',
  cell: (row) => <Badge variant="outline">{row.categoryLabel}</Badge>,
  search: (row) => row.categoryLabel,
  sortValue: (row) => row.categoryLabel,
}

const QUEUE_COLUMNS: PagedColumn<ApprovalRow>[] = [
  AGENT_COLUMN,
  ACTION_COLUMN,
  CATEGORY_COLUMN,
  {
    key: 'createdAt',
    header: 'Waiting since',
    cell: (row) => row.createdAt,
    sortValue: (row) => row.createdAt,
  },
]

const HISTORY_COLUMNS: PagedColumn<ApprovalRow>[] = [
  AGENT_COLUMN,
  ACTION_COLUMN,
  CATEGORY_COLUMN,
  {
    key: 'status',
    header: 'Decision',
    cell: (row) => <Badge variant={DECISION_VARIANT[row.status]}>{row.status}</Badge>,
    search: (row) => row.status,
    sortValue: (row) => row.status,
  },
  {
    key: 'decidedAt',
    header: 'Decided',
    cell: (row) => row.decidedAt ?? '—',
    sortValue: (row) => row.decidedAt ?? '',
  },
  {
    key: 'decisionNote',
    header: 'Note',
    cell: (row) =>
      row.decisionNote ? (
        <span className="block max-w-xs truncate text-fg-muted">{row.decisionNote}</span>
      ) : (
        <span className="text-fg-muted">—</span>
      ),
    search: (row) => row.decisionNote ?? '',
  },
]

/**
 * Approvals in two halves: the queue, which is work, and the history, which is
 * the record. Both are the same rows read the same way — one paginated table
 * each — and a row opens the request in full, because approving an external
 * email without reading it is not approval.
 */
export function ApprovalsView({
  pending,
  decided,
  canDecide,
  initialTab,
}: {
  pending: ApprovalRow[]
  decided: ApprovalRow[]
  /** Whether this member may decide. The server action is the real gate. */
  canDecide: boolean
  /** Which subtab to open on arrival, for deep links. */
  initialTab?: string
}) {
  const tabs: SectionTabItem[] = [
    { key: 'queue', label: 'Queue', count: pending.length },
    { key: 'history', label: 'History', count: decided.length },
  ]
  const [active, setActive] = React.useState(tabs.some((tab) => tab.key === initialTab) ? initialTab! : 'queue')
  const [openId, setOpenId] = React.useState<string | null>(null)
  const [note, setNote] = React.useState('')
  const [error, setError] = React.useState<string | null>(null)
  const [deciding, startDeciding] = React.useTransition()

  // Held by id, not by value: after a decision the server sends fresh rows, and
  // a row captured at click time would keep the drawer on a stale copy.
  const open = React.useMemo(
    () => [...pending, ...decided].find((row) => row.id === openId) ?? null,
    [pending, decided, openId],
  )

  const close = () => {
    setOpenId(null)
    setNote('')
    setError(null)
  }

  const decide = (row: ApprovalRow, decision: 'approve' | 'decline') => {
    const form = new FormData()
    form.set('approvalId', row.id)
    form.set('note', note)
    setError(null)
    startDeciding(async () => {
      try {
        await (decision === 'approve' ? approveAction : rejectAction)(form)
        close()
      } catch (cause) {
        // Losing the race — someone else decided it first — is the common case,
        // and the drawer has to say so rather than silently doing nothing.
        setError(cause instanceof Error ? cause.message : 'The decision could not be recorded.')
      }
    })
  }

  return (
    <div className="space-y-6">
      <SectionTabs tabs={tabs} active={active} onSelect={setActive} ariaLabel="Approval sections" />

      {active === 'queue' ? (
        <PagedTable
          columns={QUEUE_COLUMNS}
          rows={pending}
          rowKey={(row) => row.id}
          pageSize={15}
          searchable
          defaultSort={{ key: 'createdAt', dir: 'asc' }}
          onRowClick={(row) => setOpenId(row.id)}
          labels={{ searchPlaceholder: 'Search the queue…', searchLabel: 'Search the queue' }}
          empty={<EmptyState title="Queue is clear" description="Nothing is waiting on you." />}
        />
      ) : null}

      {active === 'history' ? (
        <PagedTable
          columns={HISTORY_COLUMNS}
          rows={decided}
          rowKey={(row) => row.id}
          pageSize={15}
          searchable
          defaultSort={{ key: 'decidedAt', dir: 'desc' }}
          onRowClick={(row) => setOpenId(row.id)}
          labels={{ searchPlaceholder: 'Search decisions…', searchLabel: 'Search decisions' }}
          empty={
            <EmptyState
              title="Nothing decided yet"
              description="Approvals you have approved or declined are kept here."
            />
          }
        />
      ) : null}

      <Drawer
        open={Boolean(open)}
        onClose={close}
        size="lg"
        title={open ? open.description : ''}
        description={
          open ? `${open.personName} · ${open.personTitle} · ${open.categoryLabel} · queued ${open.createdAt}` : ''
        }
      >
        {open ? (
          <div className="space-y-4 text-sm">
            {open.draft.fields.length > 0 || open.draft.text ? (
              <div className="space-y-2 rounded-md border border-border bg-bg-subtle p-3">
                {open.draft.fields.map((field) => (
                  <p key={field.label}>
                    <span className="text-fg-muted">{field.label}: </span>
                    {field.value}
                  </p>
                ))}
                {open.draft.text ? <p className="whitespace-pre-wrap">{open.draft.text}</p> : null}
              </div>
            ) : null}

            <div className="flex flex-wrap gap-4">
              <Link href={`/runs/${open.runId}`} className="text-fg-muted hover:text-primary">
                Open the run this came from →
              </Link>
              <Link href={`/organization?person=${open.personId}`} className="text-fg-muted hover:text-primary">
                {open.personName}&apos;s profile →
              </Link>
            </div>

            {open.status === 'pending' ? (
              canDecide ? (
                <div className="space-y-3 border-t border-border pt-4">
                  <div className="space-y-2">
                    <Label htmlFor="approval-note">Note back to the agent</Label>
                    <Textarea
                      id="approval-note"
                      value={note}
                      onChange={(event) => setNote(event.target.value)}
                      rows={3}
                      placeholder="Optional. A declined action is worth a reason — the agent learns from it."
                    />
                  </div>
                  {error ? <p className="text-danger">{error}</p> : null}
                  <div className="flex flex-wrap items-center gap-2">
                    <Button type="button" disabled={deciding} onClick={() => decide(open, 'approve')}>
                      Approve
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      disabled={deciding}
                      onClick={() => decide(open, 'decline')}
                    >
                      Decline
                    </Button>
                  </div>
                </div>
              ) : (
                <p className="border-t border-border pt-4 text-fg-muted">
                  This is waiting on someone who can decide approvals.
                </p>
              )
            ) : (
              <div className="space-y-2 border-t border-border pt-4">
                <p className="flex items-center gap-2">
                  <Badge variant={DECISION_VARIANT[open.status]}>{open.status}</Badge>
                  {open.decidedAt ? <span className="text-fg-muted">{open.decidedAt}</span> : null}
                </p>
                {open.decisionNote ? (
                  <p>
                    <span className="text-fg-muted">Note: </span>
                    {open.decisionNote}
                  </p>
                ) : null}
              </div>
            )}
          </div>
        ) : null}
      </Drawer>
    </div>
  )
}
