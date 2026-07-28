import type { people } from '../db/schema'

type PersonRecord = Pick<typeof people.$inferSelect, 'id' | 'name' | 'reportsToId'>

/**
 * The formal reporting hierarchy is a single-manager tree over `people`, and
 * the tree is the app's only structural claim about the org: prompts route
 * escalation up it, the chart draws it, and approvals read it. A cycle would
 * make "escalate to your manager" loop forever, so the invariant is enforced
 * here — on every write path — rather than by the UI hiding the option.
 */
/** The manager chain above `personId`, nearest first. Stops at the top. */
export function managerChain(roster: PersonRecord[], personId: string): PersonRecord[] {
  const byId = new Map(roster.map((person) => [person.id, person]))
  const chain: PersonRecord[] = []
  const seen = new Set<string>([personId])
  let current = byId.get(personId)?.reportsToId ?? null
  while (current && !seen.has(current)) {
    const manager = byId.get(current)
    if (!manager) break
    chain.push(manager)
    seen.add(manager.id)
    current = manager.reportsToId
  }
  return chain
}

/**
 * Validate a proposed reporting line, throwing the message an operator should
 * read. Callers pass the tenant's full roster so the whole chain is checked in
 * one pass — the guard has to hold for drag-and-drop, the record form, and
 * hiring alike.
 */
export function assertValidManager(
  roster: PersonRecord[],
  personId: string,
  managerId: string | null,
): void {
  if (managerId === null) return
  if (managerId === personId) throw new Error('A person cannot report to themselves.')
  const manager = roster.find((person) => person.id === managerId)
  if (!manager) throw new Error('That manager is not in this organization.')
  const person = roster.find((entry) => entry.id === personId)
  if (!person) throw new Error('Person not found.')

  // Walk up from the proposed manager: reaching this person means the move
  // would close a loop (A reports to B reports to A).
  if (managerChain(roster, managerId).some((link) => link.id === personId)) {
    throw new Error(`${manager.name} already reports to ${person.name}, directly or indirectly.`)
  }
}
