# Systems: how a connection proves who it is

A system is outside software an agent works in. Most systems are reached over
MCP; a company can also adopt a private HTTP API definition proposed by one of
its employees. Which agents carry a system is [`roles.md`](roles.md); this is
about the governed connection behind it.

## Company-private API systems

An employee may propose an integration after reading a system's official API
documentation. The proposal appears in the existing Systems library; it does
not install code, create a public plugin, or make the integration available to
another tenant. An operator reviews the operations, authentication shape, and
autonomy category for each ability, then supplies the credential and activates
the proposal only after its read-only health check succeeds.

The executable definition is deliberately small: an HTTPS base URL, bearer or
named-header authentication, JSON input schemas, request paths and query/body
mappings, optional provider idempotency headers, and one harmless `GET` health
operation. Bunkhouse owns the transport. Requests use AppKit's SSRF-safe fetch,
remain below the reviewed base path, reject transport-managed headers, and are
bounded to 30 seconds, two redirects, and 2 MiB responses. Credentials are
sealed separately and are never part of an employee-authored revision.

Revisions are append-only. A new proposal advances `latest_version`, while
`active_version` keeps the previously approved definition running until the
operator tests and activates the update. Activation, disabling, and assignment
changes write audit events. Active definitions are checked hourly; disabling a
system preserves its revisions, credential record, health history, and audit
evidence.

Three methods, all ending in request headers on an MCP dial, all sealed at rest
with `@braedonsaunders/appkit-crypto`. They are not equivalent, and the difference is not
convenience — it is whether the connection survives a quiet week.

| Method | What is stored | What can lapse |
| ------ | -------------- | -------------- |
| Header token | The token the operator pasted | Whatever the provider decided when it issued the token |
| OAuth sign-in | A refresh token, replaced on every use | The refresh token, on the provider's schedule |
| Certificate (M2M) | A private key | Nothing until the certificate expires, on yours |

## Prefer the certificate wherever a provider offers one

The client-credentials grant (RFC 6749 §4.4) authenticating with a signed
assertion (RFC 7523 `private_key_jwt`) issues **no refresh token**. Access
tokens are minted from the key on demand, cached in memory, and never written
down. There is nothing to persist, so there is nothing to race and nothing to
lose.

That matters because the alternative fails in a way that is easy to miss.
Providers that rotate refresh tokens — NetSuite among them — invalidate the old
one the moment a new one is minted. The stored token is therefore destroyed by
its own use, and the write that replaces it is not optional: lose it once and
the connection is dead until a human signs in again. Two runs connecting in the
same second is enough, and an agent's duties routinely start together. A
refresh token also expires from disuse, so a deployment that sits quiet over a
holiday can come back to a system that no longer answers.

None of that applies to a key the company holds. The provider has only the
certificate, and it is replaced when the operator chooses.

An interactive sign-in is still the right shape when the connection genuinely
acts *as a person* — the provider scopes access to that user's own grants. When
it acts as the company, the certificate is both more durable and more honest
about what is happening.

### Where a provider offers one is narrower than it looks

Read the capability at the resource, not the authorization server. An
authorization server advertises `grant_types_supported` across everything it
protects; an individual scope may still refuse most of them. NetSuite is the
case in point: its metadata lists `client_credentials` and `private_key_jwt`,
and both are real — for REST web services. The AI Connector Service scope that
the MCP endpoint requires accepts only authorization code with PKCE, and
NetSuite rejects an integration record that asks for that scope and the
machine-to-machine grant together.

So metadata saying yes is necessary, not sufficient. The connect flow proves it
by minting a token before saving, which is the only check that distinguishes
"the server can do this" from "the server will do this for me, here". Where the
answer is no, the connection stays on a refresh token — and everything below is
what keeps that survivable.

## What is checked before a connection saves

Discovery, mint, and dial — in that order, because all three fail as the same
opaque `invalid_grant` at most providers:

