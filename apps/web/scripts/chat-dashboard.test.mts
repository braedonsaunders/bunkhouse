import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// A conversation's dashboard: one governed app per chat thread, authored by
// the agent, rendered in the Dashboard tab, editable by the operator. These
// tests pin the contracts that keep it scoped — the key derivation, the path
// jail, the size ceilings, the governed capability set, and the places the
// tab, the tools, and the tables meet. Database behaviour (provisioning,
// RLS, the bridge) runs against the real platform behind these shapes.

const lib = readFileSync(
  fileURLToPath(new URL('../src/lib/chat-dashboard.ts', import.meta.url)),
  'utf8',
)
const abilities = readFileSync(
  fileURLToPath(new URL('../src/lib/agent-abilities.ts', import.meta.url)),
  'utf8',
)
const surface = readFileSync(
  fileURLToPath(new URL('../src/lib/chat-work-surface.ts', import.meta.url)),
  'utf8',
)
const actions = readFileSync(
  fileURLToPath(new URL('../src/app/chat/actions.ts', import.meta.url)),
  'utf8',
)
const stage = readFileSync(
  fileURLToPath(new URL('../src/components/chat-work-surface.tsx', import.meta.url)),
  'utf8',
)
const panel = readFileSync(
  fileURLToPath(new URL('../src/components/chat-dashboard.tsx', import.meta.url)),
  'utf8',
)
const schemaIndex = readFileSync(
  fileURLToPath(new URL('../src/db/schema/index.ts', import.meta.url)),
  'utf8',
)
const migration = readFileSync(
  fileURLToPath(new URL('../../../migrations/0079_conversation_dashboard.sql', import.meta.url)),
  'utf8',
)

const {
  dashboardAppKey,
  dashboardPathError,
  toAppEndpoints,
  dashboardDataRequestError,
  normalizeDashboardOrigins,
  DASHBOARD_CAPABILITIES,
  DASHBOARD_MAX_FILE_CHARS,
} = await import('../src/lib/chat-dashboard')

// --- key derivation ----------------------------------------------------------
test('the dashboard key names its thread and stays a valid app slug', () => {
  const key = dashboardAppKey('550E8400-E29B-41D4-A716-446655440000')
  assert.equal(key, 'chat-550e8400-e29b-41d4-a716-446655440000')
  assert.match(key, /^[a-z][a-z0-9-]*$/)
  assert.ok(key.length <= 64)
  assert.notEqual(
    dashboardAppKey('550e8400-e29b-41d4-a716-446655440000'),
    dashboardAppKey('660e8400-e29b-41d4-a716-446655440000'),
    'two conversations never share a dashboard',
  )
})

// --- path jail ---------------------------------------------------------------
test('dashboard writes stay under frontend/, backend/, or assets/', () => {
  for (const ok of ['frontend/index.html', 'frontend/styles.css', 'frontend/app.js', 'backend/stats.js', 'assets/logo.png']) {
    assert.equal(dashboardPathError(ok), null, `${ok} is writable`)
  }
  for (const bad of ['manifest.json', 'objects/thing.json', '../secrets', '/etc/passwd', 'frontend/../../x', 'index.html', '']) {
    assert.ok(dashboardPathError(bad), `${bad || '(empty)'} is refused`)
  }
})

// --- size ceiling --------------------------------------------------------------
test('the model-facing file ceiling sits far below the store ceiling', () => {
  assert.equal(DASHBOARD_MAX_FILE_CHARS, 200_000)
  assert.ok(lib.includes('DASHBOARD_MAX_FILE_CHARS'), 'the ceiling is one named constant, enforced at the door')
})

