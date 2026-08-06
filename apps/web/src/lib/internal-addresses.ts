import 'server-only'
import { eq } from 'drizzle-orm'
import { people } from '../db/schema'
import { db } from '../db/client'
import { getCompanyIdentity } from './company-identity'
import { matchesInternalDomain } from './internal-domains'

/**
 * Who counts as "us".
 *
 * Two governance decisions hang off this question and both used to answer it
 * with an exact lookup in the staff directory: the autonomy dial (writing to a
 * colleague is internal_email, writing to anyone else is external_email) and
 * the inbound gate (a `staff_only` agent only works for staff). An exact
 * lookup is right about the people it knows and wrong about everyone else at
 * the same company — a colleague who has never been added to the directory
 * reads as a stranger, so an agent needs sign-off to answer their own
 * finance manager and refuses mail from their own company's addresses.
 *
 * So the test is the directory OR one of the company's own email domains,
 * which `internal-domains.ts` matches on a dot boundary.
 */

/** Everything an address needs to pass to count as internal. Sync on purpose:
 *  the dial is resolved before a tool runs, so it cannot await a query. */
export type InternalAddressTest = (address: string) => boolean

/**
 * Load the test once, for the whole of a run's assembly. Both inputs are small
 * and already being read nearby; the point of loading them together is that
 * every caller gets the same answer to "is this one of ours".
 */
export async function loadInternalAddressTest(tenantId: string): Promise<InternalAddressTest> {
  const app = db()
  const [staff, identity] = await Promise.all([
    app.db.select({ email: people.email }).from(people).where(eq(people.status, 'active')),
    getCompanyIdentity(tenantId),
  ])
  const addresses = new Set(staff.map((row) => row.email.trim().toLowerCase()).filter(Boolean))
  const domains = identity.internalDomains
  return (address: string) => {
    const lower = (address ?? '').trim().toLowerCase()
    if (!lower) return false
    return addresses.has(lower) || matchesInternalDomain(lower, domains)
  }
}
