import {
  createEgressProxy,
  isPublicHostname,
  isPublicIpAddress,
  normalizeOutboundHostname,
  type EgressAuditEntry,
  type EgressPolicyRequest,
} from '@appkit/egress-proxy'

/**
 * The egress chokepoint for every desk (docs/agent-desk.md §3.11). All guest
 * traffic is DNAT'd here at the TAP device by the desk-runner's network glue,
 * so the guest cannot opt out — there is no proxy setting to unset, and it
 * covers every application including the ones that ignore HTTP_PROXY. That
 * placement is the point: the agent has a root shell inside the guest, so
 * enforcement lives outside the boundary the agent controls.
 *
 * The policy is bunkhouse's public-host rule — the same posture as
 * `assertPublicHost` in apps/web/src/lib/research.ts, expressed with this
 * package's own fail-closed primitives rather than by importing the app
 * (research.ts drags server-only and the database; this process owns neither
 * a database URL nor a secret beyond its port). Name-level checks here;
 * `resolvePublicUpstream` (the package default) re-checks every resolved
 * address, so a public name pointing at a private address is still refused.
 *
 * A per-tenant allowlist layers on later as an env/config input — the policy
 * function below is the seam it slots into.
 *
 * Audit: structured JSON lines on stdout, one per decision/flow. Denials are
 * log-only in this slice — draining them into desk_events (kind
 * 'egress_blocked') needs the principal→desk mapping the tap addressing glue
 * owns, and that wiring lands with it. The chokepoint itself enforces today.
 */

const PORT = Number(process.env.PORT ?? 3128)
const HOST = process.env.BUNKHOUSE_EGRESS_LISTEN ?? '0.0.0.0'
/**
 * The two TRANSPARENT listeners, one per pre-DNAT port. The desk-runner sends
 * guest :80 to the first and guest :443 to the second (§3.11).
 *
 * Why two rather than one: the package recovers a transparent flow's
 * destination NAME from the TLS ClientHello's SNI or the plain-HTTP Host
 * header, but the destination PORT has to come from somewhere, and node
 * cannot read SO_ORIGINAL_DST off a DNAT'd socket. So the port is carried by
 * WHICH listener the flow arrived on: each one is created with the pre-DNAT
 * port it serves, and the policy sees the port the guest actually asked for
 * rather than a guess. A Host header that names its own port still wins on
 * the plain-HTTP listener, and a port outside the allowlist is denied — so
 * lying about it does not buy the guest anything.
 */
const TRANSPARENT_HTTP_PORT = Number(process.env.BUNKHOUSE_EGRESS_HTTP_PORT ?? 3129)
const TRANSPARENT_HTTPS_PORT = Number(process.env.BUNKHOUSE_EGRESS_HTTPS_PORT ?? 3130)
/** Destination ports guests may reach. Everything else is refused. */
const ALLOWED_PORTS = new Set(
  (process.env.BUNKHOUSE_EGRESS_ALLOW_PORTS ?? '80,443')
    .split(',')
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isInteger(value) && value > 0 && value < 65_536),
)

function policy(request: EgressPolicyRequest): 'allow' | 'deny' {
  if (!ALLOWED_PORTS.has(request.port)) return 'deny'
  let hostname: string
  try {
    hostname = normalizeOutboundHostname(request.host)
  } catch {
    return 'deny'
  }
  // An IP literal must itself be public; a name must not be reserved for
  // local or private use. The default upstream resolver then rejects any
  // name whose answer set includes a private address.
  if (/^[0-9.]+$/.test(hostname) || hostname.includes(':')) {
    return isPublicIpAddress(hostname) ? 'allow' : 'deny'
  }
  return isPublicHostname(hostname) ? 'allow' : 'deny'
}

function audit(entry: EgressAuditEntry): void {
  // One JSON line per entry; the deployment's log shipper takes it from here.
  console.log(JSON.stringify({ source: 'egress-proxy', ...entry }))
}

/**
 * The guest a flow belongs to, as its source address. The desk-runner numbers
 * each desk's tap from one template (BUNKHOUSE_GUEST_ADDR_TEMPLATE) and this
 * process shares its network namespace, so the peer address of a DNAT'd
 * socket IS the guest — nothing the guest can set travels in it.
 */
function principalFor(socket: { remoteAddress?: string | undefined }): string | null {
  const address = socket.remoteAddress
  if (!address) return null
  // Node reports v4 peers on a dual-stack listener in v4-mapped form.
  return address.replace(/^::ffff:/, '')
}

const listeners = [
  // Explicit proxying and CONNECT, for anything configured to use a proxy.
  { role: 'explicit', port: PORT, options: {} },
  { role: 'transparent-http', port: TRANSPARENT_HTTP_PORT, options: { transparentHttpPort: 80 } },
  { role: 'transparent-https', port: TRANSPARENT_HTTPS_PORT, options: { transparentHttpsPort: 443 } },
] as const

const proxies = listeners.map(({ role, port, options }) => ({
  role,
  port,
  handle: createEgressProxy({ policy, audit, principalFor, listen: { host: HOST, port }, ...options }),
}))

for (const { role, handle } of proxies) {
  const bound = await handle.listen()
  console.log(`[egress-proxy] ${role} on ${bound.host}:${bound.port}`)
}
console.log(`[egress-proxy] ports allowed: ${[...ALLOWED_PORTS].join(', ')}`)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void Promise.all(proxies.map(({ handle }) => handle.close())).finally(() => process.exit(0))
  })
}
