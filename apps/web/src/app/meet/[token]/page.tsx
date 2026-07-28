import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import { EmptyState, PageHeader } from '@appkit/ui'
import { lookupMeetingByToken } from '../../../lib/meetings'
import { MeetingRoom } from '../../../components/meeting-room'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Video meeting · Bunkhouse',
}

/**
 * The guest room renders outside the app shell — whoever opens this link has
 * no workspace, no account, and nothing to navigate to — so the page carries
 * its own container.
 */
function GuestPage({ children }: { children: ReactNode }) {
  return <div className="mx-auto w-full max-w-5xl space-y-6 p-4 sm:p-6">{children}</div>
}

/** Full-page honest stop: what happened to the link, in plain words. */
function Blocked({ title, description }: { title: string; description: string }) {
  return (
    <GuestPage>
      <PageHeader title="Video meeting" description="Meetings open in your browser — no account needed." />
      <EmptyState title={title} description={description} />
    </GuestPage>
  )
}

const BLOCKED: Record<'unknown' | 'expired' | 'ended' | 'unavailable', { title: string; description: string }> = {
  unknown: {
    title: 'This meeting link is not valid',
    description:
      'The link may have been copied incompletely. Check the address in your invitation email, or reply to it and ask for a fresh link.',
  },
  expired: {
    title: 'This meeting link has expired',
    description: 'Meeting links stay open for a limited time. Reply to the invitation email and ask for a new one.',
  },
  ended: {
    title: 'This meeting has ended',
    description: 'The room is closed. Reply to the invitation email if you would like to arrange another time.',
  },
  unavailable: {
    title: 'This meeting is no longer available',
    description:
      'The person who invited you cannot take the meeting at the moment. Reply to the invitation email and they will sort it out.',
  },
}

export default async function MeetPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const meeting = await lookupMeetingByToken(token)
  if (!meeting.ok) return <Blocked {...BLOCKED[meeting.reason]} />

  const livekitUrl = process.env.LIVEKIT_URL
  if (!livekitUrl || !process.env.LIVEKIT_API_KEY || !process.env.LIVEKIT_API_SECRET) {
    throw new Error('LIVEKIT_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET must be set — deployment infrastructure, see .env.local.')
  }

  return (
    <GuestPage>
      <MeetingRoom
        serverUrl={livekitUrl}
        token={token}
        agent={meeting.agent}
        {...(meeting.purpose ? { purpose: meeting.purpose } : {})}
      />
    </GuestPage>
  )
}
