import 'server-only'
import pg from 'pg'

type Wake = () => void
type NotificationRuntime = typeof globalThis & {
  __bunkhouseRunEventWake?: {
    client: pg.Client | null
    connecting: Promise<pg.Client> | null
    listeners: Map<string, Set<Wake>>
  }
}

const runtime = globalThis as NotificationRuntime

function state() {
  return (runtime.__bunkhouseRunEventWake ??= { client: null, connecting: null, listeners: new Map() })
}

async function listenerClient(): Promise<pg.Client> {
  const shared = state()
  if (shared.client) return shared.client
  if (shared.connecting) return shared.connecting
  const url = process.env.BUNKHOUSE_DB_URL
  if (!url) throw new Error('BUNKHOUSE_DB_URL is not configured.')
  shared.connecting = (async () => {
    const client = new pg.Client({ connectionString: url, application_name: 'bunkhouse-run-event-wake' })
    client.on('notification', (notice) => {
      if (notice.channel !== 'bunkhouse_run_events' || !notice.payload) return
      try {
        const runId = String((JSON.parse(notice.payload) as { runId?: unknown }).runId ?? '')
        for (const wake of shared.listeners.get(runId) ?? []) wake()
      } catch {
        // Malformed notifications are only lost hints; the cursor poll remains authoritative.
      }
    })
    const disconnected = () => {
      if (shared.client === client) shared.client = null
      for (const wakes of shared.listeners.values()) for (const wake of wakes) wake()
    }
    client.on('error', disconnected)
    client.on('end', disconnected)
    await client.connect()
    await client.query('listen bunkhouse_run_events')
    shared.client = client
    return client
  })().finally(() => {
    shared.connecting = null
  })
  return shared.connecting
}

/** Low-latency hint for a run. Lost notifications are repaired by cursor reads. */
export async function waitForRunEventWake(runId: string, signal: AbortSignal): Promise<void> {
  await listenerClient()
  if (signal.aborted) return
  const shared = state()
  await new Promise<void>((resolve) => {
    const wakes = shared.listeners.get(runId) ?? new Set<Wake>()
    const finish = () => {
      wakes.delete(finish)
      if (wakes.size === 0) shared.listeners.delete(runId)
      signal.removeEventListener('abort', finish)
      resolve()
    }
    wakes.add(finish)
    shared.listeners.set(runId, wakes)
    signal.addEventListener('abort', finish, { once: true })
  })
}

/** Close the process listener during orderly shutdowns and disposable tests. */
export async function closeRunEventNotifications(): Promise<void> {
  const shared = state()
  const client = shared.client ?? (await shared.connecting?.catch(() => null))
  shared.client = null
  shared.connecting = null
  for (const wakes of shared.listeners.values()) for (const wake of wakes) wake()
  if (client) await client.end().catch(() => undefined)
}
