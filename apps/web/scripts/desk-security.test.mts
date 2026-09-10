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

// --- a desk that cannot be spoken to is not left running --------------------
//
// `desks.set` happens only after the guest is configured, so a failure in
// between used to leave the VM RESIDENT on the host while the runner forgot it.
// Every later call resumed that same unreachable VM and failed identically, so a
// desk that broke once stayed broken. Measured in production: three hours of
// run_shell and workspace-file calls timing out behind one desk whose guest agent
// never answered its vsock handshake, with the host reporting a resident desk
// nothing could reach.
{
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const runner = readFileSync(fileURLToPath(new URL('./desk-runner.mts', import.meta.url)), 'utf8')
  const ensure = runner.slice(runner.indexOf('await ensureDeskNetwork(index)'), runner.indexOf('/** Park the VM but keep its tap'))
  assert.match(
    ensure,
    /await host\.suspend\(deskId\)\.catch\(\(\) => undefined\)[\s\S]*?throw error/,
    'a guest that cannot be configured is parked before the error propagates',
  )
  assert.ok(
    ensure.indexOf('await host.suspend(deskId)') < ensure.indexOf('desks.set(deskId, entry)'),
    'the teardown runs on the failure path, before the entry would have been cached',
  )
  // Never destroy: that is the only path that deletes the agent's overlay disk,
  // so recovering a wedged desk must not cost the agent its files.
  assert.equal(
    ensure.includes('host.destroy'),
    false,
    'recovery parks the desk and keeps its disk — it never reclaims the overlay',
  )
}

console.log('desk-security: per-desk identity and scoped, expiring handover capabilities — verified')
