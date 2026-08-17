import assert from 'node:assert/strict'
import {
  deskIdentity,
  deskIdentityMatches,
  signDeskHandoverCapability,
  verifyDeskHandoverCapability,
} from '../src/lib/desk-security'

const secret = 'runner-secret'
const deskId = 'd-0123456789abcdef'
const identity = deskIdentity(secret, deskId)

assert.equal(deskIdentityMatches(secret, deskId, identity), true)
assert.equal(deskIdentityMatches(secret, `${deskId}-other`, identity), false, 'identity is bound to one desk')

const value = {
  deskId,
  scope: 'control' as const,
  expiresAt: 1_800_000_000_000,
  nonce: '0123456789abcdef01234567',
}
const capability = signDeskHandoverCapability(secret, value)
assert.equal(verifyDeskHandoverCapability(secret, value, capability, value.expiresAt - 1), true)
assert.equal(
  verifyDeskHandoverCapability(secret, { ...value, scope: 'view' }, capability, value.expiresAt - 1),
  false,
  'scope escalation invalidates the capability',
)
assert.equal(
  verifyDeskHandoverCapability(secret, { ...value, deskId: `${deskId}-other` }, capability, value.expiresAt - 1),
  false,
  'a capability cannot cross desks',
)
assert.equal(
  verifyDeskHandoverCapability(secret, value, capability, value.expiresAt),
  false,
  'the deadline is enforced at verification time',
)

console.log('desk-security: per-desk identity and scoped, expiring handover capabilities — verified')
