-- Three things 0040 got wrong, all of which only showed up against a real
-- database.
--
-- ONE: the audit columns. Every tenant table in this schema carries
-- created_by/updated_by through `auditColumns`, and the drizzle model for
-- departments declares them — so `select *` named columns the table did not
-- have and the page died with a server error. The model was right and the
-- migration was short.
--
-- TWO: the seed inserted nothing, silently. It read
-- `SELECT DISTINCT tenant_id FROM people`, and `people` has FORCE ROW LEVEL
-- SECURITY — which applies to the table owner too. A migration runs with no
-- `app.tenant_id` set, so that select saw zero rows, the cross join produced
-- zero rows, and the insert succeeded having done nothing at all. `tenants` is
-- not row-secured, which is what a migration should be reading from anyway:
-- the list of companies is not tenant-scoped data.
--
-- THREE: RLS was enabled but not FORCED. `people` forces it, `departments` did
-- not, and the difference matters — the app connects as the role that owns
-- these tables, and an owner is exempt from its own policies unless the table
-- forces them. Enabling without forcing is a policy that looks like isolation
-- and is not.

ALTER TABLE "departments" ADD COLUMN IF NOT EXISTS "created_by" uuid;
--> statement-breakpoint
ALTER TABLE "departments" ADD COLUMN IF NOT EXISTS "updated_by" uuid;
--> statement-breakpoint
-- Seeded from `tenants`, which a migration can actually read. Every company
-- gets the six built-in rooms so the floor keeps looking like itself, and
-- ON CONFLICT means running this again after somebody has renamed or removed
-- one does not resurrect it.
INSERT INTO "departments" ("tenant_id", "name", "slug", "scene_kind", "position")
SELECT t.id, d.name, d.slug, d.kind, d.pos
FROM tenants t
CROSS JOIN (VALUES
  ('The floor',    'floor',       'office',     0),
  ('Executive',    'executive',   'executive',  1),
  ('Warehouse',    'warehouse',   'warehouse',  2),
  ('Server room',  'server-room', 'serverroom', 3),
  ('Break room',   'break-room',  'breakroom',  4),
  ('Rooftop',      'rooftop',     'rooftop',    5)
) AS d(name, slug, kind, pos)
ON CONFLICT ("tenant_id", "slug") DO NOTHING;
--> statement-breakpoint
-- Forced LAST, and that ordering is the whole of it. Forcing applies the
-- policy to the table's owner as well, and a migration runs with no
-- `app.tenant_id` — so the seed above has to happen while the owner is still
-- exempt. Forced first, the insert fails with "new row violates row-level
-- security policy", which is exactly what it did.
ALTER TABLE "departments" FORCE ROW LEVEL SECURITY;
