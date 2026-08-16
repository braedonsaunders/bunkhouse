'use client'

import * as React from 'react'
import { Badge, SettingsRow, SettingsSection, Switch } from '@appkit/ui'
import { saveFeaturesAction } from '../app/admin/settings/actions'

export type FeaturesView = { desk: boolean; desktop: boolean }

/**
 * The one authoritative feature switchboard (AGENTS.md): every org-level gate
 * lives here and only here. Module pages show effective status and link back;
 * none of them carries a second switch. Dependent capabilities follow their
 * parent — the desktop switch is disabled and shown off whenever desks are
 * off, so the child can never be independently available.
 */
export function FeaturesSettings({ features }: { features: FeaturesView }) {
  const [state, setState] = React.useState(features)
  const [error, setError] = React.useState<string | null>(null)
  const [busy, startBusy] = React.useTransition()

  const apply = (next: FeaturesView) => {
    // The dependency is enforced on write as well as in the UI: desk off
    // forces desktop off, whatever the click order was.
    const resolved = { desk: next.desk, desktop: next.desk && next.desktop }
    const previous = state
    setState(resolved)
    startBusy(async () => {
      setError(null)
      const result = await saveFeaturesAction(resolved)
      if (!result.ok) {
        setState(previous)
        setError(result.message)
      }
    })
  }

  return (
    <SettingsSection
      title="Features"
      description="What this company's agents are offered. Turning a capability off withholds it everywhere — abilities, navigation, and configuration alike — while every record and audit trail it produced stays on the books."
    >
      <SettingsRow
        title="Agent desks"
        description="Each agent's own machine: a terminal, a persistent filesystem, tools, and a browser whose logins survive between runs. Off, agents keep their tier-0 abilities — documents, spreadsheets, research, mail — but have no machine; desk history and session replays remain readable."
        control={
          <span className="flex items-center gap-2">
            <Badge variant={state.desk ? 'default' : 'outline'}>{state.desk ? 'on' : 'off'}</Badge>
            <Switch
              checked={state.desk}
              disabled={busy}
              aria-label="Agent desks"
              onChange={(event) => apply({ desk: event.target.checked, desktop: state.desktop })}
            />
          </span>
        }
      />
      <SettingsRow
        title="Desktop screens"
        description="The expensive tier on a desk: a real desktop an agent opens with a recorded reason, for software that has no other way in. Requires agent desks — it switches off with them and cannot be turned on without them."
        control={
          <span className="flex items-center gap-2">
            <Badge variant={state.desktop ? 'default' : 'outline'}>{state.desktop ? 'on' : 'off'}</Badge>
            <Switch
              checked={state.desktop}
              disabled={busy || !state.desk}
              aria-label="Desktop screens"
              onChange={(event) => apply({ desk: state.desk, desktop: event.target.checked })}
            />
          </span>
        }
      />
      {error ? (
        <SettingsRow title="The change did not save" description={error} control={<Badge variant="destructive">error</Badge>} />
      ) : null}
    </SettingsSection>
  )
}
