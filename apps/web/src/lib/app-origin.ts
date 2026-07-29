import 'server-only'
import { headers } from 'next/headers'

/**
 * Where this deployment answers from, as an origin (`https://host`).
 *
 * OAuth redirect URIs must be an absolute, externally reachable address, and
 * they must be byte-identical between the authorization request and the token
 * exchange — a provider compares them as strings. So this has to be right, and
 * it has to be the same answer twice.
 *
 * Resolution, in order:
 *
 * 1. `APP_URL`, when it is set to something non-blank. An operator who names
 *    the address explicitly always wins; this is the escape hatch for setups
 *    where the app sits behind something that rewrites Host.
 * 2. The incoming request, read from the proxy's forwarding headers. This is
 *    the normal path and needs no configuration at all.
 *
 * If neither can answer, this throws. It deliberately does not fall back to
 * localhost: a localhost redirect URI is refused by every serious provider, so
 * a fallback only converts a clear configuration error into a provider error
 * message that reveals nothing about the actual cause.
 */

/** Blank counts as absent — `APP_URL: ${APP_URL}` in compose with the variable
 *  unset reaches the process as an empty string, not as undefined. */
function configuredOrigin(): string | null {
  const value = process.env.APP_URL?.trim()
  if (!value) return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return url.origin
  } catch {
    return null
  }
}

/**
 * The origin of the request being served, per the reverse proxy in front of us.
 * `x-forwarded-host` wins over `host` because the latter is the internal
 * service name once a proxy has rewritten it.
 */
async function requestOrigin(): Promise<string | null> {
  let list: Awaited<ReturnType<typeof headers>>
  try {
    list = await headers()
  } catch {
    // No request in scope — a worker tick or a scheduled job.
    return null
  }
  const forwardedHost = list.get('x-forwarded-host')?.split(',')[0]?.trim()
  const host = forwardedHost || list.get('host')?.trim()
  if (!host) return null
  // A proxy terminating TLS forwards the original scheme; without one we are
  // being reached directly, which in practice only happens in local dev.
  const proto = list.get('x-forwarded-proto')?.split(',')[0]?.trim() || (host.startsWith('localhost') ? 'http' : 'https')
  try {
    return new URL(`${proto}://${host}`).origin
  } catch {
    return null
  }
}

export async function appOrigin(): Promise<string> {
  const configured = configuredOrigin()
  if (configured) return configured
  const derived = await requestOrigin()
  if (derived) return derived
  throw new Error(
    'This deployment’s public address could not be determined from the request. Set APP_URL to the address operators reach this app on, for example https://bunkhouse.example.com.',
  )
}

/** An absolute URL on this deployment, for a path that must be reachable from
 *  outside — an OAuth callback, a webhook, a link in an email. */
export async function appUrl(path: string): Promise<string> {
  const origin = await appOrigin()
  return `${origin}${path.startsWith('/') ? path : `/${path}`}`
}
