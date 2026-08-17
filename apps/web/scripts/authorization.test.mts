import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import {
  ROUTE_AUTHORIZATION,
  SERVER_ACTION_AUTHORIZATION,
} from '../src/lib/authorization-registry.ts'

const sourceRoot = join(process.cwd(), 'src')
const appRoot = join(sourceRoot, 'app')

async function filesBelow(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name)
      return entry.isDirectory() ? filesBelow(path) : Promise.resolve([path])
    }),
  )
  return nested.flat()
}

const keyOf = (path: string) => relative(sourceRoot, path).split(sep).join('/')
const files = await filesBelow(appRoot)
const actionModules: string[] = []
for (const path of files.filter((candidate) => candidate.endsWith('.ts'))) {
  const source = await readFile(path, 'utf8')
  if (/^['"]use server['"]/m.test(source)) actionModules.push(keyOf(path))
}
const routeModules = files.filter((path) => path.endsWith(`${sep}route.ts`)).map(keyOf)

assert.deepEqual(
  actionModules.sort(),
  Object.keys(SERVER_ACTION_AUTHORIZATION).sort(),
  'every server-action module must be classified in SERVER_ACTION_AUTHORIZATION',
)
assert.deepEqual(
  routeModules.sort(),
  Object.keys(ROUTE_AUTHORIZATION).sort(),
  'every route handler must be classified in ROUTE_AUTHORIZATION',
)

const sessionGate = /requireUser|requireTenantPermission|resolveTenantId|getTenantAccess|requireSuperAdmin/
const capabilityGate = /lookupMeetingByToken|oauth|state|token/i
const webhookGate = /signature|securityToken|verify/i

for (const [module, boundary] of Object.entries({
  ...SERVER_ACTION_AUTHORIZATION,
  ...ROUTE_AUTHORIZATION,
})) {
  const source = await readFile(join(sourceRoot, module), 'utf8')
  if (boundary === 'tenant_session' || boundary === 'superadmin_session') {
    assert.match(source, sessionGate, `${module} declares a session boundary but contains no server-side session gate`)
  } else if (boundary === 'capability_token') {
    assert.match(source, capabilityGate, `${module} declares a capability boundary but contains no token/state check`)
  } else if (boundary === 'signed_webhook') {
    assert.match(source, webhookGate, `${module} declares a webhook boundary but contains no signature/token verification`)
  }
}

console.log('authorization: every server action and route has an exhaustive, checked boundary classification')
