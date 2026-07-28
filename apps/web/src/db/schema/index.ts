export * from './people'
export * from './mail'
export * from './procedures'
export * from './memory'
export * from './work'
export * from './governance'
export * from './settings'
export * from './pricing'
export * from './avatars'
export * from './roles'
export * from './voice'
export * from './pbx'
export * from './files'
export * from './workspace'

import { PEOPLE_TENANT_TABLES } from './people'
import { MAIL_TENANT_TABLES } from './mail'
import { PROCEDURES_TENANT_TABLES } from './procedures'
import { MEMORY_TENANT_TABLES } from './memory'
import { WORK_TENANT_TABLES } from './work'
import { GOVERNANCE_TENANT_TABLES } from './governance'
import { SETTINGS_TENANT_TABLES } from './settings'
import { PRICING_TENANT_TABLES } from './pricing'
import { AVATARS_TENANT_TABLES } from './avatars'
import { ROLES_TENANT_TABLES } from './roles'
import { VOICE_TENANT_TABLES } from './voice'
import { PBX_TENANT_TABLES } from './pbx'
import { FILES_TENANT_TABLES } from './files'
import { WORKSPACE_TENANT_TABLES } from './workspace'

/** Every bunkhouse tenant-scoped table; feed to @appkit/db's RLS installer. */
export const BUNKHOUSE_TENANT_TABLES = [
  ...PEOPLE_TENANT_TABLES,
  ...MAIL_TENANT_TABLES,
  ...PROCEDURES_TENANT_TABLES,
  ...MEMORY_TENANT_TABLES,
  ...WORK_TENANT_TABLES,
  ...GOVERNANCE_TENANT_TABLES,
  ...SETTINGS_TENANT_TABLES,
  ...PRICING_TENANT_TABLES,
  ...AVATARS_TENANT_TABLES,
  ...ROLES_TENANT_TABLES,
  ...VOICE_TENANT_TABLES,
  ...PBX_TENANT_TABLES,
  ...FILES_TENANT_TABLES,
  ...WORKSPACE_TENANT_TABLES,
] as const
