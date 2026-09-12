import 'server-only'
import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import {
  getFrontendBundle,
  installApp,
  runBridgeMethod,
  updateApp,
  type AppMetaUpdate,
  type InstalledApp,
} from '@braedonsaunders/appkit-apps'
import { createDrizzleAppStore } from '@braedonsaunders/appkit-apps/drizzle'
import { auditLog } from '@braedonsaunders/appkit-db'
import { appFiles } from '@braedonsaunders/appkit-apps/schema'
import { db } from '../db/client'
import { chatMessages, chatThreads } from '../db/schema/chat-threads'
import { duties, runs } from '../db/schema/work'
import { files } from '../db/schema/files'
import { people } from '../db/schema/people'
import { threadDutyIds } from './duty-conversation'
import { conversationIdFor } from './chat-threads'

type Store = ReturnType<typeof createDrizzleAppStore>

/**
 * A conversation's dashboard: one governed app per chat thread on the shared
 * installable-app platform. The agent authors the sandboxed frontend (and may
 * extend the QuickJS backend); the Dashboard tab renders it; the bridge feeds
 * it exactly this conversation's data.
 *
 * Scoping is structural, never prompt-deep. The app key names the thread, the
 * records adapter closes over the thread id, and the store runs inside the
 * tenant's RLS context — a dashboard cannot reach another conversation even
 * when its author is being creative.
 */

/** Capabilities a conversation dashboard may request. Read-only by design:
 *  the bridge exposes this conversation's data and nothing else, so granting
 *  it at provision time asks nothing of the operator. */
export const DASHBOARD_CAPABILITIES = [
  {
    key: 'records.read',
    label: 'Read conversation records',
    description: 'Read this conversation\u2019s messages, runs, files, and the agent\u2019s duties through the sandboxed bridge.',
  },
] as const

const DASHBOARD_CAPABILITY_KEYS = new Set(DASHBOARD_CAPABILITIES.map((capability) => capability.key))

/** Model-facing ceiling per dashboard file — far below the store's own 2 MB,
 *  because a file bigger than this is a bundle that should have been an
 *  attachment, not markup the next run has to re-read. */
export const DASHBOARD_MAX_FILE_CHARS = 200_000

const DASHBOARD_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(frontend|backend|assets)\/[a-z0-9._\-/]+$/i

export function dashboardAppKey(threadId: string): string {
  return `chat-${threadId.toLowerCase()}`
}

export function dashboardPathError(path: string): string | null {
  if (!DASHBOARD_PATH.test(path)) {
    return 'Path must live under frontend/, backend/, or assets/ (for example frontend/index.html or backend/stats.js). manifest.json, objects/, and anything outside those three folders are managed through the dashboard settings instead.'
  }
  return null
}

/** Endpoints as authors send them (method optional) → the manifest shape the
 *  platform validates. Unknown methods are refused, never coerced: silently
 *  rewriting POST to ANY would change what the dashboard can be called with. */
export function toAppEndpoints(input: Array<{ name: string; file: string; method?: string }>): Array<{ name: string; file: string; method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'ANY' }> {
  const methods = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'ANY'])
  return input.map((endpoint) => {
    const name = endpoint.name.trim()
    const file = endpoint.file.trim()
    if (!name || !file) throw new Error('Every endpoint needs a name and its backend file (save the file first).')
    const method = (endpoint.method ?? 'ANY').toUpperCase()
    if (!methods.has(method)) throw new Error(`Unknown endpoint method: ${endpoint.method}. Use GET, POST, PUT, PATCH, DELETE, or ANY.`)
    return { name, file, method: method as 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'ANY' }
  })
}

function storeFor(tenantDb: { db: unknown }): Store {
  // The store is host-agnostic: it only needs a node-postgres Drizzle handle.
  // The handle here is the tenant-scoped one, so every platform read and
  // write runs under the tenant's RLS context.
  return createDrizzleAppStore(tenantDb.db as NodePgDatabase<Record<string, never>>)
}

