'use client'

import * as React from 'react'
import {
  Badge,
  Button,
  Checkbox,
  EmptyState,
  Input,
  Label,
  PagedTable,
  Select,
  SettingsRow,
  SettingsSection,
  Switch,
  type PagedColumn,
} from '@appkit/ui'
import {
  disconnectFilingTargetAction,
  checkFilingDirectoryAction,
  removeFilingAppAction,
  saveFilingAppAction,
  saveFilingDirectoryAction,
  saveFilingOptionsAction,
} from '../app/admin/settings/filing-actions'

/**
 * Settings → Filing. Deliverables always land in the company file record and
 * in the recipient's inbox; filing puts a copy where the company already keeps
 * its paperwork. The copy is best-effort on purpose — every attempt, including
 * every failure, shows up in the activity list at the bottom of this screen.
 */

export type FilingFileKindView = 'document' | 'spreadsheet' | 'attachment'
export type FilingLayoutView = 'flat' | 'agent' | 'month'
export type FilingProviderView = 'google_drive' | 'onedrive' | 'smb'

export type FilingSettingsView = {
  enabled: boolean
  kinds: FilingFileKindView[]
  layout: FilingLayoutView
  target: { provider: FilingProviderView; label: string; detail: string; account: string | null } | null
  apps: { provider: 'google_drive' | 'onedrive'; label: string; clientId: string; directory: string | null }[]
  redirectUri: string
}

export type FilingActivityRow = {
  id: string
  fileId: string
  file: string
  status: 'filed' | 'failed'
  destination: string
  detail: string
  when: string
}

const KIND_LABELS: { value: FilingFileKindView; label: string; hint: string }[] = [
  { value: 'document', label: 'Documents', hint: '.docx and .pdf an agent produced' },
  { value: 'spreadsheet', label: 'Spreadsheets', hint: '.xlsx an agent produced' },
  { value: 'attachment', label: 'Mail attachments', hint: 'Files people send your agents' },
]

const LAYOUTS: { value: FilingLayoutView; label: string }[] = [
  { value: 'flat', label: 'Everything in one folder' },
  { value: 'agent', label: 'A subfolder per agent' },
  { value: 'month', label: 'A subfolder per month' },
]

const ACTIVITY_COLUMNS: PagedColumn<FilingActivityRow>[] = [
  {
    key: 'file',
    header: 'File',
    cell: (row) => (
      <a href={`/api/files/${row.fileId}`} className="font-medium text-primary hover:underline">
        {row.file}
      </a>
    ),
    search: (row) => row.file,
    sortValue: (row) => row.file,
  },
  {
    key: 'status',
    header: 'Result',
    cell: (row) => <Badge variant={row.status === 'filed' ? 'default' : 'destructive'}>{row.status}</Badge>,
    search: (row) => row.status,
    sortValue: (row) => row.status,
  },
  {
    key: 'destination',
    header: 'Destination',
    cell: (row) => row.destination,
    search: (row) => row.destination,
    sortValue: (row) => row.destination,
  },
  {
    key: 'detail',
    header: 'Location or reason',
    cell: (row) => <span className="block max-w-md truncate">{row.detail}</span>,
    search: (row) => row.detail,
  },
  { key: 'when', header: 'When', cell: (row) => row.when, sortValue: (row) => row.when },
]

const PROVIDER_LABELS: Record<FilingProviderView, string> = {
  google_drive: 'Google Drive',
  onedrive: 'OneDrive / SharePoint',
  smb: 'Server folder (SMB / NAS)',
}

