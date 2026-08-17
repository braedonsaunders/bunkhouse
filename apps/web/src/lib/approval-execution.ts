import type { runs } from '../db/schema'
import { workRefusal, type WorkCandidate } from './person-work'

/**
 * The rules for carrying out a decided approval, decided from facts alone —
 * no database, no model, no worker. `lib/approval-executor.ts` is the shell
 * that fetches the facts and performs what is chosen here and nothing else,
 * which is what makes these rules provable (`scripts/governance.test.mts`).
 */

/**
 * How many times one decided approval may be attempted before it is given up
 * on. Small on purpose: an approval that has failed five times is not going to
 * succeed on the sixth, and every attempt is a governed run that costs money.
 *
 * There was no cap at all. One rejected approval was re-leased every five
 * minutes for seventeen hours — 196 attempts, 51 of them spawning a run for an
 * agent that had been offboarded four hours earlier — and four more reached
 * 'succeeded' only after 144 to 147 attempts.
 */
export const APPROVAL_MAX_ATTEMPTS = 5

type RunStatus = (typeof runs.$inferSelect)['status']

export type ApprovalExecutionPlan =
  /** Stop for good: this decision can never be carried out. */
  | { do: 'give_up'; reason: string }
  /** Declined, and the run that asked has already been closed: note and finish. */
  | { do: 'deliver_refusal' }
  /** Carry the decision back to the agent — on the parked run, or a follow-up. */
  | { do: 'continue'; resume: boolean }

export function planApprovalExecution(facts: {
  /** Attempts INCLUDING the one about to be made. */
  attempts: number
  decision: 'approved' | 'rejected'
  /** The run the approval was raised by; null when it no longer exists. */
  run: { status: RunStatus } | null
  /** The agent the approval belongs to; null when it no longer exists. */
  person: WorkCandidate | null
}): ApprovalExecutionPlan {
  if (facts.attempts > APPROVAL_MAX_ATTEMPTS) {
    return {
      do: 'give_up',
      reason: `Gave up after ${APPROVAL_MAX_ATTEMPTS} attempts to carry this decision out. Nothing further will be tried.`,
    }
  }
  if (!facts.run) return { do: 'give_up', reason: 'The originating run no longer exists.' }
  if (!facts.person) return { do: 'give_up', reason: 'The agent this was decided for no longer exists.' }

  // The employment gate, asked here so the approval is settled with a reason
  // instead of throwing its way to the cap five runs later. Every refusal is
  // terminal at this point, including the temporary one: an approval decided
  // in a previous employment must not resurrect when an agent is onboarded
  // again — a rehire starts fresh, with a memory handover, not with the
  // unfinished business of the last one.
  const refusal = workRefusal(facts.person)
  if (refusal) return { do: 'give_up', reason: `Not carried out: ${refusal.reason}` }

  const resume = facts.run.status === 'waiting_approval'

  // The root cause of the runaway. Declining an approval in the app closes the
  // originating run in the same transaction ('Stopped: the requested action
  // was declined.'), so by the time the executor looks, the run is `completed`
  // and never resumable — which sent EVERY declined approval down the
  // follow-up branch and started a brand-new governed run, per decision,
  // purely to say "no". That run could not even tell the person waiting: its
  // trigger is `approval_followup`, so it is never given the thread's reply
  // ability. All it could do was cost money and fail, and every failure came
  // straight back here to be tried again five minutes later.
  //
  // A refusal is not new work. While the run is still parked on the decision
  // the agent genuinely needs to adjust, so it is resumed; once the run has
  // closed, the decision goes on its ledger and the approval is finished.
  if (facts.decision === 'rejected' && !resume) return { do: 'deliver_refusal' }

  return { do: 'continue', resume }
}

/**
 * Where a failed attempt leaves the row: retryable until the cap, terminal on
 * it. Separate from the plan because a failure is discovered mid-attempt, once
 * the plan has already been chosen.
 *
 * TERMINAL vs RETRYABLE is the distinction this whole slice exists to make
 * obvious. `executed_at` is the ONLY column that removes a decided approval
 * from `decidedApprovalIds`; `execution_status = 'failed'` does not, because
 * it is deliberately inside that retry set so a worker that died halfway is
 * picked up again. "Mark it failed" is therefore a request to RETRY, and
 * anything that must never run again has to stamp `executed_at` as well.
 */
export function settlementAfterFailure(attempts: number, message: string): { terminal: boolean; error: string } {
  if (attempts >= APPROVAL_MAX_ATTEMPTS) {
    return {
      terminal: true,
      error: `Gave up after ${APPROVAL_MAX_ATTEMPTS} attempts to carry this decision out. Last failure: ${message}`,
    }
  }
  return { terminal: false, error: message }
}
