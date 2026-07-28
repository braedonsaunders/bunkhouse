import assert from 'node:assert/strict'
import { assertValidManager, managerChain } from '../src/lib/org'

type Row = { id: string; name: string; reportsToId: string | null }

const roster: Row[] = [
  { id: 'owner', name: 'Rae', reportsToId: null },
  { id: 'ops', name: 'Dana', reportsToId: 'owner' },
  { id: 'admin', name: 'Mo', reportsToId: 'ops' },
  { id: 'sales', name: 'Kit', reportsToId: 'owner' },
]

function rejects(personId: string, managerId: string | null, expected: RegExp): void {
  assert.throws(() => assertValidManager(roster, personId, managerId), expected)
}

// --- manager chain ----------------------------------------------------------
assert.deepEqual(
  managerChain(roster, 'admin').map((m) => m.id),
  ['ops', 'owner'],
  'walks the whole line to the top',
)
assert.deepEqual(managerChain(roster, 'owner'), [], 'the top of the org reports to nobody')
assert.deepEqual(managerChain(roster, 'ghost'), [], 'an unknown id has no chain')

// A cycle already in the data must terminate rather than spin.
const looped: Row[] = [
  { id: 'a', name: 'A', reportsToId: 'c' },
  { id: 'b', name: 'B', reportsToId: 'a' },
  { id: 'c', name: 'C', reportsToId: 'b' },
]
assert.deepEqual(managerChain(looped, 'a').map((m) => m.id), ['c', 'b'], 'stops when it revisits the start')

// --- the tree invariant -----------------------------------------------------
assert.doesNotThrow(() => assertValidManager(roster, 'admin', 'owner'), 'may move up the same branch')
assert.doesNotThrow(() => assertValidManager(roster, 'admin', 'sales'), 'may move to a sibling branch')
assert.doesNotThrow(() => assertValidManager(roster, 'ops', null), 'may be promoted to the top level')

rejects('admin', 'admin', /cannot report to themselves/)
rejects('admin', 'ghost', /not in this organization/)
rejects('owner', 'admin', /already reports to/)
rejects('owner', 'ops', /already reports to/)
rejects('ops', 'admin', /already reports to/)

console.log('org: ok')
