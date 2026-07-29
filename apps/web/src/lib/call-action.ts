import type { people } from '../db/schema'

/** The Call action for one person: where it goes, and why it may be closed. */
export type CallAction = {
  /** The agent's web-call room. */
  href: string
  /** Why the call cannot be placed right now — null when it can. */
  disabledReason: string | null
}

/** The columns the rule reads — so any query selecting these can resolve it. */
type Callee = Pick<typeof people.$inferSelect, 'id' | 'kind' | 'status' | 'voiceConfig'>

/**
 * One source of truth for "can this person be called, and where does it go" —
 * shared by the person drawer's header action and the roster row action, so
 * the two can never disagree about who is reachable.
 *
 * Humans are not called through the app; they get no action at all.
 */
export function resolveCallAction(person: Callee): CallAction | null {
  if (person.kind !== 'agent') return null
  return {
    href: `/call/${person.id}`,
    disabledReason:
      person.voiceConfig == null
        ? 'Give this agent a voice on the Voice tab to call them.'
        : person.status !== 'active'
          ? 'Only active agents take calls.'
          : null,
  }
}
