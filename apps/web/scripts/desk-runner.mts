import { execFile } from 'node:child_process'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { connect as tcpConnect } from 'node:net'
import { join } from 'node:path'
import type { Duplex } from 'node:stream'
import { promisify } from 'node:util'
import {
  cleanDeskId,
  createCloudHypervisorBackend,
  createDeskHost,
  DEFAULT_RUNTIME_DIR,
  verifyDeskHost,
  type DeskEvent,
  type DeskHandle,
  type DeskHost,
  type DeskHostVerification,
  type DeskJob,
  type DeskScreenHandle,
  type DeskVideoChunk,
} from '@braedonsaunders/appkit-desk'
import {
  deskIdentityMatches,
  signDeskHandoverCapability,
  verifyDeskHandoverCapability,
  type DeskHandoverScope,
} from '../src/lib/desk-security'

/**
 * The desk runner: the only process allowed to boot a microVM. It has no
 * database, no provider keys, no session secret, and no published port —
 * mechanism lives here, and the RECORD stays in bunkhouse's tier: this
 * service buffers what happens on each desk and the web app drains it into
 * the desk_events ledger over the authenticated protocol below. AppKit
 * boundary, on purpose: this file must stay readable in one sitting and must
 * never grow a dependency on the app.
 *
 * Wire protocol 'desk-v1' (mirrored, deliberately by hand, in
 * apps/web/src/lib/desk.ts — change both together):
 *
 *   GET  /health                                — { ok, protocol, ...verification, ...stats }
 *   POST /desks/:id/lease                       — start or resume; renews when resident
 *   POST /desks/:id/executions                  — idempotent start by executionId
 *   GET  /executions/:id?wait=1                 — long-poll the retained result
 *   POST /desks/:id/jobs                        — start a keepAlive job
 *   GET  /desks/:id/jobs                        — list running keepAlive jobs
 *   POST /desks/:id/screen/start|stop           — the expensive tier, on demand
 *   GET  /desks/:id/screen/observe              — png (base64) + windows + a11y
 *   POST /desks/:id/screen/input                — click/type/key/scroll/drag/move
 *   POST /desks/:id/screen/focus                — activate a window via AT-SPI
 *   POST /desks/:id/screen/launch               — launch an app
 *   POST /desks/:id/screen/clipboard            — read/write
 *   POST /desks/:id/screen/frames/start|stop    — the still-picture capture pump
 *                                                 (start with pin:false = re-tune the rate)
 *   GET  /desks/:id/screen/frames               — SSE: base64 stills off that pump,
 *                                                 each { seq, width, height, at, format, data }
 *   POST /desks/:id/screen/video/start|stop     — the live-view H.264 encode
 *                                                 (start with pin:false = re-tune the rate)
 *   GET  /desks/:id/screen/video                — the live view: a binary stream of
 *                                                 length-prefixed fragmented-MP4 chunks
 *                                                 (see encodeVideoWireChunk for the framing)
 *   POST /desks/:id/handover                    — begin/end, idempotent begin
 *   GET  /desks/:id/handover/stream (WS)        — relay the in-guest viewer outward
 *   POST /desks/:id/suspend                     — park the VM; disk persists
 *   DELETE /desks/:id                           — destroy the VM and its tap
 *   GET  /desks/:id/events?after=N&wait=1       — buffered typed events since seq
 *   POST /desks/:id/browser                     — ensure in-guest Chromium, return CDP path
 *   GET  /desks/:id/browser/devtools/... (WS)   — relay CDP into the guest
 *   GET  /stats                                 — host residency/queue/capacity
 */

const PORT = Number(process.env.PORT ?? 8080)
const TOKEN = process.env.BUNKHOUSE_DESK_TOKEN ?? ''
const DISKS_ROOT = process.env.BUNKHOUSE_AGENT_DISKS ?? '/data/agent-disks'
const SHARED_FOLDER = process.env.BUNKHOUSE_SHARED_FOLDER ?? '/data/shared'
const CAPACITY = Number(process.env.BUNKHOUSE_DESK_CAPACITY ?? 8)
const IDLE_SUSPEND_MS = Number(process.env.BUNKHOUSE_DESK_IDLE_MS ?? 5 * 60_000)
const BODY_LIMIT_BYTES = 512 * 1024
const EXEC_RETENTION_MS = 15 * 60_000
const EVENT_BUFFER_CAP = 1_000
const LONG_POLL_MS = 25_000
const CDP_PORT = 9222
/**
 * Chromium 151 binds its DevTools socket to guest loopback even when it is
 * launched with `--remote-debugging-address=0.0.0.0`. The runner therefore
 * reaches it through a guest-side forwarder bound only to that desk's tap
 * address, just as the handover path reaches loopback-only x11vnc. Keeping
 * the relay on a distinct port avoids relying on Linux allowing two listeners
 * on port 9222 with different bind addresses.
 */
const CDP_RELAY_PORT = Number(process.env.BUNKHOUSE_CDP_RELAY_PORT ?? 9223)
const GUEST_HOME = '/home/agent'
const BROWSER_PROFILE_DIR = `${GUEST_HOME}/.config/bunkhouse-browser`
const DOWNLOADS_DIR = `${GUEST_HOME}/downloads`

/**
 * Guest addressing convention: the runner's network glue assigns each desk's
 * TAP a /24 slot and the guest the matching address, DNAT'ing all egress into
 * the proxy at EGRESS_PROXY. The CDP relay dials the guest on that address.
 * `{index}` is the per-desk index this process assigns at first lease,
 * starting at 2. Override the template when the deployment's addressing
 * differs — but keep it in step with the tap setup or the relay dials air.
 */
const GUEST_ADDR_TEMPLATE = process.env.BUNKHOUSE_GUEST_ADDR_TEMPLATE ?? '172.30.0.{index}'
/** Index 1 of that template is the host end of every desk's link. */
const GUEST_PREFIX_LENGTH = 24

/**
 * Where the guest's DNAT'd traffic actually lands. The egress proxy shares
 * this process's network namespace (deploy/desk-runner.compose.yaml), so these
 * are ports on the very address the tap already carries — the redirect never
 * leaves the namespace and its target cannot move when a container restarts.
 * They are the proxy's TRANSPARENT listeners, one per pre-DNAT port, because
 * @braedonsaunders/appkit-egress-proxy recovers the original port from the listener it was
 * reached on (there is no SO_ORIGINAL_DST from Node).
 */
const EGRESS_HTTP_PORT = Number(process.env.BUNKHOUSE_EGRESS_HTTP_PORT ?? 3129)
const EGRESS_HTTPS_PORT = Number(process.env.BUNKHOUSE_EGRESS_HTTPS_PORT ?? 3130)

/**
 * The one resolver a guest may reach, DNAT'd so it cannot pick another. DNS
 * is the simplest correct option here: running dnsmasq per tap would be a
 * second daemon to supervise for no added safety, because the answer a guest
 * gets decides nothing — the proxy re-resolves every destination by NAME from
 * the SNI or Host header, so a poisoned or hostile answer still cannot take a
 * flow anywhere the policy would not.
 */
const GUEST_DNS = process.env.BUNKHOUSE_GUEST_DNS ?? '1.1.1.1'

/**
 * The kernel command line every desk — and the boot probe — starts with.
 * Partition 3 holds the golden root after virt-resize moved it there (the
 * package default `root=/dev/vda` is wrong for this image), and the serial
 * console carries guest boot logs to the VMM. One constant on purpose: a
 * probe that boots differently from a desk answers a different question, and
 * a panicking probe is indistinguishable from a host without KVM.
 */
/**
 * How long to wait for a freshly booted guest agent to answer on vsock.
 *
 * The package default is twenty seconds, which is right for a microVM on bare
 * metal. A desk here is an L2 guest — a Cloud Hypervisor VM inside a Hyper-V
 * VM — and a measured cold boot of this image is 120-140s. Twenty seconds
 * would fail every first lease and report a host that cannot run desks, so
 * this is sized against the real number with room over it, and every desk and
 * the boot probe share the one backend so they cannot disagree.
 */
const GUEST_CONNECT_TIMEOUT_MS = Number(process.env.BUNKHOUSE_DESK_CONNECT_MS ?? 120_000)

const deskBackend = createCloudHypervisorBackend({
  connectTimeoutMs: GUEST_CONNECT_TIMEOUT_MS,
  // Poll for the guest agent every second, not ten times a second. The
  // package's 100ms default is sized for a microVM that is up almost at once;
  // here the guest is still booting for its first ten-plus seconds, and every
  // attempt in that window is a fresh CONNECT into Cloud Hypervisor's vsock
  // multiplexer that the guest cannot answer. A thousand of those buys
  // nothing and is a poor neighbour to the device we are waiting on.
  connectRetryDelayMs: Number(process.env.BUNKHOUSE_DESK_RETRY_MS ?? 2_000),
})

/**
 * The kernel command line every desk — and the boot probe — starts with.
 *
 * Partition 3 holds the golden root after virt-resize moved it there, so the
 * package default `root=/dev/vda` is wrong for this image.
 *
 * And deliberately NO `console=`. The plan boots every desk with `--serial off
 * --console off`, so naming ttyS0 here points the kernel and systemd at a
 * console device that does not exist: the guest stalls late in boot, the agent
 * never reaches vsock, and the whole thing reads as a host that cannot run VMs
 * at all. The same image answers in about ten seconds with the console unset.
 * Only add one alongside a `--serial file=` when debugging a boot.
 */
const GUEST_KERNEL_CMDLINE = process.env.BUNKHOUSE_GUEST_CMDLINE ?? 'root=/dev/vda3 rw'

/**
 * The handover's two guest-side ports.
 *
 * The in-guest agent starts x11vnc bound to 127.0.0.1 ONLY — deliberately;
 * its comment says "the runner does the exposing" — and speaks raw RFB, not
 * websockets. So exposing it is two steps, both driven from here:
 *
 *   · reachability — a socat forwarder on the guest's tap address, started
 *     over the exec channel and bounded by `timeout` so it cannot outlive the
 *     grant even if this process dies. socat is already in the base image (it
 *     is what bridges vsock), so this adds nothing to the guest.
 *   · protocol — this runner terminates the websocket and splices its payload
 *     to that forwarder, which is what noVNC in a browser expects and what
 *     websockify would otherwise be a whole extra service to provide.
 */
const HANDOVER_FALLBACK_PORT = 5900
const HANDOVER_RELAY_PORT = Number(process.env.BUNKHOUSE_HANDOVER_RELAY_PORT ?? 5901)

if (!TOKEN) {
  console.error('[desk-runner] BUNKHOUSE_DESK_TOKEN is not set; refusing to start unauthenticated.')
  process.exit(1)
}

function tokenMatches(offered: string): boolean {
  const a = Buffer.from(offered)
  const b = Buffer.from(TOKEN)
  return a.length === b.length && timingSafeEqual(a, b)
}

// --- state ------------------------------------------------------------------

type DeskEntry = {
  handle: DeskHandle
  screen: DeskScreenHandle | null
  handoverUrl: string | null
  /** Guest-side TCP port the handover relay splices to, from that URL. */
  handoverPort: number
  /** Host-side TTL deadline; the relay refuses past it and the timer revokes. */
  handoverExpiresAt: number
  /** Scope and nonce are part of the browser capability and die on revoke. */
  handoverScope: DeskHandoverScope | null
  handoverNonce: string | null
  /** Live relay sockets, so an expiry can cut them rather than wait them out. */
  handoverSockets: Set<Duplex>
  handoverTimer: ReturnType<typeof setTimeout> | null
  browserPath: string | null
  /** Stable per-desk index; the guest address and the tap derive from it. */
  index: number
}

