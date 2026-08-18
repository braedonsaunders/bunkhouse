'use client'

import * as React from 'react'
import {
  Badge,
  Button,
  Drawer,
  EmptyState,
  Input,
  Label,
  RecordList,
  Select,
  SettingsRow,
  SettingsSection,
  type RecordColumn,
} from '@braedonsaunders/appkit-ui'
import { REMOTE_PROTOCOLS, type RemoteProtocol } from '@braedonsaunders/appkit-remote-sessions'
import {
  disableRemoteComputerAction,
  saveRemoteComputerAction,
  testRemoteComputerAction,
} from '../app/admin/settings/actions'

export type RemoteComputerRow = {
  id: string
  name: string
  host: string
  port: number
  protocol: RemoteProtocol
  providerBaseUrl: string
  providerTargetId: string
  status: 'ready' | 'unreachable' | 'disabled'
  lastConnectedAt: string
  lastError: string
}

const COLUMNS: RecordColumn<RemoteComputerRow>[] = [
  { key: 'name', label: 'Computer', kind: 'reference', sortable: true },
  { key: 'protocol', label: 'Access', sortable: true },
  { key: 'host', label: 'Address', sortable: true },
  { key: 'status', label: 'Status', kind: 'status', sortable: true },
  { key: 'lastConnectedAt', label: 'Last reached', sortable: true },
]

const LABELS: Record<RemoteProtocol, string> = {
  rdp: 'Remote Desktop (RDP)',
  vnc: 'VNC',
  ssh: 'SSH',
  winrm: 'Windows Remote Management',
  'powershell-ssh': 'PowerShell over SSH',
  telnet: 'Telnet',
}

function emptyDraft(): Omit<RemoteComputerRow, 'id' | 'status' | 'lastConnectedAt' | 'lastError'> & { token: string } {
  return { name: '', host: '', port: 3389, protocol: 'rdp', providerBaseUrl: '', providerTargetId: '', token: '' }
}

