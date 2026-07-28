import { index, integer, jsonb, pgEnum, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { auditColumns, id, tenantRef } from '@appkit/db'
import type { SealedSecret } from '@appkit/crypto'

/**
 * The phone system: a tenant's PBX (or any SIP peer) is a sip_trunks row —
 * config, not code. In 'trunk' mode the PBX points a SIP line at the
 * bunkhouse SIP ingress and routes an extension range to it; agents are
 * reached by their extension on people.extension. 'extension' mode (the
 * agent REGISTERing to the PBX as a endpoint) shares this table and lands
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

/**
 * Real phone numbers agents answer. A carrier (Twilio, Telnyx, a PBX DID)
 * delivers the call over a sip_trunks connection with the dialed number as
 * the callee; this table maps that number to the agent who picks up. The
 * number is stored as bare digits (E.164 without '+') — the one shape every
 * carrier's callee header normalizes to.
 */
export const phoneNumbers = pgTable(
  'phone_numbers',
  {
    id: id(),
    tenantId: tenantRef(),
    /** E.164 digits, no '+', e.g. 15551234567. */
    number: text('number').notNull(),
    /** Operator-facing label, e.g. "Main line" or "+1 (555) 123-4567". */
    label: text('label').notNull(),
    personId: uuid('person_id').notNull(),
    ...auditColumns,
  },
  (t) => [
    index('phone_numbers_tenant_idx').on(t.tenantId),
    uniqueIndex('phone_numbers_tenant_number_key').on(t.tenantId, t.number),
  ],
)

export const PBX_TENANT_TABLES = ['sip_trunks', 'phone_numbers'] as const
