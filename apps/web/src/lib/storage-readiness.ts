import type { Storage } from '@braedonsaunders/appkit-storage'

export type ReadyStorage = { storage: Storage; ready: Promise<void> }

/**
 * Share successful storage readiness without making a transient failure
 * process-lifetime state. Concurrent callers still join one readiness check;
 * a rejected check is evicted so the next real operation can recover.
 */
export function createReadyStorageAccessor(factory: () => Storage): () => ReadyStorage {
  let cached: ReadyStorage | null = null
  return () => {
    if (cached) return cached
    const storage = factory()
    const entry: ReadyStorage = { storage, ready: Promise.resolve() }
    entry.ready = storage.ensureReady().catch((error: unknown) => {
      if (cached === entry) cached = null
      throw error
    })
    cached = entry
    return entry
  }
}
