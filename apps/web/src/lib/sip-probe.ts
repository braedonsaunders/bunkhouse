import 'server-only'
import { randomBytes } from 'node:crypto'
import { createSocket } from 'node:dgram'
import { connect as connectTcp, type Socket } from 'node:net'
import { connect as connectTls } from 'node:tls'

/**
 * A SIP OPTIONS keepalive, spoken directly from Node.
 *
 * OPTIONS is the standard "are you there" of SIP: any compliant phone system
 * answers it with its own status line and the methods it supports, without
 * ringing anything. It is what Avaya IP Office's "Check OOS" setting sends,
 * and it is how this deployment tells a configured trunk from a reachable
 * one — a saved row proves nothing until the far end answers.
 *
 * The request is built by hand rather than pulling in a SIP stack: one
 * transaction, no dialog, no retransmission (a single timeout is a truthful
 * answer for a health probe). Anything the far end says back — including a
 * 403 or a 404 — proves the address is live and speaking SIP, so the status
 * line is reported verbatim rather than judged.
 */

export type SipProbeResult = {
  /** The far end answered with a SIP response of any class. */
  reachable: boolean
  /** Response status code, when one came back. */
  code: number | null
  /** The response's status line, or the reason nothing came back. */
  detail: string
  /** Round trip in milliseconds; null when nothing answered. */
  latencyMs: number | null
}

export type SipProbeTarget = {
  host: string
  port: number
  transport: 'udp' | 'tcp' | 'tls'
  /** How long to wait for the first response. */
  timeoutMs?: number
  /** Domain to address the request to; defaults to the host. */
  domain?: string
}

const DEFAULT_TIMEOUT_MS = 4000

/** RFC 3261 branch parameters are prefixed with the magic cookie. */
function branch(): string {
  return `z9hG4bK${randomBytes(8).toString('hex')}`
}

function buildOptions(target: SipProbeTarget, localAddress: string): string {
  const domain = target.domain?.trim() || target.host
  const transport = target.transport.toUpperCase()
  const tag = randomBytes(6).toString('hex')
  const callId = `${randomBytes(12).toString('hex')}@${localAddress}`
  return [
    `OPTIONS sip:${domain} SIP/2.0`,
    `Via: SIP/2.0/${transport} ${localAddress};branch=${branch()};rport`,
    'Max-Forwards: 70',
    `From: <sip:bunkhouse@${localAddress}>;tag=${tag}`,
    `To: <sip:${domain}>`,
    `Call-ID: ${callId}`,
    'CSeq: 1 OPTIONS',
    'Contact: <sip:bunkhouse@' + localAddress + '>',
    'User-Agent: bunkhouse',
    'Accept: application/sdp',
    'Content-Length: 0',
    '',
    '',
  ].join('\r\n')
}

/** First line of a SIP response: `SIP/2.0 200 OK`. */
function parseStatusLine(payload: string): { code: number; detail: string } | null {
  const line = payload.split(/\r?\n/, 1)[0]?.trim() ?? ''
  const match = /^SIP\/2\.0\s+(\d{3})\s*(.*)$/.exec(line)
  if (!match) return null
  return { code: Number(match[1]), detail: line }
}

function probeUdp(target: SipProbeTarget, timeoutMs: number): Promise<SipProbeResult> {
  return new Promise((resolve) => {
    const socket = createSocket('udp4')
    const startedAt = Date.now()
    let settled = false
    const finish = (result: SipProbeResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.close()
      resolve(result)
    }
    const timer = setTimeout(
      () =>
        finish({
          reachable: false,
          code: null,
          detail: `No SIP response within ${Math.round(timeoutMs / 1000)}s.`,
          latencyMs: null,
        }),
      timeoutMs,
    )
    socket.on('error', (error) =>
      finish({ reachable: false, code: null, detail: error.message, latencyMs: null }),
    )
    socket.on('message', (message) => {
      // Provisional responses are not an answer to OPTIONS; keep waiting.
      const status = parseStatusLine(message.toString('utf8'))
      if (!status || status.code < 200) return
      finish({ reachable: true, code: status.code, detail: status.detail, latencyMs: Date.now() - startedAt })
    })
    socket.bind(0, () => {
      const local = socket.address()
      const request = buildOptions(target, `${local.address === '0.0.0.0' ? '127.0.0.1' : local.address}:${local.port}`)
      socket.send(Buffer.from(request, 'utf8'), target.port, target.host, (error) => {
        if (error) finish({ reachable: false, code: null, detail: error.message, latencyMs: null })
      })
    })
  })
}

function probeStream(target: SipProbeTarget, timeoutMs: number): Promise<SipProbeResult> {
  return new Promise((resolve) => {
    const startedAt = Date.now()
    let buffered = ''
    let settled = false
    const socket: Socket =
      target.transport === 'tls'
        ? connectTls({ host: target.host, port: target.port, servername: target.host, rejectUnauthorized: false })
        : connectTcp({ host: target.host, port: target.port })
    const finish = (result: SipProbeResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      resolve(result)
    }
    const timer = setTimeout(
      () =>
        finish({
          reachable: false,
          code: null,
          detail: `No SIP response within ${Math.round(timeoutMs / 1000)}s.`,
          latencyMs: null,
        }),
      timeoutMs,
    )
    socket.on('error', (error: Error) =>
      finish({ reachable: false, code: null, detail: error.message, latencyMs: null }),
    )
    socket.on('close', () => {
      if (!settled) {
        finish({
          reachable: false,
          code: null,
          detail: 'The phone system closed the connection without answering.',
          latencyMs: null,
        })
      }
    })
    socket.on('data', (chunk: Buffer) => {
      buffered += chunk.toString('utf8')
      const status = parseStatusLine(buffered)
      if (!status || status.code < 200) return
      finish({ reachable: true, code: status.code, detail: status.detail, latencyMs: Date.now() - startedAt })
    })
    const ready = () => {
      const local = `${socket.localAddress ?? '127.0.0.1'}:${socket.localPort ?? 5060}`
      socket.write(buildOptions(target, local.replace(/^::ffff:/, '')))
    }
    if (target.transport === 'tls') socket.once('secureConnect', ready)
    else socket.once('connect', ready)
  })
}

/**
 * Send one OPTIONS request and report what came back. Never throws: an
 * unreachable phone system is a result, not an error.
 */
export async function sipOptionsPing(target: SipProbeTarget): Promise<SipProbeResult> {
  const timeoutMs = target.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (!target.host.trim()) {
    return { reachable: false, code: null, detail: 'No phone system address is set on this trunk.', latencyMs: null }
  }
  try {
    return target.transport === 'udp'
      ? await probeUdp(target, timeoutMs)
      : await probeStream(target, timeoutMs)
  } catch (error) {
    return {
      reachable: false,
      code: null,
      detail: error instanceof Error ? error.message : String(error),
      latencyMs: null,
    }
  }
}
