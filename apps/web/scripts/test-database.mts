import { spawn } from 'node:child_process'
import pg from 'pg'
import { PostgreSqlContainer } from '@testcontainers/postgresql'

export type TestDatabase = {
  adminUrl: string
  appUrl: string
  superUrl: string
  env: NodeJS.ProcessEnv
  stop(): Promise<void>
}

export function runProcess(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  options: { cwd?: string; quiet?: boolean } = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? process.cwd(),
      env: { ...process.env, ...env },
      stdio: options.quiet ? 'ignore' : 'inherit',
    })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(`${command} exited ${code ?? signal ?? 'without a status'}`))
    })
  })
}

/** Start and migrate a disposable PostgreSQL with production-shaped roles. */
export async function startTestDatabase(): Promise<TestDatabase> {
  const database = 'bunkhouse_test'
  const password = 'bunkhouse-test-only'
  const container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase(database)
    .withUsername('postgres')
    .withPassword(password)
    .start()
  try {
    const host = container.getHost()
    const port = container.getMappedPort(5432)
    const adminUrl = `postgresql://postgres:${password}@${host}:${port}/${database}`
    const appUrl = `postgresql://bunkhouse_app:${password}@${host}:${port}/${database}`
    const superUrl = `postgresql://bunkhouse_super:${password}@${host}:${port}/${database}`

    const admin = new pg.Client({ connectionString: adminUrl })
    await admin.connect()
    try {
      await admin.query(`create role bunkhouse_super login password '${password}' bypassrls`)
      await admin.query(`create role bunkhouse_app login password '${password}'`)
      await admin.query('alter database bunkhouse_test owner to bunkhouse_app')
      await admin.query('alter schema public owner to bunkhouse_app')
    } finally {
      await admin.end()
    }

    const env = { BUNKHOUSE_DB_URL: appUrl, BUNKHOUSE_SUPER_URL: superUrl }
    await runProcess('pnpm', ['exec', 'tsx', 'scripts/migrate.mts'], env)
    return { adminUrl, appUrl, superUrl, env, stop: () => container.stop().then(() => undefined) }
  } catch (error) {
    await container.stop()
    throw error
  }
}