const STARTER_CSS = `:root{color-scheme:light dark}*{box-sizing:border-box}body{margin:0;background:Canvas;color:CanvasText;font-family:ui-sans-serif,system-ui,-apple-system,sans-serif}main{max-width:56rem;margin:auto;padding:clamp(1.5rem,5vw,3rem) 1.25rem}header p{margin:0}.eyebrow{color:GrayText;font-size:.7rem;font-weight:800;letter-spacing:.16em}.eyebrow.live{color:FieldText;background:SelectedItem;border-radius:999px;padding:.15rem .6rem}h1{margin:.6rem 0 .25rem;font-size:clamp(1.6rem,4.5vw,2.6rem);letter-spacing:-.03em;line-height:1.05}.sub{color:GrayText;font-size:.9rem}section{margin-top:1.5rem}.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(9rem,1fr));gap:.75rem}.tile{border:1px solid GrayText;border-radius:.9rem;padding:.9rem 1rem}.tile span{display:block;font-size:.68rem;font-weight:700;letter-spacing:.1em;color:GrayText}.tile strong{display:block;margin-top:.3rem;font-size:1.5rem;font-variant-numeric:tabular-nums}ul{list-style:none;margin:.75rem 0 0;padding:0;display:grid;gap:.5rem}li{border:1px solid GrayText;border-radius:.7rem;padding:.6rem .8rem;font-size:.83rem}li .meta{display:block;margin-top:.2rem;color:GrayText;font-size:.72rem}.error{border-color:SelectedItem}.hint{margin-top:1.5rem;color:GrayText;font-size:.8rem}`

