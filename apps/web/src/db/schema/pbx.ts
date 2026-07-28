import { index, integer, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { auditColumns, id, tenantRef } from '@appkit/db'
import type { SealedSecret } from '@appkit/crypto'

/**
 * The phone system: a tenant's PBX (or any SIP peer) is a sip_trunks row —
 * config, not code. In 'trunk' mode the PBX points a SIP line at the
 * bunkhouse SIP ingress and routes an extension range to it; agents are
 * reached by their extension on people.extension. In 'extension' mode the
 * phone system will not take a trunk, so the bridge REGISTERs to it as one
 * endpoint per agent — those endpoints are the pbx_extensions rows below.
 *
 * Provisioning: an active trunk is mirrored to a LiveKit SIP inbound trunk
 * plus a callee dispatch rule (rooms `pbx-<extension>…`); the mirrored ids
 * are stored so re-provisioning is deterministic and idempotent.
 */
export const sipTrunkFlavor = pgEnum('sip_trunk_flavor', ['avaya_ip_office', 'generic_sip'])
export const sipTrunkMode = pgEnum('sip_trunk_mode', ['trunk', 'extension'])
export const sipTransport = pgEnum('sip_transport', ['udp', 'tcp', 'tls'])
export const sipTrunkStatus = pgEnum('sip_trunk_status', ['unconfigured', 'active', 'error'])
/** Media encryption on the line: off, offered and used when the far end
 *  accepts it, or mandatory — calls fail rather than run in the clear. */
export const sipSrtpMode = pgEnum('sip_srtp_mode', ['disabled', 'best_effort', 'required'])
/** What the last SIP OPTIONS keepalive found on the line. */
export const sipTrunkHealth = pgEnum('sip_trunk_health', ['unknown', 'ok', 'unreachable'])

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
    /** Media encryption offered to the phone system on this line. */
    srtp: sipSrtpMode('srtp').notNull().default('disabled'),
    /** RFC 4028 session-expiry to match the phone system's own line setting;
     *  null leaves the timer unset. A mismatch is what drops calls at 15 or
     *  30 minutes. */
    sessionTimerSeconds: integer('session_timer_seconds'),
    /** Every address this trunk may be INVITEd from — pushed to the SIP
     *  ingress as the inbound trunk's allowlist. Empty accepts any source
     *  the credentials authenticate. */
    allowedAddresses: text('allowed_addresses').array().notNull().default([]),
    /** The extension the Test call button dials on this phone system. */
    testExtension: text('test_extension'),
    status: sipTrunkStatus('status').notNull().default('unconfigured'),
    lastError: text('last_error'),
    /** SIP OPTIONS keepalive result, its detail (the response line or the
     *  failure), and when the phone system last answered. */
    health: sipTrunkHealth('health').notNull().default('unknown'),
    healthDetail: text('health_detail'),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
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

/** Whether the bridge currently holds a registration for the extension. */
export const pbxExtensionRegStatus = pgEnum('pbx_extension_reg_status', [
  'unregistered',
  'registered',
  'failed',
])

/**
 * The extension map for registered-extension mode: one row per agent endpoint
 * the bridge REGISTERs to the tenant's phone system. The phone system holds a
 * SIP extension and a user record for each one, and its login code is the
 * sealed password here; the bridge renders its configuration from these rows
 * and writes the registration state back onto them.
 *
 * Extensions are unique per trunk — a company may run more than one phone
 * system, and extension numbering is that system's own.
 */
export const pbxExtensions = pgTable(
  'pbx_extensions',
  {
    id: id(),
    tenantId: tenantRef(),
    /** The phone system this endpoint registers to. */
    trunkId: uuid('trunk_id').notNull(),
    /** The dialable code on that phone system, e.g. '701'. */
    extension: text('extension').notNull(),
    /** The agent that answers it. */
    personId: uuid('person_id').notNull(),
    /** SIP auth name — the extension number on Avaya IP Office. */
    authUsername: text('auth_username'),
    /** The endpoint's own password (IP Office: the user's login code). */
    sealedAuthPassword: jsonb('sealed_auth_password').$type<SealedSecret>(),
    regStatus: pbxExtensionRegStatus('reg_status').notNull().default('unregistered'),
    regExpiresAt: timestamp('reg_expires_at', { withTimezone: true }),
    lastError: text('last_error'),
    ...auditColumns,
  },
  (t) => [
    index('pbx_extensions_tenant_idx').on(t.tenantId),
    uniqueIndex('pbx_extensions_trunk_extension_key').on(t.trunkId, t.extension),
    index('pbx_extensions_person_idx').on(t.tenantId, t.personId),
  ],
)

export const PBX_TENANT_TABLES = ['sip_trunks', 'phone_numbers', 'pbx_extensions'] as const