// --- endpoint normalization ----------------------------------------------------
test('endpoint updates validate loudly and default honestly', () => {
  assert.deepEqual(toAppEndpoints([{ name: 'stats', file: 'backend/stats.js' }]), [
    { name: 'stats', file: 'backend/stats.js', method: 'ANY' },
  ])
  assert.deepEqual(toAppEndpoints([{ name: 'stats', file: 'backend/stats.js', method: 'post' }]), [
    { name: 'stats', file: 'backend/stats.js', method: 'POST' },
  ])
  assert.throws(() => toAppEndpoints([{ name: '', file: 'backend/stats.js' }]), /name and its backend file/)
  assert.throws(() => toAppEndpoints([{ name: 'stats', file: 'backend/stats.js', method: 'BREW' }]), /Unknown endpoint method/)
  assert.ok(lib.includes('Save the backend file first'), 'an endpoint cannot be registered for a file that does not exist yet')
  assert.ok(lib.includes('reclassifies every endpoint file to backend'), 'registering an endpoint re-saves its file under the new manifest, so a backend file saved first still executes')
})

test('live data requests are dashboard-agnostic and exact-origin scoped', () => {
  assert.deepEqual(normalizeDashboardOrigins([' https://api.example.com/ ', 'https://api.example.com']), ['https://api.example.com'])
  assert.equal(dashboardDataRequestError(['https://api.example.com'], { url: 'https://api.example.com/v1/items?q=1' }), null)
  assert.equal(dashboardDataRequestError(['https://api.example.com'], { url: 'https://api.example.com/v1/items', method: 'POST', body: { page: 1 } }), null)
  assert.match(dashboardDataRequestError(['https://api.example.com'], { url: 'https://other.example.com/v1/items' }) ?? '', /not a declared/)
  assert.match(dashboardDataRequestError(['https://api.example.com'], { url: 'http://api.example.com/v1/items' }) ?? '', /HTTPS/)
  assert.match(dashboardDataRequestError(['https://api.example.com'], { url: 'https://user:pass@api.example.com/v1/items' }) ?? '', /credentials/)
  assert.match(dashboardDataRequestError(['https://api.example.com'], { url: 'https://api.example.com/v1/items', method: 'DELETE' }) ?? '', /GET and POST/)
  assert.throws(() => normalizeDashboardOrigins(['https://api.example.com/private']), /exact HTTPS origin/)
})

// --- capability set --------------------------------------------------------------
test('a conversation dashboard gets scoped records and separately governed public data', () => {
  assert.deepEqual(DASHBOARD_CAPABILITIES.map((capability) => capability.key), ['records.read', 'network.read'])
  assert.ok(lib.includes("grantedPermissions: ['records.read']"), 'provisioning grants records but never network access')
  assert.ok(lib.includes("'http.request'"), 'the backend receives one generic public-data function')
  assert.ok(lib.includes('maxRedirects: 0'), 'public-data requests cannot escape the declared origin through redirects')
  assert.ok(
    lib.includes('Unknown records collection'),
    'the bridge fails closed on collections it was never offered',
  )
  assert.ok(abilities.includes('Never create or schedule a duty merely to refresh a dashboard'), 'agents are explicitly told that dashboard JavaScript owns freshness')
  for (const collection of ['thread.overview', 'thread.messages', 'thread.runs', 'thread.files', 'thread.duties']) {
    assert.ok(lib.includes(`'${collection}'`), `the bridge offers ${collection}`)
  }
})

// --- agent tools -------------------------------------------------------------------
test('dashboard tools exist, read freely, and write under the file dial', () => {
  for (const tool of ['get_dashboard', 'save_dashboard_file', 'update_dashboard', 'delete_dashboard_file']) {
    assert.ok(abilities.includes(`name: '${tool}'`), `${tool} is an assembled ability`)
  }
  const block = abilities.slice(abilities.indexOf('dashboardAbilities'), abilities.indexOf('MCP integrations'))
  assert.ok(block.includes("category: null"), 'reading the dashboard is ungoverned like reading the conversation')
  assert.equal(
    (block.match(/category: 'file_write'/g) ?? []).length,
    3,
    'saving, reconfiguring, and deleting files all ride the file-writes dial',
  )
  assert.ok(
    abilities.includes('dashboardAbilities({ tenantId, person, runId, chatThreadId: args.chatThreadId })'),
    'dashboard tools assemble wherever a conversation is in scope',
  )
  assert.ok(
    abilities.includes('thread there is no tab, and the tools would provision orphans'),
    'the assembly says why threadless runs get no dashboard tools',
  )
})

