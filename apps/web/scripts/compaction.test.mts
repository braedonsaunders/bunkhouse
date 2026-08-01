import assert from 'node:assert/strict'
import type { ModelMessage } from 'ai'
import { compactMessages, COMPACT_KEEP_RECENT } from '@bunkhouse/runtime'

const BIG = 'x'.repeat(50_000)

function toolResult(id: string, value: unknown, type: 'text' | 'json' = 'json'): ModelMessage {
  return {
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId: id,
        toolName: 'netsuite_ns_runCustomSuiteQL',
        output: type === 'text' ? { type: 'text', value: value as string } : { type: 'json', value: value as never },
      },
    ],
  }
}

/** A transcript of `n` fat tool results, oldest first. */
const transcript = (n: number, tag = 'r'): ModelMessage[] => [
  { role: 'user', content: 'produce the deposit report' },
  ...Array.from({ length: n }, (_, i) => toolResult(`${tag}${i}`, { blob: BIG })),
]

// --- nothing to do ----------------------------------------------------------
const small: ModelMessage[] = [{ role: 'user', content: 'hello' }, toolResult('a', { rows: [1, 2, 3] })]
const untouched = compactMessages(small)
assert.equal(untouched.trimmedChars, 0, 'small transcripts are left alone')
assert.equal(untouched.messages, small, 'the original array is returned when nothing changed')

// --- the working set always survives -----------------------------------------
const recent = transcript(COMPACT_KEEP_RECENT)
assert.equal(compactMessages(recent).trimmedChars, 0, `the most recent ${COMPACT_KEEP_RECENT} results are never trimmed`)

// --- the boundary only moves in strides --------------------------------------
// Below a full stride of trimmable results, nothing is trimmed: paying for one
// extra old result is cheaper than moving the prefix and missing the cache.
assert.equal(compactMessages(transcript(COMPACT_KEEP_RECENT + 7)).trimmedResults, 0, 'a partial stride is left alone')
const stride = compactMessages(transcript(COMPACT_KEEP_RECENT + 8))
assert.equal(stride.trimmedResults, 8, `a whole stride is trimmed at once, got ${stride.trimmedResults}`)
assert.ok(stride.trimmedChars > 300_000, `and it is a lot of context, trimmed ${stride.trimmedChars}`)

// --- prefix stability: the whole reason for the stride ------------------------
// Adding another turn must not re-cut the history, or every step would rewrite
// the head of the request and the provider's prompt cache would miss each time.
const before = compactMessages(transcript(COMPACT_KEEP_RECENT + 8))
const after = compactMessages([...transcript(COMPACT_KEEP_RECENT + 8), toolResult('next', { blob: BIG })])
const head = (r: { messages: ModelMessage[] }) => JSON.stringify(r.messages.slice(0, COMPACT_KEEP_RECENT + 5))
assert.equal(head(after), head(before), 'the compacted prefix is byte-identical after another step')

// --- structure is never rearranged -------------------------------------------
const source = transcript(COMPACT_KEEP_RECENT + 8)
const compacted = compactMessages(source)
assert.equal(compacted.messages.length, source.length, 'no message is dropped')
assert.deepEqual(
  compacted.messages.map((m) => m.role),
  source.map((m) => m.role),
  'message order and roles are untouched',
)
const aged = compacted.messages[1]
assert.ok(aged && aged.role === 'tool' && Array.isArray(aged.content))
const agedPart = aged.content[0]
assert.ok(agedPart && agedPart.type === 'tool-result', 'the part keeps its shape')
assert.equal(agedPart.toolCallId, 'r0', 'call/result pairing is preserved')
const serialized = JSON.stringify(agedPart.output)
assert.ok(serialized.length < 3_000, `the aged result is small now, was ${serialized.length}`)
assert.ok(serialized.includes('trimmed'), 'the agent is told the rest was trimmed, not left to guess')

// --- text outputs compact too ------------------------------------------------
const textual: ModelMessage[] = [
  toolResult('page', BIG, 'text'),
  ...Array.from({ length: COMPACT_KEEP_RECENT + 8 }, (_, i) => toolResult(`n${i}`, { i })),
]
const textCompacted = compactMessages(textual)
const textPart = (textCompacted.messages[0] as { content: { output: { type: string } }[] }).content[0]
assert.equal(textPart!.output.type, 'text', 'a text output stays a text output')

console.log('compaction: ok')