function starterHtml(conversationTitle: string, agentName: string): string {
  const title = conversationTitle.replace(/</g, '&lt;')
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="frontend/styles.css"></head><body><main><header><p><span class="eyebrow">CONVERSATION DASHBOARD</span> <span class="eyebrow live">LIVE</span></p><h1>${title}</h1><p class="sub">Kept by ${agentName.replace(/</g, '&lt;')} · refreshes every 15 seconds</p></header><section><div class="tiles" id="tiles"></div></section><section><h2>Recent work</h2><ul id="runs"><li>Loading…</li></ul></section><section><h2>Duties</h2><ul id="duties"><li>Loading…</li></ul></section><p class="hint" id="note"></p></main><script>(function(){var tiles=document.getElementById('tiles'),runs=document.getElementById('runs'),duties=document.getElementById('duties'),note=document.getElementById('note');function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];});}function tile(label,value){return '<div class="tile"><span>'+esc(label)+'</span><strong>'+esc(value)+'</strong></div>';}function refresh(){appkit.records.list('thread.overview',{}).then(function(rows){var o=rows[0]||{};tiles.innerHTML=tile('MESSAGES',o.messages==null?'—':o.messages)+tile('RUNS',o.runs==null?'—':o.runs)+tile('FILES',o.files==null?'—':o.files)+tile('DUTIES',o.duties==null?'—':o.duties);note.textContent=o.lastActivity?('Last activity '+o.lastActivity):'';}).catch(function(e){note.textContent=e.message;});appkit.records.list('thread.runs',{limit:8}).then(function(rows){runs.innerHTML=rows.length?rows.map(function(r){return '<li>'+esc(r.summary||r.status)+'<span class="meta">'+esc(r.status)+' · '+esc(r.at)+'</span></li>';}).join(''):'<li>No runs yet.</li>';}).catch(function(){runs.innerHTML='<li class="error">Could not load runs.</li>';});appkit.records.list('thread.duties',{}).then(function(rows){duties.innerHTML=rows.length?rows.map(function(d){return '<li>'+esc(d.title)+'<span class="meta">'+esc(d.enabled==='on'?'scheduled':'off')+(d.nextDueAt?(' · next '+d.nextDueAt):'')+'</span></li>';}).join(''):'<li>No duties.</li>';}).catch(function(){duties.innerHTML='<li class="error">Could not load duties.</li>';});}refresh();setInterval(refresh,15000);})();</script></body></html>`
}

async function threadContext(tenantId: string, threadId: string) {
  const app = db()
  return app.withTenantContext(tenantId, async () => {
    const [thread] = await app.db
      .select({ id: chatThreads.id, title: chatThreads.title, personId: chatThreads.personId, status: chatThreads.status, lastMessageAt: chatThreads.lastMessageAt })
      .from(chatThreads)
      .where(and(eq(chatThreads.id, threadId)))
      .limit(1)
    if (!thread) return null
    const [person] = await app.db
      .select({ id: people.id, name: people.name })
      .from(people)
      .where(eq(people.id, thread.personId))
      .limit(1)
    return { thread, personName: person?.name ?? 'The agent' }
  })
}

/** The dashboard app for a conversation, or null when nobody has built one.
 *  Never provisions: reads stay reads, so polling the tab cannot create. */
export async function getDashboardApp(tenantId: string, threadId: string): Promise<InstalledApp | null> {
  const app = db()
  return app.withTenantContext(tenantId, async () => {
    const store = storeFor(app)
    return store.getApp(tenantId, dashboardAppKey(threadId))
  })
}

/** The dashboard app for a conversation, provisioned with a working starter
 *  when this is the first touch. Writes (agent saves, operator edits) come
 *  through here; the tab's reads go through `getDashboardApp`. */
export async function ensureDashboardApp(args: {
  tenantId: string
  actorId: string
  threadId: string
}): Promise<InstalledApp> {
  const { tenantId, actorId, threadId } = args
  const context = await threadContext(tenantId, threadId)
  if (!context) throw new Error('That conversation is no longer here.')
  const { thread, personName } = context
  const app = db()
  return app.withTenantContext(tenantId, async () => {
    const store = storeFor(app)
    const key = dashboardAppKey(threadId)
    const existing = await store.getApp(tenantId, key)
    if (existing) return existing
    const title = thread.title?.trim() || 'Untitled conversation'
    const name = `${personName} · ${title}`.slice(0, 120)
    // Two first touches racing (the agent saving while the operator starts
    // the starter) both see no app; the platform upserts the app row but
    // refuses the duplicate version, so the loser re-reads the winner.
    try {
      return await provision(store, app)
    } catch (error) {
      if (error instanceof Error && /version .* already exists/.test(error.message)) {
        const winner = await store.getApp(tenantId, key)
        if (winner) return winner
      }
      throw error
    }
    async function provision(provisionStore: Store, tenantApp: ReturnType<typeof db>): Promise<InstalledApp> {
      const installed = await installApp({
        store: provisionStore,
        tenantId,
        actorId,
        capabilityKeys: DASHBOARD_CAPABILITY_KEYS,
        bundle: {
          manifest: {
            key,
            name,
            version: '1.0.0',
            description: `Live dashboard for the conversation \u201c${title}\u201d. Authored by ${personName}; rendered in the Dashboard tab.`,
            icon: 'layout-dashboard',
            permissions: ['records.read'],
            frontend: { entry: 'frontend/index.html' },
            endpoints: [],
            nav: { show: false },
          },
          files: [
            { path: 'frontend/index.html', content: starterHtml(title, personName) },
            { path: 'frontend/styles.css', content: STARTER_CSS },
          ],
          grantedPermissions: ['records.read'],
        },
      })
      await tenantApp.db.insert(auditLog).values({
        tenantId,
        entityType: 'dashboard',
        entityId: installed.id,
        action: 'provisioned_for_conversation',
        summary: `${personName}'s dashboard was provisioned for \u201c${title}\u201d`,
        after: { key, threadId },
        metadata: { threadId, personId: thread.personId, provisionedBy: actorId },
      })
      return installed
    }
  })
}

export type DashboardFileInput = { path: string; content: string; isBinary?: boolean }

function checkFileInput(path: string, content: string): void {
  const problem = dashboardPathError(path)
  if (problem) throw new Error(problem)
  if (content.length > DASHBOARD_MAX_FILE_CHARS) {
    throw new Error(
      `That file is ${(content.length / 1_024).toFixed(0)} KB — the dashboard ceiling is ${(DASHBOARD_MAX_FILE_CHARS / 1_024).toFixed(0)} KB per file. Split it (markup in frontend/, logic in backend/ endpoints, data over the bridge) rather than pasting a bundle.`,
    )
  }
}

