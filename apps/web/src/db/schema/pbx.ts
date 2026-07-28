import { index, integer, jsonb, pgEnum, pgTable, text } from 'drizzle-orm/pg-core'
import { auditColumns, id, tenantRef } from '@appkit/db'
import type { SealedSecret } from '@appkit/crypto'

/**
 * The phone system: a tenant's PBX (or any SIP peer) is a sip_trunks row —
 * config, not code. In 'trunk' mode the PBX points a SIP line at the
 * bunkhouse SIP ingress and routes an extension range to it; hands are
 * reached by their extension on people.extension. 'extension' mode (the
 * hand REGISTERing to the PBX as a endpoint) shares this table and lands
 * in a later slice — the column exists so rows never migrate shape.
 *
 * Provisioning: an active trunk is mirrored to a LiveKit SIP inbound trunk
 * plus a callee dispatch rule (rooms `pbx-<extension>…`); the mirrored ids
 * are stored so re-provisioning is deterministic and idempotent.
 */
export const sipTrunkFlavor = pgEnum('sip_trunk_flavor', ['avaya_ip_office', 'generic_sip'])
export const sipTrunkMode = pgEnum('sip_trunk_mode', ['trunk', 'extension'])
export const sipTransport = pgEnum('sip_transport', ['udp', 'tcp', 'tls'])
export const sipTrunkStatus = pgEnum('sip_trunk_status', ['unconfigured', 'active', 'error'])

export const sipTrunks = pgTable(
  'sip_trunks',
  {
    id: id(),
    tenantId: tenantRef(),
    name: text('name').notNull(),
    flavor: sipTrunkFlavor('flavor').notNull().default('generic_sip'),
    mode: sipTrunkMode('mode').notNull().default('trunk'),
    /** The PBX's own address — used as the inbound source allowlist. */
    pbxHost: text('pbx_host'),
    pbxPort: integer('pbx_port').notNull().default(5060),
    transport: sipTransport('transport').notNull().default('udp'),
    /** Optional SIP digest auth the PBX presents on INVITE. */
    authUsername: text('auth_username'),
    sealedAuthPassword: jsonb('sealed_auth_password').$type<SealedSecret>(),
    /** Operator hint for the routed range, e.g. '7XX'. */
    extensionRange: text('extension_range'),
    status: sipTrunkStatus('status').notNull().default('unconfigured'),
    lastError: text('last_error'),
    /** Mirrored LiveKit SIP objects (inbound trunk + callee dispatch rule). */
    livekitTrunkId: text('livekit_trunk_id'),
    livekitDispatchRuleId: text('livekit_dispatch_rule_id'),
    ...auditColumns,
  },
  (t) => [index('sip_trunks_tenant_idx').on(t.tenantId)],
)

export const PBX_TENANT_TABLES = ['sip_trunks'] as const
