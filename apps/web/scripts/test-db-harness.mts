import { runProcess, startTestDatabase } from './test-database.mts'

const database = await startTestDatabase()

try {
  await runProcess('pnpm', ['exec', 'tsx', 'scripts/db-claims.test.mts'], {
    BUNKHOUSE_TEST_DB_URL: database.adminUrl,
    BUNKHOUSE_TEST_APP_URL: database.appUrl,
    BUNKHOUSE_TEST_SUPER_URL: database.superUrl,
  })
} finally {
  await database.stop()
}
