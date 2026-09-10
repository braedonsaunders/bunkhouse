import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { hasNulChar, pgJsonSafe } from '../src/lib/pg-json'

/**
 * Postgres cannot store U+0000, and it refuses the whole INSERT rather than the
 * one column — so a single NUL byte in recorded output destroys the entire row.
 *
 * That is not a theoretical input. Four `run_shell` calls in one day ran to
 * completion on the desk and were then reported to the agent as failures, with
 * the raw failed INSERT — SQL, parameters, command text and all — handed over as
 * the error message, because the output being recorded came off a binary read and
 * carried padding NULs.
 */
const NUL = '\u0000'

// --- the data actually seen -------------------------------------------------
assert.equal(pgJsonSafe(`pubkey=${NUL}${NUL}${NUL}`), 'pubkey=')
assert.equal(pgJsonSafe(`=== balance ===\n${NUL}12.5 SOL\n`), '=== balance ===\n12.5 SOL\n')

// Nested exactly as a desk_events detail is shaped.
const detail = pgJsonSafe({
  command: 'cd ~/advisor/meme && cat wallet-pubkey',
  output: `pub${NUL}key`,
  exitCode: 0,
  outputTruncated: false,
  lines: [`a${NUL}`, 'b'],
})
assert.equal(detail.output, 'pubkey')
assert.deepEqual(detail.lines, ['a', 'b'])
assert.equal(detail.exitCode, 0, 'non-strings are untouched')
assert.equal(hasNulChar(detail), false)

// --- everything else is returned unchanged, by identity ---------------------
//
// Cheap insurance that this sits on every persisted payload for free: a value
// with nothing to strip must not be rebuilt.
const clean = { text: 'nothing to do here', nested: { list: [1, 2, 3] } }
assert.equal(pgJsonSafe(clean), clean, 'a clean payload is the same object')
assert.equal(pgJsonSafe(clean).nested, clean.nested, 'and so is every branch of it')

// Values the driver must receive intact rather than walked into plain objects.
const when = new Date('2026-09-10T14:05:29.133Z')
assert.equal(pgJsonSafe({ at: when }).at, when)
const buffer = Buffer.from([0, 1, 2])
assert.equal(pgJsonSafe({ blob: buffer }).blob, buffer, 'a Buffer is not a jsonb string')
assert.equal(pgJsonSafe(null), null)
assert.equal(pgJsonSafe(undefined), undefined)

// --- hasNulChar reports, it does not guess ----------------------------------
assert.equal(hasNulChar({ a: [{ b: `x${NUL}` }] }), true)
assert.equal(hasNulChar({ a: [{ b: 'x' }] }), false)
assert.equal(hasNulChar(7), false)

// --- and it is wired to both writers of arbitrary output --------------------
//
// These are the two tables that hold text this app did not write: `run_events`
// (every tool call, result, thought and message) and `desk_events` (everything a
// command printed). Either one takes a NUL and the statement dies.
for (const [file, table] of [
  ['../src/lib/run-events.ts', 'runEvents'],
  ['../src/lib/desk.ts', 'deskEvents'],
] as const) {
  const src = readFileSync(new URL(file, import.meta.url), 'utf8')
  const insert = src.slice(src.indexOf(`insert(${table}).values(`))
  const body = insert.slice(0, insert.indexOf('\n    })'))
  assert.match(body, /pgJsonSafe\(/, `${table} sanitizes its jsonb payload before inserting it`)
}

// A completed command is reported as completed. Recording it is an audit duty
// that happens afterwards; a failure there is logged, never returned as the
// command's own result.
{
  const desk = readFileSync(new URL('../src/lib/desk.ts', import.meta.url), 'utf8')
  const shell = desk.slice(desk.indexOf('async function runShellOnDesk'))
  const append = shell.slice(shell.indexOf("appendSerialized(ctx, live, 'shell_command'"))
  const upToReturn = append.slice(0, append.indexOf('return {'))
  assert.match(upToReturn, /\.catch\(/, 'a ledger write failure does not fail the command that already ran')
}

console.log('pg-json: all assertions passed')
