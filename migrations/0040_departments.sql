-- Departments: the floor stops being a wallpaper and becomes a place.
--
-- The scene switcher was a personal cosmetic preference — six hardcoded rooms
-- kept in localStorage, with every agent drawn on every one of them. That is a
-- screensaver. A company has PLACES, people belong to them, and knowing who is
-- where is the whole reason to look at a floor plan.
--
-- So a department is company data: a name, a backdrop, and an order. The
-- backdrop is either one of the built-in scene kinds (which keep working
-- exactly as they did, and seed the defaults below) or an SVG somebody had
-- generated for it.
--
-- ON THAT SVG: it is written by a model and rendered into the page, which makes
-- it untrusted markup in a trusted origin — a script tag, an onload attribute
-- or a foreignObject is a cross-site scripting hole, not a picture. It is
-- sanitised against an allowlist before it is ever stored, and the column holds
-- only what survived that. See lib/scene-svg.ts.

CREATE TABLE IF NOT EXISTS "departments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "name" text NOT NULL,
  "slug" text NOT NULL,
  /* One of the built-in scene kinds. Null when this department is drawn from
     its own artwork instead. */
  "scene_kind" text,
  /* Sanitised SVG, when somebody has had one made for this department. */
  "backdrop_svg" text,
  /* What was asked for, kept so it can be tweaked and regenerated rather than
     described again from scratch. */
  "backdrop_prompt" text,
  "position" integer DEFAULT 0 NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "departments_slug_key" ON "departments" ("tenant_id", "slug");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "departments_order_idx" ON "departments" ("tenant_id", "position");
--> statement-breakpoint
ALTER TABLE "departments" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON departments;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON departments
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
-- Where an agent normally works. Null means "no fixed desk" — they show up
-- wherever, which is the right default for anyone nobody has placed yet.
ALTER TABLE "people" ADD COLUMN IF NOT EXISTS "department_id" uuid;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "people_department_idx" ON "people" ("tenant_id", "department_id");
--> statement-breakpoint
-- The six built-in rooms become the starting departments for every company
-- that already has people, so the floor looks the same the moment this lands
-- and gains meaning as somebody assigns desks. Names are ordinary business
-- words rather than the art's own filenames.
INSERT INTO "departments" ("tenant_id", "name", "slug", "scene_kind", "position")
SELECT t.id, d.name, d.slug, d.kind, d.pos
FROM (SELECT DISTINCT tenant_id AS id FROM people) t
CROSS JOIN (VALUES
  ('The floor',    'floor',       'office',     0),
  ('Executive',    'executive',   'executive',  1),
  ('Warehouse',    'warehouse',   'warehouse',  2),
  ('Server room',  'server-room', 'serverroom', 3),
  ('Break room',   'break-room',  'breakroom',  4),
  ('Rooftop',      'rooftop',     'rooftop',    5)
) AS d(name, slug, kind, pos)
ON CONFLICT ("tenant_id", "slug") DO NOTHING;
