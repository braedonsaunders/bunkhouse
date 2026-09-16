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
const bridgeRoute = readFileSync(
  fileURLToPath(new URL('../src/app/api/chat/[threadId]/dashboard/bridge/route.ts', import.meta.url)),
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
    5,
    'saving, reconfiguring and deleting files, and publishing and deleting datasets, all ride the file-writes dial',
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
  assert.equal(actions.includes('dashboardBridgeAction'), false, 'the live bridge is not tied to a deployment-specific Server Action id')
  assert.ok(bridgeRoute.includes("requireTenantPermission('work.read')"), 'the HTTP bridge keeps the same tenant permission gate')
  assert.ok(bridgeRoute.includes('runDashboardBridge'), 'the route reuses the one governed bridge implementation')
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
  assert.ok(panel.includes("fetch(`/api/chat/${encodeURIComponent(threadId)}/dashboard/bridge`"), 'the frame reaches its conversation through a stable HTTP route')
  assert.ok(panel.includes("cache: 'no-store'"), 'live bridge responses are never reused as snapshots')
  assert.ok(panel.includes('no ambient network'), 'the sandbox model is stated where it runs')
  assert.ok(panel.includes('Live public data'), 'operators can configure exact public-data origins and the grant')
  assert.ok(panel.includes('<Switch'), 'the public-data grant is an explicit operator control')
  assert.ok(panel.includes('CodeMirror'), 'the operator edits real files, not a form standing in for them')
  assert.ok(panel.includes('Backend endpoints'), 'endpoints are managed beside the files that serve them')
  assert.ok(panel.includes('Every backend call'), 'the run record is visible where the dashboard is edited')
  assert.equal(panel.includes('Sandboxed · refreshes live'), false, 'the header never calls an installed app live when its public-data grant is off')
  assert.ok(panel.includes('bundle.app.liveDataGranted'), 'the header reads the same authoritative public-data grant as the bridge')
  assert.ok(panel.includes("label: 'Public data off'"), 'the disabled public-data state is explicit in the header')
  assert.ok(lib.includes('Never render a theme selector'), 'the bridge contract makes the host theme authoritative')
  assert.ok(abilities.includes('never add a separate theme selector'), 'dashboard authors are told to use the inherited app theme')
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

// --- datasets ---------------------------------------------------------------------
// The dashboard could read this conversation's records and, with a grant,
// declared public origins. Neither covered the data the agent produced itself,
// so agents pasted snapshots into frontend source and hand-edited them. These
// pin the fourth plane: published rows, read over the records bridge the
// frontend already speaks, refreshed by a command instead of by a model.
test('datasets reach the frontend through records, not a new sandbox surface', () => {
  assert.ok(lib.includes("isDatasetType(typeKey)"), 'the records adapter routes dataset collections')
  assert.ok(
    lib.includes("appkit.records.list('dataset.<name>', { limit: 50 })"),
    'the bridge contract advertises dataset reads as ordinary records calls',
  )
  assert.ok(lib.includes("appkit.records.list('datasets', {})"), 'the dataset index is discoverable from the frontend')
  assert.ok(
    !lib.includes('BRIDGE_METHODS') && !lib.includes("method === 'datasets."),
    'datasets add no bridge method of their own',
  )
  assert.ok(
    lib.includes('datasets, and dataset.<name>'),
    'the unknown-collection error names the dataset collections it will serve',
  )
})

test('dataset storage is app-scoped, so one conversation cannot read another', () => {
  assert.ok(lib.includes('async function dashboardStorage('), 'datasets resolve through a single scoped helper')
  assert.ok(
    lib.includes('store.getApp(tenantId, dashboardAppKey(threadId))'),
    'the storage handle is bound to this thread’s app, not chosen by the caller',
  )
  assert.ok(lib.includes('withTenantContext'), 'dataset reads and writes run inside the tenant context')
})

test('publishing reads the agent machine host-side and stays bounded', () => {
  assert.ok(lib.includes('DATASET_SOURCE_MAX_BYTES'), 'a source file ceiling exists')
  assert.ok(lib.includes('file.truncated'), 'an oversized source is refused rather than silently cut')
  assert.ok(
    lib.includes("await import('./desk')"),
    'the host reaches into the machine; the machine never reaches out',
  )
  assert.ok(
    lib.includes('Publish a dataset either from a file on your machine (fromFile) or with rows.'),
    'publishing needs a real source',
  )
})

test('a producer refreshes data without a run or a model call', () => {
  assert.ok(lib.includes('runDeskCommandHeadless'), 'the producer command runs headless')
  assert.ok(lib.includes('claimDatasetRefresh'), 'concurrent pollers do not all run the command')
  assert.ok(lib.includes('datasetIsStale'), 'staleness decides when a producer runs')
  assert.ok(
    lib.includes('refreshDatasetIfStale(tenantId, threadId, String('),
    'the dashboard poll is the clock that drives refresh',
  )
  assert.ok(
    lib.includes('recordDatasetError'),
    'a failed producer is recorded instead of blanking the panel',
  )
})

test('a failed refresh keeps the last good rows', () => {
  const refresh = lib.slice(lib.indexOf('export async function refreshDashboardDataset'))
  assert.ok(refresh.includes('recordDatasetError'), 'the error lands on the dataset')
  assert.ok(
    !refresh.includes('deleteStoredDataset') && !refresh.includes('rows: []'),
    'nothing clears the rows on failure',
  )
})

test('the agent is told to publish data instead of pasting it', () => {
  assert.ok(abilities.includes("name: 'publish_dataset'"), 'the publish tool exists')
  assert.ok(abilities.includes("name: 'list_datasets'"), 'the agent can see what it already published')
  assert.ok(abilities.includes("name: 'delete_dataset'"), 'the agent can retire a dataset')
  assert.ok(
    abilities.includes('Never paste your own data into a file as a literal'),
    'the file-writing tool forbids the snapshot habit outright',
  )
  assert.ok(
    lib.includes('Never paste your own data into a file as a literal.'),
    'the bridge contract carries the same rule the tool does',
  )
  assert.ok(
    abilities.includes('with no model call'),
    'the refresh rule explains why a producer is not a duty',
  )
})

test('dataset writes ride the file dial and reads stay ungoverned', () => {
  const publish = abilities.slice(abilities.indexOf("name: 'publish_dataset'"))
  assert.ok(publish.slice(0, 2_000).includes("category: 'file_write'"), 'publishing is a governed write')
  const listing = abilities.slice(abilities.indexOf("name: 'list_datasets'"))
  assert.ok(listing.slice(0, 1_200).includes('category: null'), 'listing the agent’s own datasets is a read')
  const removal = abilities.slice(abilities.indexOf("name: 'delete_dataset'"))
  assert.ok(removal.slice(0, 1_200).includes("category: 'file_write'"), 'deleting a dataset is a governed write')
})

test('the operator can see and control every dataset', () => {
  assert.ok(panel.includes("key: 'data'"), 'the management surface has a Data tab')
  assert.ok(panel.includes('dashboardDatasetsAction'), 'the tab lists what was published')
  assert.ok(panel.includes('refreshDashboardDatasetAction'), 'an operator can refresh on demand')
  assert.ok(panel.includes('setDashboardDatasetProducerEnabledAction'), 'an operator can pause a producer')
  assert.ok(panel.includes('deleteDashboardDatasetAction'), 'an operator can delete a dataset')
  assert.ok(panel.includes('dataset.lastError'), 'the last producer error is visible, not buried in logs')
  assert.ok(panel.includes('refreshedLabel'), 'freshness is shown in words an operator reads')
  for (const action of [
    'dashboardDatasetsAction',
    'refreshDashboardDatasetAction',
    'setDashboardDatasetProducerEnabledAction',
    'deleteDashboardDatasetAction',
  ]) {
    assert.ok(actions.includes(`export async function ${action}`), `${action} is a real server action`)
    const body = actions.slice(actions.indexOf(`export async function ${action}`))
    assert.ok(
      body.slice(0, 900).includes("requireTenantPermission('work.manage')"),
      `${action} checks the same permission as the rest of the surface`,
    )
  }
})
