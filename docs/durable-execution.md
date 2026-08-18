# Durable execution

A run row is the mutable authority; its history is append-only evidence.

Every model/tool execution claims a lease by atomically incrementing `runs.lease_fence` and
inserting an immutable `run_attempts` row. Heartbeats extend only the matching owner, fence,
and attempt. Losing any of those aborts the model, the in-flight tool, and its external-effect
signal. Terminal run updates include that same fence in their `WHERE` clause, so a delayed
worker cannot overwrite the result of the attempt that replaced it. `run_attempt_events`
records claims, renewals, completion, cancellation, failures, and lost leases without
updating history. A takeover closes the expired attempt with `lease_lost` in the same
transaction that installs its successor, so a worker crash cannot leave history permanently
looking active; an expired owner cannot revive its lease.

An operator stop locks the run, revokes its owner/fence binding immediately, and appends the
attempt's `cancelled` fact in the same transaction. The cancellation watcher feeds the same
signal into the model, tool deadline, adapter, and effect boundary; a worker that observes the
revocation returns the already-recorded cancelled outcome instead of trying to commit again.

Actions that cross into another system pass through the external-effect boundary after
autonomy and approval, but before the adapter. `external_effect_intents` records a
tenant/run/attempt, effect kind, redacted request, and stable invocation identity. The
runtime preserves the AI SDK tool-call id by default, so two intentional calls with the same
request remain two actions. An adapter may instead supply a destination-owned domain key.
When a crashed fenced attempt is replaced, the new attempt correlates each tool's Nth
invocation with the Nth immutable intent rather than hashing the request; a changed request
at that position fails closed instead of replaying or duplicating a different action.
Recovery also recognizes request-hash intents written before this contract, so a rolling
deployment cannot abandon an already-delivered effect and execute it again.
The database verifies that its provenance names either a same-tenant run attempt or the
same-run approval execution that performed it. Outcomes are new `external_effect_events`
rows. A recorded completion is replayed; a
definitive failure may be retried; an intent with unknown fate is blocked until explicitly
reconciled. Operator evidence is refused while the originating run or approval still holds an
execution lease, preventing a manual decision from racing a late adapter outcome. Secrets and
visual frame bytes are removed before either side is written.

`run_events` remains the durable activity stream. Writers append under the existing per-run
lock and issue a transaction-aware PostgreSQL notification. Followers backfill strictly
after their cursor, use `LISTEN/NOTIFY` only to wake early, and poll as a repair path. A lost
notification, disconnect, or process restart therefore changes latency, never which events
are observed.
