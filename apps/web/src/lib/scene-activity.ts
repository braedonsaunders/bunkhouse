import { describeToolCall } from './call-activity'

/**
 * What an agent is doing right now, in a few words.
 *
 * One description, two surfaces. The observatory shows it on a run card; the
 * lobby floor shows it as a pill over the character's head — and before that,
 * a floor of figures strolling about conveyed that the office was populated
 * and nothing whatever about whether anybody was working, which is the only
 * reason to open it. Two copies of this would have drifted within a week.
 */

export const snippet = (value: unknown, max = 80): string | null => {
  const text = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : ''
  if (!text) return null
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** The card's "now" line: the newest ledger event, phrased as an activity. */
export function describeLatestEvent(kind: string, payload: Record<string, unknown>): string | null {
  switch (kind) {
    case 'tool_call':
      return describeToolCall(String(payload.toolName ?? ''), payload.input)
    case 'tool_result': {
      const name = snippet(payload.toolName)
      return name ? `Reviewing ${name.replace(/[_-]+/g, ' ')} results` : 'Reviewing results'
    }
    case 'thought': {
      const text = snippet(payload.text)
      return text ? `Thinking — ${text}` : 'Thinking…'
    }
    case 'message': {
      const text = snippet(payload.text)
      return text ? `“${text}”` : 'Writing a reply'
    }
    case 'procedure_citation':
      return `Consulting ${String(payload.slug ?? 'a procedure')} v${String(payload.version ?? '?')}`
    case 'approval_request': {
      const text = snippet(payload.description)
      return text ? `Waiting for sign-off — ${text}` : 'Waiting for sign-off'
    }
    case 'delegation':
      return 'Delegating work to a colleague'
    case 'error': {
      const text = snippet(payload.message)
      return text ? `Hit an error — ${text}` : 'Hit an error'
    }
    default:
      return null
  }
}