export async function saveDashboardFile(args: {
  tenantId: string
  actorId: string
  threadId: string
  runId?: string
  userId?: string
  file: DashboardFileInput
}): Promise<{ path: string; size: number }> {
  checkFileInput(args.file.path, args.file.content)
  const context = await threadContext(args.tenantId, args.threadId)
  if (!context) throw new Error('That conversation is no longer here.')
  const app = db()
  return app.withTenantContext(args.tenantId, async () => {
    const store = storeFor(app)
    const installed = await ensureDashboardApp({ tenantId: args.tenantId, actorId: args.actorId, threadId: args.threadId })
    await store.writeFile(args.tenantId, args.actorId, installed.key, {
      path: args.file.path,
      content: args.file.content,
      ...(args.file.isBinary ? { isBinary: true } : {}),
    })
    await app.db.insert(auditLog).values({
      tenantId: args.tenantId,
      entityType: 'dashboard',
      entityId: installed.id,
      action: args.runId ? 'file_saved_by_employee' : 'file_saved_by_operator',
      summary: `${args.file.path} saved on the dashboard for conversation ${args.threadId}`,
      after: { path: args.file.path, size: args.file.content.length },
      metadata: {
        threadId: args.threadId,
        personId: context.thread.personId,
        ...(args.runId ? { runId: args.runId } : {}),
        ...(args.userId ? { userId: args.userId } : {}),
      },
    })
    return { path: args.file.path, size: args.file.content.length }
  })
}

export async function updateDashboardMeta(args: {
  tenantId: string
  actorId: string
  threadId: string
  runId?: string
  userId?: string
  update: Omit<AppMetaUpdate, 'endpoints'> & { endpoints?: Array<{ name: string; file: string; method?: string }> }
}): Promise<void> {
  const context = await threadContext(args.tenantId, args.threadId)
  if (!context) throw new Error('That conversation is no longer here.')
  const endpoints = args.update.endpoints ? toAppEndpoints(args.update.endpoints) : undefined
  const { endpoints: _looseEndpoints, ...rest } = args.update
  void _looseEndpoints
  const update: AppMetaUpdate = { ...rest, ...(endpoints ? { endpoints } : {}) }
  const app = db()
  return app.withTenantContext(args.tenantId, async () => {
    const store = storeFor(app)
    const installed = await ensureDashboardApp({ tenantId: args.tenantId, actorId: args.actorId, threadId: args.threadId })
    if (endpoints) {
      // Fail at authoring time, not at 2am when the dashboard calls it: an
      // endpoint must name a backend file that already exists.
      const present = new Set((await store.listFiles(args.tenantId, installed.key)).map((file) => file.path))
      const missing = endpoints.filter((endpoint) => !present.has(endpoint.file))
      if (missing.length) {
        throw new Error(
          `No such dashboard file: ${missing.map((endpoint) => `${endpoint.name} → ${endpoint.file}`).join(', ')}. Save the backend file first, then register the endpoint.`,
        )
      }
    }
    await updateApp({
      store,
      tenantId: args.tenantId,
      actorId: args.actorId,
      key: installed.key,
      update: { ...update, showInNav: false },
      capabilityKeys: DASHBOARD_CAPABILITY_KEYS,
    })
    if (endpoints?.length) {
      // The store classifies a file from the manifest at write time, so a
      // backend file saved BEFORE its endpoint was registered sits as an
      // asset and the bridge refuses to execute it. Re-saving under the new
      // manifest reclassifies every endpoint file to backend.
      for (const endpoint of endpoints) {
        const current = await store.readFile(args.tenantId, installed.key, endpoint.file)
        if (current && !current.isBinary) {
          await store.writeFile(args.tenantId, args.actorId, installed.key, { path: current.path, content: current.content })
        }
      }
    }
    await app.db.insert(auditLog).values({
      tenantId: args.tenantId,
      entityType: 'dashboard',
      entityId: installed.id,
      action: args.runId ? 'settings_saved_by_employee' : 'settings_saved_by_operator',
      summary: `Dashboard settings saved for conversation ${args.threadId}`,
      after: update as Record<string, unknown>,
      metadata: {
        threadId: args.threadId,
        personId: context.thread.personId,
        ...(args.runId ? { runId: args.runId } : {}),
        ...(args.userId ? { userId: args.userId } : {}),
      },
    })
  })
}

export async function readDashboardFile(tenantId: string, threadId: string, path: string) {
  const app = db()
  return app.withTenantContext(tenantId, async () => {
    const installed = await getDashboardApp(tenantId, threadId)
    if (!installed) return null
    return storeFor(app).readFile(tenantId, installed.key, path)
  })
}

