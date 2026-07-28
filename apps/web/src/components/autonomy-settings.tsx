'use client'

import * as React from 'react'
import type { ActionCategory, AutonomyLevel } from '@bunkhouse/runtime'
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
} from '@appkit/ui'
import {
  ACTION_CATEGORIES,
  AUTONOMY_LEVELS,
  CATEGORY_LABELS,
  LEVEL_BADGES,
  LEVEL_DESCRIPTIONS,
} from '../lib/autonomy'
import { setAutonomy } from '../app/people/actions'

/** One hand's complete dial — every category resolved, no gaps. */
export type HandDial = {
  personId: string
  name: string
  title: string
  status: string
  levels: Record<ActionCategory, AutonomyLevel>
}

type DialRow = HandDial & { trusted: number; notify: number; approval: number; forbidden: number }

const COLUMNS: RecordColumn<DialRow>[] = [
  { key: 'name', label: 'Hand', kind: 'reference', sortable: true, href: (row) => `/people/${row.personId}` },
  { key: 'title', label: 'Job title', sortable: true },
  { key: 'trusted', label: 'Acts alone', sortable: true },
  { key: 'notify', label: 'Acts, then tells you', sortable: true },
  { key: 'approval', label: 'Asks first', sortable: true },
  { key: 'forbidden', label: 'Blocked', sortable: true },
]

/**
 * The company view of the autonomy dial: every hand, every action category, in
 * one place. Writes go through the same action the hand's profile uses, so the
 * dial keeps a single source of truth.
 */
export function AutonomySettings({ hands, linkRender }: { hands: HandDial[]; linkRender: LinkRender }) {
  const [openHand, setOpenHand] = React.useState<string | null>(null)

  const rows: DialRow[] = hands.map((hand) => {
    const levels = Object.values(hand.levels)
    return {
      ...hand,
      trusted: levels.filter((l) => l === 'trusted').length,
      notify: levels.filter((l) => l === 'notify').length,
      approval: levels.filter((l) => l === 'approval').length,
      forbidden: levels.filter((l) => l === 'forbidden').length,
    }
  })
  const selected = hands.find((h) => h.personId === openHand) ?? null

  if (hands.length === 0) {
    return (
      <EmptyState
        title="No hands on the roster"
        description="Onboard a hand and its day-one dial arrives with it, set from the role you onboarded it into."
      />
    )
  }

  return (
    <>
      <RecordList
        columns={COLUMNS}
        rows={rows}
        getRowId={(row) => row.personId}
        linkRender={linkRender}
        onRowClick={(row) => setOpenHand(row.personId)}
        empty={{ title: 'No hands on the roster', description: 'Onboard a hand to set its autonomy.' }}
      />
      <SettingsRow
        title="What the levels mean"
        description="A hand can never exceed its dial — the runtime enforces it on every action, not the prompt."
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

      <Drawer
        open={selected !== null}
        onClose={() => setOpenHand(null)}
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
