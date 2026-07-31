/**
 * Where somebody is right now — and why they are sometimes somewhere else.
 *
 * An agent has a home department, and most of the time that is where you find
 * them. But a company where everybody is always at their own desk is a
 * spreadsheet with pictures. People wander: they take a coffee, they go and
 * stand in someone else's doorway to ask a question, they end up in the server
 * room because that is where the problem is. That is what makes a floor plan
 * feel like a place rather than a seating chart.
 *
 * THE ONE HARD CONSTRAINT: this must be STABLE. The floor re-renders whenever
 * anything on the page changes, and a whereabouts that rolled dice per render
 * would teleport the whole company several times a second — the exact bug that
 * made characters jump when a flyout closed, but continuous and worse. So it is
 * a pure function of (who, when, where they might go), and "when" is quantised
 * into slots. Inside one slot the answer never changes; when a slot rolls over,
 * some of them have drifted. No state, no storage, no clock skew between the
 * server render and the browser.
 *
 * Deterministic also means honest: two people looking at the same screen at the
 * same moment see the same office.
 */

/** How long anybody stays put. Long enough to notice they moved, short enough to feel alive. */
export const WANDER_SLOT_MINUTES = 7

/**
 * Roughly how much of the company is away from its own desk at any moment.
 *
 * A tenth is about right: on a floor of ten you will usually see one person
 * somewhere they do not belong, which reads as a working office. Much more and
 * the departments stop meaning anything.
 */
export const WANDER_CHANCE = 0.12

/** A small, fast, stable hash. Same inputs, same number, everywhere. */
function hash(text: string): number {
  let value = 2166136261
  for (let index = 0; index < text.length; index++) {
    value ^= text.charCodeAt(index)
    value = Math.imul(value, 16777619)
  }
  // Unsigned, then folded into [0, 1).
  return ((value >>> 0) % 100000) / 100000
}

export type Whereabouts = {
  /** The department they are drawn in for this slot. */
  departmentId: string | null
  /** True when that is not their own — the UI can say "visiting". */
  visiting: boolean
}

/**
 * Where this person is during the slot containing `now`.
 *
 * `homeId` null means nobody has given them a desk, so they are simply
 * everywhere-and-nowhere: shown on whichever department is being viewed rather
 * than hidden from all of them, because a person with no desk who appears on no
 * floor looks like a bug.
 */
export function whereaboutsOf(args: {
  personId: string
  homeId: string | null
  /** Departments they could plausibly turn up in. */
  departmentIds: readonly string[]
  now: Date
  /** Off by default at the call site; a company can turn the wandering off. */
  wander: boolean
}): Whereabouts {
  const { personId, homeId, departmentIds, now, wander } = args
  if (!wander || !homeId || departmentIds.length < 2) {
    return { departmentId: homeId, visiting: false }
  }

  const slot = Math.floor(now.getTime() / (WANDER_SLOT_MINUTES * 60_000))
  // Two independent draws from one seed: whether they moved, and where to.
  // Separate salts so the two are not correlated — otherwise everybody who
  // wanders would head for the same room.
  const moved = hash(`${personId}:${slot}:away`)
  if (moved >= WANDER_CHANCE) return { departmentId: homeId, visiting: false }

  const elsewhere = departmentIds.filter((id) => id !== homeId)
  if (elsewhere.length === 0) return { departmentId: homeId, visiting: false }
  const pick = Math.floor(hash(`${personId}:${slot}:where`) * elsewhere.length)
  return { departmentId: elsewhere[Math.min(pick, elsewhere.length - 1)]!, visiting: true }
}

/**
 * Everyone to draw on one department's floor.
 *
 * People with no desk appear wherever you are looking — see above.
 */
export function peopleInDepartment<T extends { id: string; departmentId?: string | null }>(args: {
  people: readonly T[]
  departmentId: string
  departmentIds: readonly string[]
  now: Date
  wander: boolean
}): (T & { visiting: boolean })[] {
  return args.people
    .map((person) => {
      const where = whereaboutsOf({
        personId: person.id,
        homeId: person.departmentId ?? null,
        departmentIds: args.departmentIds,
        now: args.now,
        wander: args.wander,
      })
      const here = where.departmentId === null || where.departmentId === args.departmentId
      return here ? { ...person, visiting: where.visiting } : null
    })
    .filter((row): row is T & { visiting: boolean } => row !== null)
}
