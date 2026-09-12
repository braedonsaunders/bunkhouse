'use client'

import * as React from 'react'
import {
  Activity,
  ArrowLeft,
  CheckCircle2,
  Eye,
  FileCode2,
  FilePlus2,
  LayoutDashboard,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Settings2,
  Trash2,
} from 'lucide-react'
import { Badge, Button, EmptyState, Input, SubtabNav, Switch } from '@braedonsaunders/appkit-ui'
import { AppFrame } from '@braedonsaunders/appkit-apps/react'
import CodeMirror from '@uiw/react-codemirror'
import { html } from '@codemirror/lang-html'
import { css } from '@codemirror/lang-css'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import {
  dashboardBridgeAction,
  dashboardBundleAction,
  dashboardFileAction,
  dashboardFilesAction,
  dashboardRunsAction,
  deleteDashboardFileAction,
  ensureDashboardAction,
  saveDashboardFileAction,
  updateDashboardAction,
} from '../app/chat/actions'
import type { ChatDashboardSummary } from '../lib/chat-work-surface'

type BundleView = {
  app: {
    key: string
    name: string
    description: string | null
    iconKey: string
    status: string
    version: string | null
    grantedPermissions: string[]
    endpoints: Array<{ name: string; file: string; method: string }>
    dataOrigins: string[]
    liveDataGranted: boolean
  }
  bundle: { entry: string; entryHtml: string; replacements: Record<string, string> }
  context: {
    app: { id: string; key: string; name: string; version: string }
    user: { id: string; name: string }
  }
}

type FileRow = { path: string; kind: string; contentType: string; size: number; isBinary: boolean }
type RunRow = { endpoint: string; status: string; error: string | null; at: string }

function extensionsFor(path: string) {
  if (path.endsWith('.html')) return [html()]
  if (path.endsWith('.css')) return [css()]
  if (path.endsWith('.js') || path.endsWith('.mjs')) return [javascript()]
  if (path.endsWith('.json')) return [json()]
  return []
}

