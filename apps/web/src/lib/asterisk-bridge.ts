import 'server-only'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { connect, type Socket } from 'node:net'

/**
 * The registered-extensions bridge (mode B).
 *
 * LiveKit SIP is trunk-only — it cannot REGISTER to a phone system as an
 * endpoint — so companies whose phone system will not take a SIP line get a
 * small Asterisk (PJSIP) container instead: it REGISTERs once per mapped
 * agent, and bridges each answered call to the SIP ingress with the dialled
 * extension as the callee, landing on exactly the same dispatch path as a
 * trunk call.
 *
 * The container is never hand-edited. Its whole configuration is rendered
 * from the pbx_extensions rows by the pure functions below, written to the
 * directory the container mounts, and reloaded over the Asterisk Manager
 * Interface — the same reconstruct-on-save discipline the LiveKit mirror
 * uses. Registration state is read back over AMI and stamped on the rows.
 */

// ---------------------------------------------------------------------------
// Deployment infrastructure — where the bridge lives, not what it does
// ---------------------------------------------------------------------------

export type BridgeDeployment = {
  /** Directory the container mounts as its configuration. */
  configDir: string
  /** host:port the bridge sends bridged calls to — the SIP ingress. */
  ingress: string
  /** SIP port the bridge listens on. Not 5060: the SIP ingress already
   *  publishes that on the deployment's host. */
  bindPort: number
  /** RTP port range the bridge anchors media on, clear of the ingress range. */
  rtpPorts: { start: number; end: number }
  ami: { host: string; port: number; username: string; password: string } | null
}

/** Deployment settings for the bridge, or null when it is not deployed here. */
export function bridgeDeployment(): BridgeDeployment | null {
  const configDir = process.env.BUNKHOUSE_BRIDGE_CONFIG_DIR
  if (!configDir) return null
  const amiHost = process.env.BUNKHOUSE_BRIDGE_AMI_HOST
  const amiUser = process.env.BUNKHOUSE_BRIDGE_AMI_USERNAME
  const amiPassword = process.env.BUNKHOUSE_BRIDGE_AMI_PASSWORD
  const amiPort = Number(process.env.BUNKHOUSE_BRIDGE_AMI_PORT ?? 5038)
  const bindPort = Number(process.env.BUNKHOUSE_BRIDGE_SIP_PORT ?? 5070)
  const rtpStart = Number(process.env.BUNKHOUSE_BRIDGE_RTP_START ?? 10100)
  const rtpEnd = Number(process.env.BUNKHOUSE_BRIDGE_RTP_END ?? 10109)
  return {
    configDir,
    ingress: process.env.BUNKHOUSE_BRIDGE_SIP_INGRESS ?? 'livekit-sip:5060',
    bindPort: Number.isInteger(bindPort) ? bindPort : 5070,
    rtpPorts: {
      start: Number.isInteger(rtpStart) ? rtpStart : 10100,
      end: Number.isInteger(rtpEnd) && rtpEnd > rtpStart ? rtpEnd : 10109,
    },
    ami:
      amiHost && amiUser && amiPassword && Number.isInteger(amiPort)
        ? { host: amiHost, port: amiPort, username: amiUser, password: amiPassword }
        : null,
  }
}

// ---------------------------------------------------------------------------
// Configuration rendering — pure
// ---------------------------------------------------------------------------

/** One mapped agent endpoint, with its credentials already unsealed. */
export type BridgeExtension = {
  id: string
  tenantId: string
  trunkId: string
  /** The trunk's name, for readable comments in the generated file. */
  trunkName: string
  extension: string
  /** The agent that answers, for readable comments. */
  personName: string
  pbxHost: string
  pbxPort: number
  transport: 'udp' | 'tcp' | 'tls'
  srtp: 'disabled' | 'best_effort' | 'required'
  sessionTimerSeconds: number | null
  authUsername: string | null
  authPassword: string | null
}

export type BridgeRenderInput = {
  extensions: BridgeExtension[]
  /** host:port of the SIP ingress the bridge hands calls to. */
  ingress: string
  /** Port the bridge's SIP transports bind to. */
  bindPort: number
  /** RTP range the bridge anchors media on. */
  rtpPorts: { start: number; end: number }
}

/** Section prefix for one extension row — stable for the row's whole life. */
function sectionName(extension: BridgeExtension): string {
  return `bh-${extension.id}`
}

