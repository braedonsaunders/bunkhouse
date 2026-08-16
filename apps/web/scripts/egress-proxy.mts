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

const proxy = createEgressProxy({
  policy,
  audit,
  listen: { host: HOST, port: PORT },
})

const bound = await proxy.listen()
console.log(
  `[egress-proxy] listening on ${bound.host}:${bound.port}; ports allowed: ${[...ALLOWED_PORTS].join(', ')}`,
)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void proxy.close().finally(() => process.exit(0))
  })
}
