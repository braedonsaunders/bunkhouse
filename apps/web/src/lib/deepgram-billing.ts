import 'server-only'

/**
 * What Deepgram actually charged this company for a minute of listening.
 *
 * Deepgram publishes no price list an application could read — the rate depends
 * on the contract behind the key. What it does publish is the bill: every
 * project can be asked what it was charged over a window, and how many hours it
 * transcribed in the same window. Money divided by minutes is this company's
 * real rate, measured rather than typed in, and it moves on its own when the
 * contract does.
 *
 * Nothing here is guessed. A project that has not transcribed anything yet has
 * no rate to report, and says so.
 */

const API = 'https://api.deepgram.com/v1'
const TIMEOUT_MS = 20_000

type DeepgramProject = { project_id: string; name?: string }

/** A billing breakdown row: what one line item cost over the window. */
type BillingResult = {
  total_amount?: number
  amount?: number
  results?: { amount?: number; total_amount?: number }[]
}

/** A usage breakdown row: how much audio was processed over the window. */
type UsageResult = {
  total_hours?: number
  results?: { total_hours?: number; hours?: number }[]
}

async function deepgram<T>(apiKey: string, path: string): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    headers: { authorization: `Token ${apiKey}`, accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!response.ok) {
    const detail = response.status === 401 || response.status === 403 ? ' — the key needs Member access or higher' : ''
    throw new Error(`Deepgram ${path} returned ${response.status}${detail}.`)
  }
  return (await response.json()) as T
}

/** Sum every amount the response carries, at either nesting the API uses. */
function sumAmounts(body: BillingResult): number {
  const rows = body.results ?? []
  const nested = rows.reduce((total, row) => total + (Number(row.amount ?? row.total_amount) || 0), 0)
  const top = Number(body.total_amount ?? body.amount) || 0
  return rows.length > 0 ? nested : top
}

function sumHours(body: UsageResult): number {
  const rows = body.results ?? []
  const nested = rows.reduce((total, row) => total + (Number(row.total_hours ?? row.hours) || 0), 0)
  const top = Number(body.total_hours) || 0
  return rows.length > 0 ? nested : top
}

const day = (date: Date): string => date.toISOString().slice(0, 10)

export type DeepgramRateMeasurement =
  | {
      ok: true
      usdPerMinute: number
      /** The window measured, as `YYYY-MM-DD…YYYY-MM-DD`, for the audit trail. */
      window: string
      billedUsd: number
      minutes: number
    }
  | { ok: false; message: string }

/**
 * Measure the company's Deepgram rate over the trailing window. Thirty days is
 * long enough that a single short call cannot skew it and short enough that a
 * contract change shows up within a billing cycle.
 */
export async function measureDeepgramRate(apiKey: string, days = 30): Promise<DeepgramRateMeasurement> {
  const end = new Date()
  const start = new Date(end.getTime() - days * 86_400_000)
  const window = `${day(start)}…${day(end)}`
  const range = `start=${day(start)}&end=${day(end)}`

  try {
    const { projects } = await deepgram<{ projects?: DeepgramProject[] }>(apiKey, '/projects')
    const project = projects?.[0]
    if (!project) return { ok: false, message: 'This key can see no Deepgram project.' }

    const [billing, usage] = await Promise.all([
      deepgram<BillingResult>(apiKey, `/projects/${project.project_id}/billing/breakdown?${range}`),
      deepgram<UsageResult>(apiKey, `/projects/${project.project_id}/usage/breakdown?${range}`),
    ])

    const billedUsd = sumAmounts(billing)
    const minutes = sumHours(usage) * 60
    if (minutes <= 0) {
      return {
        ok: false,
        message: `Deepgram transcribed nothing in the last ${days} days, so there is no rate to measure yet.`,
      }
    }
    if (billedUsd <= 0) {
      return {
        ok: false,
        message:
          'Deepgram reports no charges for this period — a trial credit or an enterprise plan bills elsewhere. Enter the rate from your agreement instead.',
      }
    }
    return { ok: true, usdPerMinute: billedUsd / minutes, window, billedUsd, minutes }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}
