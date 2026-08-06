/**
 * Who counts as "us" — the domain half, which is the part that can be got
 * dangerously wrong. A too-narrow match makes an agent ask permission to
 * answer its own CFO (the defect this was written for); a too-wide one lets a
 * lookalike domain in as staff, which is worse.
 */
import assert from 'node:assert/strict'
import { matchesInternalDomain, normalizeDomain } from '../src/lib/internal-domains'

// --- normalizing what an operator types -------------------------------------
assert.equal(normalizeDomain('rassaun.com'), 'rassaun.com')
assert.equal(normalizeDomain('@rassaun.com'), 'rassaun.com', 'a leading @ is how people write a domain')
assert.equal(normalizeDomain('  Rassaun.COM '), 'rassaun.com', 'case and whitespace are not a difference')
assert.equal(normalizeDomain('bsaunders@rassaun.com'), 'rassaun.com', 'a whole address gives up its domain')
assert.equal(normalizeDomain('https://rassaun.com/careers'), 'rassaun.com', 'a pasted URL is still a domain')
assert.equal(normalizeDomain('mail.rassaun.com'), 'mail.rassaun.com', 'a subdomain is a domain of its own')
assert.equal(normalizeDomain(''), null)
assert.equal(normalizeDomain('   '), null)
assert.equal(normalizeDomain('rassaun'), null, 'no dot, no domain — the operator sees the typo')
assert.equal(normalizeDomain('not a domain'), null)
assert.equal(normalizeDomain('-rassaun.com'), null, 'a label may not start with a hyphen')
console.log('internal domains: what an operator types normalizes to something comparable')

// --- matching an address against them ---------------------------------------
{
  const domains = ['rassaun.com', 'bunkhouse.local']
  assert.equal(matchesInternalDomain('bsaunders@rassaun.com', domains), true)
  assert.equal(matchesInternalDomain('BSaunders@Rassaun.com', domains), true, 'addresses arrive in any case')
  assert.equal(matchesInternalDomain('dana@bunkhouse.local', domains), true, 'every configured domain counts')
  assert.equal(
    matchesInternalDomain('noreply@mail.rassaun.com', domains),
    true,
    'a subdomain of ours is still ours',
  )

  // The whole point of the dot boundary: these must never read as internal.
  assert.equal(
    matchesInternalDomain('attacker@notrassaun.com', domains),
    false,
    'a domain that merely ends with ours is a stranger',
  )
  assert.equal(
    matchesInternalDomain('attacker@rassaun.com.evil.tld', domains),
    false,
    'our domain as a prefix of theirs is a stranger',
  )
  assert.equal(matchesInternalDomain('someone@gmail.com', domains), false)
  assert.equal(matchesInternalDomain('', domains), false)
  assert.equal(matchesInternalDomain('bsaunders@rassaun.com', []), false, 'no domains configured, no domain match')
  console.log('internal domains: subdomains count, lookalikes do not')
}
