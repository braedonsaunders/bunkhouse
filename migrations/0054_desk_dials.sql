-- The desk cutover for the autonomy dial: 'shell' becomes 'sandbox' and
-- 'computer_use' becomes 'desktop'. Wherever two settings collide on one new
-- key, the MORE RESTRICTIVE level wins (forbidden > approval > notify >
-- trusted) — no agent silently gains reach on upgrade. The retired values stay
-- in the pg type: postgres cannot drop enum values in place, and historical
-- approvals rows still carry them as audit history, so retirement is enforced
-- in application code — the runtime's ActionCategory union and the app's
-- category lists no longer admit them, which is what stops new rows.

-- shell → sandbox. A 'sandbox' row cannot predate 0053 (the value is new), but
-- a replay or a partial write must not resurrect looser access: where a target
-- row already exists, keep the more restrictive of the two, then drop the old.
update autonomy_settings as kept
set level = old.level, updated_at = now()
from autonomy_settings as old
where kept.tenant_id = old.tenant_id
  and kept.person_id = old.person_id
  and kept.category = 'sandbox'
  and old.category = 'shell'
  and (case old.level when 'forbidden' then 0 when 'approval' then 1 when 'notify' then 2 else 3 end)
    < (case kept.level when 'forbidden' then 0 when 'approval' then 1 when 'notify' then 2 else 3 end);--> statement-breakpoint
delete from autonomy_settings as old
using autonomy_settings as kept
where old.tenant_id = kept.tenant_id
  and old.person_id = kept.person_id
  and old.category = 'shell'
  and kept.category = 'sandbox';--> statement-breakpoint
update autonomy_settings
set category = 'sandbox', updated_at = now()
where category = 'shell';--> statement-breakpoint

-- computer_use → desktop, same shape.
update autonomy_settings as kept
set level = old.level, updated_at = now()
from autonomy_settings as old
where kept.tenant_id = old.tenant_id
  and kept.person_id = old.person_id
  and kept.category = 'desktop'
  and old.category = 'computer_use'
  and (case old.level when 'forbidden' then 0 when 'approval' then 1 when 'notify' then 2 else 3 end)
    < (case kept.level when 'forbidden' then 0 when 'approval' then 1 when 'notify' then 2 else 3 end);--> statement-breakpoint
delete from autonomy_settings as old
using autonomy_settings as kept
where old.tenant_id = kept.tenant_id
  and old.person_id = kept.person_id
  and old.category = 'computer_use'
  and kept.category = 'desktop';--> statement-breakpoint
update autonomy_settings
set category = 'desktop', updated_at = now()
where category = 'computer_use';--> statement-breakpoint

-- Tenant-authored role definitions persist the same keys as jsonb defaults.
-- The role builder validates against the category list, so 'sandbox'/'desktop'
-- cannot predate this migration — but if a key were somehow already there, the
-- more restrictive of the two survives, same rule as above.
update role_defs
set autonomy_defaults = (autonomy_defaults - 'shell' - 'computer_use')
  || case when autonomy_defaults ? 'shell' then jsonb_build_object('sandbox',
       case when autonomy_defaults ? 'sandbox'
         and (case autonomy_defaults->>'sandbox' when 'forbidden' then 0 when 'approval' then 1 when 'notify' then 2 else 3 end)
           < (case autonomy_defaults->>'shell' when 'forbidden' then 0 when 'approval' then 1 when 'notify' then 2 else 3 end)
       then autonomy_defaults->'sandbox' else autonomy_defaults->'shell' end)
     else '{}'::jsonb end
  || case when autonomy_defaults ? 'computer_use' then jsonb_build_object('desktop',
       case when autonomy_defaults ? 'desktop'
         and (case autonomy_defaults->>'desktop' when 'forbidden' then 0 when 'approval' then 1 when 'notify' then 2 else 3 end)
           < (case autonomy_defaults->>'computer_use' when 'forbidden' then 0 when 'approval' then 1 when 'notify' then 2 else 3 end)
       then autonomy_defaults->'desktop' else autonomy_defaults->'computer_use' end)
     else '{}'::jsonb end,
  updated_at = now()
where autonomy_defaults ?| array['shell', 'computer_use'];--> statement-breakpoint

-- Connected systems (tenant_settings 'integrations.mcp') each carry the one
-- category the dial governs them under, as a plain string in jsonb. Left as
-- 'shell'/'computer_use' they would fall back to the 'approval' default after
-- the remap above — fail-safe, but a silent tightening. Rename in place; each
-- system has exactly one category, so no collision is possible here.
update tenant_settings
set value = (
    select jsonb_agg(
      case entry->>'category'
        when 'shell' then jsonb_set(entry, '{category}', '"sandbox"')
        when 'computer_use' then jsonb_set(entry, '{category}', '"desktop"')
        else entry
      end
    )
    from jsonb_array_elements(value) as entry
  ),
  updated_at = now()
where key = 'integrations.mcp'
  and jsonb_typeof(value) = 'array'
  and exists (
    select 1 from jsonb_array_elements(value) as entry
    where entry->>'category' in ('shell', 'computer_use')
  );