type BufferedEvent = { seq: number; kind: string; at: string; detail: Record<string, unknown> }

type ExecutionEntry = {
  deskId: string
  snapshot: {
    executionId: string
    done: boolean
    result: {
      exitCode: number | null
      signal: string | null
      stdout: string
      stderr: string
      truncated: boolean
      timedOut: boolean
      startedAt: string
      finishedAt: string
    } | null
  }
  waiters: (() => void)[]
  expiresAt: number
}

const desks = new Map<string, DeskEntry>()
const deskIndexes = new Map<string, number>()
let nextDeskIndex = 2
const eventBuffers = new Map<string, { events: BufferedEvent[]; nextSeq: number; waiters: (() => void)[] }>()
const executions = new Map<string, ExecutionEntry>()

let verification: DeskHostVerification | null = null
let refusalReason: string | null = null
let host: DeskHost | null = null

function buffer(deskId: string): { events: BufferedEvent[]; nextSeq: number; waiters: (() => void)[] } {
  let entry = eventBuffers.get(deskId)
  if (!entry) {
    entry = { events: [], nextSeq: 1, waiters: [] }
    eventBuffers.set(deskId, entry)
  }
  return entry
}

/**
 * The onEvent port: every typed desk event is buffered per desk, with a
 * monotone seq, until the web tier drains it into the ledger. The record is
 * not this runner's — losing this process loses at most the undrained tail,
 * never the persisted history. Handover masking is upstream in @braedonsaunders/appkit-desk:
 * during a handover the only events that ever arrive here are the boundaries.
 */
function onDeskEvent(event: DeskEvent): void {
  const { deskId, at, kind, ...detail } = event
  const entry = buffer(deskId)
  entry.events.push({ seq: entry.nextSeq, kind, at, detail: detail as Record<string, unknown> })
  entry.nextSeq += 1
  if (entry.events.length > EVENT_BUFFER_CAP) entry.events.splice(0, entry.events.length - EVENT_BUFFER_CAP)
  for (const wake of entry.waiters.splice(0)) wake()
}

function guestAddressFor(index: number): string {
  return GUEST_ADDR_TEMPLATE.replace('{index}', String(index))
}

// --- guest networking and enforced egress (§3.11) ---------------------------

/**
 * The host end of every desk's point-to-point link: index 1 of the same
 * template the guests are numbered from, so one comment describes the whole
 * plan. It is carried on each tap as a /32 (the same address on every tap is
 * legal on Linux and is what lets one DNAT target serve all of them) with a
 * host route pointing each guest's /32 back down its own device.
 */
const HOST_GATEWAY_ADDR = guestAddressFor(1)

const execFileAsync = promisify(execFile)

/** The tap for a desk. `dsk<n>` matches @braedonsaunders/appkit-desk's own naming. */
function tapDeviceFor(index: number): string {
  return `dsk${index}`
}

/** Locally-administered, deterministic, and the same shape the package derives. */
function macAddressFor(index: number): string {
  const octets = [0x06, 0x00, (index >>> 24) & 0xff, (index >>> 16) & 0xff, (index >>> 8) & 0xff, index & 0xff]
  return octets.map((octet) => octet.toString(16).padStart(2, '0')).join(':')
}

async function run(command: string, args: readonly string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync(command, [...args], { timeout: 15_000 })
    return stdout
  } catch (error) {
    const failure = error as { stderr?: string; message?: string }
    const detail = (failure.stderr ?? failure.message ?? String(error)).trim()
    throw new Error(`${command} ${args.join(' ')}: ${detail || 'failed'}`)
  }
}

async function succeeds(command: string, args: readonly string[]): Promise<boolean> {
  try {
    await execFileAsync(command, [...args], { timeout: 15_000 })
    return true
  } catch {
    return false
  }
}

type Rule = readonly string[]

/**
 * The per-desk rule set, as data. Everything a guest can emit is either
 * redirected into the proxy or dropped; there is no accept-by-default anywhere
 * in it, which is the whole point of putting enforcement at the tap rather
 * than inside a guest whose root shell the agent holds (§3.11).
 */
function deskRules(tap: string, guest: string): {
  table: 'nat' | 'filter'
  parent: string
  chain: string
  jumps: Rule[]
  rules: Rule[]
}[] {
  return [
    {
      table: 'nat',
      parent: 'PREROUTING',
      chain: `bh-pre-${tap}`,
      jumps: [['-i', tap]],
      rules: [
        // Plain HTTP and TLS are the only two things that reach a network at
        // all, and both land on the proxy's transparent listeners. The guest
        // is never told; there is no proxy setting for it to unset.
        ['-p', 'tcp', '--dport', '80', '-j', 'DNAT', '--to-destination', `${HOST_GATEWAY_ADDR}:${EGRESS_HTTP_PORT}`],
        ['-p', 'tcp', '--dport', '443', '-j', 'DNAT', '--to-destination', `${HOST_GATEWAY_ADDR}:${EGRESS_HTTPS_PORT}`],
        // DNS is pinned to one resolver rather than allowed outward freely.
        ['-p', 'udp', '--dport', '53', '-j', 'DNAT', '--to-destination', `${GUEST_DNS}:53`],
        ['-p', 'tcp', '--dport', '53', '-j', 'DNAT', '--to-destination', `${GUEST_DNS}:53`],
      ],
    },
    {
      table: 'nat',
      parent: 'POSTROUTING',
      chain: `bh-post-${tap}`,
      jumps: [['-s', `${guest}/32`]],
      // Only the DNS hop is actually forwarded out of this namespace; the
      // proxy hop is delivered locally. Masquerade covers the former.
      rules: [['-j', 'MASQUERADE']],
    },
    {
      table: 'filter',
      parent: 'INPUT',
      chain: `bh-in-${tap}`,
      jumps: [['-i', tap]],
      rules: [
        // Replies to flows THIS process opened into the guest — the CDP relay
        // and the handover relay both dial the guest, and their return traffic
        // arrives here on the tap.
        ['-m', 'conntrack', '--ctstate', 'ESTABLISHED,RELATED', '-j', 'ACCEPT'],
        ['-p', 'tcp', '-d', HOST_GATEWAY_ADDR, '--dport', String(EGRESS_HTTP_PORT), '-j', 'ACCEPT'],
        ['-p', 'tcp', '-d', HOST_GATEWAY_ADDR, '--dport', String(EGRESS_HTTPS_PORT), '-j', 'ACCEPT'],
        // Default drop. QUIC (443/udp) dies here, and it MUST: Chromium
        // speaks QUIC first and falls back to TCP only when UDP fails, so a
        // guest whose 443/udp escaped would silently route the traffic this
        // whole file exists to intercept around the proxy entirely.
        ['-j', 'DROP'],
      ],
    },
    {
      table: 'filter',
      parent: 'FORWARD',
      chain: `bh-fwd-${tap}`,
      // Both directions through one chain: guest-originated forwards, and the
      // answers coming back down the tap.
      jumps: [['-i', tap], ['-o', tap]],
      rules: [
        ['-m', 'conntrack', '--ctstate', 'ESTABLISHED,RELATED', '-j', 'ACCEPT'],
        ['-i', tap, '-p', 'udp', '-d', GUEST_DNS, '--dport', '53', '-j', 'ACCEPT'],
        ['-i', tap, '-p', 'tcp', '-d', GUEST_DNS, '--dport', '53', '-j', 'ACCEPT'],
        ['-j', 'DROP'],
      ],
    },
  ]
}

/**
 * Install this desk's rules. Idempotent by construction: each desk owns named
 * chains that are created if missing, flushed, and refilled, and the jump into
 * each built-in chain is added only when `-C` says it is not already there.
 */
/**
 * Turn on IPv4 forwarding, tolerating a container that already has it.
 *
 * ip_forward is namespaced, so a desk's traffic cannot leave its tap without
 * it. But /proc/sys is mounted READ-ONLY in a container, and NET_ADMIN does
 * not change that: the value has to be set at create time (the compose file
 * does, via `sysctls`), and writing it from in here fails with EROFS even
 * when it is already exactly what we want. So read first, and only complain
 * if forwarding is genuinely off and we cannot turn it on — otherwise a
 * correctly configured host refuses every desk over a write it never needed
 * to make.
 */
async function enableForwarding(): Promise<void> {
  const path = '/proc/sys/net/ipv4/ip_forward'
  const current = await readFile(path, 'utf8').catch(() => '')
  if (current.trim() === '1') return
  try {
    await writeFile(path, '1')
  } catch (error) {
    throw new Error(
      `IPv4 forwarding is off and ${path} is not writable (${error instanceof Error ? error.message : String(error)}). ` +
        "Set it on the container instead — deploy/desk-runner.compose.yaml's `sysctls`.",
    )
  }
}

async function installEgressRules(tap: string, guest: string): Promise<void> {
  for (const { table, parent, chain, jumps, rules } of deskRules(tap, guest)) {
    if (!(await succeeds('iptables', ['-t', table, '-N', chain]))) {
      await run('iptables', ['-t', table, '-F', chain])
    }
    for (const rule of rules) await run('iptables', ['-t', table, '-A', chain, ...rule])
    for (const jump of jumps) {
      const target = [...jump, '-j', chain]
      if (await succeeds('iptables', ['-t', table, '-C', parent, ...target])) continue
      // Position 1: docker owns rules in FORWARD, and a desk's default drop
      // has to be reached before anything of docker's can accept around it.
      await run('iptables', ['-t', table, '-I', parent, '1', ...target])
    }
  }
}

async function removeEgressRules(tap: string, guest: string): Promise<void> {
  for (const { table, parent, chain, jumps } of deskRules(tap, guest)) {
    for (const jump of jumps) {
      while (await succeeds('iptables', ['-t', table, '-C', parent, ...jump, '-j', chain])) {
        if (!(await succeeds('iptables', ['-t', table, '-D', parent, ...jump, '-j', chain]))) break
      }
    }
    await succeeds('iptables', ['-t', table, '-F', chain])
    await succeeds('iptables', ['-t', table, '-X', chain])
  }
}

/**
 * Create this desk's tap, address it, and put the enforcement in front of it —
 * in that order, and BEFORE the VM boots. Failing here throws, which is the
 * point: a desk that cannot be filtered must not exist, because an unfiltered
 * one is a machine with a root shell and an open route to the internet.
 */
async function ensureDeskNetwork(index: number): Promise<void> {
  const tap = tapDeviceFor(index)
  const guest = guestAddressFor(index)
  if (!(await succeeds('ip', ['link', 'show', 'dev', tap]))) {
    await run('ip', ['tuntap', 'add', 'dev', tap, 'mode', 'tap'])
  }
  await run('ip', ['addr', 'replace', `${HOST_GATEWAY_ADDR}/32`, 'dev', tap])
  await run('ip', ['link', 'set', 'dev', tap, 'up'])
  await run('ip', ['route', 'replace', `${guest}/32`, 'dev', tap])
  // Namespaced, and needed for the one hop that leaves: DNS.
  await enableForwarding()
  await installEgressRules(tap, guest)
}

async function teardownDeskNetwork(index: number): Promise<void> {
  const tap = tapDeviceFor(index)
  await removeEgressRules(tap, guestAddressFor(index))
  await succeeds('ip', ['link', 'del', 'dev', tap])
}

