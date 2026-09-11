import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { __tokenRenewalForTests } from '../src/lib/mcp-oauth'

/**
 * A refresh token only stays alive by being spent.
 *
 * The live NetSuite connection died of exactly that. Its grant was written
 * 2026-09-03 09:00 and never rewritten — because `isStale` returned false when
 * the provider had reported no `expires_in`, so the ten-minute housekeeping pass
 * declined to renew it around a thousand times in a row and the header path
 * never renewed it either. The access token happened to keep working, so ten
 * tool calls succeeded across the week and nothing looked wrong, while the
 * refresh token sat unspent until it hit NetSuite's seven-day limit. The first
 * refresh ever attempted failed with `invalid_grant` on 2026-09-10 10:00 — seven
 * days and one hour after issue.
 *
 * Unlike openbooks, which reaches NetSuite's REST/SuiteQL API with OAuth 1.0a
 * token-based auth and therefore holds credentials that never expire at all,
 * the MCP endpoint accepts only authorization-code + PKCE. A rotating refresh
 * token is not optional here, so keeping it rotating is load-bearing.
 */
const { isStale, MAX_TOKEN_AGE_MS, ASSUMED_ACCESS_LIFETIME_MS } = __tokenRenewalForTests

const now = Date.now()
const minutes = (n: number) => n * 60_000
const base = { accessToken: 'a', tokenType: 'Bearer', refreshToken: 'r' }

// --- the bug: an unknown lifetime is not an eternal one ----------------------
assert.equal(
  isStale({ ...base, mintedAt: now }),
  false,
  'a token just minted with no reported lifetime is not immediately spent',
)
assert.equal(
  isStale({ ...base, mintedAt: now - ASSUMED_ACCESS_LIFETIME_MS - 1 }),
  true,
  'but one with no reported lifetime IS renewed on a cadence rather than trusted for ever',
)
// The precise shape that killed it: no expiresAt, a week old, previously "fresh".
assert.equal(isStale({ ...base, mintedAt: now - 7 * 24 * 60 * 60_000 }), true, 'a week-old undated token is due')

// --- an undated set predating `mintedAt` heals itself -----------------------
// Every grant stored before this existed has neither field. Reading that as new
// would preserve the original bug on exactly the connections that have it.
assert.equal(isStale({ ...base }), true, 'a set with no timestamps at all is treated as ancient, not as new')

// --- a known expiry still decides, with its slack ---------------------------
assert.equal(isStale({ ...base, mintedAt: now, expiresAt: now + minutes(120) }), false, 'plenty of life left')
assert.equal(isStale({ ...base, mintedAt: now, expiresAt: now + 1_000 }), true, 'about to expire')
assert.equal(isStale({ ...base, mintedAt: now, expiresAt: now - 1 }), true, 'already expired')
// The housekeeping pass renews further ahead than a run does, so a token a run
// would still accept is one the scheduler replaces first.
assert.equal(
  isStale({ ...base, mintedAt: now, expiresAt: now + minutes(20) }, minutes(30)),
  true,
  'the early-renewal window is honoured',
)

// --- and the age floor applies however healthy the access token looks -------
// This is the clause that actually prevents the failure: a provider could report
// a long-lived access token and the refresh token would still lapse behind it.
assert.equal(
  isStale({ ...base, mintedAt: now - MAX_TOKEN_AGE_MS - 1, expiresAt: now + minutes(600) }),
  true,
  'a token set older than the age floor is renewed even with hours of access left',
)
assert.equal(
  isStale({ ...base, mintedAt: now - MAX_TOKEN_AGE_MS + minutes(5), expiresAt: now + minutes(600) }),
  false,
  'and is left alone until it reaches that age',
)

// The floor has to sit well inside the shortest provider refresh-token window
// we know of — NetSuite's seven days — or it is decoration.
assert.ok(MAX_TOKEN_AGE_MS < 7 * 24 * 60 * 60_000, 'the age floor is inside the seven-day refresh window')
assert.ok(MAX_TOKEN_AGE_MS <= 24 * 60 * 60_000, 'with at least six days of margin')

// --- the renewal pass has to be able to act on all of this ------------------
{
  const worker = readFileSync(new URL('./worker.mts', import.meta.url), 'utf8')
  const every = Number(
    /upsertJobScheduler\('systems', \{ every: ([\d_]+) \}/.exec(worker)?.[1]?.replaceAll('_', ''),
  )
  assert.ok(Number.isFinite(every), 'the systems pass states its cadence')
  assert.ok(
    every < ASSUMED_ACCESS_LIFETIME_MS,
    `a pass every ${every}ms cannot keep ahead of a ${ASSUMED_ACCESS_LIFETIME_MS}ms assumed lifetime`,
  )
  assert.ok(every < MAX_TOKEN_AGE_MS, 'nor the age floor')

  // And the mint must stay exclusive: NetSuite invalidates the old refresh token
  // the instant a new one is issued, so two concurrent refreshes leave a dead
  // credential behind. withTenant opens a real transaction, which is what makes
  // the xact lock hold across the token request rather than for one statement.
  const oauth = readFileSync(new URL('../src/lib/mcp-oauth.ts', import.meta.url), 'utf8')
  const refresh = oauth.slice(oauth.indexOf('async function refreshSharedTokens'))
  assert.match(refresh, /pg_advisory_xact_lock/, 'the mint is serialized across processes')
  assert.match(refresh, /withTenant\(/, 'inside a transaction, or the lock is released immediately')
  assert.ok(
    refresh.indexOf('pg_advisory_xact_lock') < refresh.indexOf('refreshTokens('),
    'the lock is taken before the token request, not after it',
  )
  assert.match(refresh, /saveMcpIntegrations\(/, 'and the rotated token is persisted')
}

console.log('mcp tokens: an unspent refresh token is an expiring one — renewal is driven by age, not only expiry')
