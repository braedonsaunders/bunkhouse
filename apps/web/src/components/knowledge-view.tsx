'use client'

import * as React from 'react'
import { SubtabNav, type SubtabItem } from '@appkit/ui'
import { NotesView, ProposalsView, type NoteRow, type ProposalRow } from './notes-view'
import { ProceduresView, type AssignOption, type ProcedureRow } from './procedures-view'

/** Company knowledge: one list per subtab — never stacked tables. */
export function KnowledgeView({
  notes,
  proposals,
  procedures,
  rolePackOptions,
  handOptions,
}: {
  notes: NoteRow[]
  proposals: ProposalRow[]
  procedures: ProcedureRow[]
  rolePackOptions: AssignOption[]
  handOptions: AssignOption[]
}) {
  const [active, setActive] = React.useState('notes')
  const tabs: SubtabItem[] = [
    { key: 'notes', label: 'Notes', count: notes.length },
    { key: 'procedures', label: 'Procedures', count: procedures.length },
    { key: 'proposals', label: 'Proposals', count: proposals.length },
  ]
  return (
    <div className="space-y-4">
      <SubtabNav tabs={tabs} active={active} onSelect={setActive} ariaLabel="Knowledge sections" />
      {active === 'notes' ? <NotesView scope="company" rows={notes} /> : null}
      {active === 'procedures' ? (
        <div className="space-y-3">
          <p className="text-sm text-fg-muted">
            Versioned company doctrine. Hands follow the active revision and cite it in their work — changes are new
            versions, never edits.
          </p>
          <ProceduresView rows={procedures} rolePackOptions={rolePackOptions} handOptions={handOptions} />
        </div>
      ) : null}
      {active === 'proposals' ? <ProposalsView rows={proposals} /> : null}
    </div>
  )
}
