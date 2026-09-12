-- A conversation's dashboard: the agent's own live surface beside the chat.
--
-- Each chat conversation gets one governed app (key `chat-<thread id>`) on the
-- shared installable-app platform (`@braedonsaunders/appkit-apps`): an
-- opaque-origin sandboxed frontend the agent authors, a QuickJS backend it can
-- extend, per-app storage, and a records bridge that exposes exactly this
-- conversation's data. The Dashboard tab renders it; the agent keeps it
-- current with its dashboard tools; the operator can read and edit the same
-- files.
--
-- These six tables are the platform's own DDL, kept identical to the
-- package's `drizzle/0000_apps.sql` so the package's Drizzle store stays the
-- single reader and writer — nothing here reimplements it. The five
-- tenant-scoped tables carry the standard tenant RLS below. `app_listings`
-- is deliberately excluded: it has no `tenant_id` (it keys on
-- `publisher_tenant_id`) and is the deployment-owned marketplace catalogue,
-- which this slice does not expose — there is no publish/install surface, so
-- nothing can put a row there or read one from it.
CREATE TABLE IF NOT EXISTS apps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, key text NOT NULL, name text NOT NULL,
  description text, icon_key text NOT NULL DEFAULT 'box', status text NOT NULL DEFAULT 'installed', active_version_id uuid,
  granted_permissions jsonb NOT NULL DEFAULT '[]'::jsonb, show_in_nav boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0, provisioned_objects jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), created_by uuid, updated_by uuid
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS apps_tenant_key_ux ON apps (tenant_id, key);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS apps_tenant_status_idx ON apps (tenant_id, status);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS app_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  version text NOT NULL, manifest jsonb NOT NULL, status text NOT NULL DEFAULT 'draft',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), created_by uuid, updated_by uuid
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS app_versions_app_version_ux ON app_versions (app_id, version);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS app_versions_tenant_app_idx ON app_versions (tenant_id, app_id);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS app_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  version_id uuid NOT NULL REFERENCES app_versions(id) ON DELETE CASCADE, path text NOT NULL, kind text NOT NULL,
  content_type text NOT NULL DEFAULT 'text/plain', content text NOT NULL DEFAULT '', is_binary boolean NOT NULL DEFAULT false,
  size integer NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), created_by uuid, updated_by uuid
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS app_files_version_path_ux ON app_files (version_id, path);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS app_files_version_kind_idx ON app_files (version_id, kind);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS app_storage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  namespace text NOT NULL DEFAULT 'default', key text NOT NULL, value jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), created_by uuid, updated_by uuid
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS app_storage_app_namespace_key_ux ON app_storage (app_id, namespace, key);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS app_storage_tenant_app_idx ON app_storage (tenant_id, app_id);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS app_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  version_id uuid REFERENCES app_versions(id) ON DELETE SET NULL, endpoint text NOT NULL, status text NOT NULL,
  units integer NOT NULL DEFAULT 0, logs jsonb NOT NULL DEFAULT '[]'::jsonb, error_message text,
  duration_ms integer NOT NULL DEFAULT 0, actor_id uuid, at timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS app_runs_tenant_app_at_idx ON app_runs (tenant_id, app_id, at);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS app_listings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), publisher_tenant_id uuid NOT NULL, key text NOT NULL, name text NOT NULL,
  description text, icon_key text NOT NULL DEFAULT 'box', version text NOT NULL, manifest jsonb NOT NULL,
  files jsonb NOT NULL DEFAULT '[]'::jsonb, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), created_by uuid, updated_by uuid
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS app_listings_key_ux ON app_listings (key);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS app_listings_active_name_idx ON app_listings (is_active, name);--> statement-breakpoint

-- Tenant isolation on the five tenant-scoped tables. The platform's store
-- filters by tenant on every query; these policies are the enforcement, not
-- the filter — a query that forgot its tenant finds nothing rather than
-- everything.
ALTER TABLE apps ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE apps FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON apps;--> statement-breakpoint
CREATE POLICY tenant_isolation ON apps
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint

ALTER TABLE app_versions ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE app_versions FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON app_versions;--> statement-breakpoint
CREATE POLICY tenant_isolation ON app_versions
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint

ALTER TABLE app_files ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE app_files FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON app_files;--> statement-breakpoint
CREATE POLICY tenant_isolation ON app_files
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint

ALTER TABLE app_storage ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE app_storage FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON app_storage;--> statement-breakpoint
CREATE POLICY tenant_isolation ON app_storage
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint

ALTER TABLE app_runs ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE app_runs FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON app_runs;--> statement-breakpoint
CREATE POLICY tenant_isolation ON app_runs
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint

COMMENT ON TABLE apps IS
  'Installable apps. A chat conversation owns one dashboard app (key chat-<thread id>); the Dashboard tab renders its frontend and the agent authors it.';
COMMENT ON TABLE app_listings IS
  'Deployment-owned marketplace catalogue. Unexposed in this slice: no publish or install surface reads or writes it.';
