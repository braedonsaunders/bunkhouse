'use client'

import * as React from 'react'
import type { ActionCategory, AutonomyLevel } from '@bunkhouse/acp'
import {
  Badge,
  Button,
  Drawer,
  EmptyState,
  RecordList,
  Select,
  SettingsRow,
  type LinkRender,
  type RecordColumn,
} from '@braedonsaunders/appkit-ui'
import {
  ACTION_CATEGORIES,
  AUTONOMY_LEVELS,
  CATEGORY_LABELS,
  LEVEL_BADGES,
  LEVEL_DESCRIPTIONS,
} from '../lib/autonomy'
import { setAutonomy } from '../app/organization/actions'

/** One agent's complete dial — every category resolved, no gaps. */
export type AgentDial = {
  personId: string
  name: string
  title: string
  status: string
  levels: Record<ActionCategory, AutonomyLevel>
}

type DialRow = AgentDial & { trusted: number; notify: number; approval: number; forbidden: number }

const COLUMNS: RecordColumn<DialRow>[] = [
  { key: 'name', label: 'Agent', kind: 'reference', sortable: true, href: (row) => `/organization?person=${row.personId}` },
  { key: 'title', label: 'Job title', sortable: true },
  { key: 'trusted', label: 'Acts alone', sortable: true },
  { key: 'notify', label: 'Acts, then tells you', sortable: true },
  { key: 'approval', label: 'Asks first', sortable: true },
  { key: 'forbidden', label: 'Blocked', sortable: true },
]

/**
 * The company view of the autonomy dial: every agent, every action category, in
 * one place. Writes go through the same action the agent's profile uses, so the
 * dial keeps a single source of truth.
 */
export function AutonomySettings({ agents, linkRender }: { agents: AgentDial[]; linkRender: LinkRender }) {
  const [openAgent, setOpenAgent] = React.useState<string | null>(null)

  const rows: DialRow[] = agents.map((agent) => {
    const levels = Object.values(agent.levels)
    return {
      ...agent,
      trusted: levels.filter((l) => l === 'trusted').length,
      notify: levels.filter((l) => l === 'notify').length,
      approval: levels.filter((l) => l === 'approval').length,
      forbidden: levels.filter((l) => l === 'forbidden').length,
    }
  })
  const selected = agents.find((h) => h.personId === openAgent) ?? null

  if (agents.length === 0) {
    return (
      <EmptyState
        title="No agents on the roster"
        description="Onboard an agent and its day-one dial arrives with it, set from the role you onboarded it into."
      />
    )
  }

  return (
    <>
      <SettingsRow
        title="What the levels mean"
        description="An agent can never exceed its dial — the runtime enforces it on every action, not the prompt."
        stacked
      >
        <div className="grid gap-2 sm:grid-cols-2">
          {AUTONOMY_LEVELS.map((level) => (
            <div key={level} className="flex items-start gap-2 rounded-md border border-border px-3 py-2 text-sm">
              <Badge variant={LEVEL_BADGES[level]}>{level}</Badge>
              <span className="text-fg-muted">{LEVEL_DESCRIPTIONS[level]}</span>
            </div>
          ))}
        </div>
      </SettingsRow>
      <RecordList
        columns={COLUMNS}
        rows={rows}
        getRowId={(row) => row.personId}
        linkRender={linkRender}
        onRowClick={(row) => setOpenAgent(row.personId)}
        empty={{ title: 'No agents on the roster', description: 'Onboard an agent to set its autonomy.' }}
      />

      <Drawer
        open={selected !== null}
        onClose={() => setOpenAgent(null)}
        title={selected ? `Autonomy — ${selected.name}` : ''}
        description={selected ? `${selected.title} · changes apply to new work, never to work already done` : undefined}
        size="md"
      >
        {selected ? (
          <div className="space-y-2">
            {ACTION_CATEGORIES.map((category) => {
              const current = selected.levels[category]
              return (
                <form
                  key={category}
                  action={setAutonomy}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2"
                >
                  <input type="hidden" name="personId" value={selected.personId} />
                  <input type="hidden" name="category" value={category} />
                  <span className="flex items-center gap-2 text-sm">
                    {CATEGORY_LABELS[category]}
                    <Badge variant={LEVEL_BADGES[current]}>{current}</Badge>
                  </span>
                  <span className="flex items-center gap-1">
                    <Select name="level" defaultValue={current} aria-label={CATEGORY_LABELS[category]}>
                      {AUTONOMY_LEVELS.map((level) => (
                        <option key={level} value={level}>
                          {level}
                        </option>
                      ))}
                    </Select>
                    <Button type="submit" variant="outline" size="sm">
                      Set
                    </Button>
                  </span>
                </form>
              )
            })}
          </div>
        ) : null}
      </Drawer>
    </>
  )
}