export async function listDashboardFiles(tenantId: string, threadId: string) {
  const app = db()
  return app.withTenantContext(tenantId, async () => {
    const installed = await getDashboardApp(tenantId, threadId)
    if (!installed) return null
    const store = storeFor(app)
    return { app: installed, files: await store.listFiles(tenantId, installed.key) }
  })
}

export async function deleteDashboardFile(args: {
  tenantId: string
  actorId: string
  threadId: string
  path: string
  runId?: string
  userId?: string
}): Promise<void> {
  const context = await threadContext(args.tenantId, args.threadId)
  if (!context) throw new Error('That conversation is no longer here.')
  const app = db()
  return app.withTenantContext(args.tenantId, async () => {
    const installed = await getDashboardApp(args.tenantId, args.threadId)
    if (!installed) throw new Error('This conversation does not have a dashboard yet.')
    await storeFor(app).deleteFile(args.tenantId, installed.key, args.path)
    await app.db.insert(auditLog).values({
      tenantId: args.tenantId,
      entityType: 'dashboard',
      entityId: installed.id,
      action: args.runId ? 'file_deleted_by_employee' : 'file_deleted_by_operator',
      summary: `${args.path} deleted from the dashboard for conversation ${args.threadId}`,
      before: { path: args.path },
      metadata: {
        threadId: args.threadId,
        personId: context.thread.personId,
        ...(args.runId ? { runId: args.runId } : {}),
        ...(args.userId ? { userId: args.userId } : {}),
      },
    })
  })
}

export async function listDashboardRuns(tenantId: string, threadId: string, limit = 20) {
  const app = db()
  return app.withTenantContext(tenantId, async () => {
    const installed = await getDashboardApp(tenantId, threadId)
    if (!installed) return []
    return storeFor(app).listRuns(tenantId, installed.id, limit)
  })
}

export async function getDashboardBundle(tenantId: string, threadId: string) {
  const app = db()
  return app.withTenantContext(tenantId, async () => {
    const installed = await getDashboardApp(tenantId, threadId)
    if (!installed) return null
    const store = storeFor(app)
    const bundle = await getFrontendBundle(store, tenantId, installed.key)
    return { app: installed, bundle }
  })
}

/** What the work surface needs to decide whether the tab has anything to show. */
export async function dashboardSummary(tenantId: string, threadId: string): Promise<{
  present: boolean
  updatedAt: string | null
  appName: string | null
}> {
  const installed = await getDashboardApp(tenantId, threadId)
  if (!installed) return { present: false, updatedAt: null, appName: null }
  const app = db()
  return app.withTenantContext(tenantId, async () => {
    // `getApp` carries no timestamp, and the bundle read is heavier than a
    // tab poll should spend — the newest file write is the freshness signal.
    const [newest] = await app.db
      .select({ updatedAt: appFiles.updatedAt })
      .from(appFiles)
      .where(eq(appFiles.appId, installed.id))
      .orderBy(desc(appFiles.updatedAt))
      .limit(1)
    return { present: true, updatedAt: newest?.updatedAt.toISOString() ?? null, appName: installed.name }
  })
}

/** The dashboard as the agent meets it: full file contents (bounded), recent
 *  backend runs, and the bridge contract — or, when nothing is built yet, the
 *  contract and the starter it will grow from. Reading never provisions: a
 *  curious read must not mint an app, so the first save is what creates. */
export async function readDashboardForAgent(args: { tenantId: string; threadId: string }) {
  const { tenantId, threadId } = args
  const found = await listDashboardFiles(tenantId, threadId)
  if (!found) {
    return {
      present: false,
      bridge: BRIDGE_CONTRACT,
      starter: ['frontend/index.html', 'frontend/styles.css'],
      note: 'No dashboard yet — your first save_dashboard_file provisions it with a working starter showing live conversation stats, which you then extend. Read back with get_dashboard after saving.',
    }
  }
  const app = db()
  return app.withTenantContext(tenantId, async () => {
    const store = storeFor(app)
    const contents = await Promise.all(
      found.files
        .filter((file) => !file.isBinary)
        .map(async (file) => {
          const full = await store.readFile(tenantId, found.app.key, file.path)
          const content = full?.content ?? ''
          return {
            path: file.path,
            kind: file.kind,
            size: content.length,
            truncated: content.length > 8_000,
            content: content.length > 8_000 ? `${content.slice(0, 8_000)}\n\u2026 [truncated — ${content.length} chars total]` : content,
          }
        }),
    )
    const runs = await store.listRuns(tenantId, found.app.id, 10)
    return {
      present: true,
      name: found.app.name,
      description: found.app.description,
      endpoints: found.app.manifest?.endpoints ?? [],
      files: contents,
      recentRuns: runs.map((run) => ({
        endpoint: run.endpoint,
        status: run.status,
        error: run.errorMessage,
        at: run.at.toISOString(),
      })),
      bridge: BRIDGE_CONTRACT,
    }
  })
}