/**
 * Address the guest's NIC from the host side, over the exec channel that
 * already exists. The kernel command line is shared by every desk, so it
 * cannot carry a per-desk `ip=`; the host knows the number it assigned and
 * says so. Idempotent (`replace`), and fatal when it fails — a desk that came
 * up without the address the CDP and handover relays dial is a desk nothing
 * can reach.
 */
async function configureGuestNetwork(entry: DeskEntry): Promise<void> {
  const guest = guestAddressFor(entry.index)
  const script = [
    'set -e',
    'dev=$(ls /sys/class/net | grep -E "^(en|eth)" | head -n 1)',
    'test -n "$dev"',
    `ip addr replace ${guest}/${GUEST_PREFIX_LENGTH} dev "$dev"`,
    'ip link set dev "$dev" up',
    `ip route replace default via ${HOST_GATEWAY_ADDR} dev "$dev"`,
    // A stock cloud image points /etc/resolv.conf at a resolved stub that is
    // not running here; replace the link, do not write through it.
    'rm -f /etc/resolv.conf',
    `printf 'nameserver %s\\n' ${GUEST_DNS} > /etc/resolv.conf`,
  ].join('\n')
  const snapshot = await entry.handle.exec({ command: '/bin/sh', args: ['-c', script], timeoutMs: 20_000 })
  if (snapshot.exitCode !== 0) {
    throw new Error(`The guest's network could not be configured: ${snapshot.stderr.trim() || 'no reason given'}`)
  }
}

/**
 * Boot-time proof that this process can actually do the above. Without
 * NET_ADMIN the tap and the rules are impossible, and a desk booted anyway
 * would have either no network or — worse — an unfiltered one.
 */
async function verifyNetAdmin(): Promise<void> {
  const probe = 'dskprobe'
  await succeeds('ip', ['link', 'del', 'dev', probe])
  try {
    await run('ip', ['tuntap', 'add', 'dev', probe, 'mode', 'tap'])
    await run('iptables', ['-t', 'nat', '-S'])
    await run('iptables', ['-t', 'filter', '-S'])
  } catch (error) {
    throw new Error(
      'This container cannot create a tap or write iptables rules, so guest egress cannot be enforced ' +
        `and no desk may boot. Grant NET_ADMIN (deploy/desk-runner.compose.yaml). Underlying failure: ${describe(error)}`,
    )
  } finally {
    await succeeds('ip', ['link', 'del', 'dev', probe])
  }
}

async function ensureDesk(
  deskId: string,
  options: { memoryMb?: number; vcpus?: number; leaseMs?: number },
): Promise<DeskEntry> {
  if (!host) throw new Error(refusalReason ?? 'This host cannot serve desks.')
  const existing = desks.get(deskId)
  if (existing) {
    try {
      if (options.leaseMs) existing.handle.renewLease(options.leaseMs)
      return existing
    } catch {
      // The host suspended it out from under us; fall through and re-lease.
      desks.delete(deskId)
    }
  }
  let index = deskIndexes.get(deskId)
  if (index === undefined) {
    index = nextDeskIndex
    nextDeskIndex += 1
    deskIndexes.set(deskId, index)
  }
  // Before the VM, always: the tap has to exist for the VMM to attach to it,
  // and the rules have to be in front of it before a single guest packet can
  // be emitted. A throw here is a desk that does not boot, on purpose.
  await ensureDeskNetwork(index)
  let handle: DeskHandle
  try {
    handle = await host.resume(deskId)
  } catch {
    handle = await host.start({
      deskId,
      // RAW base, not qcow2: Cloud Hypervisor cannot follow qcow2 backing
      // chains, so overlays are reflink copies (cp --reflink=auto) of a raw
      // base rather than a copy-on-write qcow2 over a backing file.
      baseImage: join(DISKS_ROOT, 'base.raw'),
      overlayPath: join(DISKS_ROOT, 'overlays', `${deskId}.raw`),
      // Named rather than left to the package's CID-derived default: the tap
      // this runner created and filtered is the only one the guest may have.
      network: { tapDevice: tapDeviceFor(index), macAddress: macAddressFor(index) },
      ...(options.memoryMb ? { memoryMb: options.memoryMb } : {}),
      ...(options.vcpus ? { vcpus: options.vcpus } : {}),
      ...(options.leaseMs ? { leaseMs: options.leaseMs } : {}),
    })
  }
  const entry: DeskEntry = {
    handle,
    screen: null,
    handoverUrl: null,
    handoverPort: HANDOVER_FALLBACK_PORT,
    handoverExpiresAt: 0,
    handoverScope: null,
    handoverNonce: null,
    handoverSockets: new Set(),
    handoverTimer: null,
    browserPath: null,
    index,
  }
  await configureGuestNetwork(entry)
  desks.set(deskId, entry)
  return entry
}

/** Park the VM but keep its tap: the index is stable, so a resume reuses it. */
async function suspendDesk(deskId: string): Promise<void> {
  if (!host) throw new Error(refusalReason ?? 'This host cannot serve desks.')
  const entry = desks.get(deskId)
  closeFramePump(deskId)
  closeVideoPump(deskId)
  if (entry) revokeHandover(entry)
  await host.suspend(deskId)
  desks.delete(deskId)
}

/** Destroy the VM and take its tap and rules down with it. */
async function destroyDesk(deskId: string): Promise<void> {
  if (!host) throw new Error(refusalReason ?? 'This host cannot serve desks.')
  const entry = desks.get(deskId)
  closeFramePump(deskId)
  closeVideoPump(deskId)
  if (entry) revokeHandover(entry)
  await host.destroy(deskId).catch(() => undefined)
  desks.delete(deskId)
  const index = deskIndexes.get(deskId)
  if (index !== undefined) {
    deskIndexes.delete(deskId)
    await teardownDeskNetwork(index)
  }
}

// --- executions: idempotent start, retained result, long-poll ---------------

function sweepExecutions(): void {
  const now = Date.now()
  for (const [id, entry] of executions) {
    if (entry.expiresAt <= now) executions.delete(id)
  }
}
setInterval(sweepExecutions, 60_000).unref()

function startExecution(
  entry: DeskEntry,
  deskId: string,
  body: {
    executionId: string
    command: string[]
    cwd?: string
    env?: Record<string, string>
    timeoutMs?: number
    outputLimitKb?: number
  },
): ExecutionEntry {
  const known = executions.get(body.executionId)
  if (known) return known
  const timeoutMs = Math.min(Math.max(body.timeoutMs ?? 60_000, 1_000), 600_000)
  const cap = Math.min(Math.max(body.outputLimitKb ?? 64, 1), 8_192) * 1_024
  const execution: ExecutionEntry = {
    deskId,
    snapshot: { executionId: body.executionId, done: false, result: null },
    waiters: [],
    expiresAt: Date.now() + timeoutMs + EXEC_RETENTION_MS,
  }
  executions.set(body.executionId, execution)
  const startedAt = Date.now()
  const [command, ...args] = body.command
  void entry.handle
    .exec({
      command: command ?? '/bin/false',
      args,
      ...(body.cwd ? { cwd: body.cwd } : {}),
      ...(body.env ? { env: body.env } : {}),
      timeoutMs,
    })
    .then((snapshot) => {
      const elapsed = Date.now() - startedAt
      execution.snapshot.result = {
        exitCode: snapshot.exitCode,
        signal: snapshot.signal,
        stdout: snapshot.stdout.slice(0, cap),
        stderr: snapshot.stderr.slice(0, cap),
        truncated: snapshot.truncated || snapshot.stdout.length > cap || snapshot.stderr.length > cap,
        timedOut: snapshot.signal !== null && elapsed >= timeoutMs,
        startedAt: snapshot.startedAt,
        finishedAt: snapshot.finishedAt,
      }
    })
    .catch((error: unknown) => {
      const stamp = new Date().toISOString()
      execution.snapshot.result = {
        exitCode: null,
        signal: null,
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error),
        truncated: false,
        timedOut: false,
        startedAt: stamp,
        finishedAt: stamp,
      }
    })
    .finally(() => {
      execution.snapshot.done = true
      execution.expiresAt = Date.now() + EXEC_RETENTION_MS
      for (const wake of execution.waiters.splice(0)) wake()
    })
  return execution
}

// --- the live view: one capture pump per desk, fanned out as SSE (§3.13) ----

/**
 * The frames a desk is emitting, and everyone watching them.
 *
 * MASKING (§3.14, and the contract on @braedonsaunders/appkit-desk's DeskPorts): frames are
 * taken from `handle.screen.frames()` — the package's MASKED host API — and
 * never from the machine's raw event subscription. That is the whole safety
 * argument for this relay: inside the package, the frame subscriber drops
 * every frame while a handover is active, so a handover suppresses this
 * stream at the source. Relaying the raw `{event:'frame'}` messages instead
 * would carry a human's session out past the mask, which is exactly the leak
 * the ledger design exists to prevent. Do not "optimise" this into a direct
 * subscription.
 *
 * One pump per desk, however many subscribers: the guest encodes once, and a
 * second viewer costs a socket rather than a second capture. The rate is a
 * property of the pump rather than of a subscription, for the same reason:
 * whoever wants it faster (an operator who has taken the controls) speeds up
 * the one capture, and everybody watching gets the same picture.
 */
type FramePump = {
  fps: number
  width: number
  height: number
  /** An explicit start pins the pump open even with nobody watching yet. */
  pinned: boolean
  subscribers: Set<ServerResponse>
  closed: boolean
  /** Change the rate of the capture that is already running. */
  retune: (fps: number) => void
  stop: () => void
}

const framePumps = new Map<string, FramePump>()

/**
 * How much unflushed frame data one subscriber's socket may be holding before
 * it is skipped. One 1280x900 PNG frame is comfortably under this; a viewer
 * that is more than a frame behind is a viewer whose link cannot carry the
 * rate, and the honest answer is a dropped frame rather than a queue.
 */
const SUBSCRIBER_BACKLOG_CAP_BYTES = 4 * 1024 * 1024

/**
 * The rate bounds the GUEST enforces (FRAMES_MIN_FPS/FRAMES_MAX_FPS in
 * deploy/desk-image/agent/desk-guest-agent.mjs). Clamped here rather than
 * passed on: the guest REFUSES a rate outside them, and a refused frames-start
 * ends the iterator — so a mistyped query parameter would take a live view
 * down instead of being ignored.
 */
function clampFps(fps: number): number {
  if (!Number.isFinite(fps)) return 10
  return Math.min(30, Math.max(1, Math.round(fps)))
}

