import type { ResourceAssignment } from '../db/schema'

/**
 * "Applies to", resolved in one place.
 *
 * Every governed resource — a procedure, a skill, a company note, a connected
 * system — binds to agents through the same assignment, so it binds through the
 * same function. Three copies of this rule drifting apart is how an operator
 * ends up with a procedure that shows as assigned on screen and never reaches
 * the agent's prompt.
 */

/** The agent a resource is being resolved against. */
export type AgentBinding = {
  personId: string
  /** The role the agent holds, when it was onboarded from one. */
  roleSlug: string | null
}

/**
 * How one agent is matched against every assignment in the company: its own
 * name, and the role it holds. Built once per caller so procedures, skills,
 * knowledge and systems all resolve against the same agent.
 */
export function agentBinding(person: { id: string; rolePackSlug: string | null }): AgentBinding {
  return { personId: person.id, roleSlug: person.rolePackSlug }
}

export function bindsToAgent(assignment: ResourceAssignment, agent: AgentBinding): boolean {
  if (assignment.everyone) return true
  if (assignment.personIds?.includes(agent.personId)) return true
  return Boolean(agent.roleSlug && assignment.roles?.includes(agent.roleSlug))
}

/** Whether a resource is linked to one role — the role side of the same edge. */
export function bindsToRole(assignment: ResourceAssignment, roleSlug: string): boolean {
  return assignment.roles?.includes(roleSlug) ?? false
}

/**
 * Add or remove one role, leaving the rest of the assignment alone. Linking
 * from a role never silently widens a resource: a resource already assigned to
 * everyone stays that way, and unlinking it there is a decision to make on the
 * resource itself, where the consequence is visible.
 */
export function withRole(assignment: ResourceAssignment, roleSlug: string): ResourceAssignment {
  if (assignment.everyone || bindsToRole(assignment, roleSlug)) return assignment
  return { ...assignment, roles: [...(assignment.roles ?? []), roleSlug] }
}

export function withoutRole(assignment: ResourceAssignment, roleSlug: string): ResourceAssignment {
  if (!bindsToRole(assignment, roleSlug)) return assignment
  const roles = (assignment.roles ?? []).filter((slug) => slug !== roleSlug)
  const { roles: _dropped, ...rest } = assignment
  return roles.length > 0 ? { ...rest, roles } : rest
}

/** "Applies to", in the operator's words, for a list column or a drawer header. */
export function describeAssignment(
  assignment: ResourceAssignment,
  names: { roles: Map<string, string>; agents: Map<string, string> },
): string {
  if (assignment.everyone) return 'Everyone'
  const parts = [
    ...(assignment.roles ?? []).map((slug) => names.roles.get(slug) ?? slug),
    ...(assignment.personIds ?? []).map((id) => names.agents.get(id) ?? 'an agent'),
  ]
  return parts.join(', ') || 'Nobody yet'
}

/** Read an assignment off a drawer form — the one parser every resource uses. */
export function parseAssignment(formData: FormData): ResourceAssignment {
  if (String(formData.get('everyone') ?? '') === 'on') return { everyone: true }
  const list = (key: string) =>
    String(formData.get(key) ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)
  const roles = list('roles')
  const personIds = list('personIds')
  return { ...(roles.length ? { roles } : {}), ...(personIds.length ? { personIds } : {}) }
}
