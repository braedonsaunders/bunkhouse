-- One inbound message, one run.
--
-- Starting a run for new mail was guarded only by a "does a run already quote
-- this message id" check performed before the run row exists. Two schedulers
-- overlapping — two worker replicas, or a deploy leaving the old one draining
-- — both read "no", and both start. Measured on the customer-service mailbox:
-- one refund request produced two runs and two near-identical approval
-- requests, which is a customer emailed twice and a manager asked to sign off
-- on the same reply twice. The product's own standard calls mail sync
-- idempotent; a check-then-act is not idempotent, a constraint is.
--
-- The uniqueness is per tenant and only over email triggers: duty, assignment,
-- chat and approval-followup runs carry no messageId and are unaffected. A
-- resumed run reuses its row, so a thread that goes to approval and comes back
-- still occupies exactly one.

-- Older rows predate the guarantee; keep the first run of each pair, which is
-- the one whose events and approvals operators have already seen, and mark the
-- rest rather than deleting evidence.
--
-- Migrations connect as the table owner, and these tables carry FORCE ROW
-- LEVEL SECURITY, which applies to the owner too. With no app.tenant_id set
-- the owner sees no rows at all, so a backfill written the obvious way updates
-- nothing and still reports success. The exemption is lifted for exactly this
-- statement, inside this transaction, and put back immediately.
alter table runs no force row level security;

with ranked as (
  select
    id,
    row_number() over (
      partition by tenant_id, trigger ->> 'messageId'
      order by created_at, id
    ) as seq
  from runs
  where trigger ->> 'type' = 'email'
    and trigger ->> 'messageId' is not null
)
update runs r
set status = 'cancelled',
    finished_at = coalesce(r.finished_at, now()),
    summary = 'Superseded: a second run had been started for the same inbound message.',
    updated_at = now()
from ranked
where ranked.id = r.id
  and ranked.seq > 1;

alter table runs force row level security;

-- Cancelled rows are outside the constraint so the superseded runs above stay
-- readable as history; what must never happen twice is a run that is live or
-- that counts as having handled the message.
create unique index if not exists runs_inbound_message_key
  on runs (tenant_id, (trigger ->> 'messageId'))
  where trigger ->> 'type' = 'email'
    and trigger ->> 'messageId' is not null
    and status <> 'cancelled';
