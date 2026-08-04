/**
 * README screenshot rig. Mints a short-lived session directly in the database
 * (no credentials pass through anything), signs the cookie the way better-auth
 * itself does, and walks a headless Chrome through the screens worth showing.
 *
 *   tsx --env-file=.env.local scripts/shoot-screens.mts <user-email> [outDir]
 *
 * Dev tooling, not product: it points at APP_URL and the session it mints
 * expires in an hour.
 */
import { mkdirSync } from 'node:fs'
import { createHmac, randomBytes } from 'node:crypto'
import pg from 'pg'
import puppeteer from 'puppeteer-core'

const email = process.argv[2]
const outDir = process.argv[3] ?? '../../.github/assets/screenshots'
if (!email) throw new Error('usage: shoot-screens.mts <user-email> [outDir]')
const secret = process.env.BETTER_AUTH_SECRET
const superUrl = process.env.BUNKHOUSE_SUPER_URL
const appUrl = process.env.APP_URL ?? 'http://localhost:4810'
if (!secret || !superUrl) throw new Error('BETTER_AUTH_SECRET and BUNKHOUSE_SUPER_URL must be set')

const SHOTS: { name: string; path: string; settleMs?: number }[] = [
  { name: 'office', path: '/', settleMs: 3500 },
  { name: 'org-chart', path: '/organization/chart' },
  { name: 'people', path: '/organization/people' },
  { name: 'mail', path: '/mail' },
  { name: 'observatory', path: '/observatory' },
  { name: 'approvals', path: '/approvals' },
  { name: 'roles', path: '/roles' },
  { name: 'autonomy', path: '/admin/settings?section=autonomy' },
  ...(process.env.SHOT_RUN_ID ? [{ name: 'run', path: `/runs/${process.env.SHOT_RUN_ID}`, settleMs: 2500 }] : []),
]

const db = new pg.Client({ connectionString: superUrl })
await db.connect()
const { rows: users } = await db.query('select id from users where email = $1', [email])
if (!users[0]) throw new Error(`no user with email ${email}`)
const { rows: tenants } = await db.query(
  `select t.id from tenants t join tenant_users tu on tu.tenant_id = t.id where tu.user_id = $1 order by t.created_at limit 1`,
  [users[0].id],
)
const token = randomBytes(32).toString('hex')
await db.query(
  `insert into sessions (user_id, token, expires_at, active_tenant_id, user_agent)
   values ($1, $2, now() + interval '1 hour', $3, 'shoot-screens')`,
  [users[0].id, token, tenants[0]?.id ?? null],
)
await db.end()

// The same signature better-call's signCookieValue writes: HMAC-SHA256 keyed
// by the raw secret, standard base64 WITH padding (btoa), then URI-encoded.
const signature = createHmac('sha256', secret).update(token).digest('base64')
const cookieValue = encodeURIComponent(`${token}.${signature}`)

mkdirSync(outDir, { recursive: true })
const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  args: ['--hide-scrollbars'],
  defaultViewport: { width: 1440, height: 900, deviceScaleFactor: 2 },
})
const page = await browser.newPage()
await browser.setCookie({
  name: 'better-auth.session_token',
  value: cookieValue,
  domain: new URL(appUrl).hostname,
  path: '/',
  httpOnly: true,
  sameSite: 'Lax',
})
for (const shot of SHOTS) {
  await page.goto(`${appUrl}${shot.path}`, { waitUntil: 'networkidle2', timeout: 60_000 })
  await new Promise((r) => setTimeout(r, shot.settleMs ?? 1500))
  const file = `${outDir}/${shot.name}.png`
  await page.screenshot({ path: file as `${string}.png` })
  console.log(`shot ${shot.name} → ${file}  (${page.url()})`)
}
await browser.close()
