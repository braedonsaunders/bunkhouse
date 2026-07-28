import 'server-only'
import { and, eq, ne } from 'drizzle-orm'
import { SipClient } from 'livekit-server-sdk'
import { sealSecret, unsealSecret } from '@appkit/crypto'
import { people, sipTrunks } from '../db/schema'
import { db } from '../db/client'

/**
 * The phone system: tenant PBX trunks and hand extensions. A trunk row is
 * the single source of truth; saving one mirrors it to the LiveKit SIP
 * ingress (inbound trunk + callee dispatch rule that creates `pbx-<ext>…`
 * rooms the voice agent answers). Mirroring is reconstruct-on-save: the
 * previous LiveKit objects are removed and fresh ones created, and their
 * ids stored on the row — deterministic, idempotent, and safe to repeat.
 */

export type SipTrunkRow = typeof sipTrunks.$inferSelect

export type SipTrunkInput = {
  name: string
  flavor: 'avaya_ip_office' | 'generic_sip'
  pbxHost?: string | null
  pbxPort?: number
  transport?: 'udp' | 'tcp' | 'tls'
  authUsername?: string | null
  /** Plain password; sealed here. Undefined = leave the stored one alone. */
  authPassword?: string | null
  extensionRange?: string | null
}

function livekitEnv(): { host: string; apiKey: string; apiSecret: string } | null {
  const url = process.env.LIVEKIT_URL
  const apiKey = process.env.LIVEKIT_API_KEY
  const apiSecret = process.env.LIVEKIT_API_SECRET
  if (!url || !apiKey || !apiSecret) return null
  // SipClient speaks HTTP against the same endpoint the ws URL names.
  const host = url.replace(/^ws:/, 'http:').replace(/^wss:/, 'https:')
  return { host, apiKey, apiSecret }
}

/** The address a PBX points its SIP line at — deployment infrastructure,
 *  derived from the LiveKit media plane's host. */
export function sipIngressAddress(): { host: string; port: number } | null {
  const url = process.env.LIVEKIT_URL
  if (!url) return null
  try {
    return { host: new URL(url).hostname, port: 5060 }
  } catch {
    return null
  }
}

export async function listSipTrunks(tenantId: string): Promise<SipTrunkRow[]> {
  const app = db()
  return app.withTenantContext(tenantId, () => app.db.select().from(sipTrunks))
}

/** Mirror one trunk row to the LiveKit SIP service. Returns the row's new
 *  status fields; never throws — provisioning failures land on the row. */
async function provisionTrunk(
  tenantId: string,
  trunk: SipTrunkRow,
): Promise<Pick<SipTrunkRow, 'status' | 'lastError' | 'livekitTrunkId' | 'livekitDispatchRuleId'>> {
  const env = livekitEnv()
  if (!env) {
    return { status: 'unconfigured', lastError: null, livekitTrunkId: null, livekitDispatchRuleId: null }
  }
  const client = new SipClient(env.host, env.apiKey, env.apiSecret)
  try {
    // Reconstruct: drop the previous mirrored objects (ignore "already gone"),
    // then create fresh ones. Re-running converges on the same state.
    if (trunk.livekitDispatchRuleId) {
      await client.deleteSipDispatchRule(trunk.livekitDispatchRuleId).catch(() => undefined)
    }
    if (trunk.livekitTrunkId) {
      await client.deleteSipTrunk(trunk.livekitTrunkId).catch(() => undefined)
    }
    const password = trunk.sealedAuthPassword ? unsealSecret(trunk.sealedAuthPassword) : null
    const created = await client.createSipInboundTrunk(`bunkhouse-${trunk.id}`, [], {
      ...(trunk.pbxHost ? { allowedAddresses: [trunk.pbxHost] } : {}),
      ...(trunk.authUsername ? { authUsername: trunk.authUsername } : {}),
      ...(password ? { authPassword: password } : {}),
      metadata: JSON.stringify({ tenantId, trunkId: trunk.id }),
    })
    const rule = await client.createSipDispatchRule(
      // Callee dispatch: the dialed extension names the room (`pbx-<ext>` plus
      // a random suffix so every call is its own room/session).
      { type: 'callee', roomPrefix: 'pbx-', randomize: true },
      {
        name: `bunkhouse-${trunk.id}`,
        trunkIds: [created.sipTrunkId],
        attributes: { 'bunkhouse.tenantId': tenantId, 'bunkhouse.trunkId': trunk.id },
      },
    )
    return {
      status: 'active',
      lastError: null,
      livekitTrunkId: created.sipTrunkId,
      livekitDispatchRuleId: rule.sipDispatchRuleId,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      status: 'error',
      lastError: `Provisioning failed: ${message}`,
      livekitTrunkId: trunk.livekitTrunkId,
      livekitDispatchRuleId: trunk.livekitDispatchRuleId,
    }
  }
}

