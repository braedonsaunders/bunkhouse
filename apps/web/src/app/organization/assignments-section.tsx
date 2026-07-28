import Link from 'next/link'
import { eq, inArray } from 'drizzle-orm'
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, EmptyState } from '@appkit/ui'
import { formatAttachmentSize } from '@appkit/storage'
import { assignments as assignmentsTable, files as filesTable } from '../../db/schema'
import { db } from '../../db/client'

type AssignmentRow = typeof assignmentsTable.$inferSelect
type FileRow = typeof filesTable.$inferSelect

const STATUS_LABEL: Record<AssignmentRow['status'], string> = {
  pending: 'Queued',
  working: 'In progress',
  waiting_approval: 'Waiting on approval',
  delivered: 'Delivered',
  failed: 'Needs attention',
  cancelled: 'Cancelled',
}

const STATUS_VARIANT: Record<AssignmentRow['status'], 'default' | 'secondary' | 'outline' | 'warning' | 'destructive'> = {
  pending: 'secondary',
  working: 'default',
  waiting_approval: 'warning',
  delivered: 'default',
  failed: 'destructive',
  cancelled: 'outline',
}

function sourceLabel(source: AssignmentRow['source']): string {
  if (source.kind === 'call') return 'Taken on a call'
  if (source.kind === 'mail') return 'Taken over email'
  return 'Assigned directly'
}

/**
 * The agent's committed deliverables: what it has promised, to whom, where
 * each one stands, and the finished files once they ship. Every row links to
 * the run doing the work — the full audit trail.
 */
export async function AssignmentsSection({ tenantId, personId }: { tenantId: string; personId: string }) {
  const app = db()
  const data = await app.withTenantContext(tenantId, async () => {
    const rows = await app.db
      .select()
      .from(assignmentsTable)
      .where(eq(assignmentsTable.personId, personId))
      .orderBy(assignmentsTable.createdAt)
    const fileIds = rows.flatMap((row) => row.resultFileIds)
    const fileRows: FileRow[] = fileIds.length
      ? await app.db.select().from(filesTable).where(inArray(filesTable.id, fileIds))
      : []
    return { rows: rows.reverse(), files: new Map(fileRows.map((f) => [f.id, f])) }
  })

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Assignments</CardTitle>
        <CardDescription>
          Deliverables this agent has committed to — from calls, email, or you — and where each one stands. Finished
          files are attached to the delivery email and kept here.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {data.rows.length === 0 ? (
          <EmptyState
            title="No assignments yet"
            description="Ask for work on a call or over email — a report, a spreadsheet, research — and the commitment shows up here while it is produced and delivered."
          />
        ) : (
          <ul className="space-y-3">
            {data.rows.map((row) => (
              <li key={row.id} className="rounded-lg border border-border bg-bg-subtle p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-fg">{row.title}</p>
                    <p className="text-xs text-fg-muted">
                      {sourceLabel(row.source)} · for {row.deliverTo.name ?? row.deliverTo.address}
                      {row.formats.length ? ` · ${row.formats.map((f) => f.toUpperCase()).join(', ')}` : ''}
                      {row.dueAt ? ` · due ${row.dueAt.toISOString().slice(0, 16).replace('T', ' ')}` : ''}
                    </p>
                  </div>
                  <Badge variant={STATUS_VARIANT[row.status]}>{STATUS_LABEL[row.status]}</Badge>
                </div>
                {row.lastError ? <p className="mt-2 text-xs text-danger">{row.lastError}</p> : null}
                {(row.resultFileIds.length > 0 || row.runId) && (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    {row.resultFileIds.map((fileId) => {
                      const file = data.files.get(fileId)
                      if (!file) return null
                      return (
                        <a
                          key={fileId}
                          href={`/api/files/${fileId}`}
                          download={file.filename}
                          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-2 py-1 text-xs text-fg transition-colors hover:bg-surface-hover"
                        >
                          <span className="font-medium">{file.filename}</span>
                          <span className="text-fg-muted">{formatAttachmentSize(file.sizeBytes)}</span>
                        </a>
                      )
                    })}
                    {row.runId ? (
                      <Link href={`/runs/${row.runId}`} className="text-xs text-primary hover:underline">
                        View the run
                      </Link>
                    ) : null}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
