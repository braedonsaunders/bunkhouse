-- One avatar per person, built from a tenant parts library.
--
-- The portrait/full-body split is retired. A person now has a single
-- composition — a full-body figure assembled from library parts — and every
-- portrait in the app is that composition cropped to its head viewport. There
-- is no second image to generate, store, or keep in sync.
--
-- Rendering happens in the browser from the parts, so no flattened PNG cache
-- is kept: a flattened image cannot animate per layer (a mouth on a live call)
-- and would have to be re-rendered at every size the app shows. The parts
-- themselves are the cache.
--
-- Existing avatars are preserved, not discarded. Each stored image becomes a
-- `body` part in the library — a full-body take is exactly that, and a portrait
-- crops to a face once the head viewport is placed over it — and its person
-- gets a composition wearing it. Nothing generated so far is lost, and every
-- imported figure is editable in the composer like any other.

CREATE TABLE "avatar_parts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"category_id" text NOT NULL,
	"name" text NOT NULL,
	"content_type" text NOT NULL,
	"data" text NOT NULL,
	"color_variant" text,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"model" text NOT NULL,
	"prompt" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE INDEX "avatar_parts_category_ix" ON "avatar_parts" USING btree ("tenant_id","category_id");
--> statement-breakpoint
ALTER TABLE avatar_parts ENABLE ROW LEVEL SECURITY;
ALTER TABLE avatar_parts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON avatar_parts;
CREATE POLICY tenant_isolation ON avatar_parts
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint

CREATE TABLE "avatar_compositions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"composition" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE UNIQUE INDEX "avatar_compositions_person_ux" ON "avatar_compositions" USING btree ("tenant_id","person_id");
--> statement-breakpoint
ALTER TABLE avatar_compositions ENABLE ROW LEVEL SECURITY;
ALTER TABLE avatar_compositions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON avatar_compositions;
CREATE POLICY tenant_isolation ON avatar_compositions
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint

-- Carry every existing avatar into the library as a body part. A person with
-- both takes keeps the full-body one, which composes better; the portrait is
-- still imported as its own part so nothing generated is thrown away.
INSERT INTO avatar_parts (id, tenant_id, category_id, name, content_type, data, tags, model, created_at, updated_at)
SELECT
  gen_random_uuid(),
  ai.tenant_id,
  'body',
  p.name || CASE WHEN ai.kind = 'full_body' THEN ' (imported)' ELSE ' (imported portrait)' END,
  ai.content_type,
  ai.data,
  ARRAY['imported']::text[],
  ai.model,
  ai.created_at,
  now()
FROM avatar_images ai
JOIN people p ON p.id = ai.person_id AND p.tenant_id = ai.tenant_id;
--> statement-breakpoint

-- Dress each person in their preferred imported part.
--
-- The imported artwork is a square 1:1 image of a whole figure, not a part cut
-- to the `body` category's 300x640 frame, so it is placed at the scale that
-- makes it as large as the stage allows: 300 x 1.70667 = 512 units wide,
-- centred vertically, where the artwork contain-fits to a 512x512 square
-- occupying y 128..640. The head viewport starts over where a generated
-- figure's head falls in that square; the composer's head-framing mode is
-- where an operator nudges it onto the actual face.
INSERT INTO avatar_compositions (tenant_id, person_id, composition)
SELECT
  chosen.tenant_id,
  chosen.person_id,
  jsonb_build_object(
    'version', 1,
    'headViewport', jsonb_build_object('x', 171, 'y', 148, 'width', 170, 'height', 170),
    'parts', jsonb_build_object(
      'body', jsonb_build_object(
        'partId', chosen.part_id::text,
        'transform', jsonb_build_object('x', 0, 'y', -162, 'scale', 1.70666667, 'rotation', 0)
      )
    )
  )
FROM (
  SELECT DISTINCT ON (ai.tenant_id, ai.person_id)
    ai.tenant_id,
    ai.person_id,
    part.id AS part_id
  FROM avatar_images ai
  JOIN people p ON p.id = ai.person_id AND p.tenant_id = ai.tenant_id
  JOIN avatar_parts part
    ON part.tenant_id = ai.tenant_id
   AND part.data = ai.data
   AND part.category_id = 'body'
  ORDER BY ai.tenant_id, ai.person_id, (ai.kind = 'full_body') DESC, ai.created_at DESC
) AS chosen
ON CONFLICT (tenant_id, person_id) DO NOTHING;
--> statement-breakpoint

DROP TABLE "avatar_images";
--> statement-breakpoint
DROP TYPE "public"."avatar_kind";
