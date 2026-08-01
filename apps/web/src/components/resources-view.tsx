'use client'

import * as React from 'react'
import { SubtabNav, type SubtabItem } from '@appkit/ui'
import { NotesView, ProposalsView, type NoteRow, type ProposalRow } from './notes-view'
import { ProceduresView, type AssignOption, type ProcedureRow } from './procedures-view'
import { SkillsView, type SkillRowView } from './skills-view'
import { SystemsView, type McpOauthOutcome, type SystemRowView } from './systems-view'

/**
 * Resources: everything an agent brings to the job. What it knows (notes), the
 * doctrine it is bound by (procedures), the competence it can draw on (skills),
 * and the outside software it has access to (systems) — plus the changes agents
 * nominate to any of it. One list per subtab; never stacked tables.
 */
export function ResourcesView({
  notes,
  proposals,
  procedures,
  skills,
  shellAvailable,
  systems,
  mcpOauthOutcome,
  mcpOauthRedirectUri,
  roleOptions,
  agentOptions,
  initialTab,
}: {
  notes: NoteRow[]
  proposals: ProposalRow[]
  procedures: ProcedureRow[]
  skills: SkillRowView[]
  /** Whether this deployment can run sandboxed shell commands at all. */
  shellAvailable: boolean
  systems: SystemRowView[]
  /** How the last MCP OAuth sign-in ended, when the operator just came back. */
  mcpOauthOutcome?: McpOauthOutcome | null
  /** The exact address providers must be told to call back to. */
  mcpOauthRedirectUri: string
  roleOptions: AssignOption[]
  agentOptions: AssignOption[]
  /** Which subtab to open on arrival — the OAuth callback and links deep-link here. */
  initialTab?: string
}) {
  const tabs: SubtabItem[] = [
    { key: 'notes', label: 'Notes', count: notes.length },
    { key: 'procedures', label: 'Procedures', count: procedures.length },
    { key: 'skills', label: 'Skills', count: skills.length },
    { key: 'systems', label: 'Systems', count: systems.length },
    { key: 'proposals', label: 'Proposals', count: proposals.length },
  ]
  const [active, setActive] = React.useState(
    tabs.some((tab) => tab.key === initialTab) ? (initialTab as string) : 'notes',
  )

  return (
    <div className="space-y-4">
      <SubtabNav tabs={tabs} active={active} onSelect={setActive} ariaLabel="Resource sections" />
      {active === 'notes' ? (
        <NotesView scope="company" rows={notes} roleOptions={roleOptions} agentOptions={agentOptions} />
      ) : null}
      {active === 'procedures' ? (
        <div className="space-y-3">
          <p className="text-sm text-fg-muted">
            Versioned company doctrine. Agents follow the active revision and cite it in their work — changes are new
            versions, never edits.
          </p>
          <ProceduresView rows={procedures} roleOptions={roleOptions} agentOptions={agentOptions} />
        </div>
      ) : null}
      {active === 'skills' ? (
        <SkillsView
          rows={skills}
          roleOptions={roleOptions}
          agentOptions={agentOptions}
          shellAvailable={shellAvailable}
        />
      ) : null}
      {active === 'systems' ? (
        <SystemsView
          systems={systems}
          oauthOutcome={mcpOauthOutcome ?? null}
          oauthRedirectUri={mcpOauthRedirectUri}
          roleOptions={roleOptions}
          agentOptions={agentOptions}
        />
      ) : null}
      {active === 'proposals' ? <ProposalsView rows={proposals} /> : null}
    </div>
  )
}
