import 'server-only'
import { and, eq } from 'drizzle-orm'
import { tenantSettings } from '../db/schema'
import { db } from '../db/client'

/**
 * Desk policy and the desk feature gate — tenant configuration, read the way
 * `getWorkspacePolicy` reads its key: one settings row, resolved against
 * defaults, with every number bounds-checked so a stored value can never be
 * unsafe. Enforcement lives where the numbers are consumed (the desk client
 * and the runner); this module owns what the numbers ARE for a tenant.
 */

export const DESK_POLICY_KEY = 'desk.policy'
export const FEATURES_KEY = 'company.features'

export type DeskPolicy = {
  /** How long one lease keeps a desk resident before it must be renewed. */
  leaseMs: number
  /** Idle this long and the desk suspends — the VM stops, the disk persists. */
  idleSuspendMs: number
  /** Hard cap on concurrently resident desks. Size against SCREEN-OPEN desks. */
  concurrencyCap: number
  /** Queue depth past which the operator surface should alert (§3.15). */
  queueAlertDepth: number
  /**
   * Hard step ceiling per screen session — the cost governor for the expensive
   * tier (§3.18). Mirrors the browser's MAX_STEPS default of 40.
   */
  screenStepCeiling: number
  /** Guest memory per desk. Headless desks run small; a screen roughly triples it. */
  memoryMb: number
  vcpus: number
}

export const DEFAULT_DESK_POLICY: DeskPolicy = {
  leaseMs: 15 * 60_000,
  idleSuspendMs: 5 * 60_000,
  concurrencyCap: 8,
  queueAlertDepth: 3,
  screenStepCeiling: 40,
  memoryMb: 1024,
  vcpus: 2,
}

function boundedInteger(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be a whole number from ${minimum} to ${maximum}.`)
  }
  return value
}

/** Resolve a partial/stored tenant policy and reject unsafe values. */
export function resolveDeskPolicy(value: Partial<DeskPolicy> | null | undefined): DeskPolicy {
  const policy = { ...DEFAULT_DESK_POLICY, ...(value ?? {}) }
  return {
    leaseMs: boundedInteger(policy.leaseMs, 60_000, 4 * 60 * 60_000, 'Desk lease duration'),
    idleSuspendMs: boundedInteger(policy.idleSuspendMs, 30_000, 60 * 60_000, 'Desk idle suspend'),
    concurrencyCap: boundedInteger(policy.concurrencyCap, 1, 64, 'Desk concurrency cap'),
    queueAlertDepth: boundedInteger(policy.queueAlertDepth, 1, 64, 'Desk queue alert depth'),
    screenStepCeiling: boundedInteger(policy.screenStepCeiling, 5, 200, 'Screen session step ceiling'),
    memoryMb: boundedInteger(policy.memoryMb, 256, 16_384, 'Desk memory'),
    vcpus: boundedInteger(policy.vcpus, 1, 16, 'Desk vCPUs'),
  }
}

export async function getDeskPolicy(tenantId: string): Promise<DeskPolicy> {
  const app = db()
  const [row] = await app.withTenantContext(tenantId, () =>
    app.db
      .select({ value: tenantSettings.value })
      .from(tenantSettings)
      .where(and(eq(tenantSettings.tenantId, tenantId), eq(tenantSettings.key, DESK_POLICY_KEY))),
  )
  return resolveDeskPolicy(row?.value as Partial<DeskPolicy> | undefined)
}

export async function saveDeskPolicy(tenantId: string, value: DeskPolicy): Promise<void> {
  const resolved = resolveDeskPolicy(value)
  const app = db()
  await app.withTenant(tenantId, async () => {
    await app.db
      .insert(tenantSettings)
      .values({ tenantId, key: DESK_POLICY_KEY, value: resolved })
      .onConflictDoUpdate({
        target: [tenantSettings.tenantId, tenantSettings.key],
        set: { value: resolved, updatedAt: new Date() },
      })
  })
}

/**
 * The feature gate, per AGENTS.md: one authoritative switchboard setting.
 * `desk` is having a machine at all; `desktop` is opening a screen on it.
 * The child gate is never independently available — desk off forces desktop
 * off, whatever the stored row says (docs/agent-desk.md §6.4).
 */
export type DeskFeatures = {
  desk: boolean
  desktop: boolean
  remoteComputers: boolean
}

export function resolveDeskFeatureValue(value: unknown): DeskFeatures {
  const stored = (value ?? {}) as Partial<Record<'desk' | 'desktop' | 'remoteComputers', unknown>>
  const desk = stored.desk !== false
  const desktop = desk && stored.desktop !== false
  const remoteComputers = stored.remoteComputers !== false
  return { desk, desktop, remoteComputers }
}

/**
 * The single source of truth for the desk feature gate — used by ability
 * assembly AND by UI/server actions, so a screen never claims a capability the
 * runtime withholds. Defaults to both on.
 */
export async function resolveDeskFeatures(tenantId: string): Promise<DeskFeatures> {
  const app = db()
  const [row] = await app.withTenantContext(tenantId, () =>
    app.db
      .select({ value: tenantSettings.value })
      .from(tenantSettings)
      .where(and(eq(tenantSettings.tenantId, tenantId), eq(tenantSettings.key, FEATURES_KEY))),
  )
  return resolveDeskFeatureValue(row?.value)
}

export async function saveDeskFeatures(tenantId: string, value: DeskFeatures): Promise<void> {
  const resolved = resolveDeskFeatureValue(value)
  const app = db()
  await app.withTenant(tenantId, async () => {
    await app.db
      .insert(tenantSettings)
      .values({ tenantId, key: FEATURES_KEY, value: resolved })
      .onConflictDoUpdate({
        target: [tenantSettings.tenantId, tenantSettings.key],
        set: { value: resolved, updatedAt: new Date() },
      })
  })
}
