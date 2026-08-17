import { spawn, type ChildProcess } from 'node:child_process'
import { runProcess, startTestDatabase } from './test-database.mts'

const port = 4811
const baseUrl = `http://localhost:${port}`
const database = await startTestDatabase()
let web: ChildProcess | null = null

async function waitForWeb(): Promise<void> {
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/login`)
      if (response.ok) return
    } catch {
      // The server is still compiling.
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(`The test web server did not answer at ${baseUrl}.`)
}

const env = {
  ...database.env,
  APP_URL: baseUrl,
  BETTER_AUTH_SECRET: 'e2e-only-secret-value-at-least-thirty-two-characters',
  ADMIN_EMAIL: 'operator@bunkhouse.test',
  ADMIN_PASSWORD: 'correct-horse-battery-staple',
  BUNKHOUSE_E2E_BASE_URL: baseUrl,
  NODE_ENV: 'test',
}

try {
  await runProcess('pnpm', ['exec', 'tsx', 'scripts/seed.mts'], env)
  web = spawn('pnpm', ['exec', 'next', 'dev', '-p', String(port)], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stdio: 'inherit',
  })
  await waitForWeb()
  await runProcess('pnpm', ['exec', 'playwright', 'test'], env)
} finally {
  if (web && web.exitCode === null) {
    web.kill('SIGTERM')
    await new Promise((resolve) => web!.once('exit', resolve))
  }
  await database.stop()
}