function startFramePump(
  deskId: string,
  screen: DeskScreenHandle,
  options: { fps: number; width: number; height: number },
): FramePump {
  const openIterator = (fps: number) =>
    screen.frames({ fps, width: options.width, height: options.height })[Symbol.asyncIterator]()
  // The live source. A re-tune swaps it, and the read loop below notices the
  // swap by identity rather than by the old iterator ending — which it also
  // does, because ending it is how the guest is told to stop the old rate.
  let source = openIterator(clampFps(options.fps))
  const pump: FramePump = {
    fps: clampFps(options.fps),
    width: options.width,
    height: options.height,
    pinned: false,
    subscribers: new Set(),
    closed: false,
    retune: (requested: number) => {
      const fps = clampFps(requested)
      if (pump.closed || fps === pump.fps) return
      const previous = source
      pump.fps = fps
      // ORDER IS LOAD-BEARING. Finishing the old iterator sends `frames-stop`
      // to the guest and opening the new one sends `frames-start`; both are
      // written to the same vsock stream in call order and the guest agent
      // serializes what it reads, so stop-then-start leaves the capture
      // running at the new rate. The other order would have the stop land on
      // the capture the start had just begun, and the picture would die
      // quietly — which is the one failure mode a live view must not have.
      void previous.return?.().catch(() => undefined)
      source = openIterator(fps)
      console.log(`[desk-runner] frame pump for ${deskId} re-tuned to ${fps}fps`)
    },
    stop: () => {
      if (pump.closed) return
      pump.closed = true
      // Cancel the iterator rather than waiting for a frame that may never
      // come: a still screen emits nothing, so `break` alone would hang.
      void source.return?.().catch(() => undefined)
      for (const subscriber of pump.subscribers.values()) subscriber.end()
      pump.subscribers.clear()
      if (framePumps.get(deskId) === pump) framePumps.delete(deskId)
    },
  }
  framePumps.set(deskId, pump)
  void (async () => {
    try {
      for (;;) {
        const reading = source
        const next = await reading.next()
        if (pump.closed) break
        if (next.done) {
          // A re-tune ends the iterator we were reading from. That is not the
          // end of the stream — the next frame comes off the new one.
          if (reading !== source) continue
          break
        }
        const frame = next.value
        const payload = JSON.stringify({
          seq: frame.seq,
          width: frame.width,
          height: frame.height,
          at: frame.at,
          // Carried, never assumed: the guest picks the encoding and a
          // consumer that guessed PNG would hand a decoder the wrong type.
          format: frame.format,
          data: frame.data.toString('base64'),
        })
        for (const subscriber of pump.subscribers.values()) {
          // Never queue: a subscriber that cannot keep up drops frames rather
          // than growing a buffer in the one process that boots microVMs. At
          // thirty frames a second that stopped being theoretical — a socket
          // that is already holding a frame it has not flushed is skipped
          // rather than handed a second one, and it catches up on the next
          // frame the guest paints.
          if (subscriber.writableEnded) continue
          if (subscriber.writableLength > SUBSCRIBER_BACKLOG_CAP_BYTES) continue
          subscriber.write(`data: ${payload}\n\n`)
        }
      }
    } catch (error) {
      console.error(`[desk-runner] frame pump for ${deskId} stopped: ${describe(error)}`)
    } finally {
      pump.stop()
    }
  })()
  return pump
}

/**
 * The pump for this desk, started if there is none — and RE-TUNED if there is
 * one and the caller asked for a different rate. Re-tuning rather than
 * ignoring the number is what lets a viewer change the rate without dropping
 * its subscription: the socket carrying the picture is untouched and only the
 * guest's capture changes speed.
 *
 * The geometry is not re-tuned. Frames go out at the screen's real size and
 * never rescale (the coordinate contract), so a different width or height is a
 * different screen, not a different capture.
 */
function ensureFramePump(
  deskId: string,
  screen: DeskScreenHandle,
  options: { fps: number; width: number; height: number },
): FramePump {
  const existing = framePumps.get(deskId)
  if (existing && !existing.closed) {
    existing.retune(options.fps)
    return existing
  }
  return startFramePump(deskId, screen, options)
}

/** The running pump for this desk, or null. Never starts one. */
function liveFramePump(deskId: string): FramePump | null {
  const pump = framePumps.get(deskId)
  return pump && !pump.closed ? pump : null
}

function closeFramePump(deskId: string): void {
  framePumps.get(deskId)?.stop()
}

// --- the live view: one H.264 encode per desk, fanned out as bytes (§3.13) ---

/**
 * The video a desk is encoding, and everyone watching it.
 *
 * The same shape as the frame pump above and for the same reasons — one encode
 * per desk however many subscribers, the rate a property of the pump, frames
 * taken from `@braedonsaunders/appkit-desk`'s MASKED `screen.video()` so a handover suppresses
 * the stream at the source. What is different is that video chunks only mean
 * anything IN ORDER and ONLY AFTER the init segment.
 *
 * So the pump owns two pieces of resync state that the frame pump has no need
 * for:
 *
 *   · `init` — the last init segment the guest sent. A subscriber that arrives
 *     mid-stream is handed it before anything else. A consumer that never gets
 *     it decodes nothing at all and shows a black rectangle with no error, so
 *     this is not an optimisation, it is the difference between working and
 *     silently not.
 *
 *   · a per-subscriber `ready` flag — after the init segment, a subscriber is
 *     fed nothing until a chunk whose `keyframe` is true, because the middle of
 *     a group of pictures decodes to nothing. The wait is bounded by the
 *     guest's keyframe interval.
 *
 * An encoder restart (a died-and-respawned ffmpeg) sends a NEW init segment,
 * which lands here as a fresh `init` and resets every subscriber to waiting for
 * a keyframe — exactly the same path a late joiner takes.
 */
type VideoSubscriber = {
  response: ServerResponse
  /** False until this subscriber has been given init and then a keyframe. */
  ready: boolean
  /** The init segment this subscriber was given, so a new one is re-sent. */
  init: Buffer | null
}

type VideoPump = {
  fps: number
  width: number
  height: number
  pinned: boolean
  subscribers: Map<ServerResponse, VideoSubscriber>
  closed: boolean
  /** The last init segment and the codec it declared, for a late joiner. */
  init: Buffer | null
  codec: string | null
  retune: (fps: number) => void
  stop: () => void
}

const videoPumps = new Map<string, VideoPump>()

/**
 * The rate bounds the guest enforces (VIDEO_MIN_FPS/VIDEO_MAX_FPS in
 * deploy/desk-image/agent/desk-guest-agent.mjs), clamped here for the same
 * reason the frame rate is: the guest REFUSES a rate outside them, and a
 * refused video-start ends the iterator, so a mistyped query parameter would
 * take the live view down rather than being ignored.
 */
function clampVideoFps(fps: number): number {
  if (!Number.isFinite(fps)) return 30
  return Math.min(30, Math.max(1, Math.round(fps)))
}

/**
 * One chunk on the wire to a subscriber.
 *
 * A length-prefixed BINARY framing, not SSE and not JSON: this is a continuous
 * byte stream and base64-in-text would cost a third of it plus a decode per
 * chunk in the browser, on the one path the whole change exists to make cheap.
 * A plain chunked HTTP response is used rather than a websocket because the
 * browser reaches this only through the app's authenticated proxy — the runner
 * token must never reach a page — and a streaming response passes through that
 * proxy untouched, where a websocket upgrade does not.
 *
 *   [magic:2 = 'DV'][kind:1][flags:1][length:4 BE][payload:length]
 *
 * kind 1 = init, 2 = media. flags bit 0 = keyframe. The init payload is
 * preceded by its codec string as [codecLength:1][codec:codecLength] so a
 * consumer can build its decoder from what the bytes actually are.
 */
const VIDEO_WIRE_MAGIC = Buffer.from('DV', 'latin1')
const VIDEO_WIRE_KIND_INIT = 1
const VIDEO_WIRE_KIND_MEDIA = 2

function encodeVideoWireChunk(
  kind: number,
  keyframe: boolean,
  payload: Buffer,
): Buffer {
  const header = Buffer.allocUnsafe(8)
  VIDEO_WIRE_MAGIC.copy(header, 0)
  header[2] = kind
  header[3] = keyframe ? 1 : 0
  header.writeUInt32BE(payload.length, 4)
  return Buffer.concat([header, payload])
}

/** The init segment framed with the codec string a decoder has to be told. */
function encodeVideoInit(codec: string, init: Buffer): Buffer {
  const name = Buffer.from(codec, 'latin1').subarray(0, 255)
  const body = Buffer.concat([Buffer.from([name.length]), name, init])
  return encodeVideoWireChunk(VIDEO_WIRE_KIND_INIT, false, body)
}

/**
 * How much unflushed video one subscriber's socket may hold before it is cut
 * back to a keyframe. Smaller than the frame pump's cap because a fragment is
 * a fraction of a picture: a subscriber holding megabytes of video is seconds
 * behind, and seconds behind is not a live view.
 */
const VIDEO_SUBSCRIBER_BACKLOG_CAP_BYTES = 2 * 1024 * 1024

function startVideoPump(
  deskId: string,
  screen: DeskScreenHandle,
  options: { fps: number; width: number; height: number },
): VideoPump {
  const openIterator = (fps: number) =>
    screen.video({ fps, width: options.width, height: options.height })[Symbol.asyncIterator]()
  let source = openIterator(clampVideoFps(options.fps))
  const pump: VideoPump = {
    fps: clampVideoFps(options.fps),
    width: options.width,
    height: options.height,
    pinned: false,
    subscribers: new Map(),
    closed: false,
    init: null,
    codec: null,
    retune: (requested: number) => {
      const fps = clampVideoFps(requested)
      if (pump.closed || fps === pump.fps) return
      const previous = source
      pump.fps = fps
      // ORDER IS LOAD-BEARING, exactly as on the frame pump: finishing the old
      // iterator sends `video-stop` and opening the new one sends
      // `video-start`, both written to the same vsock stream in call order and
      // serialized by the guest. The other order would have the stop land on
      // the encoder the start had just begun.
      void previous.return?.().catch(() => undefined)
      source = openIterator(fps)
      // The new encoder emits a new init segment; until it lands, a subscriber
      // has nothing it can decode, so nobody is ready.
      pump.init = null
      pump.codec = null
      for (const subscriber of pump.subscribers.values()) subscriber.ready = false
      console.log(`[desk-runner] video pump for ${deskId} re-tuned to ${fps}fps`)
    },
    stop: () => {
      if (pump.closed) return
      pump.closed = true
      void source.return?.().catch(() => undefined)
      for (const subscriber of pump.subscribers.keys()) subscriber.end()
      pump.subscribers.clear()
      if (videoPumps.get(deskId) === pump) videoPumps.delete(deskId)
    },
  }
  videoPumps.set(deskId, pump)
  void (async () => {
    try {
      for (;;) {
        const reading = source
        const next = await reading.next()
        if (pump.closed) break
        if (next.done) {
          // A re-tune ends the iterator we were reading from; the next chunk
          // comes off the new one.
          if (reading !== source) continue
          break
        }
        const chunk = next.value
        if (chunk.kind === 'init') {
          pump.init = chunk.data
          pump.codec = chunk.codec
          // Everyone must be re-primed: the stream this describes is not the
          // stream they were watching.
          for (const subscriber of pump.subscribers.values()) subscriber.ready = false
        }
        for (const subscriber of pump.subscribers.values()) {
          writeVideoTo(pump, subscriber, chunk)
        }
      }
    } catch (error) {
      console.error(`[desk-runner] video pump for ${deskId} stopped: ${describe(error)}`)
    } finally {
      pump.stop()
    }
  })()
  return pump
}

/**
 * Hand one chunk to one subscriber, priming it first if it is not yet decoding.
 *
 * Never queues, for the same reason the frame pump never queues — but a drop
 * here costs more, because a hole makes everything after it decode to nothing.
 * So a backed-up subscriber is not handed the next chunk anyway; it is dropped
 * back to waiting for a keyframe, which is the only place a decoder can be
 * restarted cleanly.
 */
function writeVideoTo(pump: VideoPump, subscriber: VideoSubscriber, chunk: DeskVideoChunk): void {
  const { response } = subscriber
  if (response.writableEnded) return
  if (response.writableLength > VIDEO_SUBSCRIBER_BACKLOG_CAP_BYTES) {
    subscriber.ready = false
    return
  }
  if (!pump.init || !pump.codec) return
  if (subscriber.init !== pump.init) {
    response.write(encodeVideoInit(pump.codec, pump.init))
    subscriber.init = pump.init
    subscriber.ready = false
  }
  if (chunk.kind === 'init') return
  // Only a keyframe can start a decoder; anything before one is bytes that
  // decode to nothing and a picture that never appears.
  if (!subscriber.ready) {
    if (!chunk.keyframe) return
    subscriber.ready = true
  }
  response.write(encodeVideoWireChunk(VIDEO_WIRE_KIND_MEDIA, chunk.keyframe, chunk.data))
}

