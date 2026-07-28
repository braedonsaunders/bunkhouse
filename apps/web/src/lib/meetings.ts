import 'server-only'
import { randomBytes, randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { defineAbility, type Ability } from '@bunkhouse/runtime'
import { callSessions, meetingLinks, people } from '../db/schema'
import { db } from '../db/client'
import { sendNewMail } from './mailbox'

/**
 * Video meetings: the agent sets one up, mails the link, and joins the room
 * itself. A meeting is a call session like any other — same room, same voice
 * worker, same transcript ledger — with one extra row: the meeting_links
 * token that lets a guest walk in with no account and no software (doctrine
 * #1). The link is the credential, so it is unguessable, single-meeting, and
 * expires; using it is stamped on the row.
 */

type PersonRow = typeof people.$inferSelect

/** Rooms the voice worker answers as meetings. */
export const MEETING_ROOM_PREFIX = 'meet-'

export function meetingRoomName(sessionId: string): string {
  return `${MEETING_ROOM_PREFIX}${sessionId}`
}

/** How long an invitation stays good for. Long enough for tomorrow morning. */
export const MEETING_LINK_TTL_HOURS = 48

/** Where the guest page lives. Same origin the app is served on. */
function appUrl(): string {
  return (process.env.APP_URL ?? 'http://localhost:4810').replace(/\/+$/, '')
}

export function meetingUrlFor(token: string): string {
  return `${appUrl()}/meet/${token}`
}

export type MeetingInvitee = { name?: string; address?: string }

export type CreatedMeeting = {
  sessionId: string
  token: string
  meetingUrl: string
  expiresAt: Date
}

/**
 * Set up a meeting: the session (and its room) exists from this moment, so
 * the voice worker finds it the instant the guest walks in, and the guest
 * link is committed alongside it in the same transaction.
 */
export async function createMeeting(args: {
  tenantId: string
  person: PersonRow
  runId: string
  purpose: string
  invitee?: MeetingInvitee
}): Promise<CreatedMeeting> {
  const { tenantId, person, runId } = args
  const purpose = args.purpose.trim()
  const sessionId = randomUUID()
  const token = randomBytes(24).toString('base64url')
  const expiresAt = new Date(Date.now() + MEETING_LINK_TTL_HOURS * 60 * 60 * 1000)
  const counterparty = {
    name: args.invitee?.name?.trim() || 'Guest',
    ...(args.invitee?.address ? { email: args.invitee.address } : {}),
  }

  const app = db()
  await app.withTenant(tenantId, async () => {
    await app.db.insert(callSessions).values({
      id: sessionId,
      tenantId,
      personId: person.id,
      runId,
      room: meetingRoomName(sessionId),
      direction: 'web',
      counterparty,
      purpose,
    })
    await app.db.insert(meetingLinks).values({
      tenantId,
      sessionId,
      token,
      createdByPersonId: person.id,
      expiresAt,
    })
  })

  return { sessionId, token, meetingUrl: meetingUrlFor(token), expiresAt }
}

export type MeetingLookup =
  | {
      ok: true
      tenantId: string
      sessionId: string
      room: string
      purpose: string | null
      expiresAt: Date
      joinedAt: Date | null
      agent: { id: string; name: string; title: string }
    }
  | { ok: false; reason: 'unknown' | 'expired' | 'ended' | 'unavailable' }

/**
 * Resolve a guest link. Guests carry no session and belong to no tenant, so
 * the token itself is the only thing that names one — the lookup runs above
 * RLS and every read after it is pinned to the tenant the token resolved to.
 */
export async function lookupMeetingByToken(token: string): Promise<MeetingLookup> {
  if (!token || token.length > 128) return { ok: false, reason: 'unknown' }
  const app = db()
  const [link] = await app.withSuperAdmin((superDb) =>
    superDb.select().from(meetingLinks).where(eq(meetingLinks.token, token)),
  )
  if (!link) return { ok: false, reason: 'unknown' }
  if (link.expiresAt.getTime() <= Date.now()) return { ok: false, reason: 'expired' }

  const [session] = await app.withTenantContext(link.tenantId, () =>
    app.db.select().from(callSessions).where(eq(callSessions.id, link.sessionId)),
  )
  if (!session) return { ok: false, reason: 'unknown' }
  if (session.status !== 'active') return { ok: false, reason: 'ended' }

  const [agent] = await app.withTenantContext(link.tenantId, () =>
    app.db.select().from(people).where(eq(people.id, session.personId)),
  )
  if (!agent || agent.kind !== 'agent' || agent.status !== 'active' || !agent.voiceConfig) {
    return { ok: false, reason: 'unavailable' }
  }

  return {
    ok: true,
    tenantId: link.tenantId,
    sessionId: session.id,
    room: session.room,
    purpose: session.purpose,
    expiresAt: link.expiresAt,
    joinedAt: link.joinedAt,
    agent: { id: agent.id, name: agent.name, title: agent.title },
  }
}

/** Close a meeting nobody will ever attend, and its link with it. */
async function abandonMeeting(tenantId: string, sessionId: string): Promise<void> {
  const app = db()
  const now = new Date()
  await app.withTenant(tenantId, async () => {
    await app.db
      .update(callSessions)
      .set({ status: 'failed', endedAt: now, durationSeconds: 0, updatedAt: now })
      .where(eq(callSessions.id, sessionId))
    await app.db
      .update(meetingLinks)
      .set({ expiresAt: now, updatedAt: now })
      .where(eq(meetingLinks.sessionId, sessionId))
  })
}

/** The invitation email — plain text, professional, link and validity up front. */
function meetingEmailBody(args: {
  agentName: string
  purpose: string
  message?: string
  meetingUrl: string
  expiresAt: Date
}): string {
  const validUntil = args.expiresAt.toUTCString()
  return [
    ...(args.message?.trim() ? [args.message.trim(), ''] : []),
    `I have set up a video meeting so we can go through this together: ${args.purpose}`,
    '',
    `Join here: ${args.meetingUrl}`,
    '',
    'The link opens straight in your browser — no account and nothing to install. You can turn on your camera and share your screen from the meeting page, which is the quickest way to show me what you are looking at.',
    `The link is good until ${validUntil}.`,
    '',
    args.agentName,
  ].join('\n')
}

/**
 * The meeting ability. Delivery is email, so it answers to the same dial as
 * any other outside message; what makes it worth its own tool is the room it
 * creates and the screen the agent gets to look at once someone is in it.
 */
export function meetingAbilities(args: { tenantId: string; person: PersonRow; runId: string }): Ability[] {
  const { tenantId, person, runId } = args
  return [
    defineAbility({
      name: 'send_meeting_link',
      description:
        'Set up a video meeting and email someone the link. Reach for this when talking is not enough because something has to be SHOWN — they need to walk you through a screen, a document, an error, a system they are stuck in, or you need to see it for yourself before you can help. The guest just clicks the link: it opens in their browser with camera, microphone, and screen share, no account and no download. You join the meeting yourself and hold the conversation there.',
      category: 'external_email',
      inputSchema: z.object({
        toEmail: z.string().describe('The email address of the person you are inviting.'),
        purpose: z
          .string()
          .describe('What the meeting is for, in a sentence — you open the meeting with this, and it is what they read in the invitation.'),
        subject: z.string().optional().describe('Subject line for the invitation email. Defaults to a plain one built from the purpose.'),
        message: z.string().optional().describe('A short note to open the email with, in your own words. The link and the practicalities are added for you.'),
      }),
      execute: async ({ toEmail, purpose, subject, message }) => {
        const trimmedPurpose = purpose.trim()
        if (!trimmedPurpose) {
          return {
            sent: false,
            reason: 'Say what the meeting is for — it is what you open the meeting with, and what the invitation explains.',
          }
        }
        if (!person.voiceConfig) {
          return {
            sent: false,
            reason:
              'You have no voice configured, so you cannot speak in a meeting. Tell whoever asked that this needs setting up on your profile first, and offer to handle it over email instead.',
          }
        }
        const meeting = await createMeeting({
          tenantId,
          person,
          runId,
          purpose: trimmedPurpose,
          invitee: { address: toEmail },
        })
        try {
          await sendNewMail({
            tenantId,
            personId: person.id,
            to: [{ address: toEmail }],
            subject: subject?.trim() || `Video meeting: ${trimmedPurpose}`,
            text: meetingEmailBody({
              agentName: person.name,
              purpose: trimmedPurpose,
              ...(message ? { message } : {}),
              meetingUrl: meeting.meetingUrl,
              expiresAt: meeting.expiresAt,
            }),
            runId,
          })
        } catch (error) {
          // Nobody was invited, so nobody can walk in: close the room rather
          // than leaving an open meeting on the record that will never happen.
          await abandonMeeting(tenantId, meeting.sessionId)
          return {
            sent: false,
            reason: `The invitation could not be sent, so there is no meeting: ${(error as Error).message}`,
          }
        }
        return {
          sent: true,
          to: toEmail,
          meetingUrl: meeting.meetingUrl,
          expiresAt: meeting.expiresAt.toISOString(),
          note: `The invitation is sent. The room is open now and stays open for ${MEETING_LINK_TTL_HOURS} hours — you join it when they do, so there is nothing further to do about it here.`,
        }
      },
    }),
  ]
}
