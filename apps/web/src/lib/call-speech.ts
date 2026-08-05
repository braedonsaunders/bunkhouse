import type { MailboxPost } from './call-mailbox'
import type { WorkReport } from './call-worker'

/** A phone turn long enough to carry the answer, but short enough to invite the caller back in. */
const MAX_RESULT_WORDS = 55

const wordCount = (text: string): number => text.split(/\s+/).filter(Boolean).length

/**
 * Remove formatting that only makes sense on a screen. Table rows are omitted
 * rather than read cell-by-cell; the worker's concluding prose carries the
 * spoken answer and the full table remains in the run and any generated file.
 */
function proseParagraphs(markdown: string): string[] {
  const withoutCode = markdown.replace(/```[\s\S]*?```/g, ' ')
  return withoutCode
    .split(/\n\s*\n/)
    .map((paragraph) =>
      paragraph
        .split('\n')
        .filter((line) => {
          const trimmed = line.trim()
          if (!trimmed) return false
          if (/^\|?\s*:?-{3,}/.test(trimmed)) return false
          return (trimmed.match(/\|/g)?.length ?? 0) < 2
        })
        .join(' ')
        .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/^\s{0,3}#{1,6}\s+/g, '')
        .replace(/(^|\s)[*_-]{1,3}(?=\S)/g, '$1')
        .replace(/[*_`~]/g, '')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter(Boolean)
}

function boundedTurn(text: string, maxWords = MAX_RESULT_WORDS): string {
  const normalized = text.replace(/\s+/g, ' ').replace(/\.{2,}/g, '.').trim()
  if (wordCount(normalized) <= maxWords) return normalized

  const words = normalized.split(' ')
  const candidate = words.slice(0, maxWords).join(' ')
  // Prefer ending on a real sentence once enough of the answer has been said.
  const endings = [...candidate.matchAll(/[.!?](?=\s|$)/g)]
  const ending = endings.reverse().find((match) => wordCount(candidate.slice(0, (match.index ?? 0) + 1)) >= 12)
  if (ending?.index !== undefined) return candidate.slice(0, ending.index + 1)
  return `${candidate.replace(/[,:;\-–—]+$/, '')}.`
}

/**
 * The work engine writes a durable, detailed answer. A call needs its spoken
 * conclusion: one or two sentences, never a markdown table or a five-minute
 * readout. Models are asked for this shape too, but this boundary enforces it
 * when one returns the full written report followed by the requested summary.
 */
export function spokenWorkResult(markdown: string): string {
  const paragraphs = proseParagraphs(markdown)
  if (paragraphs.length === 0) return 'That is finished.'

  // The live-work brief asks for a concluding spoken answer. When the model
  // also wrote its working report, that conclusion is the final prose block.
  const conclusion = paragraphs.at(-1)!
  return boundedTurn(conclusion)
}

/** Exactly one mailbox state for a settled piece of live work. */
export function settledWorkPost(report: WorkReport): MailboxPost | null {
  switch (report.status) {
    case 'done':
      return { kind: 'result', workId: report.id, text: spokenWorkResult(report.detail) }
    case 'needs_approval':
      // The approval_request/tool_result events already posted the actionable
      // sign-off line. Treating the worker's final note as a result repeated
      // that line and incorrectly marked the work finished.
      return null
    case 'failed':
      return { kind: 'failed', workId: report.id, text: boundedTurn(`That did not work: ${report.detail}`) }
    case 'stopped':
      return { kind: 'failed', workId: report.id, text: boundedTurn(report.detail) }
    case 'working':
      return null
  }
}

export type ApprovalCompletion = { text: string; failed: boolean }

/** Turn an approval executor's durable tool result into words for the active call. */
export function approvalCompletion(toolName: string, output: unknown): ApprovalCompletion {
  const result = output !== null && typeof output === 'object' ? (output as Record<string, unknown>) : {}
  const failure =
    typeof result.error === 'string' && result.error.trim()
      ? result.error.trim()
      : result.sent === false && typeof result.reason === 'string' && result.reason.trim()
        ? result.reason.trim()
        : null
  if (failure) {
    return {
      text: boundedTurn(`That was approved, but it still could not be completed: ${failure}`),
      failed: true,
    }
  }

  if (toolName === 'send_email' && result.sent === true) {
    const to = typeof result.to === 'string' && result.to.trim() ? ` to ${result.to.trim()}` : ''
    const attachments = typeof result.attachedFiles === 'number' ? result.attachedFiles : 0
    const attached = attachments > 0 ? ` with ${attachments === 1 ? 'the attachment' : `${attachments} attachments`}` : ''
    return { text: `The email${to} has been approved and sent${attached}. Is there anything else you need?`, failed: false }
  }

  return { text: 'That has been approved and completed. Is there anything else you need?', failed: false }
}