const BRIDGE_CONTRACT = {
  globals: ['appkit'],
  calls: [
    { call: "appkit.getContext()", returns: 'The dashboard, user, and tenant the frontend is running for.' },
    { call: "appkit.records.list('thread.overview', {})", returns: 'One row: title, status, agent, message/run/file/duty counts, last activity.' },
    { call: "appkit.records.list('thread.messages', { limit: 20 })", returns: 'Newest first: seq, role, body (500 chars), at.' },
    { call: "appkit.records.list('thread.runs', { limit: 20 })", returns: 'Newest first: id, status, summary, at.' },
    { call: "appkit.records.list('thread.files', { limit: 20 })", returns: 'Newest first: id, filename, kind, size, at.' },
    { call: "appkit.records.list('thread.duties', {})", returns: "The agent's duties: slug, title, enabled, next run, run count." },
    { call: 'appkit.callBackend(endpoint, payload)', returns: "Runs one of the dashboard's own backend endpoints (see endpoints above) in QuickJS with per-dashboard storage. Resolves { status, body } — read your values off response.body." },
  ],
  rules: [
    'No network, no cookies, no parent DOM — data arrives only through these calls.',
    'Poll on an interval (15 seconds is the house rhythm) rather than rendering once.',
    'Escape every value you render; the bridge hands you text, not markup.',
  ],
} as const

/**
 * The records a conversation dashboard may read: this conversation, closed
 * over at call time. Unknown type keys fail closed — a dashboard cannot
 * probe for tables it was never offered.
 */
