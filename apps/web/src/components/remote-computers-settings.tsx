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
  type RecordColumn,
} from '@braedonsaunders/appkit-ui'
import { REMOTE_PROTOCOLS, type RemoteProtocol } from '@braedonsaunders/appkit-remote-sessions'
import {
  disableRemoteComputerAction,
  saveRemoteComputerAction,
  testRemoteComputerAction,
} from '../app/resources/remote-computer-actions'

export type RemoteComputerRow = {
  id: string
  name: string
  host: string
  port: number
  protocol: RemoteProtocol
  username: string
  domain: string
  credentialKind: 'password' | 'private_key'
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

function emptyDraft(): Omit<RemoteComputerRow, 'id' | 'status' | 'lastConnectedAt' | 'lastError'> & { credential: string } {
  return { name: '', host: '', port: 3389, protocol: 'rdp', username: '', domain: '', credentialKind: 'password', credential: '' }
}

export function RemoteComputersView({ rows, enabled }: { rows: RemoteComputerRow[]; enabled: boolean }) {
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
    <section className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-3xl space-y-1">
          <h2 className="text-base font-semibold text-fg">Remote computers</h2>
          <p className="text-sm text-fg-muted">
            Customer-owned Windows, macOS, and Linux computers agents can work on. Every connection, handover,
            terminal command, and close stays with its run.
          </p>
        </div>
        <Button size="sm" disabled={!enabled} onClick={() => { setDraft(emptyDraft()); setCreating(true); setSelectedId(null) }}>Connect computer</Button>
      </div>
      {!enabled ? (
        <div className="rounded-md border border-border bg-bg-subtle px-4 py-3 text-sm text-fg-muted">
          Remote computers are off. Turn the capability on under Company Settings → Features to make saved
          computers available to agents; their records and history are preserved.
        </div>
      ) : null}
      <div>
        {rows.length ? (
          <RecordList
            columns={COLUMNS}
            rows={rows}
            getRowId={(row) => row.id}
            onRowClick={(row) => { setDraft({ ...row, credential: '' }); setSelectedId(row.id); setCreating(false) }}
            empty={{ title: 'No remote computers', description: 'Connect a customer-owned computer.' }}
          />
        ) : (
          <EmptyState
            title="No remote computers"
            description="Connect a computer once, then agents can use it alongside their own Bunkhouse desk."
            action={enabled ? <Button size="sm" onClick={() => { setDraft(emptyDraft()); setCreating(true) }}>Connect computer</Button> : undefined}
          />
        )}
      </div>

      <Drawer
        open={creating || selected !== null}
        onClose={close}
        title={creating ? 'Connect a remote computer' : selected?.name ?? ''}
        description="Bunkhouse seals the computer credential and exchanges only short-lived viewer access. Credentials never enter the agent prompt."
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
                  else setNotice('Bunkhouse reached this computer successfully.')
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
            <Field label="Username"><Input autoComplete="off" value={draft.username} onChange={(event) => setDraft({ ...draft, username: event.target.value })} placeholder="operator" /></Field>
            <Field label="Domain"><Input value={draft.domain} onChange={(event) => setDraft({ ...draft, domain: event.target.value })} placeholder="Optional Windows domain" /></Field>
            <Field label="Credential type">
              <Select value={draft.credentialKind} onChange={(event) => setDraft({ ...draft, credentialKind: event.target.value as 'password' | 'private_key' })}>
                <option value="password">Password</option>
                <option value="private_key">Private key</option>
              </Select>
            </Field>
            <Field label={selected ? 'Replace credential' : draft.credentialKind === 'private_key' ? 'Private key' : 'Password'}>
              <Input type="password" autoComplete="new-password" value={draft.credential} onChange={(event) => setDraft({ ...draft, credential: event.target.value })} placeholder={selected ? 'Leave blank to keep current credential' : draft.credentialKind === 'private_key' ? 'Paste private key' : 'Enter password'} />
            </Field>
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
              <Button disabled={busy || !draft.name.trim() || !draft.host.trim() || (creating && !draft.credential.trim())} onClick={() => startTransition(async () => {
                setError(null)
                const result = await saveRemoteComputerAction({
                  ...(selected ? { id: selected.id } : {}), name: draft.name, host: draft.host, port: draft.port,
                  protocol: draft.protocol, username: draft.username, domain: draft.domain, credentialKind: draft.credentialKind,
                  ...(draft.credential.trim() ? { credential: draft.credential } : {}), enabled: true,
                })
                if (!result.ok) setError(result.message)
                else close()
              })}>Save computer</Button>
            </div>
          </div>
        </div>
      </Drawer>
    </section>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="space-y-2"><Label>{label}</Label>{children}</div>
}
