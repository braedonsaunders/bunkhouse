import 'server-only'
import { asc, eq, inArray } from 'drizzle-orm'
import type { RunInputAttachment } from '@bunkhouse/runtime'
import { chatDispatchAttachments, files } from '../db/schema'
import { db } from '../db/client'
import { extractFileText } from './file-reading'
import { getFileBytes, getFileRecord, type FileRecord } from './files'
import {
  ensurePersonDesk,
  execOnDesk,
  guestWorkspacePath,
  recordDeskLedgerEvent,
} from './desk'
import { resolveDeskFeatures } from './desk-policy'

export type ChatAttachmentView = {
  fileId: string
  filename: string
  contentType: string
  sizeBytes: number
}

/** Ordered file metadata for one or more durable dispatches. */
export async function chatAttachmentsByDispatch(
  tenantId: string,
  dispatchIds: string[],
): Promise<Map<string, ChatAttachmentView[]>> {
  const grouped = new Map<string, ChatAttachmentView[]>()
  if (dispatchIds.length === 0) return grouped
  const app = db()
  const rows = await app.withTenantContext(tenantId, () =>
    app.db
      .select({
        dispatchId: chatDispatchAttachments.dispatchId,
        fileId: files.id,
        filename: files.filename,
        contentType: files.contentType,
        sizeBytes: files.sizeBytes,
      })
      .from(chatDispatchAttachments)
      .innerJoin(files, eq(files.id, chatDispatchAttachments.fileId))
      .where(inArray(chatDispatchAttachments.dispatchId, dispatchIds))
      .orderBy(asc(chatDispatchAttachments.dispatchId), asc(chatDispatchAttachments.ordinal)),
  )
  for (const row of rows) {
    const list = grouped.get(row.dispatchId) ?? []
    list.push({ fileId: row.fileId, filename: row.filename, contentType: row.contentType, sizeBytes: row.sizeBytes })
    grouped.set(row.dispatchId, list)
  }
  return grouped
}

/** Resolve the exact ordered file ids a dispatch handed to the run. */
export async function chatAttachmentRecords(tenantId: string, fileIds: string[]): Promise<FileRecord[]> {
  const records: FileRecord[] = []
  for (const fileId of fileIds) {
    const record = await getFileRecord(tenantId, fileId)
    if (!record) throw new Error('An attached file is no longer available.')
    records.push(record)
  }
  return records
}

const TOTAL_EXTRACTED_TEXT_CHARS = 48_000

/**
 * Read, extract, and copy chat inputs into the employee's persistent Linux
 * home after the run row exists. The ledger file remains authoritative; the
 * guest copy is a convenient working copy with a deterministic name.
 */
export async function ingestChatRunAttachments(args: {
  tenantId: string
  personId: string
  runId: string
  attachments: RunInputAttachment[]
}): Promise<RunInputAttachment[]> {
  if (args.attachments.length === 0) return []
  const features = await resolveDeskFeatures(args.tenantId)
  const desk = features.desk
    ? await ensurePersonDesk({ tenantId: args.tenantId, personId: args.personId }).catch(() => null)
    : null
  let remainingText = TOTAL_EXTRACTED_TEXT_CHARS
  const ingested: RunInputAttachment[] = []

  for (const attachment of args.attachments) {
    const record = await getFileRecord(args.tenantId, attachment.fileId)
    if (!record) throw new Error(`Attached file ${attachment.filename} is no longer available.`)
    const bytes = await getFileBytes(record)
    let extractedText = ''
    let extractionNote: string | undefined
    try {
      const extracted = await extractFileText(record, bytes)
      extractedText = extracted.text.slice(0, Math.max(0, remainingText))
      remainingText -= extractedText.length
      extractionNote = extracted.note
    } catch (reason) {
      extractionNote = reason instanceof Error ? `Text extraction failed: ${reason.message}` : 'Text extraction failed.'
    }

    let workspacePath: string | undefined
    let stagingError: string | undefined
    if (desk) {
      const safeName = record.filename.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'attachment'
      const relative = `inbox/${record.id.slice(0, 8)}-${safeName}`
      const target = guestWorkspacePath(relative)
      try {
        await requireDeskCommand(desk.deskId, [
          '/usr/bin/install', '-d', '-o', 'agent', '-g', 'agent', '-m', '0700', guestWorkspacePath('inbox'),
        ])
        await requireDeskCommand(desk.deskId, [
          '/usr/bin/install', '-o', 'agent', '-g', 'agent', '-m', '0600', '/dev/null', target,
        ])
        for (let offset = 0; offset < bytes.byteLength; offset += 128 * 1024) {
          const encoded = Buffer.from(bytes.slice(offset, offset + 128 * 1024)).toString('base64')
          await requireDeskCommand(desk.deskId, [
            '/usr/bin/node',
            '-e',
            "require('node:fs').appendFileSync(process.argv[1],Buffer.from(process.argv[2],'base64'))",
            target,
            encoded,
          ])
        }
        workspacePath = `~/${relative}`
        await recordDeskLedgerEvent({
          tenantId: args.tenantId,
          personId: args.personId,
          runId: args.runId,
          kind: 'file_write',
          detail: { target: workspacePath, title: `Received ${record.filename} from chat` },
        })
      } catch (reason) {
        stagingError = reason instanceof Error ? reason.message : 'The employee machine could not receive the file.'
      }
    } else {
      stagingError = 'The employee machine is not enabled for this company.'
    }

    ingested.push({
      fileId: record.id,
      filename: record.filename,
      mediaType: record.contentType,
      sizeBytes: record.sizeBytes,
      ...(extractedText ? { extractedText } : {}),
      ...(extractionNote ? { extractionNote } : {}),
      ...(workspacePath ? { workspacePath } : {}),
      ...(stagingError ? { stagingError } : {}),
      ...(record.contentType.startsWith('image/') && bytes.byteLength <= 4 * 1024 * 1024
        ? { dataBase64: Buffer.from(bytes).toString('base64') }
        : {}),
    })
  }
  return ingested
}

async function requireDeskCommand(deskId: string, command: readonly string[]): Promise<void> {
  const outcome = await execOnDesk({ deskId, command, cwd: '/home/agent', timeoutMs: 60_000, outputLimitKb: 32 })
  if (outcome.status !== 'completed') {
    throw new Error(outcome.output.trim() || `The employee machine could not receive the file (${outcome.status}).`)
  }
}
