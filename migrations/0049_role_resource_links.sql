-- Roles link company resources; they no longer keep copies of them.
--
-- Procedures, skills, company knowledge and connected systems all answer one
-- question — which agents does this reach — so they now answer it in one
-- field, and a role is one end of that link rather than a second place the
-- same doctrine is typed out.

-- 1. The binding field could only ever name a first-party pack, so it was
--    called rolePacks. It now names any role, tenant-authored ones included.
UPDATE procedures
   SET assignment = (assignment - 'rolePacks') || jsonb_build_object('roles', assignment -> 'rolePacks')
 WHERE assignment ? 'rolePacks';

UPDATE skills
   SET assignment = (assignment - 'rolePacks') || jsonb_build_object('roles', assignment -> 'rolePacks')
 WHERE assignment ? 'rolePacks';

-- 2. Procedures installed with a role recorded their origin as 'role-pack'. A
--    tenant-authored role ships starter procedures the same way a pack does,
--    so the origin names the role rather than the packaging.
UPDATE procedures
   SET source = jsonb_build_object(
         'type', 'role',
         'role', source ->> 'pack',
         'procedure', source ->> 'procedure')
 WHERE source ->> 'type' = 'role-pack';

-- 3. Company knowledge gains the same binding. Every note written before now
--    reached every agent, and still does — that is what everyone means.
ALTER TABLE memories ADD COLUMN IF NOT EXISTS assignment jsonb NOT NULL DEFAULT '{}'::jsonb;
UPDATE memories SET assignment = '{"everyone": true}'::jsonb
 WHERE scope = 'company' AND assignment = '{}'::jsonb;

-- 4. Connected systems likewise: every saved connection sat in every agent's
--    toolbox, and stays there until an operator narrows it.
UPDATE tenant_settings
   SET value = (
         SELECT jsonb_agg(
                  CASE WHEN entry ? 'assignment' THEN entry
                       ELSE entry || '{"assignment": {"everyone": true}}'::jsonb END)
           FROM jsonb_array_elements(value) AS entry)
 WHERE key = 'integrations.mcp'
   AND jsonb_typeof(value) = 'array'
   AND jsonb_array_length(value) > 0;

-- 5. Procedures written inside a role definition become real ones: versioned,
--    assigned to the role that held them, and visible in Company resources
--    like every other procedure. Slugs match what hiring from a role pack has
--    always produced, so a role customized from a pack lands on the procedure
--    that pack already installed instead of a duplicate of it.
INSERT INTO procedures (tenant_id, slug, title, status, current_version, assignment, source)
SELECT rd.tenant_id,
       rd.slug || '-' || (p ->> 'slug'),
       p ->> 'title',
       'active',
       1,
       jsonb_build_object('roles', jsonb_build_array(rd.slug)),
       jsonb_build_object('type', 'role', 'role', rd.slug, 'procedure', p ->> 'slug')
  FROM role_defs rd
  CROSS JOIN LATERAL jsonb_array_elements(rd.procedures) AS p
 WHERE coalesce(p ->> 'slug', '') <> '' AND coalesce(p ->> 'title', '') <> ''
ON CONFLICT (tenant_id, slug) DO NOTHING;

INSERT INTO procedure_revisions (tenant_id, procedure_id, version, body, change_note)
SELECT rd.tenant_id,
       pr.id,
       1,
       p ->> 'body',
       'Moved out of the ' || rd.title || ' role definition.'
  FROM role_defs rd
  CROSS JOIN LATERAL jsonb_array_elements(rd.procedures) AS p
  JOIN procedures pr
    ON pr.tenant_id = rd.tenant_id AND pr.slug = rd.slug || '-' || (p ->> 'slug')
 WHERE coalesce(p ->> 'slug', '') <> '' AND coalesce(p ->> 'body', '') <> ''
ON CONFLICT (procedure_id, version) DO NOTHING;

-- A procedure that was already installed keeps its own text and history; all
-- it needs is the link to the role that also declared it.
UPDATE procedures
   SET assignment = assignment || jsonb_build_object(
         'roles', coalesce(assignment -> 'roles', '[]'::jsonb) || to_jsonb(source ->> 'role'))
 WHERE source ->> 'type' = 'role'
   AND coalesce(assignment -> 'everyone', 'false'::jsonb) <> 'true'::jsonb
   AND NOT (coalesce(assignment -> 'roles', '[]'::jsonb) @> to_jsonb(source ->> 'role'));

ALTER TABLE role_defs DROP COLUMN IF EXISTS procedures;
