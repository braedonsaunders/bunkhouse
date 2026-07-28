'use client'

import * as React from 'react'
import { SubtabNav, type SubtabItem } from '@appkit/ui'
import { NotesView, ProposalsView, type NoteRow, type ProposalRow } from './notes-view'

/** Company knowledge: one list per subtab — never stacked tables. */
export function KnowledgeView({ notes, proposals }: { notes: NoteRow[]; proposals: ProposalRow[] }) {
  const [active, setActive] = React.useState('notes')
  const tabs: SubtabItem[] = [
    { key: 'notes', label: 'Notes', count: notes.length },
    { key: 'proposals', label: 'Proposals', count: proposals.length },
  ]
  return (
    <div className="space-y-4">
      <SubtabNav tabs={tabs} active={active} onSelect={setActive} ariaLabel="Knowledge sections" />
      {active === 'notes' ? <NotesView scope="company" rows={notes} /> : <ProposalsView rows={proposals} />}
    </div>
  )
}