// --- reads never provision ------------------------------------------------------------
test('reading the dashboard cannot mint an app', () => {
  assert.ok(lib.includes('Never provisions: reads stay reads'), 'getDashboardApp documents the rule')
  assert.ok(
    lib.includes('No dashboard yet — your first save_dashboard_file provisions it'),
    'the agent is told what creates, in the read result itself',
  )
  assert.ok(lib.includes('already exists'), 'a provisioning race re-reads the winner instead of failing')
})

// --- surface, actions, stage ----------------------------------------------------------------
test('the work surface carries dashboard freshness for the tab poll', () => {
  assert.ok(surface.includes('dashboard: ChatDashboardSummary'), 'the surface type carries the dashboard')
  assert.ok(surface.includes('dashboardSummary(tenantId, threadId)'), 'freshness rides the same poll as everything else')
  assert.equal(surface.includes('ChatWorkFocus'), false, 'dashboard updates never steer the reader to another tab')
  assert.ok(actions.includes('dashboardBundleAction'), 'the tab reads its bundle through an action')
  assert.ok(actions.includes('dashboardBridgeAction'), 'bridge calls cross through an action, never directly')
  assert.ok(actions.includes('ensureDashboardAction'), 'the operator can start from the live starter')
  assert.ok(actions.includes("requireTenantPermission('work.read')"), 'dashboard reads sit behind the work gate')
  assert.ok(actions.includes("requireTenantPermission('work.manage')"), 'dashboard writes sit behind the manage gate')
})

test('the Dashboard tab renders the sandbox and manages it in place', () => {
  assert.ok(stage.includes("key: 'dashboard'"), 'Dashboard is a work-surface tab')
  assert.ok(stage.indexOf("key: 'dashboard'") < stage.indexOf("key: 'desktop'"), 'Dashboard leads the work-surface tabs')
  assert.ok(stage.includes('<ChatDashboard threadId={threadId}'), 'the tab renders the dashboard panel')
  assert.ok(stage.includes('<TabContent tabKey={activeTab}'), 'swapping surfaces crossfades instead of cutting')
  assert.ok(panel.includes('<AppFrame'), 'the dashboard renders through the opaque-origin app frame')
  assert.ok(panel.includes('dashboardBridgeAction'), 'the frame reaches its conversation through the bridge action')
  assert.ok(panel.includes('no ambient network'), 'the sandbox model is stated where it runs')
  assert.ok(panel.includes('Live public data'), 'operators can configure exact public-data origins and the grant')
  assert.ok(panel.includes('<Switch'), 'the public-data grant is an explicit operator control')
  assert.ok(panel.includes('CodeMirror'), 'the operator edits real files, not a form standing in for them')
  assert.ok(panel.includes('Backend endpoints'), 'endpoints are managed beside the files that serve them')
  assert.ok(panel.includes('Every backend call'), 'the run record is visible where the dashboard is edited')
})

// --- persistence ------------------------------------------------------------------
test('the platform tables land with tenant isolation', () => {
  assert.ok(schemaIndex.includes("export * from './apps'"), 'the apps schema module is registered')
  assert.ok(schemaIndex.includes('APPS_TENANT_TABLES'), 'the RLS registry covers the platform tables')
  for (const table of ['apps', 'app_versions', 'app_files', 'app_storage', 'app_runs']) {
    assert.ok(migration.includes(`CREATE TABLE IF NOT EXISTS ${table} (`), `${table} is created`)
    assert.ok(
      migration.includes(`CREATE POLICY tenant_isolation ON ${table}`),
      `${table} carries the tenant policy, not just the filter`,
    )
  }
  assert.ok(migration.includes('app_listings'), 'the catalogue table ships with the platform DDL')
  assert.ok(
    migration.includes('deployment-owned marketplace catalogue'),
    'the migration says why listings carry no tenant policy',
  )
})