export async function createSipTrunk(tenantId: string, input: SipTrunkInput): Promise<SipTrunkRow> {
  const app = db()
  const inserted = await app.withTenant(tenantId, async () => {
    const [row] = await app.db
      .insert(sipTrunks)
      .values({
        tenantId,
        name: input.name.trim(),
        flavor: input.flavor,
        mode: 'trunk',
        pbxHost: input.pbxHost?.trim() || null,
        pbxPort: input.pbxPort ?? 5060,
        transport: input.transport ?? 'udp',
        authUsername: input.authUsername?.trim() || null,
        sealedAuthPassword: input.authPassword ? sealSecret(input.authPassword) : null,
        extensionRange: input.extensionRange?.trim() || null,
      })
      .returning()
    return row!
  })
  return finishProvision(tenantId, inserted)
}

export async function updateSipTrunk(tenantId: string, trunkId: string, input: SipTrunkInput): Promise<SipTrunkRow> {
  const app = db()
  const updated = await app.withTenant(tenantId, async () => {
    const [current] = await app.db.select().from(sipTrunks).where(eq(sipTrunks.id, trunkId))
    if (!current) throw new Error('This trunk no longer exists.')
    const [row] = await app.db
      .update(sipTrunks)
      .set({
        name: input.name.trim(),
        flavor: input.flavor,
        pbxHost: input.pbxHost?.trim() || null,
        pbxPort: input.pbxPort ?? 5060,
        transport: input.transport ?? 'udp',
        authUsername: input.authUsername?.trim() || null,
        // Undefined leaves the sealed password untouched; empty string clears it.
        ...(input.authPassword !== undefined
          ? { sealedAuthPassword: input.authPassword ? sealSecret(input.authPassword) : null }
          : {}),
        extensionRange: input.extensionRange?.trim() || null,
        updatedAt: new Date(),
      })
      .where(eq(sipTrunks.id, trunkId))
      .returning()
    return row!
  })
  return finishProvision(tenantId, updated)
}

async function finishProvision(tenantId: string, trunk: SipTrunkRow): Promise<SipTrunkRow> {
  const app = db()
  const result = await provisionTrunk(tenantId, trunk)
  return app.withTenant(tenantId, async () => {
    const [row] = await app.db
      .update(sipTrunks)
      .set({ ...result, updatedAt: new Date() })
      .where(eq(sipTrunks.id, trunk.id))
      .returning()
    return row!
  })
}

export async function deleteSipTrunk(tenantId: string, trunkId: string): Promise<void> {
  const app = db()
  const [trunk] = await app.withTenantContext(tenantId, () =>
    app.db.select().from(sipTrunks).where(eq(sipTrunks.id, trunkId)),
  )
  if (!trunk) return
  const env = livekitEnv()
  if (env) {
    const client = new SipClient(env.host, env.apiKey, env.apiSecret)
    if (trunk.livekitDispatchRuleId) await client.deleteSipDispatchRule(trunk.livekitDispatchRuleId).catch(() => undefined)
    if (trunk.livekitTrunkId) await client.deleteSipTrunk(trunk.livekitTrunkId).catch(() => undefined)
  }
  await app.withTenant(tenantId, async () => {
    await app.db.delete(sipTrunks).where(eq(sipTrunks.id, trunkId))
  })
}

/** Assign (or clear, with null) a hand's phone-system extension. Extensions
 *  are short dialable codes, unique per tenant. */
export async function assignExtension(args: {
  tenantId: string
  personId: string
  extension: string | null
}): Promise<{ ok: true } | { ok: false; message: string }> {
  const app = db()
  const extension = args.extension?.trim() || null
  if (extension && !/^[0-9]{2,6}$/.test(extension)) {
    return { ok: false, message: 'An extension is 2–6 digits, e.g. 701.' }
  }
  return app.withTenant(args.tenantId, async () => {
    if (extension) {
      const [taken] = await app.db
        .select({ id: people.id, name: people.name })
        .from(people)
        .where(and(eq(people.extension, extension), ne(people.id, args.personId)))
      if (taken) {
        return { ok: false as const, message: `Extension ${extension} is already assigned to ${taken.name}.` }
      }
    }
    await app.db
      .update(people)
      .set({ extension, updatedAt: new Date() })
      .where(eq(people.id, args.personId))
    return { ok: true as const }
  })
}
