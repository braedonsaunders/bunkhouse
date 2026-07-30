import 'server-only'
import { lookup } from 'node:dns/promises'
import { and, eq, isNotNull, lt } from 'drizzle-orm'
import {
  EgressClient,
  EncodedFileOutput,
  EncodedFileType,
  EgressStatus,
  S3Upload,
  type EgressInfo,
} from 'livekit-server-sdk'
import { newAttachmentKey } from '@appkit/storage'
import {
  callSessions,
  tenantSettings,
  VOICE_RETENTION_KEY,
  type VoiceRetentionSettings,
} from '../db/schema'
import { db } from '../db/client'
import { deleteFileRecord, ledgerExistingObject } from './files'

/**
 * Call recording. Every call the agent holds can be kept as audio: LiveKit
 * Egress mixes the room and writes an OGG straight into the company's own
 * object storage — the bytes never pass through this application — and the
 * resulting object is ledgered in `files` like any other company file, with
 * its id stamped on the call session.
 *
 * Two deliberate choices. Audio only: a call is a conversation, and a video
 * mix of a phone call would cost real money to produce nothing. And the
 * storage endpoint is deployment infrastructure (the same APPKIT_STORAGE_*
 * contract the app itself uses), while how long a recording is kept is tenant
 * configuration — one is where the bucket lives, the other is a policy the
 * company owns.
 */

/** Longest a stopped egress is given to finish writing its object. */
const UPLOAD_GRACE_MS = 15_000

const UPLOAD_POLL_MS = 1_000

type StorageEnv = {
  endpoint: string
  accessKeyId: string
  secretAccessKey: string
  bucket: string
  region: string
  forcePathStyle: boolean
}

/**
 * Is this something a server will accept in a Host header?
 *
 * RFC 1123 labels, letters digits and hyphens. An IP address passes too, which
 * is the point below.
 */
export function legalHostname(host: string): boolean {
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i.test(host)
}

/**
 * The same object store, addressed by something a strict server will accept.
 *
 * Every recording failed to upload with MinIO answering `InvalidRequest:
 * Invalid Request (invalid hostname)`, which is not about credentials or the
 * bucket — it is about the Host header. The endpoint is a container service
 * name, and container service names contain an underscore, which is illegal in
 * a hostname. The app's own uploads go through a client that does not care;
 * egress uploads through one that does, and MinIO agrees with it.
 *
 * Nothing about the deployment needs to change for this: the name resolves,
 * it is simply not spellable in a Host header. So it is resolved here and the
 * address is used instead, which every server accepts. Left alone when the
 * hostname is already legal, so a deployment addressing storage by a real
 * domain is untouched.
 */
export async function addressableEndpoint(
  endpoint: string,
  /** How a name becomes an address. Injected so the substitution is testable. */
  resolve: (host: string) => Promise<string> = async (host) => (await lookup(host)).address,
): Promise<{ endpoint: string; note?: string }> {
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    return { endpoint }
  }
  if (legalHostname(url.hostname)) return { endpoint }
  try {
    const address = await resolve(url.hostname)
    const rewritten = new URL(url.toString())
    rewritten.hostname = address
    return {
      endpoint: rewritten.toString().replace(/\/$/, ''),
      note: `storage is addressed by a name that is not legal in a Host header, so its address was used instead`,
    }
  } catch {
    // Nothing better to offer than the name we were given; the upload will
    // fail the same way it did before, and say so on the record.
    return { endpoint }
  }
}

/** The object store egress uploads to — the app's own, read from env. */
function storageEnv(): StorageEnv | null {
  const endpoint = process.env.APPKIT_STORAGE_ENDPOINT
  const accessKeyId = process.env.APPKIT_STORAGE_ACCESS_KEY_ID
  const secretAccessKey = process.env.APPKIT_STORAGE_SECRET_ACCESS_KEY
  const bucket = process.env.APPKIT_STORAGE_BUCKET
  if (!endpoint || !accessKeyId || !secretAccessKey || !bucket) return null
  return {
    endpoint,
    accessKeyId,
    secretAccessKey,
    bucket,
    region: process.env.APPKIT_STORAGE_REGION ?? 'us-east-1',
    // MinIO and R2 both address buckets by path; the app's own storage client
    // defaults the same way.
    forcePathStyle: process.env.APPKIT_STORAGE_FORCE_PATH_STYLE !== 'false',
  }
}

