import 'server-only'
import { NextResponse } from 'next/server'
import { handleTeamsActivity, resolveTeamsTenant, type TeamsActivity } from '../../../../lib/chat-bridge'

export const dynamic = 'force-dynamic'

/**
 * Microsoft Teams' Outgoing Webhook callback (the optional inbound bridge —
 * see chat-bridge.ts's header comment for why this is the lighter Outgoing
 * Webhook mechanism rather than a full Azure Bot Service registration). Every
 * request's `Authorization: HMAC <base64>` header is verified against a
 * connected tenant's security token — keyed by HMAC-SHA256 of the exact
 * request body — before the activity inside it is trusted.
 *
 * Unlike Slack, Teams wants the reply activity back in THIS same HTTP
 * response rather than delivered out-of-band, so the run is awaited here
 * instead of fired-and-forgotten. That is this mechanism's real limit: Teams
 * waits only a few seconds before showing the user its own timeout notice;
 * a slow agent run still finishes, but its reply can arrive after Teams has
 * already given up on this request.
 */
export async function POST(request: Request): Promise<Response> {
  const rawBody = await request.text()
  const tenantId = await resolveTeamsTenant(rawBody, request.headers.get('authorization'))
  if (!tenantId) {
    return NextResponse.json({ error: 'Signature verification failed.' }, { status: 401 })
  }

  let activity: TeamsActivity
  try {
    activity = JSON.parse(rawBody) as TeamsActivity
  } catch {
    return NextResponse.json({ error: 'Invalid JSON.' }, { status: 400 })
  }

  const reply = await handleTeamsActivity(tenantId, activity)
  // A duplicate delivery (or a non-message activity) gets an empty 200 —
  // no reply activity, so nothing new is posted into the channel.
  return NextResponse.json(reply ?? {})
}
