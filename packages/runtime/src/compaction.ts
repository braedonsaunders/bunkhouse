import type { ModelMessage, ToolResultPart } from 'ai'

type ToolResultOutput = ToolResultPart['output']

/**
 * Keeping a long run affordable.
 *
 * Every step of a tool-using run re-sends the whole transcript at full price,
 * so cost grows with the square of the number of tool calls, not with the
 * amount of work done. A measured run of the morning deposit report spent
 * 5,250,208 input tokens across 26 steps — the last sixteen sending ~295,000
 * tokens each — to produce a 450-word email. Almost all of that was the same
 * handful of large tool results being re-read over and over.
 *
 * The fix is not a smaller context window; it is not re-paying full price for
 * evidence the agent has already used. Recent results stay verbatim, because
 * that is what the next step is reasoning about. Older ones keep their head —
 * enough to remember what was asked and what came back — and say plainly that
 * the rest was trimmed, so an agent that genuinely needs the detail knows to
 * ask again rather than silently working from a gap.
 */

/** Tool results this recent are never touched: they are the working set. */
export const COMPACT_KEEP_RECENT = 6

/** What an aged-out tool result is allowed to keep. */
export const COMPACT_RESULT_CHARS = 1_200

/** Below this there is nothing worth trimming, and trimming costs clarity. */
const COMPACT_FLOOR_CHARS = 2_000

/**
 * How far the trim boundary jumps when it moves.
 *
 * This exists because compaction and prompt caching pull against each other.
 * Every provider's cache is a prefix cache: it matches the longest identical
 * head of the request and charges a fraction for it. Moonshot, DeepSeek, Z.AI,
 * OpenAI and Groq all do this automatically on OpenRouter, so the cheapest
 * possible transcript is one whose head does not move.
 *
 * A boundary defined purely as "everything but the last six results" moves on
 * every single step, so the seventh-newest result is re-summarised each turn,
 * the prefix changes, and the cache misses every time — trading a discount on
 * the whole history for a saving on one message. Quantising the boundary means
 * it holds still for a stride of steps and then jumps once: the prefix is
 * stable across that stride, the cache keeps hitting, and the cost of the one
 * miss is paid every eighth step instead of every step.
 */
const COMPACT_STRIDE = 8

function clip(text: string, capChars: number): string {
  const trimmed = text.length - capChars
  return `${text.slice(0, capChars)}\n… [${trimmed.toLocaleString()} characters trimmed from this earlier result to keep the run affordable. Run the tool again if you need the full output.]`
}

/** A shortened copy of an output, or null when it is already small enough. */
function shorten(output: ToolResultOutput, capChars: number): ToolResultOutput | null {
  if (output.type === 'text') {
    if (output.value.length <= Math.max(capChars, COMPACT_FLOOR_CHARS)) return null
    return { ...output, value: clip(output.value, capChars) }
  }
  if (output.type === 'json') {
    const serialized = JSON.stringify(output.value) ?? ''
    if (serialized.length <= Math.max(capChars, COMPACT_FLOOR_CHARS)) return null
    // A string is a perfectly good JSON value, so the part keeps its shape and
    // only its bulk is lost.
    return { ...output, value: clip(serialized, capChars) }
  }
  // Denials, errors and media carry no bulk worth trimming.
  return null
}

export type CompactionResult = {
  messages: ModelMessage[]
  /** Characters removed from the transcript this step; 0 means nothing changed. */
  trimmedChars: number
  /** How many earlier tool results were shortened. */
  trimmedResults: number
}

/**
 * Shorten tool results that have aged out of the working window.
 *
 * Structure is never touched — every tool call keeps its matching result, in
 * order — so the transcript stays valid for any provider. Only the bytes
 * inside aged results shrink.
 */
export function compactMessages(
  messages: ModelMessage[],
  options?: { keepRecent?: number; capChars?: number },
): CompactionResult {
  const keepRecent = options?.keepRecent ?? COMPACT_KEEP_RECENT
  const capChars = options?.capChars ?? COMPACT_RESULT_CHARS

  // Every tool result in order, oldest first, so the boundary can be expressed
  // as a count rather than a position in a mixed message list.
  const resultIds: string[] = []
  for (const message of messages) {
    if (message.role !== 'tool' || !Array.isArray(message.content)) continue
    for (const part of message.content) {
      if (part.type === 'tool-result') resultIds.push(part.toolCallId)
    }
  }

  // The boundary only advances a stride at a time, so the compacted prefix is
  // byte-identical across a run of steps and the provider's cache keeps
  // matching it. Anything at or after the boundary is left verbatim.
  const trimmable = Math.max(0, resultIds.length - keepRecent)
  const boundary = Math.floor(trimmable / COMPACT_STRIDE) * COMPACT_STRIDE
  if (boundary === 0) return { messages, trimmedChars: 0, trimmedResults: 0 }
  const spare = new Set(resultIds.slice(boundary))

  let trimmedChars = 0
  let trimmedResults = 0
  const compacted = messages.map((message) => {
    if (message.role !== 'tool' || !Array.isArray(message.content)) return message
    let changed = false
    const content = message.content.map((part) => {
      if (part.type !== 'tool-result' || spare.has(part.toolCallId)) return part
      const before = JSON.stringify(part.output)?.length ?? 0
      const shortened = shorten(part.output, capChars)
      if (!shortened) return part
      changed = true
      trimmedResults += 1
      trimmedChars += before - (JSON.stringify(shortened)?.length ?? 0)
      return { ...part, output: shortened }
    })
    return changed ? { ...message, content } : message
  })

  return { messages: trimmedChars > 0 ? compacted : messages, trimmedChars, trimmedResults }
}