export function RemoteComputersSettings({ rows, enabled }: { rows: RemoteComputerRow[]; enabled: boolean }) {
  const [selectedId, setSelectedId] = React.useState<string | null>(null)
  const [creating, setCreating] = React.useState(false)
  const [draft, setDraft] = React.useState(emptyDraft)
  const [error, setError] = React.useState<string | null>(null)
  const [notice, setNotice] = React.useState<string | null>(null)
  const [busy, startTransition] = React.useTransition()
  const selected = rows.find((row) => row.id === selectedId) ?? null

  const close = () => {
    setCreating(false)
    setSelectedId(null)
    setError(null)
    setNotice(null)
  }

  return (
    <SettingsSection
      title="Remote computers"
      description="Customer-owned Windows, macOS, and Linux computers agents can work on through Steward. Every connection, handover, terminal command, and close is retained with its run."
    >
      <SettingsRow
        title={`${rows.length} connected computer${rows.length === 1 ? '' : 's'}`}
        description="Open a row to test, rotate its credential, or disable future access."
        control={<Button size="sm" disabled={!enabled} onClick={() => { setDraft(emptyDraft()); setCreating(true); setSelectedId(null) }}>Connect computer</Button>}
      />
      {!enabled ? (
        <div className="border-b border-border px-5 py-3 text-sm text-fg-muted">
          Remote computers are off. Turn the capability on under Features to make saved computers available to agents; history is preserved.
        </div>
      ) : null}
      <div className="px-5 py-4">
        {rows.length ? (
          <RecordList
            columns={COLUMNS}
            rows={rows}
            getRowId={(row) => row.id}
            onRowClick={(row) => { setDraft({ ...row, token: '' }); setSelectedId(row.id); setCreating(false) }}
            empty={{ title: 'No remote computers', description: 'Connect a customer-owned computer through Steward.' }}
          />
        ) : (
          <EmptyState
            title="No remote computers"
            description="Connect Steward once, then agents can use a real customer computer alongside their Bunkhouse desk."
            action={enabled ? <Button size="sm" onClick={() => { setDraft(emptyDraft()); setCreating(true) }}>Connect computer</Button> : undefined}
          />
        )}
      </div>

      <Drawer
        open={creating || selected !== null}
        onClose={close}
        title={creating ? 'Connect a remote computer' : selected?.name ?? ''}
        description="Steward keeps credentials and device access outside the agent prompt. Bunkhouse stores the token sealed and issues short-lived viewer access."
        size="md"
      >
        <div className="space-y-4">
          {selected ? (
            <div className="flex items-center justify-between rounded-md border border-border px-3 py-2 text-sm">
              <span className="flex items-center gap-2">
                <Badge variant={selected.status === 'ready' ? 'default' : selected.status === 'unreachable' ? 'destructive' : 'outline'}>{selected.status}</Badge>
                <span className="text-fg-muted">{selected.lastConnectedAt || 'Not reached yet'}</span>
              </span>
              <Button
                size="sm"
                variant="outline"
                disabled={busy || selected.status === 'disabled'}
                onClick={() => startTransition(async () => {
                  setError(null)
                  const result = await testRemoteComputerAction(selected.id)
                  if (!result.ok) setError(result.message)
                  else setNotice('Steward reached this computer successfully.')
                })}
              >Test connection</Button>
            </div>
          ) : null}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name"><Input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="Front desk PC" /></Field>
            <Field label="Protocol">
              <Select value={draft.protocol} onChange={(event) => {
                const protocol = event.target.value as RemoteProtocol
                setDraft({ ...draft, protocol, port: protocol === 'rdp' ? 3389 : protocol === 'ssh' || protocol === 'powershell-ssh' ? 22 : protocol === 'vnc' ? 5900 : draft.port })
              }}>
                {REMOTE_PROTOCOLS.map((protocol) => <option key={protocol} value={protocol}>{LABELS[protocol]}</option>)}
              </Select>
            </Field>
            <Field label="Computer address"><Input value={draft.host} onChange={(event) => setDraft({ ...draft, host: event.target.value })} placeholder="10.0.0.24" /></Field>
            <Field label="Port"><Input type="number" min={1} max={65535} value={draft.port} onChange={(event) => setDraft({ ...draft, port: Number(event.target.value) })} /></Field>
            <div className="sm:col-span-2"><Field label="Steward URL"><Input value={draft.providerBaseUrl} onChange={(event) => setDraft({ ...draft, providerBaseUrl: event.target.value })} placeholder="https://steward.example.com" /></Field></div>
            <Field label="Steward device ID"><Input value={draft.providerTargetId} onChange={(event) => setDraft({ ...draft, providerTargetId: event.target.value })} /></Field>
            <Field label={selected ? 'Replace Steward token' : 'Steward API token'}><Input type="password" value={draft.token} onChange={(event) => setDraft({ ...draft, token: event.target.value })} placeholder={selected ? 'Leave blank to keep current token' : 'Paste token'} /></Field>
          </div>
          {selected?.lastError ? <p className="text-sm text-danger">Last error: {selected.lastError}</p> : null}
          {error ? <p className="text-sm text-danger">{error}</p> : null}
          {notice ? <p className="text-sm text-success">{notice}</p> : null}
          <div className="flex items-center justify-between gap-3 border-t border-border pt-4">
            <span>
              {selected && selected.status !== 'disabled' ? (
                <Button variant="outline" disabled={busy} onClick={() => startTransition(async () => {
                  const result = await disableRemoteComputerAction(selected.id)
                  if (!result.ok) setError(result.message)
                  else close()
                })}>Disable</Button>
              ) : null}
            </span>
            <div className="flex gap-2">
              <Button variant="outline" onClick={close}>Cancel</Button>
              <Button disabled={busy || !draft.name.trim() || !draft.host.trim() || !draft.providerBaseUrl.trim() || !draft.providerTargetId.trim() || (creating && !draft.token.trim())} onClick={() => startTransition(async () => {
                setError(null)
                const result = await saveRemoteComputerAction({
                  ...(selected ? { id: selected.id } : {}), name: draft.name, host: draft.host, port: draft.port,
                  protocol: draft.protocol, providerBaseUrl: draft.providerBaseUrl, providerTargetId: draft.providerTargetId,
                  ...(draft.token.trim() ? { providerToken: draft.token } : {}), enabled: true,
                })
                if (!result.ok) setError(result.message)
                else close()
              })}>Save computer</Button>
            </div>
          </div>
        </div>
      </Drawer>
    </SettingsSection>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="space-y-2"><Label>{label}</Label>{children}</div>
}