/**
 * The video pump for this desk, started if there is none and RE-TUNED if there
 * is one at a different rate — the same contract as `ensureFramePump`, so a
 * viewer can change rate without dropping its subscription.
 */
function ensureVideoPump(
  deskId: string,
  screen: DeskScreenHandle,
  options: { fps: number; width: number; height: number },
): VideoPump {
  const existing = videoPumps.get(deskId)
  if (existing && !existing.closed) {
    existing.retune(options.fps)
    return existing
  }
  return startVideoPump(deskId, screen, options)
}

/** The running video pump for this desk, or null. Never starts one. */
function liveVideoPump(deskId: string): VideoPump | null {
  const pump = videoPumps.get(deskId)
  return pump && !pump.closed ? pump : null
}

function closeVideoPump(deskId: string): void {
  videoPumps.get(deskId)?.stop()
}

// --- the handover relay and its host-side TTL (§3.14) -----------------------

/**
 * Take a live handover down: end it in the package (which files the boundary
 * event and the audit entry with its duration), forget the URL, and cut every
 * relay socket. Called on expiry, on an explicit end, and on teardown — the
 * TTL is enforced HERE as well as in the package's own sweep, because the
 * relay is this process's door and a door has to close by itself.
 */
function revokeHandover(entry: DeskEntry): void {
  if (entry.handoverTimer) {
    clearTimeout(entry.handoverTimer)
    entry.handoverTimer = null
  }
  const wasOpen = entry.handoverUrl !== null
  entry.handoverUrl = null
  entry.handoverExpiresAt = 0
  entry.handoverScope = null
  entry.handoverNonce = null
  for (const socket of entry.handoverSockets.values()) socket.destroy()
  entry.handoverSockets.clear()
  const screen = entry.screen
  if (screen?.handover.active) {
    void screen.handover.end().catch((error: unknown) => {
      console.error(`[desk-runner] handover end failed: ${describe(error)}`)
    })
  }
  if (wasOpen) {
    // Take the forwarder down now rather than leaving it to its own timeout:
    // an ended handover must stop being reachable at the moment it ends.
    void entry.handle
      .exec({
        command: '/usr/bin/pkill',
        args: ['-f', `TCP-LISTEN:${HANDOVER_RELAY_PORT}`],
        timeoutMs: 5_000,
      })
      .catch(() => undefined)
  }
}

/**
 * Put the guest's loopback-bound viewer on its tap address for exactly as long
 * as the grant lasts. `timeout` is the guest-side backstop: if this process
 * dies mid-handover, the forwarder still goes away on schedule rather than
 * outliving the thing it was opened for.
 */
async function exposeGuestHandover(entry: DeskEntry, ttlMs: number): Promise<void> {
  const guest = guestAddressFor(entry.index)
  const seconds = Math.max(1, Math.ceil(ttlMs / 1000))
  await entry.handle.exec({
    command: '/usr/bin/timeout',
    args: [
      '-k',
      '5',
      String(seconds),
      '/usr/bin/socat',
      `TCP-LISTEN:${HANDOVER_RELAY_PORT},fork,reuseaddr,bind=${guest}`,
      `TCP:127.0.0.1:${entry.handoverPort}`,
    ],
    keepAlive: true,
  })
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (await guestPortAnswers(guest, HANDOVER_RELAY_PORT)) return
    await delay(250)
  }
  throw new Error('The handover forwarder never came up inside the guest.')
}

function guestPortAnswers(address: string, port: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const probe = tcpConnect({ host: address, port, timeout: 1_000 })
    const settle = (answer: boolean) => {
      probe.destroy()
      resolvePromise(answer)
    }
    probe.once('connect', () => settle(true))
    probe.once('error', () => settle(false))
    probe.once('timeout', () => settle(false))
  })
}

// --- the websocket half of the handover relay -------------------------------

/**
 * The runner terminates the websocket and carries its payload as a byte
 * stream, because the two ends speak different things: a browser viewer sends
 * binary websocket frames, and x11vnc inside the guest speaks raw RFB. This is
 * websockify's whole job, in the one process that can already reach the guest
 * — a second service to do it would need the tap namespace and the token, so
 * it would be this process wearing a different name.
 *
 * Nothing here interprets RFB. Payloads are concatenated in arrival order and
 * written through untouched, which is exactly right for a byte stream: frame
 * boundaries and FIN carry no meaning the RFB layer can see.
 */
const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
/** A single client frame beyond this is a protocol abuse, not a viewer. */
const WEBSOCKET_MAX_FRAME_BYTES = 8 * 1024 * 1024

function acceptWebSocket(request: IncomingMessage, socket: Duplex): boolean {
  const key = request.headers['sec-websocket-key']
  if (typeof key !== 'string' || request.headers['sec-websocket-version'] !== '13') {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
    return false
  }
  const accept = createHash('sha1').update(`${key}${WEBSOCKET_GUID}`).digest('base64')
  // noVNC asks for the 'binary' subprotocol; answering it is what stops the
  // viewer falling back to base64 framing nothing here would decode.
  const offered = String(request.headers['sec-websocket-protocol'] ?? '')
    .split(',')
    .map((value) => value.trim())
  const chosen = offered.includes('binary') ? 'binary' : null
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n` +
      (chosen ? `Sec-WebSocket-Protocol: ${chosen}\r\n` : '') +
      '\r\n',
  )
  return true
}

function encodeWebSocketFrame(payload: Buffer, opcode: number): Buffer {
  const extended = payload.length < 126 ? 0 : payload.length < 65_536 ? 2 : 8
  const header = Buffer.alloc(2 + extended)
  header[0] = 0x80 | opcode
  header[1] = extended === 0 ? payload.length : extended === 2 ? 126 : 127
  if (extended === 2) header.writeUInt16BE(payload.length, 2)
  else if (extended === 8) header.writeBigUInt64BE(BigInt(payload.length), 2)
  return Buffer.concat([header, payload])
}

type WebSocketDrain = { rest: Buffer; data: Buffer[]; pongs: Buffer[]; closed: boolean; fatal: string | null }

/** Decode as many complete client frames as the buffer holds. Fails closed. */
function drainWebSocket(buffer: Buffer): WebSocketDrain {
  const data: Buffer[] = []
  const pongs: Buffer[] = []
  let offset = 0
  for (;;) {
    if (buffer.length - offset < 2) break
    const first = buffer[offset] ?? 0
    const second = buffer[offset + 1] ?? 0
    const opcode = first & 0x0f
    const masked = (second & 0x80) !== 0
    let length = second & 0x7f
    let cursor = offset + 2
    if (length === 126) {
      if (buffer.length - cursor < 2) break
      length = buffer.readUInt16BE(cursor)
      cursor += 2
    } else if (length === 127) {
      if (buffer.length - cursor < 8) break
      const wide = buffer.readBigUInt64BE(cursor)
      if (wide > BigInt(WEBSOCKET_MAX_FRAME_BYTES)) {
        return { rest: buffer, data, pongs, closed: true, fatal: 'websocket frame is too large' }
      }
      length = Number(wide)
      cursor += 8
    }
    if (length > WEBSOCKET_MAX_FRAME_BYTES) {
      return { rest: buffer, data, pongs, closed: true, fatal: 'websocket frame is too large' }
    }
    // RFC 6455: a client frame that is not masked is a protocol error, and a
    // stream that lies about its framing cannot be resynchronized — drop it.
    if (!masked) {
      return { rest: buffer, data, pongs, closed: true, fatal: 'client frame is not masked' }
    }
    if (buffer.length - cursor < 4 + length) break
    const mask = buffer.subarray(cursor, cursor + 4)
    cursor += 4
    const payload = Buffer.allocUnsafe(length)
    for (let i = 0; i < length; i += 1) {
      payload[i] = (buffer[cursor + i] ?? 0) ^ (mask[i % 4] ?? 0)
    }
    cursor += length
    offset = cursor
    if (opcode === 0x8) return { rest: buffer.subarray(offset), data, pongs, closed: true, fatal: null }
    if (opcode === 0x9) pongs.push(payload)
    else if (opcode === 0x0 || opcode === 0x1 || opcode === 0x2) data.push(payload)
    // 0xA (pong) and anything else is dropped; nothing here needs it.
  }
  return { rest: buffer.subarray(offset), data, pongs, closed: false, fatal: null }
}

/**
 * Splice one authenticated viewer to the guest's forwarded viewer port. The
 * TTL was checked before this was called and the socket is registered on the
 * desk, so an expiry cuts it mid-stream rather than waiting for it to leave.
 */
function relayHandoverSocket(args: {
  request: IncomingMessage
  socket: Duplex
  head: Buffer
  address: string
  onClose: () => void
}): void {
  const { request, socket, head, address } = args
  if (!acceptWebSocket(request, socket)) {
    args.onClose()
    return
  }
  const upstream = tcpConnect(HANDOVER_RELAY_PORT, address)
  let pending: Buffer = Buffer.alloc(0)
  let done = false
  const drop = () => {
    if (done) return
    done = true
    upstream.destroy()
    socket.destroy()
    args.onClose()
  }
  const feed = (chunk: Buffer) => {
    pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk])
    const drained = drainWebSocket(pending)
    pending = drained.rest
    for (const payload of drained.data) upstream.write(payload)
    for (const payload of drained.pongs) socket.write(encodeWebSocketFrame(payload, 0xa))
    if (drained.fatal) console.error(`[desk-runner] handover viewer refused: ${drained.fatal}`)
    if (drained.closed) drop()
  }
  upstream.once('connect', () => {
    if (head.length > 0) feed(head)
    socket.on('data', feed)
    upstream.on('data', (chunk: Buffer) => socket.write(encodeWebSocketFrame(chunk, 0x2)))
  })
  upstream.on('error', drop)
  upstream.on('close', drop)
  socket.on('error', drop)
  socket.on('close', drop)
}

function armHandoverExpiry(entry: DeskEntry, ttlMs: number): void {
  if (entry.handoverTimer) clearTimeout(entry.handoverTimer)
  entry.handoverExpiresAt = Date.now() + ttlMs
  const timer = setTimeout(() => revokeHandover(entry), ttlMs)
  timer.unref()
  entry.handoverTimer = timer
}

/**
 * The guest hands back an in-guest URL (an x11vnc endpoint on guest
 * localhost). Only its port matters out here — the address is always the
 * guest's, and a URL claiming otherwise is not one this runner will dial.
 */
function handoverPortFrom(url: string): number {
  try {
    const parsed = new URL(url)
    const port = Number(parsed.port)
    return Number.isInteger(port) && port > 0 && port < 65_536 ? port : HANDOVER_FALLBACK_PORT
  } catch {
    return HANDOVER_FALLBACK_PORT
  }
}

function handoverStreamPath(deskId: string, entry: DeskEntry): string {
  if (!entry.handoverScope || !entry.handoverNonce || entry.handoverExpiresAt <= Date.now()) {
    throw new Error('No live handover capability can be minted for this desk.')
  }
  const value = {
    deskId,
    scope: entry.handoverScope,
    expiresAt: entry.handoverExpiresAt,
    nonce: entry.handoverNonce,
  }
  const query = new URLSearchParams({
    expires: String(value.expiresAt),
    scope: value.scope,
    nonce: value.nonce,
    capability: signDeskHandoverCapability(TOKEN, value),
  })
  return `/desks/${encodeURIComponent(deskId)}/handover/stream?${query.toString()}`
}

// --- the in-guest browser and its CDP relay ---------------------------------

/**
 * Fetch Chromium's /json/version FROM INSIDE the guest. Returns the devtools
 * websocket path, e.g. /devtools/browser/<id>, or null while it is not there.
 *
 * NODE, NOT A HAND-ROLLED HTTP REQUEST DOWN bash's /dev/tcp. That is what this
 * was, and it could not work — for two separate reasons, both measured on the
 * real desk against Chromium 151:
 *
 *   · It asked in HTTP/1.0, and Chromium's devtools server answers HTTP/1.0
 *     with silence: no status line, no body. The same request as HTTP/1.1 gets
 *     `200 OK` and the JSON.
 *   · Even in HTTP/1.1 with `Connection: close`, Chromium does not close the
 *     socket, so the `cat` reading the reply never reaches EOF. The whole
 *     command then sat until the 5s exec timeout SIGKILLed it, which reports a
 *     null exit status, which this read as failure — while holding a complete
 *     JSON reply in its stdout.
 *
 * Either one alone made this return null forever, so `POST /desks/:id/browser`
 * spent its twenty seconds and reported "The in-guest browser did not come up"
 * about a browser that was up, listening, and answering. node is the right
 * tool and costs nothing: it is in the golden image by construction, because
 * the guest agent itself runs on it.
 *
 * The exit status is deliberately NOT required to be 0. What matters is
 * whether the answer arrived; a probe that was killed a moment after printing
 * it has still told us what we asked.
 */
async function guestBrowserPath(entry: DeskEntry): Promise<string | null> {
  const probe =
    `fetch('http://127.0.0.1:${CDP_PORT}/json/version')` +
    '.then((r) => r.text()).then((t) => process.stdout.write(t)).catch(() => process.exit(1))'
  const snapshot = await entry.handle
    .exec({ command: '/usr/bin/node', args: ['-e', probe], timeoutMs: 5_000 })
    .catch(() => null)
  if (!snapshot) return null
  const match = /"webSocketDebuggerUrl":\s*"ws:\/\/[^/]+(\/devtools\/browser\/[^"]+)"/.exec(snapshot.stdout)
  return match?.[1] ?? null
}

/**
 * Put Chromium's loopback-only CDP socket onto this desk's tap address. The
 * tap and its host routes are the capability boundary: this address is not on
 * a shared Docker network and the runner is the only process that can dial
 * it. `keepAlive` ties the forwarder to the VM job lifecycle; the runner also
 * probes first, so repeated browser opens never create duplicate listeners.
 */
async function ensureGuestBrowserRelay(entry: DeskEntry): Promise<void> {
  const guest = guestAddressFor(entry.index)
  if (await guestPortAnswers(guest, CDP_RELAY_PORT)) return
  await entry.handle.exec({
    command: '/usr/bin/socat',
    args: [
      `TCP-LISTEN:${CDP_RELAY_PORT},fork,reuseaddr,bind=${guest}`,
      `TCP:127.0.0.1:${CDP_PORT}`,
    ],
    keepAlive: true,
  })
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (await guestPortAnswers(guest, CDP_RELAY_PORT)) return
    await delay(250)
  }
  throw new Error('The in-guest browser relay did not come up.')
}

async function ensureGuestBrowser(entry: DeskEntry): Promise<string> {
  if (entry.browserPath) {
    const path = await guestBrowserPath(entry)
    if (path) {
      entry.browserPath = path
      await ensureGuestBrowserRelay(entry)
      return path
    }
    entry.browserPath = null
  }
  // The persistent profile and the downloads folder live in the guest home:
  // this is what makes logins survive across runs and puts downloaded files
  // where run_shell can see them.
  await entry.handle.exec({
    command: '/bin/mkdir',
    args: ['-p', BROWSER_PROFILE_DIR, DOWNLOADS_DIR],
    timeoutMs: 10_000,
  })
  const running: DeskJob[] = entry.handle.jobs()
  if (!running.some((job) => job.status === 'running' && job.command.includes('chromium'))) {
    await entry.handle.exec({
      command: '/usr/bin/chromium',
      args: [
        '--headless=new',
        // THE GUEST AGENT IS ROOT (desk-guest-agent.service says why), and so
        // is everything it starts. Chromium refuses outright:
        //
        //   ERROR:zygote_host_impl_linux.cc] Running as root without
        //   --no-sandbox is not supported.
        //
        // It exits before it opens the debugging port, so the only symptom out
        // here is this function's own timeout — "The in-guest browser did not
        // come up" — with the actual reason on a stderr nobody was reading.
        // The guest's per-desk boundary is the microVM, not Chromium's own
        // sandbox, so this gives up nothing that was holding.
        '--no-sandbox',
        // A microVM's /dev/shm is small, and Chromium's default is to put its
        // shared-memory regions there and crash when it cannot. Debian's
        // launcher adds this itself below a 3.8GB threshold, but only when it
        // is the launcher that runs — so it is said here rather than relied on.
        '--disable-dev-shm-usage',
        `--remote-debugging-port=${CDP_PORT}`,
        '--remote-debugging-address=0.0.0.0',
        `--user-data-dir=${BROWSER_PROFILE_DIR}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-gpu',
        '--mute-audio',
        '--hide-scrollbars',
      ],
      // DISPLAY and DBUS_SESSION_BUS_ADDRESS are NOT passed here and must not
      // be: this browser is headless and may well be running on a desk with no
      // screen at all. The guest agent adds the screen's session to a job's
      // environment by itself when there IS one (see withScreenEnv there), so
      // the two cases are handled in the one place that knows the answer.
      keepAlive: true,
    })
  }
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const path = await guestBrowserPath(entry)
    if (path) {
      entry.browserPath = path
      await ensureGuestBrowserRelay(entry)
      return path
    }
    await delay(500)
  }
  throw new Error('The in-guest browser did not come up.')
}

