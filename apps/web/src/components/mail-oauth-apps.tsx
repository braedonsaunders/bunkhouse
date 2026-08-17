'use client'

import * as React from 'react'
import { Badge, Button, Drawer, Input, Label, SettingsRow } from '@braedonsaunders/appkit-ui'
import { removeMailOauthAppAction, saveMailOauthAppAction } from '../app/admin/settings/actions'

export type MailOauthAppView = {
  provider: 'google' | 'microsoft'
  label: string
  clientId: string
  /** Microsoft only: the Entra directory the application is registered in. */
  directory: string | null
}

type ProviderCopy = {
  provider: 'google' | 'microsoft'
  label: string
  /** What connecting this gives the company, in their terms. */
  line: string
  consoleUrl: string
  consoleLabel: string
  clientIdLabel: string
  clientIdPlaceholder: string
}

const PROVIDERS: ProviderCopy[] = [
  {
    provider: 'google',
    label: 'Google Workspace',
    line: 'Lets an agent sign in to its Gmail address instead of holding an app password.',
    consoleUrl: 'https://console.cloud.google.com/apis/credentials',
    consoleLabel: 'Google Cloud console',
    clientIdLabel: 'Client ID',
    clientIdPlaceholder: '000000000000-xxxxxxxx.apps.googleusercontent.com',
  },
  {
    provider: 'microsoft',
    label: 'Microsoft 365',
    line: 'Required for Microsoft mailboxes — they no longer accept passwords for mail.',
    consoleUrl: 'https://entra.microsoft.com/',
    consoleLabel: 'Microsoft Entra admin center',
    clientIdLabel: 'Application (client) ID',
    clientIdPlaceholder: '00000000-0000-0000-0000-000000000000',
  },
]

/**
 * The company's own Google Workspace / Microsoft 365 applications. Agents sign
 * their mailboxes in through these, so an operator sets each one up once and
 * every mailbox connection afterwards is a single click on the agent's record.
 * Each application is a row; setting one up happens in its drawer.
 */
export function MailOauthApps({ apps, redirectUri }: { apps: MailOauthAppView[]; redirectUri: string }) {
  const [open, setOpen] = React.useState<ProviderCopy | null>(null)
  const openApp = open ? (apps.find((entry) => entry.provider === open.provider) ?? null) : null

  return (
    <>
      <SettingsRow
        title="Email sign-in apps"
        description="Connect Google Workspace or Microsoft 365 once, and agents sign in to their own addresses from their profile — no passwords stored anywhere. Self-hosted mail keeps using the IMAP form on the agent's record."
        stacked
      >
        <div className="space-y-1">
          <Label htmlFor="mail-oauth-redirect">Redirect URI</Label>
          <Input id="mail-oauth-redirect" readOnly value={redirectUri} onFocus={(event) => event.target.select()} />
          <p className="text-xs text-fg-muted">
            Add this exact address to both applications before saving them. It is the only one either provider needs.
          </p>
        </div>
      </SettingsRow>

      {PROVIDERS.map((copy) => {
        const app = apps.find((entry) => entry.provider === copy.provider) ?? null
        return (
          <SettingsRow
            key={copy.provider}
            title={copy.label}
            description={
              app
                ? `${copy.clientIdLabel} ${app.clientId}${app.directory ? ` · directory ${app.directory}` : ''}`
                : copy.line
            }
            control={
              <span className="flex items-center gap-2">
                <Badge variant={app ? 'secondary' : 'outline'}>{app ? 'secret sealed' : 'not set up'}</Badge>
                <Button variant={app ? 'outline' : 'default'} size="sm" onClick={() => setOpen(copy)}>
                  {app ? 'Manage' : 'Set up'}
                </Button>
              </span>
            }
          />
        )
      })}

      <Drawer
        open={open !== null}
        onClose={() => setOpen(null)}
        title={open ? open.label : ''}
        description={open ? open.line : undefined}
        size="md"
      >
        {open ? (
          <MailOauthAppForm key={open.provider} copy={open} app={openApp} onDone={() => setOpen(null)} />
        ) : null}
      </Drawer>
    </>
  )
}

function MailOauthAppForm({
  copy,
  app,
  onDone,
}: {
  copy: ProviderCopy
  app: MailOauthAppView | null
  onDone: () => void
}) {
  const [clientId, setClientId] = React.useState(app?.clientId ?? '')
  const [clientSecret, setClientSecret] = React.useState('')
  const [directory, setDirectory] = React.useState(app?.directory ?? 'common')
  const [error, setError] = React.useState<string | null>(null)
  const [busy, startBusy] = React.useTransition()

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor={`${copy.provider}-client-id`}>{copy.clientIdLabel}</Label>
          <Input
            id={`${copy.provider}-client-id`}
            value={clientId}
            onChange={(event) => setClientId(event.target.value)}
            placeholder={copy.clientIdPlaceholder}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${copy.provider}-client-secret`}>Client secret</Label>
          <Input
            id={`${copy.provider}-client-secret`}
            type="password"
            value={clientSecret}
            onChange={(event) => setClientSecret(event.target.value)}
            placeholder={app ? 'Paste the secret again to replace it' : 'Paste the secret'}
          />
        </div>
        {copy.provider === 'microsoft' ? (
          <div className="space-y-1 sm:col-span-2">
            <Label htmlFor="microsoft-directory">Directory</Label>
            <Input
              id="microsoft-directory"
              value={directory}
              onChange={(event) => setDirectory(event.target.value)}
              placeholder="common"
            />
            <p className="text-xs text-fg-muted">
              Your Microsoft directory ID, or <span className="font-medium">common</span> to accept any Microsoft
              account.
            </p>
          </div>
        ) : null}
      </div>

      <p className="text-xs text-fg-muted">
        From the{' '}
        <a
          href={copy.consoleUrl}
          target="_blank"
          rel="noreferrer"
          className="text-primary underline underline-offset-2"
        >
          {copy.consoleLabel}
        </a>
        . The secret is sealed at rest and never shown again.
      </p>

      <div className="flex flex-wrap items-center gap-3">
        <Button
          disabled={busy || !clientId.trim() || !clientSecret.trim()}
          onClick={() =>
            startBusy(async () => {
              setError(null)
              const result = await saveMailOauthAppAction({
                provider: copy.provider,
                clientId,
                clientSecret,
                ...(copy.provider === 'microsoft' ? { directory } : {}),
              })
              if (!result.ok) {
                setError(result.message)
                return
              }
              onDone()
            })
          }
        >
          {busy ? 'Saving…' : app ? 'Replace application' : 'Save application'}
        </Button>
        {app ? (
          <Button
            variant="destructive"
            disabled={busy}
            onClick={() =>
              startBusy(async () => {
                setError(null)
                const result = await removeMailOauthAppAction(copy.provider)
                if (!result.ok) {
                  setError(result.message)
                  return
                }
                onDone()
              })
            }
          >
            Remove
          </Button>
        ) : null}
        {error ? <p className="text-sm text-danger">{error}</p> : null}
      </div>
    </div>
  )
}
