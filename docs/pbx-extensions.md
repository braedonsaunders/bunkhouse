# The Front Desk — hands as PBX extensions (design, researched 2026-07-27)

Owner's epic: dial a hand from any desk phone on the office PBX — hands get extension
numbers like human employees. Reference deployment: **Avaya IP Office** (the owner runs
one). This extends voice-design.md; the LiveKit media plane, voice-worker, and
call_sessions ledger from that doc are assumed.

Verdict from the July-2026 survey: **LiveKit SIP is trunk-only — it cannot REGISTER to a
PBX as an extension** (INVITE-based peering with IP-allowlist or digest auth; REGISTER is
an open, unanswered feature request, livekit/sip#524, Nov 2025). So bunkhouse ships two
tenant-selectable modes: **(A) "PBX line"** — the PBX points a SIP trunk at bunkhouse's
SIP ingress and routes an extension range to it (preferred: zero extra containers,
LiveKit-native, no per-endpoint PBX licenses); **(B) "Registered extensions"** — a
minimal **Asterisk (PJSIP) bridge container** REGISTERs to the PBX as N extensions and
trunks the audio to LiveKit SIP (for tenants who can't or won't touch trunk config).
Asterisk wins the bridge choice over drachtio+rtpengine (two components + custom Node app
vs one config-driven container) and FreeSWITCH (heavier config, no need for its
concurrency here): PJSIP `registration` sections are exactly "act as N SIP clients", it
handles signaling *and* media in one battle-tested GPL container, and config is generated
deterministically from tenant settings.

## What the IP Office research established

**Option (a) — 3rd-party SIP extensions (mode B target).** IP Office registers non-Avaya
SIP endpoints against its built-in SIP Registrar. Each endpoint consumes one **3rd Party
IP Endpoint** license (R10+: "IP Office SIP Endpoint" PLDS license; subscription-mode
systems license per user) — **one license per hand**, consumed at registration, reservable
per-extension via "Reserve 3rd Party IP Endpoint License". Setup per extension: SIP
Extension record + User record; the user's Telephony → Supervisor Settings → **Login
Code is the SIP password**; auth name = extension number. System-level: LAN1/LAN2 → VoIP →
**SIP Registrar Enable** + registrar domain (changing registrar settings requires reboot).
Codec discipline matters: Avaya's own guide recommends narrowing the extension's Enabled
codecs to one — G.711 u-law/a-law is the safe floor. IP500 V2 needs VCM channel capacity.
DTMF RFC2833 (payload type 101 default). Registration expiry ~60s typical in interop
guides; the bridge must re-REGISTER and keep NAT pinholes alive.

**Option (b) — SIP Line to an external server (mode A target).** IP Office speaks a
plain SIP trunk to any IP: create a **SIP Line** with the ITSP/gateway address = the
far end, a **SIP URI channel** with a unique Incoming/Outgoing Group ID, a **short code**
routing the extension range out the line (documented Asterisk interop pattern: code
`7XX`, Feature *Dial*, Telephone Number `7N"@<host>"`, Line Group = the URI's group),
and an **Incoming Call Route** (Bearer: Any Voice, Line Group = same ID, Destination
`.` — the period passes dialed digits through; omitting it yields the classic 404 "no
match from URI"). Licensing: **SIP Trunk Channels** licenses cap concurrent trunk calls
(1/5/10/20 packs, consumed per call in progress, central on the Server Edition primary;
subscription-mode systems bundle SIP trunk entitlements) — so mode A needs *channels for
concurrent calls*, not per-hand licenses. Also verify System → Telephony → Maximum SIP
Sessions > 0.

**IP Office quirks (versions 11.1/12.x, from Avaya KB + Asterisk/FreePBX/3CX interop):**
R11.1+ is PLDS or subscription licensing; R12.0 (May 2024) moved Linux servers to Rocky
Linux; R12.3 added RFC 8760 SHA-256 digest (pre-12.3 registrar digest is MD5). TLS/SRTP
is supported on lines and extensions (SRTP "Best Effort/Preferred" recommended) but
third-party TLS interop is rough — a known defect has TLS SIP lines listening on
ephemeral ports (4096+) instead of 5061 — so the pilot runs UDP/TCP G.711 over
LAN/VPN/IP-allowlist; TLS is a hardening slice, not a prerequisite. Set per line:
RFC2833 payload 101 both ends; **Re-invite Supported** on; **direct media OFF** (media
must anchor at the ingress); **Check OOS** on (SIP OPTIONS keepalive — LiveKit answers
OPTIONS); Session Timer (RFC 4028, IP Office advertises `Supported: timer`) matched or
On-Demand both ends — mismatch is the "calls drop at 15/30 min" classic; **Inhibit
Off-Switch Forward/Transfer** must be OFF for transfers toward the trunk; **REFER
Support** Incoming/Outgoing = Auto (default On).

**LiveKit SIP today:** inbound trunks (auth = `allowed_addresses` IP allowlist and/or
digest on INVITE; optional allowed-number list), outbound trunks + CreateSIPParticipant
for dials, dispatch rules (individual/direct/callee — callee rules route by **called
number**, and the SIP participant carries `sip.trunkPhoneNumber`/`sip.phoneNumber`
attributes), TransferSIPParticipant issues **SIP REFER** (cold transfer; the trunk peer
must accept REFER — IP Office does), TLS+SRTP capable, self-hosted Go container sharing
Redis with the LiveKit server.

## Architecture

One shared `livekit-sip` ingress (already planned for carrier telephony in voice slice
2) serves PBX traffic too. **A PBX is just another `sip_trunks` row** with
`flavor: 'pbx_line' | 'pbx_extensions'` and `pbx_type: 'avaya_ip_office' | 'generic'` —
carriers and PBXes are config, not code.

- **Mode A (PBX line).** Tenant's IP Office SIP Line points at the bunkhouse ingress.
  Desk phone dials 701 → short code sends `701@ingress` down the line → LiveKit inbound
  trunk (matched by tenant's PBX source IP/credentials) → dispatch rule creates the call
  room → voice-worker reads the called number attribute, resolves **(trunk → tenant,
  called number → hand)** via the extension map, loads that hand's runtime context, and
  answers as the hand. Extension numbers are unique only per tenant; resolution is always
  trunk-scoped.
- **Mode B (registered extensions).** A bunkhouse-operated Asterisk container (one per
  deployment, multi-tenant via per-extension config) holds a PJSIP outbound
  `registration` per mapped hand against the tenant's IP Office registrar, using sealed
  per-extension credentials. Inbound: IP Office rings the registered contact → Asterisk
  dialplan bridges to the LiveKit inbound trunk carrying the extension as the called
  number → same dispatch path as mode A. The container's pjsip.conf is **generated from
  tenant settings** (template + reload, never hand-edited); registration state per
  extension is scraped and surfaced in the UI.
- **Outbound (hand → humans).** `place_call` to an internal extension uses the tenant's
  PBX trunk: mode A, CreateSIPParticipant dials `ext@ipoffice-host` via a LiveKit
  outbound trunk (IP Office's Incoming Call Route `.` destination routes the digits);
  mode B, Asterisk originates from the hand's registered identity. Caller ID: From-user =
  the hand's extension so desk phones show "701 — Junie (AR clerk)" once the IP Office
  user record names it; mode A callers see whatever the Incoming Call Route presents.
  Internal dials are still gated by the `phone_call` autonomy category.
- **Transfers to humans.** Hand says "let me get Dana" → tool call →
  TransferSIPParticipant REFERs the caller to Dana's extension over the same trunk; IP
  Office completes it (REFER Support Auto). The transfer is a `tool_call` turn in the
  ledger; the session ends `transferred`.
- **Ledger.** Every PBX call is a call_sessions row: `channel 'phone'`, `direction
  'inbound' | 'outbound'`, plus new columns `peer_kind 'pstn' | 'pbx_extension'` and
  `peer_extension`; counterparty renders as the extension/CLI and display name. Turns,
  recording, budget metering identical to carrier calls — the PBX is just a peer.

## Schema deltas (on top of voice-design.md)

sip_trunks + flavor 'carrier'|'pbx_line'|'pbx_extensions', pbx_type, pbx_config jsonb
  (host, port, transport, registrar domain), auth sealed
pbx_extensions(id, tenant_id, trunk_id, extension, person_id, auth sealed NULLABLE
  (mode B only), reg_status unregistered|registered|failed, reg_expires_at, last_error)
  -- unique (trunk_id, extension); THE extension map, one row per hand mapping
call_sessions + peer_kind pstn|pbx_extension, peer_extension

## Tenant UI (Settings → Voice → Phone system)

Under the `telephony` gate (dependent on `voice`), a Phone system subtab on
SettingsShell: PBX type select (Avaya IP Office / Generic SIP), mode radio (SIP line /
Registered extensions) with an honest explainer of the licensing difference (trunk
channels vs per-hand endpoint licenses), PBX host/transport, sealed credentials, and the
**extension map** — a RecordList of pbx_extensions rows (extension ⇄ hand picker,
registration status + last error in mode B), row drawer for credentials. The hand's
profile Voice section shows its own extension read/write (rehomed view of the same row —
one source of truth). A **Test call** button: mode A places a loopback INVITE to a
configured test extension and reports the SIP response chain; mode B shows live
registration state and re-registers on demand. Avaya-specific setup instructions render
inline per mode (the exact Manager checklist below). Env vs tenant: SIP ingress public
host/ports and the bridge container are deployment infra (env/compose); PBX addresses,
credentials, and extension maps are sealed tenant settings.

## Build order (each slice ships its UI)

1. **Mode A inbound.** sip_trunks flavor + pbx_extensions schema; Phone system settings
   subtab + extension map UI + hand-profile extension field; trunk-scoped
   called-number→hand resolution in the voice-worker dispatch path; call ledger
   peer_kind/peer_extension. Desk phone rings a hand.
   **SHIPPED (trunk-first first pass):** livekit-sip + media-redis in compose
   (`--dev` server now on the same redis bus); migration `0012_pbx` — sip_trunks
   (flavor avaya_ip_office|generic_sip, mode trunk|extension column reserved,
   host/port/transport, sealed auth, status/last_error, mirrored LiveKit ids,
   RLS) + `people.extension` (per-tenant partial unique) instead of a separate
   pbx_extensions table for this slice; lib/pbx.ts CRUD + reconstruct-on-save
   provisioning (inbound trunk + `pbx-` callee dispatch rule via SipClient);
   voice-agent answers `pbx-<ext>…` rooms, resolves the hand by extension, and
   creates the run + call_sessions row (direction inbound_phone) itself;
   Settings → Voice → Phone system drawer (Trunks / Extensions / Connection
   details subtabs, Avaya checklist) + Phone extension card on the hand's
   Voice tab; observatory labels the runs 'Inbound call'. Still open from this
   slice's full spec: peer_kind/peer_extension ledger columns, trunk-scoped
   (vs extension-global) resolution, and the Test call button.
2. **Outbound + transfers.** place_call to internal extensions over the PBX trunk
   (autonomy-gated), REFER transfer tool + `transferred` session outcome, caller-id
   mapping, Test call button.
3. **Mode B bridge.** Asterisk container in compose (deployment infra), pjsip.conf
   generation from pbx_extensions, registration-status scraping into reg_status,
   status/last-error surfaced in the extension map UI.
4. **Hardening.** TLS/SRTP option per trunk (with the IP Office caveats documented),
   OPTIONS-keepalive health on the trunk row (status, last_error), session-timer
   config surfaced, per-tenant ingress IP allowlist management.

## Pilot checklist — owner's IP Office (Manager), mode A

Must be verified against the real system; docs above are Avaya KB + interop folklore.
1. License check: SIP Trunk Channels instances ≥ desired concurrency; System →
   Telephony → Maximum SIP Sessions > 0; VCM capacity if IP500 V2.
2. New SIP Line: ITSP/gateway address = bunkhouse SIP ingress host; UDP or TCP 5060;
   codecs G.711 ULAW+ALAW only; RFC2833 payload 101; Re-invite Supported ON; direct
   media OFF; Check OOS ON; Session Timer On-Demand; REFER Incoming/Outgoing Auto;
   Inhibit Off-Switch Forward/Transfer OFF (System → Telephony).
3. SIP URI channel on the line, Incoming Group = Outgoing Group = e.g. 700, Max Sessions
   = licensed concurrency.
4. Short code: Code `7XX`, Feature Dial, Number `7N"@<ingress-host>"`, Line Group 700
   (pick a 7xx range clear of existing extensions).
5. Incoming Call Route: Bearer Any Voice, Line Group 700, Destination `.` (for
   hand-initiated outbound dials landing back on the PBX).
6. Network: IP Office → ingress reachability on 5060 + the RTP port range (LAN, VPN, or
   firewall allowlist both directions). Then dial 701 from a desk phone.
Mode B pilot instead: SIP Registrar Enable + domain (reboot), SIP Extension + User per
hand (Login Code = password), one 3rd Party IP Endpoint license per hand, reserve it on
the extension.

## Recommendation (5 lines)

Ship PBX reachability as trunk-first: mode A "PBX line" is the default — an IP Office
SIP Line to bunkhouse's existing LiveKit SIP ingress, a 7xx short-code range, and a
per-hand extension map; no new containers, no per-hand PBX licenses. Because LiveKit SIP
cannot REGISTER (trunk-only, confirmed July 2026), offer mode B via a config-generated
Asterisk PJSIP bridge only for tenants who can't touch trunk config. Pilot on the
owner's IP Office with the Manager checklist above, UDP/G.711 first, TLS later.

Key refs: livekit/sip#524 (REGISTER open request) + LiveKit SIP trunk/dispatch/transfer
docs; Avaya IP Office KB (Telephone/Endpoint Licenses, Trunk Licensing, REFER Support,
SIP Extension guide 9.x–12.x); Tek-Tips IP Office↔Asterisk SIP-line FAQ (short code /
incoming-call-route `.` pattern); 3CX/FreePBX interop threads (payload 101, Check OOS,
session-timer drops, TLS ephemeral-port defect); R12.x bulletins (Rocky Linux, RFC 8760).