/** Deterministic order: same rows in, byte-identical file out. */
function ordered(extensions: BridgeExtension[]): BridgeExtension[] {
  return [...extensions].sort(
    (a, b) =>
      a.tenantId.localeCompare(b.tenantId) ||
      a.trunkId.localeCompare(b.trunkId) ||
      a.extension.localeCompare(b.extension, 'en', { numeric: true }),
  )
}

const SRTP_MEDIA_ENCRYPTION: Record<BridgeExtension['srtp'], string> = {
  disabled: 'no',
  best_effort: 'sdes',
  required: 'sdes',
}

/** Extensions dialable out of exactly one trunk; the rest are ambiguous. */
function uniqueByExtension(extensions: BridgeExtension[]): Map<string, BridgeExtension | null> {
  const seen = new Map<string, BridgeExtension | null>()
  for (const entry of extensions) {
    seen.set(entry.extension, seen.has(entry.extension) ? null : entry)
  }
  return seen
}

/**
 * The bridge's PJSIP configuration: one outbound registration, auth, endpoint
 * and AOR per mapped agent, plus the endpoint that carries calls to the SIP
 * ingress. Pure and deterministic — identical rows render an identical file,
 * so publishing is safe to repeat.
 */
export function renderPjsipConfig(input: BridgeRenderInput): string {
  const rows = ordered(input.extensions)
  const lines: string[] = [
    '; Generated by bunkhouse from the phone system extension map.',
    '; Edits here are overwritten on the next save — change the extension map',
    '; in Settings → Voice → Phone system instead.',
    '',
    '[global]',
    'type=global',
    'user_agent=bunkhouse',
    'endpoint_identifier_order=ip,username,anonymous',
    '',
    '[transport-udp]',
    'type=transport',
    'protocol=udp',
    `bind=0.0.0.0:${input.bindPort}`,
    '',
    '[transport-tcp]',
    'type=transport',
    'protocol=tcp',
    `bind=0.0.0.0:${input.bindPort}`,
    '',
    '; The SIP ingress. Answered calls are bridged here with the dialled',
    '; extension as the callee, so they land on the same dispatch rule a',
    '; trunk call does.',
    '[livekit]',
    'type=endpoint',
    'context=from-livekit',
    'disallow=all',
    'allow=ulaw',
    'allow=alaw',
    'dtmf_mode=rfc4733',
    'direct_media=no',
    'rtp_symmetric=yes',
    'force_rport=yes',
    'aors=livekit',
    '',
    '[livekit]',
    'type=aor',
    `contact=sip:${input.ingress}`,
    'qualify_frequency=60',
    '',
    '[livekit]',
    'type=identify',
    'endpoint=livekit',
    `match=${input.ingress.split(':')[0]}`,
    '',
  ]

  for (const row of rows) {
    const name = sectionName(row)
    const authUser = row.authUsername?.trim() || row.extension
    const server = `${row.pbxHost}:${row.pbxPort}`
    const transport = row.transport === 'tcp' || row.transport === 'tls' ? 'transport-tcp' : 'transport-udp'
    lines.push(
      `; ${row.personName} — extension ${row.extension} on ${row.trunkName}`,
      `[${name}]`,
      'type=auth',
      'auth_type=userpass',
      `username=${authUser}`,
      `password=${row.authPassword ?? ''}`,
      '',
      `[${name}]`,
      'type=aor',
      `contact=sip:${server}`,
      'qualify_frequency=60',
      '',
      `[${name}]`,
      'type=registration',
      `transport=${transport}`,
      `outbound_auth=${name}`,
      `server_uri=sip:${server}`,
      `client_uri=sip:${row.extension}@${row.pbxHost}`,
      `contact_user=${row.extension}`,
      // IP Office's registrar expires registrations in about a minute; a
      // two-minute expiry with a one-minute retry keeps the binding and the
      // NAT pinhole alive without hammering the registrar.
      'expiration=120',
      'retry_interval=60',
      'forbidden_retry_interval=300',
      'max_retries=0',
      'line=yes',
      `endpoint=${name}`,
      '',
      `[${name}]`,
      'type=endpoint',
      `context=${name}-in`,
      'disallow=all',
      'allow=ulaw',
      'allow=alaw',
      'dtmf_mode=rfc4733',
      'direct_media=no',
      'rtp_symmetric=yes',
      'force_rport=yes',
      'rewrite_contact=yes',
      `transport=${transport}`,
      `from_user=${row.extension}`,
      `aors=${name}`,
      `auth=${name}`,
      `outbound_auth=${name}`,
      `media_encryption=${SRTP_MEDIA_ENCRYPTION[row.srtp]}`,
      ...(row.srtp === 'best_effort' ? ['media_encryption_optimistic=yes'] : []),
      ...(row.sessionTimerSeconds
        ? ['timers=yes', `timers_sess_expires=${row.sessionTimerSeconds}`, 'timers_min_se=90']
        : ['timers=no']),
      '',
      `[${name}]`,
      'type=identify',
      `endpoint=${name}`,
      `match=${row.pbxHost}`,
      '',
    )
  }

  return `${lines.join('\n')}\n`
}

