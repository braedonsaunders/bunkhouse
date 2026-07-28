import { writeFileSync } from 'node:fs'
import { installRlsSql, IDENTITY_TENANT_TABLES } from '@appkit/db'
import { PLATFORM_TENANT_TABLES } from '@appkit/db'
import { API_TENANT_TABLES } from '@appkit/db'
import { BUNKHOUSE_TENANT_TABLES } from '../src/db/schema/index.ts'

const tables = [...IDENTITY_TENANT_TABLES, ...PLATFORM_TENANT_TABLES, ...API_TENANT_TABLES, ...BUNKHOUSE_TENANT_TABLES]
writeFileSync(new URL('../../../migrations/0003_rls.sql', import.meta.url), installRlsSql(tables) + '\n')
console.log('rls policies rendered for', tables.length, 'tables')