function livekitEnv(): { host: string; apiKey: string; apiSecret: string } | null {
  const url = process.env.LIVEKIT_URL
  const apiKey = process.env.LIVEKIT_API_KEY
  const apiSecret = process.env.LIVEKIT_API_SECRET
  if (!url || !apiKey || !apiSecret) return null
  return { host: url.replace(/^ws:/, 'http:').replace(/^wss:/, 'https:'), apiKey, apiSecret }
}

/** A recording in flight: what was asked for, and where it is being written. */
export type CallRecordingHandle = {
  egressId: string
  /** Object key inside the tenant's bucket — also the ledgered storage key. */
  storageKey: string
  filename: string
  contentType: string
}

export type StartCallRecordingResult =
  | { started: true; recording: CallRecordingHandle; note?: string }
  | { started: false; reason: string }

/**
 * Start recording a room. Called as the call connects; the returned handle is
 * what stops it again. Never throws — a call that cannot be recorded still
 * happens, and the reason is put on the run instead.
 */
export async function startCallRecording(args: {
  tenantId: string
  sessionId: string
  room: string
}): Promise<StartCallRecordingResult> {
  const storage = storageEnv()
  if (!storage) return { started: false, reason: 'Object storage is not configured on this deployment.' }
  const env = livekitEnv()
  if (!env) return { started: false, reason: 'The media server is not configured on this deployment.' }

  const filename = `call-${args.sessionId}.ogg`
  const storageKey = newAttachmentKey({ tenantId: args.tenantId, kind: 'audio', filename })
  // Addressed by something a strict server will accept — see above.
  const addressable = await addressableEndpoint(storage.endpoint)

  const output = new EncodedFileOutput({
    fileType: EncodedFileType.OGG,
    filepath: storageKey,
    // The ledger is the manifest; a second JSON object next to every recording
    // would be an untracked file in the company's storage.
    disableManifest: true,
    output: {
      case: 's3',
      value: new S3Upload({
        endpoint: addressable.endpoint,
        accessKey: storage.accessKeyId,
        secret: storage.secretAccessKey,
        bucket: storage.bucket,
        region: storage.region,
        forcePathStyle: storage.forcePathStyle,
      }),
    },
  })

  try {
    const client = new EgressClient(env.host, env.apiKey, env.apiSecret)
    const info = await client.startRoomCompositeEgress(args.room, output, { audioOnly: true })
    return {
      started: true,
      recording: { egressId: info.egressId, storageKey, filename, contentType: 'audio/ogg' },
      ...(addressable.note ? { note: addressable.note } : {}),
    }
  } catch (error) {
    return { started: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

/** Wait for a stopped egress to reach a terminal state, as far as it gets. */
async function settleEgress(client: EgressClient, egressId: string): Promise<EgressInfo | null> {
  const deadline = Date.now() + UPLOAD_GRACE_MS
  let last: EgressInfo | null = null
  while (Date.now() < deadline) {
    const [info] = await client.listEgress({ egressId })
    if (info) {
      last = info
      if (info.status === EgressStatus.EGRESS_COMPLETE || info.status === EgressStatus.EGRESS_FAILED) return info
      if (info.status === EgressStatus.EGRESS_ABORTED || info.status === EgressStatus.EGRESS_LIMIT_REACHED) return info
    }
    await new Promise((resolve) => setTimeout(resolve, UPLOAD_POLL_MS))
  }
  return last
}

export type FinishCallRecordingResult =
  | { recorded: true; fileId: string }
  | { recorded: false; reason: string }

/**
 * Stop the recording, wait for the upload to land, and ledger it onto the
 * call. Called once, as the call is finalized. Never throws: a lost recording
 * must not take the transcript, the run summary, or the metering with it.
 */
export async function finishCallRecording(args: {
  tenantId: string
  sessionId: string
  personId: string
  runId?: string | null
  recording: CallRecordingHandle
}): Promise<FinishCallRecordingResult> {
  const env = livekitEnv()
  if (!env) return { recorded: false, reason: 'The media server is not configured on this deployment.' }
  const client = new EgressClient(env.host, env.apiKey, env.apiSecret)
  try {
    await client.stopEgress(args.recording.egressId)
  } catch (error) {
    // A recording that ended on its own (the room closed first) is already
    // stopped; that is not a failure, so settle it either way.
    console.warn(`[voice] egress ${args.recording.egressId} stop: ${(error as Error).message}`)
  }

  const info = await settleEgress(client, args.recording.egressId)
  if (info && info.status === EgressStatus.EGRESS_FAILED) {
    return { recorded: false, reason: info.error || 'The recording failed while it was being written.' }
  }

  try {
    const file = await ledgerExistingObject({
      tenantId: args.tenantId,
      personId: args.personId,
      ...(args.runId ? { runId: args.runId } : {}),
      kind: 'recording',
      filename: args.recording.filename,
      contentType: args.recording.contentType,
      storageKey: args.recording.storageKey,
    })
    const app = db()
    await app.withTenant(args.tenantId, async () => {
      await app.db
        .update(callSessions)
        .set({ recordingFileId: file.id, updatedAt: new Date() })
        .where(eq(callSessions.id, args.sessionId))
    })
    return { recorded: true, fileId: file.id }
  } catch (error) {
    return {
      recorded: false,
      reason: `The recording could not be filed: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Retention                                                                   */
/* -------------------------------------------------------------------------- */

/** How long this company keeps call recordings. Null = keep them forever. */
export async function getVoiceRetention(tenantId: string): Promise<VoiceRetentionSettings> {
  const app = db()
  const [row] = await app.withTenantContext(tenantId, () =>
    app.db
      .select({ value: tenantSettings.value })
      .from(tenantSettings)
      .where(and(eq(tenantSettings.tenantId, tenantId), eq(tenantSettings.key, VOICE_RETENTION_KEY))),
  )
  const value = row?.value as VoiceRetentionSettings | undefined
  const days = value?.recordingDays
  return { recordingDays: typeof days === 'number' && days > 0 ? Math.floor(days) : null }
}

export async function saveVoiceRetention(tenantId: string, value: VoiceRetentionSettings): Promise<void> {
  const days = value.recordingDays
  if (days !== null && (!Number.isFinite(days) || days < 1)) {
    throw new Error('Keep recordings for at least one day, or keep them indefinitely.')
  }
  const stored: VoiceRetentionSettings = { recordingDays: days === null ? null : Math.floor(days) }
  const app = db()
  await app.withTenant(tenantId, async () => {
    await app.db
      .insert(tenantSettings)
      .values({ tenantId, key: VOICE_RETENTION_KEY, value: stored })
      .onConflictDoUpdate({
        target: [tenantSettings.tenantId, tenantSettings.key],
        set: { value: stored, updatedAt: new Date() },
      })
  })
}

/**
 * Apply the tenant's recording retention policy: delete the stored audio and
 * its ledger row for every call older than the window, and clear the pointer
 * on the session. The transcript, the run, and the spend stay — only the audio
 * goes, which is what a retention policy is for.
 *
 * With retention off (the default) this touches nothing. Idempotent: a session
 * whose recording has already gone has no pointer left to follow.
 */
export async function sweepExpiredRecordings(tenantId: string): Promise<{ deleted: number }> {
  const { recordingDays } = await getVoiceRetention(tenantId)
  if (recordingDays === null) return { deleted: 0 }
  const cutoff = new Date(Date.now() - recordingDays * 24 * 60 * 60 * 1000)

  const app = db()
  const expired = await app.withTenantContext(tenantId, () =>
    app.db
      .select({ id: callSessions.id, recordingFileId: callSessions.recordingFileId })
      .from(callSessions)
      .where(
        and(
          eq(callSessions.tenantId, tenantId),
          isNotNull(callSessions.recordingFileId),
          lt(callSessions.startedAt, cutoff),
        ),
      ),
  )

  let deleted = 0
  for (const row of expired) {
    if (!row.recordingFileId) continue
    try {
      // The object and its ledger row go first: if that fails the pointer
      // survives and the next sweep tries again, rather than orphaning bytes.
      await deleteFileRecord(tenantId, row.recordingFileId)
      await app.withTenant(tenantId, async () => {
        await app.db
          .update(callSessions)
          .set({ recordingFileId: null, updatedAt: new Date() })
          .where(eq(callSessions.id, row.id))
      })
      deleted += 1
    } catch (error) {
      console.error(`[voice] recording sweep failed for call ${row.id}: ${(error as Error).message}`)
    }
  }
  return { deleted }
}