/**
 * The bridge dialplan: a desk phone dialling a registered extension is bridged
 * straight to the ingress as that extension; a call the ingress places leaves
 * by the registration belonging to the agent that placed it.
 */
export function renderBridgeDialplan(input: BridgeRenderInput): string {
  const rows = ordered(input.extensions)
  const unique = uniqueByExtension(rows)
  const lines: string[] = [
    '; Generated by bunkhouse from the phone system extension map.',
    '; Edits here are overwritten on the next save.',
    '',
    '[from-livekit]',
    '; Outbound: the agent placing the call is the caller id; its own',
    '; registration is the line the call leaves by.',
    'exten => _.,1,NoOp(bunkhouse outbound ${EXTEN} from ${CALLERID(num)})',
    ' same => n,Set(BH_TARGET=${EXTEN})',
    ' same => n,Goto(bh-outbound,${CALLERID(num)},1)',
    '',
    '[bh-outbound]',
  ]
  if (rows.length === 0) {
    lines.push('; No extensions are mapped yet.', 'exten => _.,1,Hangup(38)', '')
  } else {
    for (const [extension, row] of [...unique.entries()].sort((a, b) =>
      a[0].localeCompare(b[0], 'en', { numeric: true }),
    )) {
      if (!row) {
        lines.push(
          `; ${extension} is mapped on more than one phone system — a call out of it`,
          '; cannot be routed to one of them without guessing.',
          `exten => ${extension},1,Hangup(38)`,
        )
        continue
      }
      lines.push(`exten => ${extension},1,Dial(PJSIP/\${BH_TARGET}@${sectionName(row)},45)`)
      lines.push(' same => n,Hangup()')
    }
    lines.push('exten => _.,1,Hangup(38)', '')
  }

  for (const row of rows) {
    const name = sectionName(row)
    lines.push(
      `; ${row.personName} — extension ${row.extension} on ${row.trunkName}`,
      `[${name}-in]`,
      `exten => _.,1,NoOp(bunkhouse inbound to ${row.extension} from \${CALLERID(num)})`,
      ` same => n,Dial(PJSIP/${row.extension}@livekit,45)`,
      ' same => n,Hangup()',
      '',
    )
  }
  return `${lines.join('\n')}\n`
}

/** Manager interface, so registration state can be read and config reloaded. */
function renderManagerConfig(ami: BridgeDeployment['ami']): string {
  if (!ami) {
    return [
      '; Generated by bunkhouse. The manager interface is disabled because no',
      '; credentials are configured for this deployment.',
      '',
      '[general]',
      'enabled=no',
      '',
    ].join('\n')
  }
  return [
    '; Generated by bunkhouse — the interface registration status is read over.',
    '',
    '[general]',
    'enabled=yes',
    'webenabled=no',
    `port=${ami.port}`,
    'bindaddr=0.0.0.0',
    '',
    `[${ami.username}]`,
    `secret=${ami.password}`,
    'deny=0.0.0.0/0.0.0.0',
    // The bridge is reachable only on the deployment's private network.
    'permit=10.0.0.0/255.0.0.0',
    'permit=172.16.0.0/255.240.0.0',
    'permit=192.168.0.0/255.255.0.0',
    'read=system,call,reporting',
    'write=system,call,reporting',
    '',
  ].join('\n')
}

function renderAsteriskConfig(): string {
  return [
    '; Generated by bunkhouse.',
    '',
    '[directories](!)',
    'astetcdir => /etc/asterisk',
    'astmoddir => /usr/lib/asterisk/modules',
    'astvarlibdir => /var/lib/asterisk',
    'astdbdir => /var/lib/asterisk',
    'astkeydir => /var/lib/asterisk',
    'astdatadir => /var/lib/asterisk',
    'astagidir => /var/lib/asterisk/agi-bin',
    'astspooldir => /var/spool/asterisk',
    'astrundir => /var/run/asterisk',
    'astlogdir => /var/log/asterisk',
    '',
    '[options]',
    'documentation_language = en_US',
    'verbose = 3',
    'debug = 0',
    '',
  ].join('\n')
}