/**
 * Relay a CDP websocket into the guest. Raw byte splice on purpose: the
 * upgrade handshake and every websocket frame pass through untouched, so this
 * needs no websocket implementation and cannot corrupt one — Chromium's
 * devtools endpoint speaks websocket at the far end, so nothing has to be
 * translated. (The handover relay above cannot use this: x11vnc speaks raw
 * RFB, so its websocket has to terminate here.) The Host header is rewritten
 * to claim guest-localhost, because Chromium refuses non-local ones.
 */
function relayGuestSocket(args: {
  request: IncomingMessage
  socket: Duplex
  head: Buffer
  address: string
  port: number
  path: string
  onClose?: () => void
}): void {
  const { request, socket, head, address, port, path } = args
  const upstream = tcpConnect(port, address)
  upstream.on('connect', () => {
    const lines = [`GET ${path} HTTP/1.1`, `Host: 127.0.0.1:${port}`]
    for (let i = 0; i < request.rawHeaders.length; i += 2) {
      const name = request.rawHeaders[i] ?? ''
      const value = request.rawHeaders[i + 1] ?? ''
      if (/^(host|authorization)$/i.test(name)) continue
      lines.push(`${name}: ${value}`)
    }
    upstream.write(lines.join('\r\n') + '\r\n\r\n')
    if (head.length > 0) upstream.write(head)
    upstream.pipe(socket)
    socket.pipe(upstream)
  })
  const drop = () => {
    upstream.destroy()
    socket.destroy()
    args.onClose?.()
  }
  upstream.on('error', drop)
  upstream.on('close', drop)
  socket.on('error', drop)
  socket.on('close', drop)
}

/** Route an upgrade to the CDP relay or the handover relay, or refuse it. */
function relayUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
  const url = new URL(request.url ?? '/', 'http://desk-runner')

  const browser = /^\/desks\/([^/]+)\/browser(\/devtools\/.*)$/.exec(url.pathname)
  if (browser) {
    const deskId = decodeURIComponent(browser[1] ?? '')
    if (
      !tokenMatches(url.searchParams.get('token') ?? '') ||
      !deskIdentityMatches(TOKEN, deskId, url.searchParams.get('identity') ?? '')
    ) {
      socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n')
      return
    }
    const entry = desks.get(deskId)
    if (!entry) {
      socket.end('HTTP/1.1 404 Not Found\r\n\r\n')
      return
    }
    relayGuestSocket({
      request,
      socket,
      head,
      address: guestAddressFor(entry.index),
      port: CDP_RELAY_PORT,
      path: browser[2] ?? '/',
    })
    return
  }

  const handover = /^\/desks\/([^/]+)\/handover\/stream$/.exec(url.pathname)
  if (handover) {
    const deskId = decodeURIComponent(handover[1] ?? '')
    const entry = desks.get(deskId)
    // Fail closed on every arm of it: no desk, no live handover, or one whose
    // TTL has run out gets nothing. The deadline is checked HERE and not only
    // by the expiry timer, so a clock that slipped or a timer that did not
    // fire still cannot leave a viewer connected past its grant.
    if (!entry || !entry.handoverUrl || !entry.screen?.handover.active) {
      socket.end('HTTP/1.1 409 Conflict\r\n\r\n')
      return
    }
    if (entry.handoverExpiresAt <= Date.now()) {
      revokeHandover(entry)
      socket.end('HTTP/1.1 410 Gone\r\n\r\n')
      return
    }
    const scope = url.searchParams.get('scope')
    const expiresAt = Number(url.searchParams.get('expires'))
    const nonce = url.searchParams.get('nonce') ?? ''
    const capability = url.searchParams.get('capability') ?? ''
    if (
      (scope !== 'view' && scope !== 'control') ||
      scope !== entry.handoverScope ||
      expiresAt !== entry.handoverExpiresAt ||
      nonce !== entry.handoverNonce ||
      !verifyDeskHandoverCapability(TOKEN, { deskId, scope, expiresAt, nonce }, capability)
    ) {
      socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n')
      return
    }
    entry.handoverSockets.add(socket)
    relayHandoverSocket({
      request,
      socket,
      head,
      address: guestAddressFor(entry.index),
      onClose: () => entry.handoverSockets.delete(socket),
    })
    return
  }

  socket.end('HTTP/1.1 404 Not Found\r\n\r\n')
}

// --- HTTP plumbing ----------------------------------------------------------

function reply(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  })
  response.end(text)
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = ''
  request.setEncoding('utf8')
  for await (const chunk of request) {
    raw += String(chunk)
    if (Buffer.byteLength(raw) > BODY_LIMIT_BYTES) throw new Error('request body is too large')
  }
  if (!raw) return {}
  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    throw new Error('request body is not JSON')
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}

function describe(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.trim() || 'no reason given'
}

/**
 * Open a server-sent-event stream. No compression and no buffering: a frame
 * held back by a proxy's write buffer is a live view that lags behind the
 * screen it is supposed to be showing.
 */
function openEventStream(response: ServerResponse): void {
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-store, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })
  response.flushHeaders()
  // And no Nagle either — same reasoning as the video subscriber's.
  response.socket?.setNoDelay(true)
}

function waitFor(register: (wake: () => void) => void, ms: number): Promise<void> {
  return new Promise((resolvePromise) => {
    const timer = setTimeout(resolvePromise, ms)
    register(() => {
      clearTimeout(timer)
      resolvePromise()
    })
  })
}

// --- routing ----------------------------------------------------------------