function fileSizeLabel(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`
  if (bytes < 1_048_576) return `${Math.max(0.1, bytes / 1_024).toFixed(1)} KB`
  return `${Math.max(0.1, bytes / 1_048_576).toFixed(1)} MB`
}

/** This conversation's live surface: the agent's sandboxed dashboard, rendered
 *  and editable in place. View is the thing itself, running opaque-origin with
 *  no ambient network — data arrives over governed bridge calls. Edit is the full
 *  management surface: files, settings and endpoints, and the backend run
 *  record with its errors. */
export function ChatDashboard({
  threadId,
  personName,
  summary,
}: {
  threadId: string
  personName: string
  summary: ChatDashboardSummary
}) {
  const [mode, setMode] = React.useState<'view' | 'edit'>('view')
  const [bundle, setBundle] = React.useState<BundleView | null>(null)
  const [bundleState, setBundleState] = React.useState<'loading' | 'ready' | 'empty' | 'error'>('loading')
  const [bundleError, setBundleError] = React.useState<string | null>(null)
  const [reloadToken, setReloadToken] = React.useState(0)
  const [editTab, setEditTab] = React.useState<'files' | 'settings' | 'runs'>('files')
  const [files, setFiles] = React.useState<FileRow[] | null>(null)
  const [filesToken, setFilesToken] = React.useState(0)
  const [selectedPath, setSelectedPath] = React.useState<string | null>(null)
  const [draft, setDraft] = React.useState<string | null>(null)
  const [baseline, setBaseline] = React.useState<string | null>(null)
  const [binarySelected, setBinarySelected] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [runs, setRuns] = React.useState<RunRow[] | null>(null)
  const [meta, setMeta] = React.useState<{ name: string; description: string; icon: string; dataOrigins: string[]; allowLiveData: boolean } | null>(null)
  const [endpoints, setEndpoints] = React.useState<Array<{ name: string; file: string; method: string }>>([])
  const [notice, setNotice] = React.useState<{ tone: 'ok' | 'error'; text: string } | null>(null)
  const [confirmDelete, setConfirmDelete] = React.useState(false)
  const [newPath, setNewPath] = React.useState('')
  const [provisioning, setProvisioning] = React.useState(false)

  // The bundle follows saves live: the freshness stamp rides the
  // work-surface poll, so the tab picks up the agent's (and the operator's)
  // latest the moment either lands. Chained like the surface poll itself, so
  // a slow read never queues behind itself.
  const freshness = summary.updatedAt
  React.useEffect(() => {
    let stopped = false
    const load = async () => {
      try {
        const found = await dashboardBundleAction(threadId)
        if (stopped) return
        if (!found) {
          setBundle(null)
          setBundleState('empty')
          return
        }
        setBundle(found)
        setBundleState('ready')
      } catch (reason) {
        if (stopped) return
        setBundle(null)
        setBundleError(reason instanceof Error ? reason.message : 'The dashboard could not be opened.')
        setBundleState('error')
      }
    }
    void load()
    return () => {
      stopped = true
    }
  }, [threadId, freshness, reloadToken])

  // Files and runs load when the management surface opens, and again after
  // every save — never on a timer, so an editor left open costs nothing.
  React.useEffect(() => {
    if (mode !== 'edit') return
    let stopped = false
    const load = async () => {
      try {
        const [found, runRows] = await Promise.all([dashboardFilesAction(threadId), dashboardRunsAction(threadId)])
        if (stopped) return
        setFiles(found?.files ?? [])
        setRuns(runRows)
      } catch {
        if (stopped) return
        setFiles([])
        setRuns([])
      }
    }
    void load()
    return () => {
      stopped = true
    }
  }, [mode, threadId, filesToken])

  // Which file the editor is pointed at right now. Reads are async, so a
  // save landing mid-fetch must not pour another file's content into the
  // draft — the ref says what is current, and stale arrivals are dropped.
  const selectionRef = React.useRef<string | null>(null)

  /** Open a file for editing: selection resets first, so a stale draft from
   *  another file can never be saved over this one. */
  const chooseFile = React.useCallback(async (path: string | null) => {
    selectionRef.current = path
    setSelectedPath(path)
    setDraft(null)
    setBaseline(null)
    setBinarySelected(false)
    setConfirmDelete(false)
    setNotice(null)
    if (!path) return
    const file = await dashboardFileAction(threadId, path)
    if (selectionRef.current !== path || !file) return
    if (file.isBinary) {
      setBinarySelected(true)
      return
    }
    setDraft(file.content)
    setBaseline(file.content)
  }, [threadId])

  const isDirty = baseline !== null && draft !== null && draft !== baseline

  const bridgeCall = React.useCallback(
    async (request: { method: string; payload: unknown }): Promise<unknown> =>
      dashboardBridgeAction({ threadId, method: request.method, payload: request.payload }),
    [threadId],
  )

  const enterEdit = React.useCallback(() => {
    // Entering edit starts clean: whatever the agent saved since the last
    // visit is fetched on click, never merged into an old draft.
    selectionRef.current = null
    setSelectedPath(null)
    setDraft(null)
    setBaseline(null)
    setBinarySelected(false)
    setConfirmDelete(false)
    setNotice(null)
    if (bundle) {
      setMeta({ name: bundle.app.name, description: bundle.app.description ?? '', icon: bundle.app.iconKey, dataOrigins: [...bundle.app.dataOrigins], allowLiveData: bundle.app.liveDataGranted })
      setEndpoints(bundle.app.endpoints.map((endpoint) => ({ name: endpoint.name, file: endpoint.file, method: endpoint.method })))
    }
    setMode('edit')
  }, [bundle])

  const saveFile = React.useCallback(async () => {
    if (!selectedPath || draft === null) return
    setSaving(true)
    setNotice(null)
    const result = await saveDashboardFileAction(threadId, selectedPath, draft)
    setSaving(false)
    if ('error' in result) {
      setNotice({ tone: 'error', text: result.error })
      return
    }
    setBaseline(draft)
    setNotice({ tone: 'ok', text: `${result.path} saved — the tab updates the moment anyone opens it.` })
    setFilesToken((token) => token + 1)
  }, [threadId, selectedPath, draft])

  const createFile = React.useCallback(async () => {
    const path = newPath.trim()
    if (!path) return
    setSaving(true)
    setNotice(null)
    const starter = path.endsWith('.css')
      ? '/* Dashboard styles — Canvas and CanvasText follow the operator\u2019s theme. */\n'
      : path.endsWith('.js')
        ? '// A dashboard script. Read conversation data with appkit.records.list; keep state in backend endpoints.\n'
        : '<!-- A dashboard fragment. Inline it from frontend/index.html or link it as an asset. -->\n'
    const result = await saveDashboardFileAction(threadId, path, starter)
    setSaving(false)
    if ('error' in result) {
      setNotice({ tone: 'error', text: result.error })
      return
    }
    setNewPath('')
    setFilesToken((token) => token + 1)
    await chooseFile(result.path)
  }, [threadId, newPath, chooseFile])

  const deleteFile = React.useCallback(async () => {
    if (!selectedPath) return
    if (!confirmDelete) {
      setConfirmDelete(true)
      return
    }
    const result = await deleteDashboardFileAction(threadId, selectedPath)
    if ('error' in result) {
      setNotice({ tone: 'error', text: result.error })
      return
    }
    const removed = selectedPath
    selectionRef.current = null
    setSelectedPath(null)
    setDraft(null)
    setBaseline(null)
    setBinarySelected(false)
    setConfirmDelete(false)
    setNotice({ tone: 'ok', text: `${removed} deleted.` })
    setFilesToken((token) => token + 1)
  }, [threadId, selectedPath, confirmDelete])

  const saveMeta = React.useCallback(async () => {
    if (!meta) return
    setSaving(true)
    setNotice(null)
    const result = await updateDashboardAction(threadId, {
      name: meta.name.trim() || undefined,
      description: meta.description.trim(),
      icon: meta.icon.trim() || undefined,
      dataOrigins: meta.dataOrigins.map((origin) => origin.trim()).filter(Boolean),
      allowLiveData: meta.allowLiveData,
      endpoints: endpoints
        .filter((endpoint) => endpoint.name.trim() && endpoint.file.trim())
        .map((endpoint) => ({ name: endpoint.name.trim(), file: endpoint.file.trim(), method: endpoint.method })),
    })
    setSaving(false)
    if ('error' in result) {
      setNotice({ tone: 'error', text: result.error })
      return
    }
    setNotice({ tone: 'ok', text: 'Dashboard settings saved.' })
    setReloadToken((token) => token + 1)
  }, [threadId, meta, endpoints])

  const provisionStarter = React.useCallback(async () => {
    setProvisioning(true)
    // Provisioning is the starter the agent would have grown from, so the
    // operator and the agent meet on the same files either way.
    try {
      const result = await ensureDashboardAction(threadId)
      if ('error' in result) throw new Error(result.error)
      setReloadToken((token) => token + 1)
    } catch (reason) {
      setBundleError(reason instanceof Error ? reason.message : 'The starter dashboard could not be built.')
      setBundleState('error')
    } finally {
      setProvisioning(false)
    }
  }, [threadId])

  if (bundleState === 'loading') {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-6">
        <Loader2 aria-label="Loading dashboard" className="size-5 animate-spin text-fg-muted" />
      </div>
    )
  }

  if (bundleState === 'error') {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-6">
        <EmptyState
          icon={<LayoutDashboard />}
          title="The dashboard could not be opened"
          description={bundleError ?? 'Try again in a moment.'}
          action={<Button type="button" variant="outline" size="sm" onClick={() => setReloadToken((token) => token + 1)}>Try again</Button>}
        />
      </div>
    )
  }

  if (bundleState === 'empty' || !bundle) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-6">
        <EmptyState
          icon={<LayoutDashboard />}
          title="No dashboard yet"
          description={`${personName} hasn't built this conversation's dashboard. Ask them in the chat — or start from a live starter showing messages, runs, files, and duties.`}
          action={(
            <Button type="button" variant="outline" size="sm" onClick={() => void provisionStarter()} disabled={provisioning}>
              {provisioning ? <Loader2 aria-hidden className="size-4 animate-spin" /> : <FilePlus2 aria-hidden className="size-4" />}
              {provisioning ? 'Building…' : 'Start from the live starter'}
            </Button>
          )}
        />
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border bg-surface px-3 py-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-fg">{bundle.app.name}</p>
          <p className="truncate text-xs text-fg-muted">
            {bundle.app.version ? `v${bundle.app.version} · ` : ''}Sandboxed · refreshes live
          </p>
        </div>
        <Badge variant={bundle.app.status === 'installed' ? 'success' : 'secondary'}>
          {bundle.app.status === 'installed' ? 'Live' : bundle.app.status}
        </Badge>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 px-2"
          onClick={() => setReloadToken((token) => token + 1)}
          aria-label="Reload dashboard"
          title="Reload dashboard"
        >
          <RefreshCw aria-hidden className="size-3.5" />
        </Button>
        <Button
          type="button"
          variant={mode === 'edit' ? 'secondary' : 'ghost'}
          size="sm"
          className="h-7 px-2"
          onClick={() => (mode === 'edit' ? setMode('view') : enterEdit())}
          aria-pressed={mode === 'edit'}
        >
          {mode === 'edit' ? <Eye aria-hidden className="size-3.5" /> : <Pencil aria-hidden className="size-3.5" />}
          {mode === 'edit' ? 'View' : 'Edit'}
        </Button>
      </div>

      {notice ? (
        <p className={`shrink-0 border-b border-border px-4 py-2 text-xs ${notice.tone === 'error' ? 'text-danger' : 'text-success'}`} role={notice.tone === 'error' ? 'alert' : 'status'}>
          {notice.text}
        </p>
      ) : null}

      {mode === 'view' ? (
        <div className="min-h-0 flex-1 overflow-hidden bg-bg-subtle">
          <AppFrame
            key={`${bundle.app.key}:${freshness ?? 'draft'}`}
            appKey={bundle.app.key}
            context={bundle.context}
            bundle={bundle.bundle}
            onBridgeCall={bridgeCall}
            title={`${bundle.app.name} dashboard`}
            className="size-full min-h-0"
          />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="shrink-0 border-b border-border px-2">
            <SubtabNav
              ariaLabel="Dashboard management"
              active={editTab}
              onSelect={(tab) => setEditTab(tab as typeof editTab)}
              tabs={[
                { key: 'files', label: <span className="flex items-center gap-1"><FileCode2 aria-hidden className="size-3.5" />Files</span> },
                { key: 'settings', label: <span className="flex items-center gap-1"><Settings2 aria-hidden className="size-3.5" />Settings</span> },
                { key: 'runs', label: <span className="flex items-center gap-1"><Activity aria-hidden className="size-3.5" />Runs</span> },
              ]}
            />
          </div>
          {editTab === 'files' ? (
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="app-scroll flex shrink-0 gap-1 overflow-x-auto border-b border-border p-2" role="listbox" aria-label="Dashboard files">
                {(files ?? []).map((file) => (
                  <Button
                    key={file.path}
                    type="button"
                    variant="ghost"
                    role="option"
                    aria-selected={selectedPath === file.path}
                    onClick={() => void chooseFile(file.path)}
                    className={`h-auto shrink-0 gap-1.5 px-2 py-1.5 font-mono text-xs ${selectedPath === file.path ? 'bg-primary-subtle text-primary hover:bg-primary-subtle/70 hover:text-primary' : 'text-fg-muted hover:text-fg'}`}
                    title={`${file.path} · ${fileSizeLabel(file.size)}`}
                  >
                    <FileCode2 aria-hidden className="size-3.5" />
                    {file.path.replace(/^(frontend|backend|assets)\//, '')}
                  </Button>
                ))}
                {files !== null && files.length === 0 ? (
                  <p className="px-2 py-1.5 text-xs text-fg-muted">No files yet.</p>
                ) : null}
              </div>
              <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
                <Input
                  aria-label="New file path"
                  placeholder="frontend/notes.html"
                  value={newPath}
                  onChange={(event) => setNewPath(event.target.value)}
                  className="h-7 font-mono text-xs"
                />
                <Button type="button" variant="ghost" size="sm" className="h-7 shrink-0 px-2" onClick={() => void createFile()} disabled={saving || !newPath.trim()}>
                  <Plus aria-hidden className="size-3.5" />New
                </Button>
              </div>
              <div className="min-h-0 flex-1 overflow-hidden">
                {selectedPath === null ? (
                  <div className="grid size-full place-items-center p-6 text-center text-sm text-fg-muted">
                    Choose a file to edit — or ask {personName} to build the dashboard and edit alongside them.
                  </div>
                ) : binarySelected ? (
                  <div className="grid size-full place-items-center p-6 text-center text-sm text-fg-muted">
                    Binary files preview in the dashboard itself; they cannot be edited as text.
                  </div>
                ) : draft === null ? (
                  <div className="grid size-full place-items-center"><Loader2 aria-label="Loading file" className="size-5 animate-spin text-fg-muted" /></div>
                ) : (
                  <CodeMirror
                    className="appkit-code-editor size-full text-sm"
                    value={draft}
                    extensions={extensionsFor(selectedPath)}
                    theme="dark"
                    height="100%"
                    basicSetup={{ lineNumbers: true, foldGutter: true, autocompletion: true }}
                    onChange={(value) => setDraft(value)}
                  />
                )}
              </div>
              <div className="flex shrink-0 items-center gap-2 border-t border-border px-3 py-2">
                <Button type="button" variant="ghost" size="sm" className="h-7 px-2" onClick={() => setMode('view')}>
                  <ArrowLeft aria-hidden className="size-3.5" />Back
                </Button>
                <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg-muted">
                  {selectedPath ?? 'No file selected'}{isDirty ? ' · unsaved changes' : ''}
                </span>
                {selectedPath ? (
                  <Button
                    type="button"
                    variant={confirmDelete ? 'destructive' : 'ghost'}
                    size="sm"
                    className="h-7 px-2"
                    onClick={() => void deleteFile()}
                    aria-label={confirmDelete ? `Confirm deletion of ${selectedPath}` : `Delete ${selectedPath}`}
                  >
                    <Trash2 aria-hidden className="size-3.5" />
                    {confirmDelete ? 'Confirm' : null}
                  </Button>
                ) : null}
                <Button type="button" variant="outline" size="sm" className="h-7 px-2" onClick={() => void saveFile()} disabled={saving || !isDirty}>
                  {saving ? <Loader2 aria-hidden className="size-3.5 animate-spin" /> : <Save aria-hidden className="size-3.5" />}
                  Save
                </Button>
              </div>
            </div>
          ) : editTab === 'settings' ? (
            <div className="app-scroll min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
              <div className="space-y-2">
                <label className="block text-xs font-semibold text-fg" htmlFor="dashboard-name">Name</label>
                <Input id="dashboard-name" value={meta?.name ?? ''} onChange={(event) => setMeta((current) => current ? { ...current, name: event.target.value } : current)} className="h-8" />
              </div>
              <div className="space-y-2">
                <label className="block text-xs font-semibold text-fg" htmlFor="dashboard-description">Description</label>
                <Input id="dashboard-description" value={meta?.description ?? ''} onChange={(event) => setMeta((current) => current ? { ...current, description: event.target.value } : current)} className="h-8" />
              </div>
              <div className="space-y-2">
                <label className="block text-xs font-semibold text-fg" htmlFor="dashboard-icon">Icon</label>
                <Input id="dashboard-icon" value={meta?.icon ?? ''} onChange={(event) => setMeta((current) => current ? { ...current, icon: event.target.value } : current)} className="h-8" />
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <span className="text-xs font-semibold text-fg">Live public data</span>
                    <p className="mt-1 text-xs leading-relaxed text-fg-muted">Dashboard JavaScript can poll its backend, which may request only these exact HTTPS origins.</p>
                  </div>
                  <Button type="button" variant="ghost" size="sm" className="h-7 shrink-0 px-2" onClick={() => setMeta((current) => current ? { ...current, dataOrigins: [...current.dataOrigins, 'https://'] } : current)}>
                    <Plus aria-hidden className="size-3.5" />Add source
                  </Button>
                </div>
                {meta?.dataOrigins.length ? (
                  <ul className="space-y-2">
                    {meta.dataOrigins.map((origin, index) => (
                      <li key={index} className="flex items-center gap-2">
                        <Input aria-label={`Public data source ${index + 1}`} placeholder="https://api.example.com" value={origin} onChange={(event) => setMeta((current) => current ? { ...current, dataOrigins: current.dataOrigins.map((candidate, candidateIndex) => candidateIndex === index ? event.target.value : candidate) } : current)} className="h-7 font-mono text-xs" />
                        <Button type="button" variant="ghost" size="icon" className="size-7 shrink-0" aria-label={`Remove public data source ${index + 1}`} onClick={() => setMeta((current) => current ? { ...current, dataOrigins: current.dataOrigins.filter((_, candidateIndex) => candidateIndex !== index), allowLiveData: current.dataOrigins.length > 1 && current.allowLiveData } : current)}>
                          <Trash2 aria-hidden className="size-3.5" />
                        </Button>
                      </li>
                    ))}
                  </ul>
                ) : <p className="text-xs text-fg-muted">No public data sources declared.</p>}
                <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-bg-subtle p-3">
                  <div>
                    <p className="text-xs font-medium text-fg">Allow live public-data requests</p>
                    <p className="mt-0.5 text-xs text-fg-muted">Backend requests stay bounded and limited to the declared origins.</p>
                  </div>
                  <Switch checked={meta?.allowLiveData ?? false} disabled={!meta?.dataOrigins.some((origin) => origin.trim() && origin.trim() !== 'https://')} onChange={(event) => setMeta((current) => current ? { ...current, allowLiveData: event.target.checked } : current)} aria-label="Allow live public-data requests" />
                </div>
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-fg">Backend endpoints</span>
                  <Button type="button" variant="ghost" size="sm" className="h-7 px-2" onClick={() => setEndpoints((current) => [...current, { name: '', file: 'backend/', method: 'POST' }])}>
                    <Plus aria-hidden className="size-3.5" />Add
                  </Button>
                </div>
                {endpoints.length === 0 ? (
                  <p className="text-xs text-fg-muted">No endpoints. The frontend reads conversation data over the bridge; add an endpoint when it needs its own state or computation.</p>
                ) : (
                  <ul className="space-y-2">
                    {endpoints.map((endpoint, index) => (
                      <li key={index} className="flex items-center gap-2">
                        <Input aria-label="Endpoint name" placeholder="stats" value={endpoint.name} onChange={(event) => setEndpoints((current) => current.map((candidate, candidateIndex) => candidateIndex === index ? { ...candidate, name: event.target.value } : candidate))} className="h-7 font-mono text-xs" />
                        <Input aria-label="Endpoint file" placeholder="backend/stats.js" value={endpoint.file} onChange={(event) => setEndpoints((current) => current.map((candidate, candidateIndex) => candidateIndex === index ? { ...candidate, file: event.target.value } : candidate))} className="h-7 font-mono text-xs" />
                        <Button type="button" variant="ghost" size="icon" className="size-7 shrink-0" aria-label={`Remove endpoint ${endpoint.name || index + 1}`} onClick={() => setEndpoints((current) => current.filter((_, candidateIndex) => candidateIndex !== index))}>
                          <Trash2 aria-hidden className="size-3.5" />
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div className="rounded-lg border border-border bg-bg-subtle p-3 text-xs leading-relaxed text-fg-muted">
                Conversation records are read-only. Live public-data access requires exact HTTPS origins and this operator grant; the iframe itself has no ambient network.
              </div>
              <div>
                <Button type="button" variant="outline" size="sm" onClick={() => void saveMeta()} disabled={saving}>
                  {saving ? <Loader2 aria-hidden className="size-3.5 animate-spin" /> : <Save aria-hidden className="size-3.5" />}
                  Save settings
                </Button>
              </div>
            </div>
          ) : (
            <div className="app-scroll min-h-0 flex-1 overflow-y-auto p-3">
              <div className="mb-2 flex items-center justify-between">
                <p className="text-xs text-fg-muted">Every backend call the dashboard has made, newest first.</p>
                <Button type="button" variant="ghost" size="sm" className="h-7 px-2" onClick={() => setFilesToken((token) => token + 1)}>
                  <RefreshCw aria-hidden className="size-3.5" />Refresh
                </Button>
              </div>
              {runs === null ? (
                <div className="grid place-items-center py-8"><Loader2 aria-label="Loading runs" className="size-5 animate-spin text-fg-muted" /></div>
              ) : runs.length === 0 ? (
                <div className="grid place-items-center px-6 py-8 text-center text-sm text-fg-muted">
                  No backend calls yet. The frontend reads conversation data directly; calls appear here once it uses an endpoint.
                </div>
              ) : (
                <ol className="space-y-1.5">
                  {runs.map((run, index) => (
                    <li key={`${run.endpoint}:${run.at}:${index}`} className="flex items-start gap-2 rounded-md border border-border-subtle px-2.5 py-2 text-xs">
                      {run.status === 'ok'
                        ? <CheckCircle2 aria-hidden className="mt-0.5 size-3.5 shrink-0 text-success" />
                        : <Activity aria-hidden className="mt-0.5 size-3.5 shrink-0 text-danger" />}
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-mono font-medium text-fg">{run.endpoint}</span>
                        {run.error ? <span className="block truncate text-danger">{run.error}</span> : null}
                        <span className="block text-fg-subtle">{new Date(run.at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })} · {run.status}</span>
                      </span>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