function renderLoggerConfig(): string {
  return ['; Generated by bunkhouse.', '', '[logfiles]', 'console => notice,warning,error', '', ''].join('\n')
}

/** Media ports, kept clear of the SIP ingress's own published range. */
function renderRtpConfig(rtpPorts: BridgeRenderInput['rtpPorts']): string {
  return [
    '; Generated by bunkhouse.',
    '',
    '[general]',
    `rtpstart=${rtpPorts.start}`,
    `rtpend=${rtpPorts.end}`,
    '',
  ].join('\n')
}

export type BridgeConfigFiles = Record<string, string>

/**
 * Every file the bridge container reads, rendered together. Returned as a map
 * so publishing is a plain write of each entry — and so the whole set can be
 * diffed or asserted on without touching a filesystem.
 */
export function renderBridgeConfig(input: BridgeRenderInput, ami: BridgeDeployment['ami']): BridgeConfigFiles {
  return {
    'asterisk.conf': renderAsteriskConfig(),
    'logger.conf': renderLoggerConfig(),
    'manager.conf': renderManagerConfig(ami),
    'rtp.conf': renderRtpConfig(input.rtpPorts),
    'pjsip.conf': renderPjsipConfig(input),
    'extensions.conf': renderBridgeDialplan(input),
  }
}

// ---------------------------------------------------------------------------
// Publishing
// ---------------------------------------------------------------------------

export type PublishResult =
  | { published: true; changed: boolean; reloaded: boolean; detail: string }
  | { published: false; detail: string }

/**
 * Write the rendered configuration where the container reads it, and ask
 * Asterisk to reload when anything changed. Writing is idempotent: identical
 * rows produce identical bytes, so an unchanged publish is a no-op.
 */
export async function publishBridgeConfig(input: BridgeRenderInput): Promise<PublishResult> {
  const deployment = bridgeDeployment()
  if (!deployment) {
    return {
      published: false,
      detail: 'The extension bridge is not part of this deployment, so there is nothing to publish to.',
    }
  }
  const files = renderBridgeConfig(
    {
      extensions: input.extensions,
      ingress: input.ingress || deployment.ingress,
      bindPort: input.bindPort,
      rtpPorts: input.rtpPorts,
    },
    deployment.ami,
  )
  let changed = false
  try {
    mkdirSync(deployment.configDir, { recursive: true })
    for (const [name, contents] of Object.entries(files)) {
      const path = join(deployment.configDir, name)
      let current: string | null = null
      try {
        current = readFileSync(path, 'utf8')
      } catch {
        current = null
      }
      if (current === contents) continue
      writeFileSync(path, contents, { mode: 0o600 })
      changed = true
    }
  } catch (error) {
    return { published: false, detail: error instanceof Error ? error.message : String(error) }
  }
  if (!changed) {
    return { published: true, changed: false, reloaded: false, detail: 'The bridge configuration was already current.' }
  }
  const reload = await reloadBridge()
  return {
    published: true,
    changed: true,
    reloaded: reload.ok,
    detail: reload.ok
      ? 'The bridge configuration was published and reloaded.'
      : `The bridge configuration was published, but the reload did not complete: ${reload.detail}`,
  }
}

// ---------------------------------------------------------------------------
// Asterisk Manager Interface
// ---------------------------------------------------------------------------

type AmiMessage = Record<string, string>

function parseAmiBlock(block: string): AmiMessage {
  const message: AmiMessage = {}
  for (const line of block.split(/\r?\n/)) {
    const index = line.indexOf(':')
    if (index <= 0) continue
    message[line.slice(0, index).trim()] = line.slice(index + 1).trim()
  }
  return message
}

/**
 * One AMI conversation: log in, run the action, collect its event stream until
 * the completion event, log out. Never throws — the bridge being unreachable
 * is a result the UI shows, not an error that breaks a page.
 */