export function dashboardRecords(tenantId: string, threadId: string) {
  const app = db()
  return {
    async list(typeKey: string, filters: Record<string, unknown>): Promise<unknown[]> {
      return app.withTenantContext(tenantId, async () => {
        const context = await threadContext(tenantId, threadId)
        if (!context) throw new Error('That conversation is no longer here.')
        const limit = Math.min(Math.max(Number(filters.limit ?? 20) || 20, 1), 100)
        if (typeKey === 'thread.overview') {
          const dutyIds = await threadDutyIds(tenantId, threadId)
          const conversation = conversationIdFor(threadId)
          const runScope = dutyIds.length > 0
            ? sql`${runs.trigger}->>'conversationId' = ${conversation} OR ${runs.trigger}->>'dutyId' IN (${sql.join(dutyIds.map((id) => sql`${id}`), sql`, `)})`
            : sql`${runs.trigger}->>'conversationId' = ${conversation}`
          const [messages, threadRuns, personDuties] = await Promise.all([
            app.db
              .select({ id: chatMessages.id })
              .from(chatMessages)
              .where(eq(chatMessages.threadId, threadId))
              .limit(1_000),
            app.db.select({ id: runs.id }).from(runs).where(runScope).limit(1_000),
            app.db.select({ id: duties.id }).from(duties).where(eq(duties.personId, context.thread.personId)).limit(1_000),
          ])
          const conversationFiles = threadRuns.length === 0
            ? []
            : await app.db
              .select({ id: files.id })
              .from(files)
              .where(inArray(files.runId, threadRuns.map((row) => row.id)))
              .limit(1_000)
          return [
            {
              threadId,
              title: context.thread.title,
              status: context.thread.status,
              agent: context.personName,
              messages: messages.length,
              runs: threadRuns.length,
              files: conversationFiles.length,
              duties: personDuties.length,
              lastActivity: context.thread.lastMessageAt.toISOString(),
            },
          ]
        }
        if (typeKey === 'thread.messages') {
          const rows = await app.db
            .select({ seq: chatMessages.seq, role: chatMessages.role, body: chatMessages.body, at: chatMessages.at })
            .from(chatMessages)
            .where(and(eq(chatMessages.threadId, threadId)))
            .orderBy(desc(chatMessages.seq))
            .limit(limit)
          return rows.map((row) => ({
            seq: row.seq,
            role: row.role,
            body: row.body.length > 500 ? `${row.body.slice(0, 500)}\u2026` : row.body,
            at: row.at.toISOString(),
          }))
        }
        if (typeKey === 'thread.runs') {
          const dutyIds = await threadDutyIds(tenantId, threadId)
          const conversation = conversationIdFor(threadId)
          const rows = await app.db
            .select({ id: runs.id, status: runs.status, summary: runs.summary, startedAt: runs.startedAt })
            .from(runs)
            .where(
              dutyIds.length > 0
                ? sql`${runs.trigger}->>'conversationId' = ${conversation} OR ${runs.trigger}->>'dutyId' IN (${sql.join(dutyIds.map((id) => sql`${id}`), sql`, `)})`
                : sql`${runs.trigger}->>'conversationId' = ${conversation}`,
            )
            .orderBy(desc(runs.startedAt))
            .limit(limit)
          return rows.map((row) => ({
            id: row.id,
            status: row.status,
            summary: row.summary,
            at: row.startedAt.toISOString(),
          }))
        }
        if (typeKey === 'thread.files') {
          const dutyIds = await threadDutyIds(tenantId, threadId)
          const conversation = conversationIdFor(threadId)
          const threadRuns = await app.db
            .select({ id: runs.id })
            .from(runs)
            .where(
              dutyIds.length > 0
                ? sql`${runs.trigger}->>'conversationId' = ${conversation} OR ${runs.trigger}->>'dutyId' IN (${sql.join(dutyIds.map((id) => sql`${id}`), sql`, `)})`
                : sql`${runs.trigger}->>'conversationId' = ${conversation}`,
            )
            .limit(1_000)
          if (threadRuns.length === 0) return []
          const rows = await app.db
            .select({ id: files.id, filename: files.filename, kind: files.kind, sizeBytes: files.sizeBytes, createdAt: files.createdAt })
            .from(files)
            .where(inArray(files.runId, threadRuns.map((row) => row.id)))
            .orderBy(desc(files.createdAt))
            .limit(limit)
          return rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }))
        }
        if (typeKey === 'thread.duties') {
          const rows = await app.db
            .select({ slug: duties.slug, title: duties.title, enabled: duties.enabled, nextDueAt: duties.nextDueAt, runCount: duties.runCount })
            .from(duties)
            .where(eq(duties.personId, context.thread.personId))
            .orderBy(duties.nextDueAt)
            .limit(limit)
          return rows.map((row) => ({ ...row, nextDueAt: row.nextDueAt?.toISOString() ?? null }))
        }
        throw new Error(`Unknown records collection: ${typeKey}. This dashboard can read thread.overview, thread.messages, thread.runs, thread.files, and thread.duties.`)
      })
    },
    async get(typeKey: string, id: string): Promise<unknown> {
      const rows = await dashboardRecords(tenantId, threadId).list(typeKey, { limit: 100 })
      const found = (rows as Array<{ id?: unknown; seq?: unknown }>)
        .find((row) => String(row.id ?? row.seq ?? '') === id)
      if (!found) throw new Error('Record not found in this conversation.')
      return found
    },
  }
}

/** Run one bridge call from a conversation dashboard's frontend. */
export async function runDashboardBridge(args: {
  tenantId: string
  user: { id: string; name: string }
  threadId: string
  method: string
  payload: unknown
}): Promise<unknown> {
  const { tenantId, user, threadId, method, payload } = args
  const app = db()
  return app.withTenantContext(tenantId, async () => {
    const installed = await getDashboardApp(tenantId, threadId)
    if (!installed) throw new Error('This conversation does not have a dashboard yet.')
    const outcome = await runBridgeMethod({
      store: storeFor(app),
      tenantId,
      key: installed.key,
      user: { id: user.id, name: user.name },
      method,
      payload,
      adapters: {
        capabilityKeys: DASHBOARD_CAPABILITY_KEYS,
        // The operator already cleared the work-surface gate at the action
        // boundary; the granted set on the app decides the rest.
        userCan: () => true,
        records: () => dashboardRecords(tenantId, threadId),
      },
    })
    if (!outcome.ok) throw new Error(outcome.error)
    return outcome.result
  })
}
