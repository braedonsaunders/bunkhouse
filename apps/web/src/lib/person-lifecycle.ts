export type PersonStatus = 'onboarding' | 'active' | 'offboarded'

/** The complete personnel lifecycle. Nobody is deleted; returning starts onboarding again. */
export const PERSON_STATUS_TRANSITIONS: Record<PersonStatus, readonly PersonStatus[]> = {
  onboarding: ['active', 'offboarded'],
  active: ['offboarded'],
  offboarded: ['onboarding'],
}

export function isPersonStatus(value: string): value is PersonStatus {
  return value === 'onboarding' || value === 'active' || value === 'offboarded'
}

export function assertPersonStatusTransition(from: PersonStatus, to: PersonStatus): void {
  if (!PERSON_STATUS_TRANSITIONS[from].includes(to)) {
    throw new Error(`Status cannot move directly from ${from} to ${to}.`)
  }
}
