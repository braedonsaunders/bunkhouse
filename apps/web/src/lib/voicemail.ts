import 'server-only'
import type { CallCounterparty } from '../db/schema'
import { sendNewMail } from './mailbox'
import { nextMonthPhrase } from './call-budget'

/**
 * Voicemail. A ringing phone always gets answered — an agent that is off
 * shift, out of call minutes, or not set up to hold a conversation still picks
 * up, says so plainly, and takes a message.
 *
 * The message then becomes work the ordinary way: the transcript is mailed to
 * the agent's own mailbox as a new thread, and the inbound-mail pass picks it
 * up on its next run exactly as it would a message from a customer. There is
 * no second queue and no special voicemail inbox — email is the surface, and a
 * voicemail is just a message that arrived down the phone.
 */

export type VoicemailReason =
  /** Outside the agent's working hours. */
  | 'off_hours'
  /** The agent is not an active employee (onboarding, or offboarded). */
  | 'inactive'
  /** No usable voice configuration — it cannot hold a conversation. */
  | 'misconfigured'
  /** This month's call-minutes ceiling has been reached. */
  | 'over_budget'

/** Who left the message, in the words used on the record and in the subject. */
export function callerLabel(counterparty: CallCounterparty): string {
  return counterparty.name ?? counterparty.number ?? 'an unknown number'
}

const firstName = (name: string): string => name.split(' ')[0] ?? name

/**
 * What the answering machine says when it picks up. One short spoken turn —
 * who this is, why they cannot talk, and an invitation to leave the message.
 * Honest in every branch: it never implies the agent is simply busy.
 */
export function voicemailGreeting(args: { agentName: string; reason: VoicemailReason; at?: Date }): string {
  const who = `Hello, you have reached ${args.agentName}'s line.`
  const why =
    args.reason === 'off_hours'
      ? 'I am outside my working hours right now, so I cannot take the call.'
      : args.reason === 'over_budget'
        ? `I have used all of my call time for this month, so I cannot take calls until ${nextMonthPhrase(args.at)}.`
        : args.reason === 'inactive'
          ? 'I am not taking calls at the moment.'
          : 'I am not able to hold a conversation on this line at the moment.'
  return `${who} ${why} Please leave your message after the tone — say who you are, how to reach you, and what you need — and it will be picked up as soon as I am back. Thank you.`
}

/**
 * The call posture for a voicemail held by the agent's own speech model — used
 * when the deterministic answering machine cannot be built. Take the message,
 * nothing else: no tools, no promises, no work started on the call.
 */
export function voicemailInstructions(args: {
  agentName: string
  reason: VoicemailReason
  caller: string
  language?: string | undefined
  at?: Date
}): string {
  const why =
    args.reason === 'off_hours'
      ? 'You are outside your working hours, so you cannot take this call.'
      : args.reason === 'over_budget'
        ? `You have used all of your call time for this month, so you cannot take calls until ${nextMonthPhrase(args.at)}.`
        : args.reason === 'inactive'
          ? 'You are not taking calls at the moment.'
          : 'You cannot hold a working conversation on this line at the moment.'
  return [
    `You are ${args.agentName}, and you are taking a voicemail from ${args.caller}. ${why}`,
    'Say who you are and that you cannot take the call, then ask them to leave a message: who they are, how to reach them, and what they need.',
    'Then listen. Acknowledge briefly — "got it", "go on" — and ask only for a name, a number, or a sentence you genuinely did not catch. Do not answer questions, look anything up, offer opinions, or promise a date.',
    'When they have finished, tell them the message will be picked up as soon as you are back, thank them, and say goodbye.',
    'Speak plainly and briefly, in whole spoken sentences. No markdown, no lists.',
    ...(args.language && args.language !== 'en' ? [`Speak in the language with BCP-47 tag "${args.language}".`] : []),
  ].join('\n')
}

/** One line of the message as it was spoken. */
export type VoicemailTurn = {
  speaker: 'agent' | 'human'
  text: string
  /** Offset from the start of the call, milliseconds. */
  atMs: number
}

const clock = (atMs: number): string => {
  const total = Math.max(0, Math.round(atMs / 1000))
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

const REASON_LINE: Record<VoicemailReason, string> = {
  off_hours: 'The call came in outside your working hours.',
  inactive: 'The call came in while you were not taking calls.',
  misconfigured: 'The call came in while your voice line could not hold a conversation.',
  over_budget: 'The call came in after this month’s call-minutes budget was used up.',
}

/**
 * The message, as a mail thread in the agent's own mailbox. Returns what
 * happened rather than throwing: a voicemail that cannot be delivered is a
 * problem for the run record, not a reason to fail the call.
 */
export async function deliverVoicemail(args: {
  tenantId: string
  person: { id: string; name: string; email: string }
  counterparty: CallCounterparty
  reason: VoicemailReason
  turns: VoicemailTurn[]
  durationSeconds: number
  runId?: string | null
  receivedAt?: Date
}): Promise<{ delivered: true; threadId: string; subject: string } | { delivered: false; reason: string }> {
  const caller = callerLabel(args.counterparty)
  const spoken = args.turns.filter((turn) => turn.speaker === 'human' && turn.text.trim().length > 0)
  const subject = `Voicemail from ${caller}`
  const received = args.receivedAt ?? new Date()

  const transcript = args.turns.length
    ? args.turns
        .map((turn) => `[${clock(turn.atMs)}] ${turn.speaker === 'agent' ? firstName(args.person.name) : caller}: ${turn.text.trim()}`)
        .join('\n')
    : 'The caller hung up without saying anything.'

  const body = [
    `${caller} called and left a message on your line at ${received.toISOString().slice(0, 16).replace('T', ' ')} UTC.`,
    REASON_LINE[args.reason],
    ...(args.counterparty.number ? [`Call back on ${args.counterparty.number}.`] : []),
    '',
    'What they said:',
    '',
    transcript,
    '',
    spoken.length === 0
      ? 'There is nothing to act on unless you want to try them back.'
      : 'Handle this the way you would handle the same request by email: work out what they need, do it, and reply to them — by phone if that is faster, and only if you have a number for them.',
  ].join('\n')

  try {
    const { threadId } = await sendNewMail({
      tenantId: args.tenantId,
      personId: args.person.id,
      to: [{ name: args.person.name, address: args.person.email }],
      subject,
      text: body,
      ...(args.runId ? { runId: args.runId } : {}),
    })
    return { delivered: true, threadId, subject }
  } catch (error) {
    return { delivered: false, reason: error instanceof Error ? error.message : String(error) }
  }
}
