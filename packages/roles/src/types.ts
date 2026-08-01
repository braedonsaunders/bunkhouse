/**
 * A role pack is the job description an agent is hired from: title, default
 * personality seeds, standing duties, starter procedures, and the autonomy
 * posture a sensible employer would start the role at. Packs are data — the
 * community can publish them from git repos; these first-party ones are the
 * reference set.
 *
 * A pack ships procedure *text* because it is distributable data with no
 * company behind it. In a company that text is a seed: it is installed into the
 * governed procedure library as version 1, assigned to the role, and from then
 * on the company's record is the doctrine. A pack cannot ship skills, knowledge
 * or systems for the same reason — those are links to things a company already
 * has, made on the role's own screen.
 */
export type ActionCategory =
  | 'external_email'
  | 'internal_email'
  | 'record_write'
  | 'money_adjacent'
  | 'file_write'
  | 'computer_use'
  | 'shell'
  | 'phone_call'

export type AutonomyLevel = 'forbidden' | 'approval' | 'notify' | 'trusted'

export type RolePackDuty = {
  slug: string
  title: string
  instruction: string
  /** Cron expression (5-field) the duty defaults to; editable per hire. */
  cron: string
}

export type RolePackProcedure = {
  slug: string
  title: string
  body: string
}

export type RolePack = {
  slug: string
  title: string
  /** One-line pitch shown on the hiring screen's candidate card. */
  pitch: string
  description: string
  personality: {
    bio: string
    tone: string[]
  }
  duties: RolePackDuty[]
  /** Starter doctrine, installed into the company's procedure library on adoption. */
  procedures: RolePackProcedure[]
  /** Sensible day-one dial. Anything omitted defaults to 'approval'. */
  autonomyDefaults: Partial<Record<ActionCategory, AutonomyLevel>>
  /** Who may task this role by email; the worker enforces it. */
  inboundPolicy: 'staff_only' | 'known_contacts' | 'anyone'
  /** Suggested monthly salary (token budget) in USD. */
  suggestedSalaryUsd: number
}
