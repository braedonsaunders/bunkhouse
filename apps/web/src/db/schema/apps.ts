/**
 * The installable-app platform's tables, owned by
 * `@braedonsaunders/appkit-apps` and created by migration 0079.
 *
 * Nothing is redeclared here: the package's Drizzle table objects are the
 * single definition, and its `createDrizzleAppStore` is the single reader and
 * writer. This module exists for one reason — the tenant-table registry at
 * the bottom of `schema/index.ts`, which is the single source of truth the
 * RLS renderer and audits read from. Re-exporting the package's own list
 * keeps that registry unable to drift from the DDL it claims to cover.
 */
export { APP_TENANT_TABLES as APPS_TENANT_TABLES } from '@braedonsaunders/appkit-apps/schema'
