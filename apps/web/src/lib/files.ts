import 'server-only'
import { createHash, randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { newAttachmentKey, newPendingUploadKey } from '@braedonsaunders/appkit-storage'
import { createStorageFromEnv } from '@braedonsaunders/appkit-storage/env'
import { chatFileUploads, files, type fileKind } from '../db/schema'
import { db } from '../db/client'
import { createReadyStorageAccessor } from './storage-readiness'

export type FileKind = (typeof fileKind.enumValues)[number]
export type FileRecord = typeof files.$inferSelect
export const MAX_CHAT_UPLOAD_BYTES = 20 * 1024 * 1024

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
  createdBy?: string | null
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
        createdBy: args.createdBy ?? null,
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
  fileId?: string
  createdBy?: string | null
}): Promise<FileRecord> {
  const { storage: s, ready } = storage()
  await ready
  const bytes = await s.getBytes(args.storageKey)
  const app = db()
  return app.withTenant(args.tenantId, async () => {
    const [row] = await app.db
      .insert(files)
      .values({
        ...(args.fileId ? { id: args.fileId } : {}),
        tenantId: args.tenantId,
        personId: args.personId ?? null,
        runId: args.runId ?? null,
        kind: args.kind,
        filename: args.filename,
        contentType: args.contentType,
        sizeBytes: bytes.byteLength,
        storageKey: args.storageKey,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        createdBy: args.createdBy ?? null,
      })
      .onConflictDoNothing()
      .returning()
    if (row) return row
    if (!args.fileId) throw new Error('File record could not be created.')
    const [existing] = await app.db.select().from(files).where(eq(files.id, args.fileId)).limit(1)
    if (!existing || existing.storageKey !== args.storageKey) throw new Error('File record could not be reconciled.')
    return existing
  })
}

export type ChatUploadReservation =
  | { ok: true; uploadId: string; mode: 'single'; putUrl: string }
  | {
      ok: true
      uploadId: string
      mode: 'multipart'
      multipartUploadId: string
      partSizeBytes: number
      partUrls: string[]
    }

/**
 * Reserve a same-origin browser upload. The app writes the pending object so
 * installations do not need a second, bucket-specific CORS configuration;
 * only finalization promotes it into the immutable files ledger.
 */
export async function reserveChatFileUpload(args: {
  tenantId: string
  threadId: string
  personId: string
  userId: string
  filename: string
  contentType: string
  sizeBytes: number
}): Promise<ChatUploadReservation> {
  const filename = args.filename.trim().replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 180)
  const contentType = args.contentType.trim().toLowerCase().slice(0, 160) || 'application/octet-stream'
  if (!filename) throw new Error('Choose a named file to attach.')
  if (!Number.isInteger(args.sizeBytes) || args.sizeBytes <= 0 || args.sizeBytes > MAX_CHAT_UPLOAD_BYTES) {
    throw new Error('Each attachment must be between 1 byte and 20 MB.')
  }
  const uploadId = randomUUID()
  const pendingStorageKey = newPendingUploadKey({ tenantId: args.tenantId, uploadId })
  const finalStorageKey = newAttachmentKey({ tenantId: args.tenantId, kind: 'other', filename })
  const reservation: ChatUploadReservation = {
    ok: true,
    uploadId,
    mode: 'single',
    putUrl: `/api/chat/uploads/${encodeURIComponent(uploadId)}`,
  }

  const app = db()
  await app.withTenant(args.tenantId, () =>
    app.db.insert(chatFileUploads).values({
      id: uploadId,
      tenantId: args.tenantId,
      threadId: args.threadId,
      personId: args.personId,
      userId: args.userId,
      filename,
      contentType,
      sizeBytes: args.sizeBytes,
      pendingStorageKey,
      finalStorageKey,
      multipartUploadId: null,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1_000),
      createdBy: args.userId,
      updatedBy: args.userId,
    }),
  )
  return reservation
}

