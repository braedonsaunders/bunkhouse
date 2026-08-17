import type { RunEvent, RunSink } from './types'

/** The marker used everywhere a protected credential was removed. */
export const REDACTED_SECRET = '[redacted]'

/**
 * Normalize once per run. Longest-first matters when one credential contains
 * another (an Authorization header and its bearer token, for example).
 */
export function normalizeSecrets(secrets: readonly string[]): string[] {
  return [...new Set(secrets.map((secret) => secret.trim()).filter(Boolean))].sort(
    (left, right) => right.length - left.length,
  )
}

/** Remove every exact protected value from text without regular expressions. */
export function redactSecrets(value: string, secrets: readonly string[]): string {
  let safe = value
  for (const secret of normalizeSecrets(secrets)) safe = safe.split(secret).join(REDACTED_SECRET)
  return safe
}

/** Tripwire used before an ability is allowed to carry data outside the loop. */
export function containsSecret(value: unknown, secrets: readonly string[]): boolean {
  const normalized = normalizeSecrets(secrets)
  if (normalized.length === 0) return false
  return containsSecretValue(value, normalized, new WeakSet<object>())
}

function containsSecretValue(value: unknown, secrets: readonly string[], seen: WeakSet<object>): boolean {
  if (typeof value === 'string') return secrets.some((secret) => value.includes(secret))
  if (value === null || typeof value !== 'object') return false
  if (seen.has(value)) return false
  seen.add(value)
  if (Array.isArray(value)) return value.some((item) => containsSecretValue(item, secrets, seen))
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (secrets.some((secret) => key.includes(secret))) return true
    if (containsSecretValue(item, secrets, seen)) return true
  }
  return false
}

/** Redact a JSON-shaped value without mutating the adapter's object. */
export function redactSecretValue<T>(value: T, secrets: readonly string[]): T {
  const normalized = normalizeSecrets(secrets)
  if (normalized.length === 0) return value
  return redactValue(value, normalized, new WeakSet<object>()) as T
}

function redactValue(value: unknown, secrets: readonly string[], seen: WeakSet<object>): unknown {
  if (typeof value === 'string') return redactSecrets(value, secrets)
  if (value === null || typeof value !== 'object') return value
  if (seen.has(value)) return '[circular]'
  seen.add(value)
  if (Array.isArray(value)) return value.map((item) => redactValue(item, secrets, seen))
  const safe: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    safe[redactSecrets(key, secrets)] = redactValue(item, secrets, seen)
  }
  return safe
}

/**
 * Redact an arbitrarily chunked text stream. It retains only the suffix that
 * could still become the beginning of a protected value, so a credential split
 * between provider deltas is never emitted in pieces.
 *
 * The streaming-boundary technique is derived from Rakazo's Apache-2.0
 * implementation (packages/core/src/events.ts, elie222/rakazo).
 */
export function createStreamingRedactor(secrets: readonly string[]): {
  push(chunk: string): string
  finish(): string
} {
  const values = normalizeSecrets(secrets)
  const longest = values[0]?.length ?? 0
  let pending = ''

  const drain = (final: boolean): string => {
    if (values.length === 0) {
      const output = pending
      pending = ''
      return output
    }
    const safeBoundary = final ? pending.length : Math.max(0, pending.length - longest + 1)
    let cursor = 0
    let output = ''
    while (cursor < safeBoundary) {
      const matched = values.find((secret) => pending.startsWith(secret, cursor))
      if (matched) {
        output += REDACTED_SECRET
        cursor += matched.length
      } else {
        output += pending[cursor]
        cursor += 1
      }
    }
    pending = pending.slice(cursor)
    return output
  }

  return {
    push(chunk) {
      pending += chunk
      return drain(false)
    },
    finish() {
      return drain(true)
    },
  }
}

/** Last-line protection for every append-only run event sink. */
export function createRedactingSink(sink: RunSink, secrets: readonly string[]): RunSink {
  const normalized = normalizeSecrets(secrets)
  if (normalized.length === 0) return sink
  return {
    event: (event: RunEvent) => sink.event(redactSecretValue(event, normalized)),
    spend: sink.spend,
  }
}