export function FilingSection({
  settings,
  activity,
  notice,
  error,
}: {
  settings: FilingSettingsView
  activity: FilingActivityRow[]
  notice?: string
  error?: string
}) {
  const [enabled, setEnabled] = React.useState(settings.enabled)
  const [kinds, setKinds] = React.useState<FilingFileKindView[]>(settings.kinds)
  const [layout, setLayout] = React.useState<FilingLayoutView>(settings.layout)
  const [choice, setChoice] = React.useState<FilingProviderView>(settings.target?.provider ?? 'google_drive')
  const [clientId, setClientId] = React.useState('')
  const [clientSecret, setClientSecret] = React.useState('')
  const [directory, setDirectory] = React.useState('common')
  const [folderName, setFolderName] = React.useState('Bunkhouse deliverables')
  const [driveId, setDriveId] = React.useState('')
  const [basePath, setBasePath] = React.useState('')
  const [localNotice, setLocalNotice] = React.useState<string | null>(null)
  const [localError, setLocalError] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)

  const oauthProvider = choice === 'smb' ? null : choice
  const registered = oauthProvider ? settings.apps.find((app) => app.provider === oauthProvider) : undefined

  const run = async (work: () => Promise<{ ok: true } | { ok: false; message: string }>, done: string) => {
    setBusy(true)
    setLocalError(null)
    setLocalNotice(null)
    const result = await work()
    setBusy(false)
    if (result.ok) setLocalNotice(done)
    else setLocalError(result.message)
  }

  const toggleKind = (kind: FilingFileKindView) =>
    setKinds((prev) => (prev.includes(kind) ? prev.filter((value) => value !== kind) : [...prev, kind]))

  const connect = () => {
    if (!oauthProvider) return
    const params = new URLSearchParams({ provider: oauthProvider, folder: folderName.trim() })
    if (oauthProvider === 'onedrive' && driveId.trim()) params.set('driveId', driveId.trim())
    window.location.assign(`/api/filing-oauth/start?${params.toString()}`)
  }

  return (
    <div className="space-y-6">
      <SettingsSection
        title="Filing"
        description="Every file your agents produce is kept in the company file record and attached to the email that delivers it. Turn filing on to also write a copy into your own storage — Google Drive, OneDrive or SharePoint, or a folder on your file server."
      >
        {settings.target ? (
          <SettingsRow
            title={settings.target.label}
            description={
              settings.target.account
                ? `${settings.target.detail} · connected as ${settings.target.account}`
                : settings.target.detail
            }
            control={
              <span className="flex items-center gap-2">
                <Badge variant={settings.enabled ? 'default' : 'outline'}>
                  {settings.enabled ? 'filing' : 'paused'}
                </Badge>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => run(disconnectFilingTargetAction, 'Disconnected. Files stay in the company record.')}
                >
                  Disconnect
                </Button>
              </span>
            }
          />
        ) : (
          <SettingsRow
            title="Not connected"
            description="Files are kept in the company file record and delivered by email. Connect a destination below to keep a copy in your own storage as well."
            control={<Badge variant="outline">off</Badge>}
          />
        )}

        <SettingsRow title="What gets copied" stacked>
          <div className="flex items-center gap-3">
            <Switch
              id="filing-enabled"
              checked={enabled}
              disabled={!settings.target}
              onChange={(event) => setEnabled(event.target.checked)}
            />
            <Label htmlFor="filing-enabled">
              {settings.target ? 'File a copy of each new file' : 'Connect a destination first'}
            </Label>
          </div>
          <div className="mt-3 space-y-2">
            {KIND_LABELS.map((kind) => (
              <div key={kind.value} className="flex items-start gap-3">
                <Checkbox
                  id={`filing-kind-${kind.value}`}
                  checked={kinds.includes(kind.value)}
                  onChange={() => toggleKind(kind.value)}
                />
                <div>
                  <Label htmlFor={`filing-kind-${kind.value}`}>{kind.label}</Label>
                  <p className="text-xs text-fg-muted">{kind.hint}</p>
                </div>
              </div>
            ))}
          </div>
          <div className="mt-3 space-y-1 sm:max-w-sm">
            <Label htmlFor="filing-layout">Folder layout</Label>
            <Select
              id="filing-layout"
              value={layout}
              onChange={(event) => setLayout(event.target.value as FilingLayoutView)}
            >
              {LAYOUTS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </div>
          <div className="mt-3 flex items-center gap-3">
            <Button
              disabled={busy}
              onClick={() =>
                run(
                  () => saveFilingOptionsAction({ enabled, kinds, layout }),
                  enabled ? 'Saved. New files are copied to your storage.' : 'Saved. Nothing is copied out.',
                )
              }
            >
              Save filing settings
            </Button>
          </div>
        </SettingsRow>
      </SettingsSection>

      <SettingsSection
        title="Destination"
        description="One destination at a time. Connecting a new one replaces the old; nothing already filed is touched."
      >
        <SettingsRow title="Where files are filed" stacked>
          <div className="space-y-1 sm:max-w-sm">
            <Label htmlFor="filing-provider">Storage</Label>
            <Select
              id="filing-provider"
              value={choice}
              onChange={(event) => setChoice(event.target.value as FilingProviderView)}
            >
              {(Object.keys(PROVIDER_LABELS) as FilingProviderView[]).map((provider) => (
                <option key={provider} value={provider}>
                  {PROVIDER_LABELS[provider]}
                </option>
              ))}
            </Select>
          </div>
        </SettingsRow>

        {oauthProvider ? (
          <>
            <SettingsRow
              title={`${PROVIDER_LABELS[oauthProvider]} application`}
              description="Your company registers its own application once, exactly as it does for mailboxes. The client secret is sealed at rest and only unsealed for a token exchange."
              stacked
            >
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor="filing-client-id">Application (client) ID</Label>
                  <Input
                    id="filing-client-id"
                    value={clientId}
                    onChange={(event) => setClientId(event.target.value)}
                    placeholder={registered ? registered.clientId : 'From the provider console'}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="filing-client-secret">Client secret</Label>
                  <Input
                    id="filing-client-secret"
                    type="password"
                    value={clientSecret}
                    onChange={(event) => setClientSecret(event.target.value)}
                    placeholder="Stored sealed"
                  />
                </div>
                {oauthProvider === 'onedrive' ? (
                  <div className="space-y-1">
                    <Label htmlFor="filing-directory">Microsoft directory</Label>
                    <Input
                      id="filing-directory"
                      value={directory}
                      onChange={(event) => setDirectory(event.target.value)}
                      placeholder="common, or your directory (tenant) ID"
                    />
                  </div>
                ) : null}
                <div className="space-y-1 sm:col-span-2">
                  <Label htmlFor="filing-redirect">Redirect URI to register</Label>
                  <Input id="filing-redirect" value={settings.redirectUri} readOnly />
                </div>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <Button
                  disabled={busy || !clientId.trim() || !clientSecret.trim()}
                  onClick={() =>
                    run(
                      () =>
                        saveFilingAppAction({
                          provider: oauthProvider,
                          clientId,
                          clientSecret,
                          ...(oauthProvider === 'onedrive' ? { directory } : {}),
                        }),
                      'Application saved. Connect the account below.',
                    ).then(() => setClientSecret(''))
                  }
                >
                  Save application
                </Button>
                {registered ? (
                  <>
                    <Badge variant="secondary">secret sealed</Badge>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        run(() => removeFilingAppAction({ provider: oauthProvider }), 'Application removed.')
                      }
                    >
                      Remove application
                    </Button>
                  </>
                ) : null}
              </div>
            </SettingsRow>

            <SettingsRow
              title="Connect the account"
              description={
                oauthProvider === 'google_drive'
                  ? 'Bunkhouse creates the folder below and can only see what it puts there — the narrowest access Google offers.'
                  : 'Bunkhouse creates the folder below in OneDrive, or in the SharePoint document library you name.'
              }
              stacked
            >
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor="filing-folder">Destination folder</Label>
                  <Input
                    id="filing-folder"
                    value={folderName}
                    onChange={(event) => setFolderName(event.target.value)}
                    placeholder="Bunkhouse deliverables"
                  />
                </div>
                {oauthProvider === 'onedrive' ? (
                  <div className="space-y-1">
                    <Label htmlFor="filing-drive">SharePoint library ID (optional)</Label>
                    <Input
                      id="filing-drive"
                      value={driveId}
                      onChange={(event) => setDriveId(event.target.value)}
                      placeholder="Leave empty to use the account's OneDrive"
                    />
                  </div>
                ) : null}
              </div>
              <div className="mt-3">
                <Button disabled={busy || !registered || !folderName.trim()} onClick={connect}>
                  {registered ? `Connect ${PROVIDER_LABELS[oauthProvider]}` : 'Save the application first'}
                </Button>
              </div>
            </SettingsRow>
          </>
        ) : (
          <SettingsRow
            title="Server folder"
            description="Mount the share into the application container (a Windows share, a NAS export, any path the server can see) and give the folder path as the server sees it. The folder is tested for a real write before it is saved."
            stacked
          >
            <div className="space-y-1">
              <Label htmlFor="filing-path">Folder path</Label>
              <Input
                id="filing-path"
                value={basePath}
                onChange={(event) => setBasePath(event.target.value)}
                placeholder="/mnt/company-files/deliverables"
              />
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <Button
                variant="outline"
                disabled={busy || !basePath.trim()}
                onClick={() =>
                  run(() => checkFilingDirectoryAction({ basePath }), 'That folder exists and is writable.')
                }
              >
                Check the folder
              </Button>
              <Button
                disabled={busy || !basePath.trim()}
                onClick={() =>
                  run(() => saveFilingDirectoryAction({ basePath }), 'Connected. New files are copied to that folder.')
                }
              >
                Use this folder
              </Button>
            </div>
          </SettingsRow>
        )}

        {localNotice || notice ? <p className="text-sm text-fg-muted">{localNotice ?? notice}</p> : null}
        {localError || error ? <p className="text-sm text-danger">{localError ?? error}</p> : null}
      </SettingsSection>

      <SettingsSection
        title="Filing activity"
        description="The last copies attempted. Filing never holds a deliverable back, so a failure here means the file is still in the company record and still went out by email — it just did not reach your storage."
      >
        <div className="px-5 py-4">
          <PagedTable
            columns={ACTIVITY_COLUMNS}
            rows={activity}
            rowKey={(row) => row.id}
            pageSize={10}
            searchable
            defaultSort={{ key: 'when', dir: 'desc' }}
            labels={{ searchPlaceholder: 'Search filing activity…', searchLabel: 'Search filing activity' }}
            empty={
              <EmptyState
                title="Nothing filed yet"
                description="Once filing is on, every copy — successful or not — is recorded here."
              />
            }
          />
        </div>
      </SettingsSection>
    </div>
  )
}
