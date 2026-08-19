export type RunAttemptEventKind = 'claimed' | 'renewed' | 'completed' | 'failed' | 'cancelled' | 'lease_lost'

export const RUN_ATTEMPT_TRANSITIONS: Record<RunAttemptEventKind, readonly RunAttemptEventKind[]> = {
  claimed: ['renewed', 'completed', 'failed', 'cancelled', 'lease_lost'],
  renewed: ['renewed', 'completed', 'failed', 'cancelled', 'lease_lost'],
  completed: [],
  failed: [],
  cancelled: [],
  lease_lost: [],
}

export function assertRunAttemptTransition(
  previous: RunAttemptEventKind | null,
  next: RunAttemptEventKind,
): void {
  if (previous === null) {
    if (next !== 'claimed') throw new Error(`Execution attempt must begin with a claim, not ${next}.`)
    return
  }
  if (!RUN_ATTEMPT_TRANSITIONS[previous].includes(next)) {
    if (RUN_ATTEMPT_TRANSITIONS[previous].length === 0) {
      throw new Error(`Execution attempt is already terminal (${previous}).`)
    }
    throw new Error(`Execution attempt cannot move from ${previous} to ${next}.`)
  }
}
