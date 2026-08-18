import 'server-only'
import { createHash } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { newAttachmentKey } from '@braedonsaunders/appkit-storage'
import { createStorageFromEnv } from '@braedonsaunders/appkit-storage/env'
import { files, type fileKind } from '../db/schema'
import { db } from '../db/client'
import { createReadyStorageAccessor } from './storage-readiness'

export type FileKind = (typeof fileKind.enumValues)[number]
export type FileRecord = typeof files.$inferSelect

/**
 * Object storage for the files ledger. The S3 endpoint is deployment
 * infrastructure (env), like the database; which files exist and who owns
 * them is tenant data in the `files` table.
 */
const storage = createReadyStorageAccessor(() =>
  createStorageFromEnv(process.env as Record<string, string | undefined>),
)

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

/**
 * Ledger an object that was written straight into the tenant's storage by
 * something other than this process — a LiveKit Egress recording, for one.
 * The bytes already exist at `storageKey`; this is the row that makes them a
 * file the company owns. The object is read back once to size and hash it, so
 * the ledger says the same thing about it as it does about every other file.
 */
export async function ledgerExistingObject(args: {
  tenantId: string
  personId?: string | null
  runId?: string | null
  kind: FileKind
  filename: string
  contentType: string
  storageKey: string
}): Promise<FileRecord> {
  const { storage: s, ready } = storage()
  await ready
  const bytes = await s.getBytes(args.storageKey)
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
        sizeBytes: bytes.byteLength,
        storageKey: args.storageKey,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      })
      .returning()
    if (!row) throw new Error('File record could not be created.')
    return row
  })
}

/**
 * Remove a ledgered file: the stored object first, then the row. Used by
 * retention sweeps, which are the only places a file is ever destroyed. A
 * storage object that has already gone is not an error — the row still goes.
 */
export async function deleteFileRecord(tenantId: string, fileId: string): Promise<boolean> {
  const record = await getFileRecord(tenantId, fileId)
  if (!record) return false
  const { storage: s, ready } = storage()
  await ready
  await s.delete(record.storageKey)
  const app = db()
  await app.withTenant(tenantId, async () => {
    await app.db.delete(files).where(and(eq(files.tenantId, tenantId), eq(files.id, fileId)))
  })
  return true
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
