-- Existing members previously had unrestricted tenant mutation access. Preserve
-- that access explicitly as a built-in Administrator role, then make future
-- access governable through AppKit IAM.
INSERT INTO roles (tenant_id, key, name, description, is_built_in, permissions)
SELECT id,
       'administrator',
       'Administrator',
       'Full company access, including roles and permissions.',
       true,
       '["people.read","people.manage","roles.read","roles.manage","work.read","work.manage","approvals.read","approvals.decide","mail.read","mail.manage","calls.manage","observatory.read","resources.read","resources.manage","settings.read","settings.manage","access.manage"]'::jsonb
FROM tenants
ON CONFLICT (tenant_id, key) DO UPDATE
SET permissions = EXCLUDED.permissions,
    name = EXCLUDED.name,
    description = EXCLUDED.description,
    is_built_in = true,
    updated_at = now();

INSERT INTO roles (tenant_id, key, name, description, is_built_in, permissions)
SELECT id,
       'viewer',
       'Viewer',
       'Read-only access to the company, work, and audit surfaces.',
       true,
       '["people.read","roles.read","work.read","approvals.read","mail.read","observatory.read","resources.read","settings.read"]'::jsonb
FROM tenants
ON CONFLICT (tenant_id, key) DO UPDATE
SET permissions = EXCLUDED.permissions,
    name = EXCLUDED.name,
    description = EXCLUDED.description,
    is_built_in = true,
    updated_at = now();

INSERT INTO role_assignments (tenant_id, tenant_user_id, role_id, scope)
SELECT tu.tenant_id, tu.id, r.id, '{"type":"tenant"}'::jsonb
FROM tenant_users tu
JOIN roles r ON r.tenant_id = tu.tenant_id AND r.key = 'administrator'
WHERE tu.status = 'active'
ON CONFLICT (tenant_id, tenant_user_id, role_id) DO NOTHING;
