import type { people } from '../db/schema'

/**
 * The employment gate: whether a person may start work at all.
 *
 * AGENTS.md requires "explicit lifecycle states and transition rules (person
 * status, run status, approval status, mailbox status) enforced at the
 * domain/service and API boundaries, not only by hiding UI". Offboarding was
 * exactly that UI-only enforcement. Standing an agent down disabled its
 * mailbox, switched its duties off and took it off the roster — but every
 * other door into the run engine was still open, because none of them ever
 * looked at `status`. A retired agent executed 51 runs in the four hours after
 * it was offboarded, every one of them a decided approval being retried.
 *
 * So the rule is written here once, and `executeAgentRun` — the single door
 * every run goes through, whether it came from mail, chat, Slack, a duty, an
 * assignment, an approval or a phone call — consults it before it opens a run
 * row. Queues that own a record of their own (approvals, assignments, inbound
 * mail) ask the same function so they can settle that record with a reason;
 * they never restate the rule.
 */

/** The three states a personnel record may hold (`person_status`). */
export type PersonWorkStatus = (typeof people.$inferSelect)['status']

/**
 * Why a person may not work, and whether waiting could ever change the answer.
 *
 * `permanent` is what tells a queue whether to hold its work or give up on it:
 * a decided approval for an offboarded agent will never become runnable, so
 * retrying it is the loop this gate exists to stop.
 */
export type WorkRefusal = { reason: string; permanent: boolean }

/** Just enough of a personnel record to answer the question. */
export type WorkCandidate = { kind: (typeof people.$inferSelect)['kind']; status: PersonWorkStatus; name: string }

/**
 * Whether this person may start work — `null` when they may.
 *
 * - `active` is the only status that works. It is the same answer the phone
 *   already gave: an inbound call to a non-active agent goes to voicemail
 *   rather than to the model (`scripts/voice-agent.mts`), and the rest of the
 *   product now agrees with the phone instead of contradicting it.
 * - `onboarding` is refused, but not permanently. Hiring is unfinished — a
 *   model may not be assigned, procedures may not be bound, the mailbox may
 *   not be provisioned — so work that arrives now waits for a human to finish
 *   onboarding rather than running half-configured. It is a state the operator
 *   moves out of deliberately.
 * - `offboarded` is refused permanently. The only transition out is a
 *   deliberate re-onboarding by a person (`STATUS_TRANSITIONS` in
 *   `app/organization/actions.ts`), so nothing queued may ever start itself
 *   again — and work decided in a previous employment must not resurrect on
 *   rehire.
 * - A human colleague is refused permanently for the same reason a human has
 *   no salary or model: they are on the org chart so agents can route work to
 *   them, not so the runtime can run them.
 */
export function workRefusal(person: WorkCandidate): WorkRefusal | null {
  if (person.kind !== 'agent') {
    return { reason: `${person.name} is a colleague, not an AI employee — no work can be run as them.`, permanent: true }
  }
  if (person.status === 'offboarded') {
    return { reason: `${person.name} has been offboarded and cannot start work.`, permanent: true }
  }
  if (person.status === 'onboarding') {
    return { reason: `${person.name} is still being onboarded and cannot start work yet.`, permanent: false }
  }
  return null
}

/**
 * Thrown by `executeAgentRun` when the gate refuses. A distinct type because
 * callers must be able to tell "this employee may not work" from "the work
 * failed": the first is a governed refusal that must never be retried on its
 * own, the second is an error that may legitimately be tried again.
 */
export class PersonNotWorkingError extends Error {
  readonly personId: string
  readonly refusal: WorkRefusal
  /** The run row recording the refusal, when one was opened for it. */
  readonly runId: string | null

  constructor(personId: string, refusal: WorkRefusal, runId: string | null = null) {
    super(refusal.reason)
    this.name = 'PersonNotWorkingError'
    this.personId = personId
    this.refusal = refusal
    this.runId = runId
  }
}

export function isPersonNotWorking(error: unknown): error is PersonNotWorkingError {
  return error instanceof PersonNotWorkingError
}
