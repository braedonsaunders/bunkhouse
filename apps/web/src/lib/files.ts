import 'server-only'
import { createHash } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { newAttachmentKey, type Storage } from '@appkit/storage'
import { createStorageFromEnv } from '@appkit/storage/env'
import { files, type fileKind } from '../db/schema'
import { db } from '../db/client'

export type FileKind = (typeof fileKind.enumValues)[number]
export type FileRecord = typeof files.$inferSelect

/**
 * Object storage for the files ledger. The S3 endpoint is deployment
 * infrastructure (env), like the database; which files exist and who owns
 * them is tenant data in the `files` table.
 */
let cached: { storage: Storage; ready: Promise<void> } | null = null
function storage(): { storage: Storage; ready: Promise<void> } {
  if (!cached) {
    const s = createStorageFromEnv(process.env as Record<string, string | undefined>)
    cached = { storage: s, ready: s.ensureReady() }
  }
  return cached
}

const STORAGE_KIND: Record<FileKind, 'document' | 'audio' | 'other'> = {
  document: 'document',
  spreadsheet: 'document',
  attachment: 'other',
  recording: 'audio',
  upload: 'other',
}

/** Store bytes and ledger them; the row id is the handle everything else uses. */
export async function saveFile(args: {
  tenantId: string
  personId?: string | null
  runId?: string | null
  kind: FileKind
  filename: string
  contentType: string
  bytes: Uint8Array
}): Promise<FileRecord> {
  const { storage: s, ready } = storage()
  await ready
  const key = newAttachmentKey({ tenantId: args.tenantId, kind: STORAGE_KIND[args.kind], filename: args.filename })
  const sha256 = createHash('sha256').update(args.bytes).digest('hex')
  await s.put({ key, body: args.bytes, contentType: args.contentType, contentDisposition: 'attachment' })

  const app = db()
  return app.withTenant(args.tenantId, async () => {
    const [row] = await app.db
      .insert(files)
      .values({
        tenantId: args.tenantId,
        personId: args.personId ?? null,
        runId: args.runId ?? null,
        kind: args.kind,
        filename: args.filename,
        contentType: args.contentType,
        sizeBytes: args.bytes.byteLength,
        storageKey: key,
        sha256,
      })
      .returning()
    if (!row) throw new Error('File record could not be created.')
    return row
  })
}

/** Look a file up within the tenant; null when it doesn't exist. */
export async function getFileRecord(tenantId: string, fileId: string): Promise<FileRecord | null> {
  const app = db()
  return app.withTenantContext(tenantId, async () => {
    const [row] = await app.db
      .select()
      .from(files)
      .where(and(eq(files.tenantId, tenantId), eq(files.id, fileId)))
    return row ?? null
  })
}

/** Fetch several records at once, preserving the requested order. */
export async function getFileRecords(tenantId: string, fileIds: string[]): Promise<FileRecord[]> {
  const found = await Promise.all(fileIds.map((id) => getFileRecord(tenantId, id)))
  return found.filter((f): f is FileRecord => f !== null)
}

/** The stored bytes for a ledgered file. */
export async function getFileBytes(record: Pick<FileRecord, 'storageKey'>): Promise<Uint8Array> {
  const { storage: s, ready } = storage()
  await ready
  return s.getBytes(record.storageKey)
}

/** Stream a file for download responses without buffering. */
export async function getFileStream(
  record: Pick<FileRecord, 'storageKey'>,
): Promise<{ stream: ReadableStream; contentLength?: number; contentType?: string }> {
  const { storage: s, ready } = storage()
  await ready
  return s.getStream(record.storageKey)
}
