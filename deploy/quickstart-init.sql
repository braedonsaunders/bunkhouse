-- First-boot roles for the quickstart compose, created once by the postgres
-- image's init hook. The posture matters even on a laptop: the application
-- connects as a NON-superuser owner, so FORCE ROW LEVEL SECURITY binds it —
-- pointing the app at a superuser would silently switch RLS off, and the
-- quickstart would be demonstrating a different product than the one shipped.
--
-- bunkhouse_app   owns the schema (migrations are DDL) but holds no bypass.
-- bunkhouse_super is BYPASSRLS for the few cross-tenant system paths, and is
--                 what migrate.mts refreshes grants for after every migration.
CREATE ROLE bunkhouse_super LOGIN PASSWORD 'bunkhouse' BYPASSRLS;
CREATE ROLE bunkhouse_app LOGIN PASSWORD 'bunkhouse';
ALTER DATABASE bunkhouse OWNER TO bunkhouse_app;
ALTER SCHEMA public OWNER TO bunkhouse_app;