1. the server's own metadata (RFC 8414) advertises `client_credentials`, and
   accepts the chosen signing algorithm;
2. a token actually mints, which is the only proof the certificate is mapped to
   an entity and role at the provider;
3. the MCP server answers over that token and reports its tools.

A connection that saves without all three reads as healthy right up until the
first duty needs it, at whatever hour that duty runs.

## Refreshing without losing the credential

Where a refresh token is unavoidable, the danger is not the network — it is
concurrency. A rotating refresh token cannot be minted from twice, so two runs
refreshing the same grant at the same moment do not merely race to write: the
second presents a token the first already destroyed, and whichever write lands
last can leave a dead credential behind. Serialising the *write* is not enough.
The **mint** has to be exclusive.

Two layers, because concurrency arrives from two directions:

- a promise map collapses the common case — several runs in one worker starting
  in the same second, which is exactly what a duty schedule produces;
- a Postgres advisory lock covers separate processes, and the re-read inside it
  means a process that queued for the lock uses the token the winner just stored
  instead of spending a second mint.

The lock is held across the token request. Releasing it earlier would reopen the
window it exists to close. The hold is bounded by the OAuth egress timeout and
happens about once an hour per connection.

## Watched, not discovered

A failing connection is silent by design: ability assembly drops a server it
cannot reach and the run continues with a smaller toolbox. That is right for the
run and useless as an alarm — nothing else looks at a system between the day it
is connected and the day someone notices the work never happened.

So the worker's `systems` pass does two things every ten minutes:

- **renews** any OAuth grant inside half an hour of expiry, so a token is
  replaced by the scheduler rather than by whichever duty needed it first, and a
  refresh token never lapses from disuse over a long weekend;
- **re-checks** each connection hourly by dialling it exactly the way an agent
  would, and records the answer.

Health lives in its own tenant setting, not on the connection. It is written
often and by whoever happened to check; a credential is written rarely and must
never be lost. Sharing a row would put a routine status update on the same
read-modify-write as a rotating token — the precise hazard above. The per-slug
write merges with `jsonb ||` in the database, so two checks finishing together
cannot drop each other's result.

## Choosing the signing algorithm

The provider's metadata names what it accepts, and the connect form is checked
against it. The trap is that a mis-padded assertion is a *valid signature of the
wrong kind*: JWS specifies RSA-PSS for `PS256` and the raw `r||s` pair for the
`ES*` family, while Node's defaults are PKCS#1 and DER. Both sign happily and
every verifier rejects them. `@braedonsaunders/appkit-oauth` handles the encoding; the operator
only picks the algorithm their key was generated for.

NetSuite requires `PS256` and does not accept `RS256` at all.

## Where it lives

| Concern | Where |
| ------- | ----- |
| Assertion signing, token minting | `@braedonsaunders/appkit-oauth` (`mintClientCredentialsToken`) |
| Sealed credential, single-flight refresh, verification | `lib/mcp-oauth.ts` |
| Header resolution for a run | `resolveIntegrationHeaders` (`lib/agent-abilities.ts`) |
| Probe and housekeeping | `lib/mcp-health.ts` |
| Stored connections and health | `lib/mcp-integrations.ts` |
| Connect, probe, save | `app/resources/system-actions.ts` |
| Renewal and health schedule | the `systems` pass in `scripts/worker.mts` |
| Authored definition validation and request mapping | `packages/runtime/src/http-system.ts` |
| Authored revisions, sealed access, activation | `lib/authored-systems.ts` |
| Authored system records and RLS | `db/schema/systems.ts`, `migrations/0065_employee_authored_systems.sql` |

The stored shape is `McpIntegrationEntry` in `db/schema/settings.ts`, under the
`integrations.mcp` tenant setting. A connection carries exactly one of
`sealedHeaders`, `oauth`, or `m2m`; `resolveIntegrationHeaders` prefers `m2m`,
so a system moved onto a certificate never falls back to a stale token set an
earlier sign-in left behind.
