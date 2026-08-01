import assert from 'node:assert/strict'
import {
  agentBinding,
  bindsToAgent,
  bindsToRole,
  describeAssignment,
  parseAssignment,
  withRole,
  withoutRole,
} from '../src/lib/assignment'

/**
 * "Applies to" is resolved in exactly one place for procedures, skills,
 * company knowledge and connected systems, and written from two screens — the
 * resource's own, and the role's. What this file guards is that the two ends
 * agree, and that linking from a role can never quietly widen or narrow what
 * the whole company sees.
 */

const clerk = agentBinding({ id: 'p-clerk', roleSlug: 'ar-collections-clerk' })
const admin = agentBinding({ id: 'p-admin', roleSlug: 'office-administrator' })
const unroled = agentBinding({ id: 'p-temp', roleSlug: null })

// --- who a resource reaches -------------------------------------------------
assert.equal(bindsToAgent({ everyone: true }, unroled), true, 'everyone reaches an agent with no role')
assert.equal(bindsToAgent({ roles: ['ar-collections-clerk'] }, clerk), true, 'the role the agent holds')
assert.equal(bindsToAgent({ roles: ['ar-collections-clerk'] }, admin), false, 'not a role it does not hold')
assert.equal(bindsToAgent({ personIds: ['p-admin'] }, admin), true, 'named agents')
assert.equal(bindsToAgent({}, clerk), false, 'an unassigned resource reaches nobody')
assert.equal(
  bindsToAgent({ roles: ['ar-collections-clerk'] }, unroled),
  false,
  'a roleless agent never matches a role link — and never matches a null slug either',
)

// --- linking from the role's side -------------------------------------------
assert.deepEqual(
  withRole({ personIds: ['p-admin'] }, 'ar-collections-clerk'),
  { personIds: ['p-admin'], roles: ['ar-collections-clerk'] },
  'linking adds the role and leaves named agents alone',
)
const already = { roles: ['ar-collections-clerk'] }
assert.equal(withRole(already, 'ar-collections-clerk'), already, 'linking twice is not a write')

// The asymmetry that keeps a role screen from changing the whole company.
const everyone = { everyone: true as const }
assert.equal(withRole(everyone, 'ar-collections-clerk'), everyone, 'an everyone resource is left alone')
assert.equal(withoutRole(everyone, 'ar-collections-clerk'), everyone, 'and cannot be unlinked from a role')
assert.equal(bindsToRole(everyone, 'ar-collections-clerk'), false, 'it reaches the role without being linked to it')

assert.deepEqual(
  withoutRole({ roles: ['ar-collections-clerk', 'office-administrator'] }, 'ar-collections-clerk'),
  { roles: ['office-administrator'] },
  'unlinking one role keeps the others',
)
assert.deepEqual(
  withoutRole({ roles: ['ar-collections-clerk'], personIds: ['p-admin'] }, 'ar-collections-clerk'),
  { personIds: ['p-admin'] },
  'the roles key goes with the last role — an empty list would read as a decision',
)
const untouched = { roles: ['office-administrator'] }
assert.equal(withoutRole(untouched, 'ar-collections-clerk'), untouched, 'unlinking what was never linked is not a write')

// --- the form round trip ----------------------------------------------------
const form = new FormData()
form.set('everyone', '')
form.set('roles', 'ar-collections-clerk, office-administrator')
form.set('personIds', '')
assert.deepEqual(
  parseAssignment(form),
  { roles: ['ar-collections-clerk', 'office-administrator'] },
  'blank lists are dropped rather than stored as empty arrays',
)

const everyoneForm = new FormData()
everyoneForm.set('everyone', 'on')
everyoneForm.set('roles', 'ar-collections-clerk')
assert.deepEqual(parseAssignment(everyoneForm), { everyone: true }, 'everyone wins outright — no stale role list under it')

// --- what the operator reads ------------------------------------------------
const names = {
  roles: new Map([['ar-collections-clerk', 'AR / Collections Clerk']]),
  agents: new Map([['p-admin', 'Mo']]),
}
assert.equal(describeAssignment({ everyone: true }, names), 'Everyone')
assert.equal(
  describeAssignment({ roles: ['ar-collections-clerk'], personIds: ['p-admin'] }, names),
  'AR / Collections Clerk, Mo',
)
assert.equal(describeAssignment({ roles: ['gone'] }, names), 'gone', 'a role since deleted still reads as something')
assert.equal(describeAssignment({}, names), 'Nobody yet')

console.log('assignment: one edge, two ends, and everyone stays everyone')