async function amiExchange(args: {
  action: AmiMessage
  /** Event name that ends the response stream; null for single-reply actions. */
  completeEvent: string | null
  timeoutMs?: number
}): Promise<{ ok: true; messages: AmiMessage[] } | { ok: false; detail: string }> {
  const deployment = bridgeDeployment()
  if (!deployment?.ami) {
    return { ok: false, detail: 'The extension bridge has no manager interface configured on this deployment.' }
  }
  const ami = deployment.ami
  const timeoutMs = args.timeoutMs ?? 8000
  return new Promise((resolve) => {
    const socket: Socket = connect({ host: ami.host, port: ami.port })
    const messages: AmiMessage[] = []
    let buffer = ''
    let settled = false
    let loggedIn = false
    const finish = (result: { ok: true; messages: AmiMessage[] } | { ok: false; detail: string }) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      resolve(result)
    }
    const timer = setTimeout(
      () => finish({ ok: false, detail: 'The extension bridge did not answer in time.' }),
      timeoutMs,
    )
    const send = (message: AmiMessage) => {
      const payload = `${Object.entries(message)
        .map(([key, value]) => `${key}: ${value}`)
        .join('\r\n')}\r\n\r\n`
      socket.write(payload)
    }
    socket.on('error', (error: Error) => finish({ ok: false, detail: error.message }))
    socket.on('close', () => {
      if (!settled) finish({ ok: false, detail: 'The extension bridge closed the connection.' })
    })
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      let split = buffer.indexOf('\r\n\r\n')
      while (split >= 0) {
        const block = buffer.slice(0, split)
        buffer = buffer.slice(split + 4)
        split = buffer.indexOf('\r\n\r\n')
        if (block.startsWith('Asterisk Call Manager')) continue
        const message = parseAmiBlock(block)
        if (!loggedIn) {
          if (message.Response === 'Success') {
            loggedIn = true
            send(args.action)
          } else if (message.Response === 'Error') {
            finish({ ok: false, detail: message.Message ?? 'The extension bridge rejected the credentials.' })
            return
          }
          continue
        }
        if (message.Response === 'Error') {
          finish({ ok: false, detail: message.Message ?? 'The extension bridge rejected the request.' })
          return
        }
        messages.push(message)
        const done = args.completeEvent
          ? message.Event === args.completeEvent
          : message.Response === 'Success' || message.Response === 'Follows'
        if (done) {
          send({ Action: 'Logoff' })
          finish({ ok: true, messages })
          return
        }
      }
    })
    socket.once('connect', () =>
      send({ Action: 'Login', Username: ami.username, Secret: ami.password, Events: 'off' }),
    )
  })
}

/** Ask Asterisk to re-read the generated configuration. */
export async function reloadBridge(): Promise<{ ok: boolean; detail: string }> {
  const result = await amiExchange({ action: { Action: 'Reload' }, completeEvent: null })
  return result.ok ? { ok: true, detail: 'Reloaded.' } : { ok: false, detail: result.detail }
}

export type PjsipRegistration = {
  /** The pbx_extensions row id the registration was generated from. */
  extensionId: string
  status: 'registered' | 'unregistered' | 'failed'
  /** Asterisk's own word for the state, kept verbatim for the operator. */
  detail: string
  /** When the binding expires, when Asterisk reports the next registration. */
  expiresAt: Date | null
}

/** Asterisk's registration states, mapped onto the three the map records. */
function mapRegistrationStatus(raw: string): PjsipRegistration['status'] {
  const value = raw.trim().toLowerCase()
  if (value === 'registered') return 'registered'
  if (value === 'unregistered' || value === 'none' || value === 'stopped') return 'unregistered'
  return 'failed'
}

/**
 * Read the live registration state of every generated registration off the
 * bridge. Returns one entry per registration Asterisk knows about, keyed by
 * the extension row it was rendered from; scheduling is the caller's business.
 */
export async function scrapePjsipRegistrations(): Promise<
  { ok: true; registrations: PjsipRegistration[] } | { ok: false; detail: string }
> {
  const result = await amiExchange({
    action: { Action: 'PJSIPShowRegistrationsOutbound' },
    completeEvent: 'OutboundRegistrationDetailComplete',
  })
  if (!result.ok) return result
  const registrations: PjsipRegistration[] = []
  for (const message of result.messages) {
    if (message.Event !== 'OutboundRegistrationDetail') continue
    const objectName = message.ObjectName ?? ''
    if (!objectName.startsWith('bh-')) continue
    const status = message.Status ?? 'Unknown'
    const nextReg = Number(message.NextReg ?? '')
    registrations.push({
      extensionId: objectName.slice(3),
      status: mapRegistrationStatus(status),
      detail: status,
      expiresAt: Number.isFinite(nextReg) && nextReg > 0 ? new Date(Date.now() + nextReg * 1000) : null,
    })
  }
  return { ok: true, registrations }
}
