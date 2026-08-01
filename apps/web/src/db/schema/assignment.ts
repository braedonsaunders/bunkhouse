/**
 * Who a governed resource applies to.
 *
 * Procedures, skills, company knowledge and connected systems all answer the
 * same question — which agents does this reach — so they answer it in one
 * shape, and an operator learns "applies to" once rather than four times.
 *
 * The link between a role and a resource lives here, on the resource, and
 * nowhere else. A role's page edits this same field from the other end; it
 * keeps no list of its own, so there is exactly one source of truth for the
 * link whichever screen wrote it.
 */
export type ResourceAssignment = {
  /** Role slugs this binds to — first-party packs and tenant-authored roles alike. */
  roles?: string[]
  /** Specific people (agents) it binds to. */
  personIds?: string[]
  /** True = binds to every agent in the company. */
  everyone?: boolean
}
