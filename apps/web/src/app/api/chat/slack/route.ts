import 'server-only'
import { NextResponse } from 'next/server'
import { handleSlackEvent, resolveSlackTenant, type SlackEventEnvelope } from '../../../../lib/chat-bridge'

export const dynamic = 'force-dynamic'

/**
 * Slack's Events API request URL. Every request — including the one-time URL
 * verification handshake Slack sends when this address is first configured —
 * is HMAC-verified (the `v0` scheme over `v0:{timestamp}:{body}`, a 5-minute
 * replay window) before anything in the body is trusted; an unverifiable
 * request is rejected outright. Slack requires a 2xx within roughly 3 seconds
 * or it retries the same event aggressively, and a governed agent run can
 * easily take longer than that — so the event is acknowledged immediately and
 * the run + reply happen after. The dedupe ledger, keyed on Slack's own
 * per-event `event_id`, is what stops a retried delivery from starting a
 * second run (see chat-bridge.ts's `claimInboundEvent`).
 */
export async function POST(request: Request): Promise<Response> {
  const rawBody = await request.text()
  const timestamp = request.headers.get('x-slack-request-timestamp')
  const signature = request.headers.get('x-slack-signature')
  if (!timestamp || !signature) {
    return NextResponse.json({ error: 'Missing Slack signature headers.' }, { status: 401 })
  }

  const tenantId = await resolveSlackTenant(rawBody, timestamp, signature)
  if (!tenantId) {
    return NextResponse.json({ error: 'Signature verification failed.' }, { status: 401 })
  }

  let payload: SlackEventEnvelope
  try {
    payload = JSON.parse(rawBody) as SlackEventEnvelope
  } catch {
    return NextResponse.json({ error: 'Invalid JSON.' }, { status: 400 })
  }

  // The Events API handshake: echo the challenge back, unprocessed.
  if (payload.type === 'url_verification') {
    return NextResponse.json({ challenge: payload.challenge })
  }

  if (payload.type === 'event_callback') {
    // Acknowledge now; the reply lands in the thread whenever the run
    // finishes. handleSlackEvent never throws — a failure only reaches the
    // server log, since Slack has already been told the delivery succeeded.
    void handleSlackEvent(tenantId, payload)
  }

  return NextResponse.json({ ok: true })
}