/** Receive the reserved bytes through the authenticated application origin. */
export async function receiveChatFileUpload(args: {
  tenantId: string
  userId: string
  uploadId: string
  contentType: string
  bytes: Uint8Array
}): Promise<void> {
  const app = db()
  const [upload] = await app.withTenantContext(args.tenantId, () =>
    app.db
      .select()
      .from(chatFileUploads)
      .where(and(eq(chatFileUploads.id, args.uploadId), eq(chatFileUploads.userId, args.userId)))
      .limit(1),
  )
  if (!upload || upload.status !== 'pending') throw new Error('That upload reservation is not available.')
  if (upload.expiresAt.getTime() <= Date.now()) throw new Error('That upload expired. Choose the file again.')
  if (args.bytes.byteLength !== upload.sizeBytes) throw new Error('The uploaded file did not match its reservation.')
  const contentType = args.contentType.trim().toLowerCase().split(';', 1)[0] ?? ''
  if (contentType !== upload.contentType) throw new Error('The uploaded file type did not match its reservation.')
  const { storage: s, ready } = storage()
  await ready
  await s.put({
    key: upload.pendingStorageKey,
    body: args.bytes,
    contentType: upload.contentType,
    contentDisposition: 'attachment',
    tagging: 'appkit-state=pending',
  })
}

/** Verify and promote one reserved upload; safe to repeat after a lost reply. */
export async function finalizeChatFileUpload(args: {
  tenantId: string
  threadId: string
  userId: string
  uploadId: string
  multipartUploadId?: string
}): Promise<FileRecord> {
  const app = db()
  const [upload] = await app.withTenantContext(args.tenantId, () =>
    app.db
      .select()
      .from(chatFileUploads)
      .where(and(
        eq(chatFileUploads.id, args.uploadId),
        eq(chatFileUploads.threadId, args.threadId),
        eq(chatFileUploads.userId, args.userId),
      ))
      .limit(1),
  )
  if (!upload) throw new Error('That upload reservation is not available.')
  if (upload.status === 'failed') throw new Error('That upload did not complete.')
  if (upload.status === 'finalized' && upload.fileId) {
    const existing = await getFileRecord(args.tenantId, upload.fileId)
    if (existing) return existing
  }
  if (upload.expiresAt.getTime() <= Date.now()) throw new Error('That upload expired. Choose the file again.')
  if ((upload.multipartUploadId ?? undefined) !== args.multipartUploadId) {
    throw new Error('That multipart upload identity is not valid.')
  }

  const { storage: s, ready } = storage()
  await ready
  if (upload.multipartUploadId) {
    await s.completeMultipartUpload(upload.pendingStorageKey, upload.multipartUploadId)
  }
  const pending = await s.headObject(upload.pendingStorageKey)
  if (!pending || pending.contentLength !== upload.sizeBytes || !pending.etag) {
    throw new Error('The uploaded file did not match its reservation.')
  }
  const existingFinal = await s.headObject(upload.finalStorageKey)
  if (!existingFinal) {
    await s.promote({
      sourceKey: upload.pendingStorageKey,
      sourceEtag: pending.etag,
      destinationKey: upload.finalStorageKey,
      contentType: upload.contentType,
      contentDisposition: 'attachment',
    })
  } else if (existingFinal.contentLength !== upload.sizeBytes) {
    throw new Error('The finalized file does not match its reservation.')
  }

  const file = await ledgerExistingObject({
    tenantId: args.tenantId,
    personId: upload.personId,
    kind: 'upload',
    filename: upload.filename,
    contentType: upload.contentType,
    storageKey: upload.finalStorageKey,
    fileId: upload.id,
    createdBy: upload.userId,
  })
  await app.withTenant(args.tenantId, () =>
    app.db
      .update(chatFileUploads)
      .set({ status: 'finalized', fileId: file.id, finalizedAt: new Date(), updatedAt: new Date(), updatedBy: args.userId })
      .where(and(eq(chatFileUploads.id, upload.id), eq(chatFileUploads.status, 'pending'))),
  )
  await s.delete(upload.pendingStorageKey).catch(() => undefined)
  return file
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
