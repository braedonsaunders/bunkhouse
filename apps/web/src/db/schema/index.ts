export * from './people'
export * from './mail'
export * from './procedures'
export * from './memory'
export * from './work'
export * from './governance'
export * from './settings'

import { PEOPLE_TENANT_TABLES } from './people'
import { MAIL_TENANT_TABLES } from './mail'
import { PROCEDURES_TENANT_TABLES } from './procedures'
import { MEMORY_TENANT_TABLES } from './memory'
import { WORK_TENANT_TABLES } from './work'
import { GOVERNANCE_TENANT_TABLES } from './governance'
import { SETTINGS_TENANT_TABLES } from './settings'

/** Every bunkhouse tenant-scoped table; feed to @appkit/db's RLS installer. */
export const BUNKHOUSE_TENANT_TABLES = [
  ...PEOPLE_TENANT_TABLES,
  ...MAIL_TENANT_TABLES,
  ...PROCEDURES_TENANT_TABLES,
  ...MEMORY_TENANT_TABLES,
  ...WORK_TENANT_TABLES,
  ...GOVERNANCE_TENANT_TABLES,
  ...SETTINGS_TENANT_TABLES,
] as const
