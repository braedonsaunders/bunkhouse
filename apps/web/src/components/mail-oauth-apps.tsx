'use client'

import * as React from 'react'
import { Badge, Button, Input, Label, SettingsRow } from '@appkit/ui'
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
 */
export function MailOauthApps({ apps, redirectUri }: { apps: MailOauthAppView[]; redirectUri: string }) {
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
            Add this exact address to both applications before saving them below. It is the only one either provider
            needs.
          </p>
        </div>
      </SettingsRow>
      {PROVIDERS.map((copy) => (
        <MailOauthAppRow
          key={copy.provider}
          copy={copy}
          app={apps.find((entry) => entry.provider === copy.provider) ?? null}
        />
      ))}
    </>
  )
}

function MailOauthAppRow({ copy, app }: { copy: ProviderCopy; app: MailOauthAppView | null }) {
  const [clientId, setClientId] = React.useState('')
  const [clientSecret, setClientSecret] = React.useState('')
  const [directory, setDirectory] = React.useState('common')
  const [error, setError] = React.useState<string | null>(null)
  const [busy, startBusy] = React.useTransition()

  return (
    <>
      <SettingsRow
        title={copy.label}
        description={
          app
            ? `${copy.clientIdLabel} ${app.clientId}${app.directory ? ` · directory ${app.directory}` : ''}`
            : copy.line
        }
        control={
          app ? (
            <span className="flex items-center gap-2">
              <Badge variant="secondary">secret sealed</Badge>
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() =>
                  startBusy(async () => {
                    setError(null)
                    const result = await removeMailOauthAppAction(copy.provider)
                    if (!result.ok) setError(result.message)
                  })
                }
              >
                Remove
              </Button>
            </span>
          ) : (
            <Badge variant="outline">not set up</Badge>
          )
        }
      />
      <SettingsRow title={app ? `Replace the ${copy.label} application` : `Set up ${copy.label}`} stacked>
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
              placeholder="Paste the secret"
            />
          </div>
          {copy.provider === 'microsoft' ? (
            <div className="space-y-1">
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
        <div className="flex flex-wrap items-center gap-3 pt-1">
          <Button
            size="sm"
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
                setClientId('')
                setClientSecret('')
              })
            }
          >
            {busy ? 'Saving…' : app ? 'Replace application' : 'Save application'}
          </Button>
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
        </div>
        {error ? <p className="text-sm text-danger">{error}</p> : null}
      </SettingsRow>
    </>
  )
}