const server = createServer((request, response) => {
  void route(request, response).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[desk-runner] ${message}`)
    if (!response.headersSent) reply(response, 500, { error: message })
    else response.destroy()
  })
})

server.on('upgrade', (request, socket, head) => {
  try {
    relayUpgrade(request, socket, head)
  } catch {
    socket.destroy()
  }
})

async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://desk-runner')

  if (request.method === 'GET' && url.pathname === '/health') {
    const ok = verification?.supported === true
    reply(response, ok ? 200 : 503, {
      ok,
      protocol: 'desk-v1',
      ...(verification ?? {}),
      ...(refusalReason ? { reason: refusalReason } : {}),
      ...(host ? host.stats() : {}),
    })
    return
  }

  const offered = (request.headers.authorization ?? '').replace(/^Bearer /i, '')
  if (!tokenMatches(offered)) {
    reply(response, 401, { error: 'unauthorized' })
    return
  }
  if (!host || verification?.supported !== true) {
    // Fail closed: an unsupported host serves nothing but its reason.
    reply(response, 503, { error: refusalReason ?? 'This host cannot serve desks.' })
    return
  }

  if (request.method === 'GET' && url.pathname === '/stats') {
    reply(response, 200, host.stats())
    return
  }

  const execMatch = /^\/executions\/([^/]+)$/.exec(url.pathname)
  if (execMatch && request.method === 'GET') {
    const executionId = decodeURIComponent(execMatch[1] ?? '')
    const execution = executions.get(executionId)
    if (!execution) {
      reply(response, 404, { error: 'execution not found or expired' })
      return
    }
    if (!deskIdentityMatches(TOKEN, execution.deskId, String(request.headers['x-bunkhouse-desk-identity'] ?? ''))) {
      reply(response, 401, { error: 'desk identity does not match' })
      return
    }
    if (!execution.snapshot.done && url.searchParams.get('wait')) {
      await waitFor((wake) => execution.waiters.push(wake), LONG_POLL_MS)
    }
    reply(response, 200, execution.snapshot)
    return
  }

  const deskMatch = /^\/desks\/([^/]+)(\/.*)?$/.exec(url.pathname)
  if (!deskMatch) {
    reply(response, 404, { error: 'not found' })
    return
  }
  let deskId: string
  try {
    deskId = cleanDeskId(decodeURIComponent(deskMatch[1] ?? ''))
  } catch (error) {
    reply(response, 400, { error: error instanceof Error ? error.message : 'bad desk id' })
    return
  }
  const rest = deskMatch[2] ?? ''
  if (!deskIdentityMatches(TOKEN, deskId, String(request.headers['x-bunkhouse-desk-identity'] ?? ''))) {
    reply(response, 401, { error: 'desk identity does not match' })
    return
  }

  if (request.method === 'POST' && rest === '/lease') {
    const body = await readBody(request)
    await ensureDesk(deskId, {
      memoryMb: numberOr(body.memoryMb),
      vcpus: numberOr(body.vcpus),
      leaseMs: numberOr(body.leaseMs),
    })
    reply(response, 200, { deskId, ...host.stats() })
    return
  }

  if (request.method === 'GET' && rest.startsWith('/events')) {
    const after = Number(url.searchParams.get('after') ?? 0)
    if (!Number.isSafeInteger(after) || after < 0) {
      reply(response, 400, { error: 'after must be a non-negative integer' })
      return
    }
    const entry = buffer(deskId)
    let events = entry.events.filter((event) => event.seq > after)
    if (events.length === 0 && url.searchParams.get('wait')) {
      await waitFor((wake) => entry.waiters.push(wake), LONG_POLL_MS)
      events = entry.events.filter((event) => event.seq > after)
    }
    reply(response, 200, { events })
    return
  }

  if (request.method === 'POST' && rest === '/executions') {
    const body = await readBody(request)
    if (typeof body.executionId !== 'string' || !Array.isArray(body.command) || body.command.length === 0) {
      reply(response, 400, { error: 'executionId and a non-empty command array are required' })
      return
    }
    const entry = await ensureDesk(deskId, {})
    const execution = startExecution(entry, deskId, {
      executionId: body.executionId,
      command: body.command.map(String),
      ...(typeof body.cwd === 'string' ? { cwd: body.cwd } : {}),
      ...(body.env && typeof body.env === 'object' ? { env: body.env as Record<string, string> } : {}),
      ...(numberOr(body.timeoutMs) !== undefined ? { timeoutMs: numberOr(body.timeoutMs) } : {}),
      ...(numberOr(body.outputLimitKb) !== undefined ? { outputLimitKb: numberOr(body.outputLimitKb) } : {}),
    })
    reply(response, 202, execution.snapshot)
    return
  }

  if (request.method === 'POST' && rest === '/jobs') {
    const body = await readBody(request)
    if (!Array.isArray(body.command) || body.command.length === 0) {
      reply(response, 400, { error: 'a non-empty command array is required' })
      return
    }
    const entry = await ensureDesk(deskId, {})
    const [command, ...args] = body.command.map(String)
    const job = await entry.handle.exec({ command: command ?? '/bin/false', args, keepAlive: true })
    reply(response, 202, job)
    return
  }

  if (request.method === 'GET' && rest === '/jobs') {
    const entry = desks.get(deskId)
    reply(response, 200, { jobs: entry ? entry.handle.jobs() : [] })
    return
  }

  if (request.method === 'POST' && rest === '/screen/start') {
    const body = await readBody(request)
    const entry = await ensureDesk(deskId, {})
    if (!entry.handle.screen.running) {
      entry.screen = await entry.handle.screen.start({
        width: numberOr(body.width) ?? 1280,
        height: numberOr(body.height) ?? 900,
      })
    }
    reply(response, 200, { running: true })
    return
  }

  if (request.method === 'POST' && rest === '/screen/stop') {
    const entry = desks.get(deskId)
    // The capture and any handover go down with the screen, in that order:
    // nothing may keep emitting frames off a compositor that is stopping.
    closeFramePump(deskId)
    closeVideoPump(deskId)
    if (entry) revokeHandover(entry)
    if (entry?.handle.screen.running) await entry.handle.screen.stop()
    if (entry) entry.screen = null
    reply(response, 200, { running: false })
    return
  }

  // Everything below needs a running screen.
  if (rest.startsWith('/screen/') || rest === '/handover') {
    const entry = desks.get(deskId)
    const screen = entry?.screen ?? null
    if (!entry || !screen) {
      reply(response, 409, { error: 'no screen is running on this desk' })
      return
    }

    if (request.method === 'GET' && rest === '/screen/observe') {
      const observation = await screen.observe()
      reply(response, 200, {
        png: observation.png.toString('base64'),
        width: observation.width,
        height: observation.height,
        a11y: observation.a11y,
        windows: observation.windows,
        focused: observation.focused,
      })
      return
    }

    if (request.method === 'POST' && rest === '/screen/input') {
      const body = await readBody(request)
      const action = String(body.action ?? '')
      switch (action) {
        case 'move':
          await screen.input.move(Number(body.x), Number(body.y))
          break
        case 'click':
          for (let click = 0; click < (body.clicks === 2 ? 2 : 1); click += 1) {
            await screen.input.click(
              Number(body.x),
              Number(body.y),
              body.button === 'middle' || body.button === 'right' ? body.button : 'left',
            )
          }
          break
        case 'type':
          await screen.input.type(String(body.text ?? ''))
          break
        case 'key':
          await screen.input.key(String(body.combo ?? ''))
          break
        case 'scroll':
          await screen.input.scroll(Number(body.x), Number(body.y), Number(body.dx ?? 0), Number(body.dy ?? 0))
          break
        case 'drag': {
          const from = body.from as { x: number; y: number }
          const to = body.to as { x: number; y: number }
          await screen.input.drag(
            { x: Number(from?.x), y: Number(from?.y) },
            { x: Number(to?.x), y: Number(to?.y) },
          )
          break
        }
        default:
          reply(response, 400, { error: `unknown input action "${action}"` })
          return
      }
      reply(response, 200, { done: true })
      return
    }

    if (request.method === 'POST' && rest === '/screen/focus') {
      const body = await readBody(request)
      await screen.a11y.invoke(String(body.windowId ?? ''), 'activate')
      reply(response, 200, { done: true })
      return
    }

    if (request.method === 'POST' && rest === '/screen/launch') {
      const body = await readBody(request)
      await screen.launch(String(body.appId ?? ''), Array.isArray(body.args) ? body.args.map(String) : [])
      reply(response, 200, { done: true })
      return
    }

    if (request.method === 'POST' && rest === '/screen/frames/start') {
      const body = await readBody(request)
      const options = {
        fps: numberOr(body.fps) ?? 10,
        width: numberOr(body.width) ?? 1280,
        height: numberOr(body.height) ?? 900,
      }
      // `pin: false` makes this a RE-TUNE and nothing else: change the rate of
      // a capture that is already running, and if none is, say so and start
      // nothing. A pump with no subscribers is a guest painting for nobody,
      // and only an explicit (pinned) start is allowed to create one.
      const pin = body.pin !== false
      const running = liveFramePump(deskId)
      if (!pin && !running) {
        reply(response, 200, { streaming: false, fps: options.fps, width: options.width, height: options.height })
        return
      }
      const pump = ensureFramePump(deskId, screen, options)
      if (pin) pump.pinned = true
      reply(response, 200, { streaming: true, fps: pump.fps, width: pump.width, height: pump.height })
      return
    }

    if (request.method === 'POST' && rest === '/screen/frames/stop') {
      closeFramePump(deskId)
      reply(response, 200, { streaming: false })
      return
    }

    if (request.method === 'GET' && rest === '/screen/frames') {
      const asked = Number(url.searchParams.get('fps') ?? 10) || 10
      // A subscription asks for a FLOOR, never a ceiling: somebody arriving to
      // watch must not slow down the capture another consumer is driving at.
      // Lowering it again is the explicit re-tune's job (POST .../frames/start
      // with pin:false), which sets the rate exactly.
      const running = liveFramePump(deskId)
      const pump = ensureFramePump(deskId, screen, {
        fps: Math.max(asked, running?.fps ?? 0),
        width: Number(url.searchParams.get('width') ?? 1280) || 1280,
        height: Number(url.searchParams.get('height') ?? 900) || 900,
      })
      openEventStream(response)
      pump.subscribers.add(response)
      // A still screen emits nothing at all — that is the damage-driven
      // capture working — so a comment line keeps the connection honest
      // through whatever sits between here and the subscriber.
      const beat = setInterval(() => {
        if (!response.writableEnded) response.write(': keepalive\n\n')
      }, 15_000)
      beat.unref()
      response.on('close', () => {
        clearInterval(beat)
        pump.subscribers.delete(response)
        // An unpinned pump exists only for its watchers; the last one leaving
        // stops the guest capturing rather than paying for a picture nobody
        // is looking at.
        if (!pump.pinned && pump.subscribers.size === 0) pump.stop()
      })
      return
    }

    if (request.method === 'POST' && rest === '/screen/video/start') {
      const body = await readBody(request)
      const options = {
        fps: numberOr(body.fps) ?? 30,
        width: numberOr(body.width) ?? 1280,
        height: numberOr(body.height) ?? 900,
      }
      const pump = ensureVideoPump(deskId, screen, options)
      // pin:false is a RE-TUNE of a pump that is already running — the rate
      // changes under the subscribers without any of them re-subscribing.
      if (body.pin !== false) pump.pinned = true
      reply(response, 200, { streaming: true, fps: pump.fps, width: pump.width, height: pump.height })
      return
    }

    if (request.method === 'POST' && rest === '/screen/video/stop') {
      closeVideoPump(deskId)
      reply(response, 200, { streaming: false })
      return
    }

    if (request.method === 'GET' && rest === '/screen/video') {
      const asked = Number(url.searchParams.get('fps') ?? 30) || 30
      // A subscription asks for a FLOOR, never a ceiling, exactly as the frame
      // stream does: somebody arriving to watch must not slow down the encode
      // another consumer is driving at.
      const running = liveVideoPump(deskId)
      const pump = ensureVideoPump(deskId, screen, {
        fps: Math.max(asked, running?.fps ?? 0),
        width: Number(url.searchParams.get('width') ?? 1280) || 1280,
        height: Number(url.searchParams.get('height') ?? 900) || 900,
      })
      response.writeHead(200, {
        'content-type': 'application/octet-stream',
        'cache-control': 'no-store, no-transform',
        connection: 'keep-alive',
        // A proxy that buffers this turns a live view into a slideshow.
        'x-accel-buffering': 'no',
      })
      response.flushHeaders()
      // NAGLE OFF, and this is a latency fix rather than a tidy-up.
      //
      // One fragment of this stream is one FRAME, and on a mostly-still
      // desktop that is a few hundred bytes — far under an MSS. Nagle holds a
      // sub-MSS write until the previous segment is acknowledged, and the peer
      // is under no obligation to acknowledge promptly (delayed ACK waits up to
      // 40ms for something to piggyback on). The two together are the classic
      // small-write stall: the guest encoded the picture in time, the runner
      // wrote it in time, and the kernel sat on it. It costs a packet per frame
      // to switch off, which is exactly what a live view wants to spend.
      response.socket?.setNoDelay(true)
      const subscriber: VideoSubscriber = { response, ready: false, init: null }
      pump.subscribers.set(response, subscriber)
      // A late joiner is primed from whatever the pump already holds, rather
      // than waiting for the encoder's next init segment — which, on a
      // long-running encode, never comes.
      if (pump.init && pump.codec) {
        response.write(encodeVideoInit(pump.codec, pump.init))
        subscriber.init = pump.init
      }
      response.on('close', () => {
        pump.subscribers.delete(response)
        // An unpinned pump exists only for its watchers; the last one leaving
        // stops the guest encoding rather than paying for a picture nobody is
        // looking at.
        if (!pump.pinned && pump.subscribers.size === 0) pump.stop()
      })
      return
    }

    if (request.method === 'POST' && rest === '/screen/clipboard') {
      const body = await readBody(request)
      if (body.op === 'write') {
        await screen.clipboard.write(String(body.text ?? ''))
        reply(response, 200, { done: true })
      } else {
        reply(response, 200, { text: await screen.clipboard.read() })
      }
      return
    }

    if (request.method === 'POST' && rest === '/handover') {
      const body = await readBody(request)
      if (body.op === 'end') {
        // revokeHandover ends it in the package (which files the boundary and
        // its duration) and cuts every viewer already spliced through.
        revokeHandover(entry)
        reply(response, 200, { ended: true })
        return
      }
      // Idempotent begin: an approval replay reopens the SAME handover rather
      // than erroring or stacking a second one. The package throws on a second
      // begin, so this branch is what makes the replay safe.
      if (screen.handover.active && entry.handoverUrl) {
        if (entry.handoverExpiresAt <= Date.now()) {
          revokeHandover(entry)
          reply(response, 409, { error: 'that handover has expired' })
          return
        }
        reply(response, 200, {
          url: handoverStreamPath(deskId, entry),
          stream: handoverStreamPath(deskId, entry),
          expiresAt: new Date(entry.handoverExpiresAt).toISOString(),
        })
        return
      }
      const ttlMs = numberOr(body.ttlMs) ?? 15 * 60_000
      const scope: DeskHandoverScope = body.scope === 'view' ? 'view' : 'control'
      const { url: handoverUrl } = await screen.handover.begin({
        ttlMs,
        scope,
        ...(typeof body.actor === 'string' ? { actor: body.actor } : {}),
      })
      entry.handoverUrl = handoverUrl
      entry.handoverPort = handoverPortFrom(handoverUrl)
      entry.handoverScope = scope
      entry.handoverNonce = randomBytes(18).toString('base64url')
      try {
        await exposeGuestHandover(entry, ttlMs)
      } catch (error) {
        // A handover nobody can reach is not a handover. End it rather than
        // hand back a URL that leads nowhere.
        revokeHandover(entry)
        reply(response, 502, { error: describe(error) })
        return
      }
      armHandoverExpiry(entry, ttlMs)
      const stream = handoverStreamPath(deskId, entry)
      reply(response, 200, {
        url: stream,
        stream,
        expiresAt: new Date(entry.handoverExpiresAt).toISOString(),
      })
      return
    }
  }

  if (request.method === 'POST' && rest === '/suspend') {
    await suspendDesk(deskId)
    reply(response, 200, { suspended: true })
    return
  }

  if (request.method === 'DELETE' && rest === '') {
    await destroyDesk(deskId)
    reply(response, 200, { destroyed: true })
    return
  }

  if (request.method === 'POST' && rest === '/browser') {
    const entry = await ensureDesk(deskId, {})
    const path = await ensureGuestBrowser(entry)
    reply(response, 200, { path })
    return
  }

  reply(response, 404, { error: 'not found' })
}

function numberOr(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

// --- boot -------------------------------------------------------------------

/**
 * Take every desk's tap and rules down on the way out. A container that dies
 * leaving its taps behind leaks devices across restarts, and leaves rules
 * pointing at devices that no longer exist.
 */
function teardownEverything(): Promise<void> {
  const indexes = [...deskIndexes.values()]
  deskIndexes.clear()
  return Promise.all(indexes.map((index) => teardownDeskNetwork(index).catch(() => undefined))).then(
    () => undefined,
  )
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void teardownEverything().finally(() => process.exit(0))
  })
}

/**
 * Delete every desk tap left in this namespace before probing.
 *
 * A tap outlives the VMM that opened it. If a desk's VMM is killed — or the
 * boot probe's own VM is left running by a previous container — the device
 * stays, still claimed, and the next VM to name it dies instantly with
 * `ConfigureTap: Resource busy`. The package reports that as "the VMM exited
 * before the guest agent came up", which is indistinguishable from a host
 * that cannot virtualise at all, and it is sticky: every subsequent boot
 * fails the same way until something removes the device.
 *
 * This process has just started, so nothing it is responsible for can
 * legitimately own one of these yet: any that exist are debris.
 */
async function reclaimStaleTaps(): Promise<void> {
  const listed = await run('ip', ['-o', 'link', 'show']).catch(() => '')
  const stale = [...listed.matchAll(/^\d+:\s+(dsk\w+)[@:]/gm)].map((match) => match[1])
  for (const device of stale) {
    if (device === undefined) continue
    await run('ip', ['link', 'del', device]).catch(() => undefined)
    console.log(`[desk-runner] reclaimed a stale tap left by an earlier run: ${device}`)
  }
}

/**
 * Probe the host until it answers, rather than once and forever.
 *
 * The probe boots a real microVM and waits for a guest that is still coming
 * up. That race is winnable and usually won, but losing it once must not
 * leave the host permanently refusing desks when nothing is actually wrong
 * with it — the first boot after a restart is exactly when the machine is
 * busiest. So a failure is retried a few times with a gap, and only a
 * consistent failure is reported as a host that cannot serve desks.
 */
async function verifyWithRetries(
  attempt: () => Promise<DeskHostVerification>,
  attempts = Number(process.env.BUNKHOUSE_DESK_VERIFY_ATTEMPTS ?? 4),
  gapMs = Number(process.env.BUNKHOUSE_DESK_VERIFY_GAP_MS ?? 20_000),
): Promise<DeskHostVerification> {
  let last: DeskHostVerification | null = null
  for (let index = 0; index < attempts; index += 1) {
    if (index > 0) {
      console.log(`[desk-runner] retrying the host probe (attempt ${index + 1} of ${attempts})`)
      await new Promise((resolvePromise) => setTimeout(resolvePromise, gapMs))
    }
    last = await attempt()
    if (last.supported) return last
  }
  return last as DeskHostVerification
}

server.listen(PORT, () => {
  console.log(`[desk-runner] listening on ${PORT}; disks ${DISKS_ROOT}; shared folder ${SHARED_FOLDER}`)
  void verifyNetAdmin()
    .then(async () => {
      // Cloud Hypervisor creates its API and vsock sockets in this directory
      // and will not create the directory itself: without it the VMM dies at
      // once with "Error creation API server's socket", which surfaces from
      // the package as the far less helpful "the VMM exited before the guest
      // agent came up".
      await mkdir(DEFAULT_RUNTIME_DIR, { recursive: true })
      await reclaimStaleTaps()
      return verifyWithRetries(() =>
        verifyDeskHost({
        kernelPath: join(DISKS_ROOT, 'vmlinux'),
        // The Debian cloud kernel is modular; without its initramfs the probe
        // VM panics before the guest agent answers and vsock reads as
        // unsupported.
        initramfsPath: join(DISKS_ROOT, 'initrd'),
        baseImagePath: join(DISKS_ROOT, 'base.raw'),
        kernelCmdline: GUEST_KERNEL_CMDLINE,
        // Clone the probe's throwaway disk where every other desk disk lives.
        // The default is the OS tmpdir, which in a container is the writable
        // overlay: no reflink there, so a 20GB base is COPIED, slowly, into a
        // layer that was never sized for it — and the probe times out looking
        // like a host that cannot boot a VM at all.
          scratchDir: join(DISKS_ROOT, 'overlays'),
          backend: deskBackend,
        }),
      )
    })
    .then((result) => {
      verification = result
      if (!result.supported) {
        refusalReason = result.kvm
          ? 'The probe desk booted but its guest agent never answered over vsock.'
          : 'KVM is not available. Desks require hardware virtualization; there is no software-emulation fallback.'
        console.error(`[desk-runner] DESKS REFUSED: ${refusalReason}`)
        return
      }
      host = createDeskHost({
        imageRoot: DISKS_ROOT,
        capacity: CAPACITY,
        idleSuspendMs: IDLE_SUSPEND_MS,
        kernelCmdline: GUEST_KERNEL_CMDLINE,
        backend: deskBackend,
        ports: {
          // Governance deliberately does NOT live here (spec §3.22): the dial
          // and the feature gate are enforced in bunkhouse's tier before a
          // request ever reaches this process, and per-command gating on a
          // root shell enforces nothing. Real enforcement is the egress
          // proxy, what is mounted, and the ledger the events below feed.
          onEvent: onDeskEvent,
          audit: (auditEntry) => console.log(`[desk-runner] audit ${JSON.stringify(auditEntry)}`),
        },
      })
      console.log(
        `[desk-runner] desks ready — kvm=${result.kvm} vsock=${result.vsock} virtioGpu=${result.virtioGpu}, ` +
          `capacity ${CAPACITY}; guest egress DNAT'd to ${HOST_GATEWAY_ADDR}:${EGRESS_HTTP_PORT}/${EGRESS_HTTPS_PORT}, ` +
          `dns ${GUEST_DNS}, everything else dropped`,
      )
    })
    .catch((error: unknown) => {
      // Fail LOUD and fail CLOSED, and that includes the network arm: without
      // NET_ADMIN there is no tap and no enforcement, and a desk booted anyway
      // would be a root shell with an unfiltered route to the internet. The
      // reason is what /health serves from here on.
      refusalReason = describe(error)
      verification = { supported: false, vmmPath: '', kvm: false, vsock: false, virtioGpu: false }
      console.error(`[desk-runner] DESKS REFUSED: ${refusalReason}`)
    })
})
