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

/** The one-word state and the glyph that animates it. */
export type SceneStatus = {
  label: string
  tone: 'active' | 'busy' | 'idle' | 'waiting' | 'trouble'
  activity: 'working' | 'reading' | 'searching' | 'talking' | 'writing' | 'waiting' | 'idle'
}

/**
 * What an agent is doing, as ONE WORD and a kind of motion.
 *
 * Separate from `describeLatestEvent` on purpose. That returns a sentence,
 * which is right on a run card and wrong beside a walking figure — a pill has
 * no room for a sentence, and the first version of this clipped one, so every
 * character on the floor wore the same grey "needs… waiting on a deci…". The
 * sentence still exists; it goes in the speech bubble above the head, which
 * has room for it.
 *
 * The vocabulary is deliberately tiny. Somebody scanning the floor is asking
 * "is anything happening, and does anything want me" — not "what exactly is
 * Bill's third tool call".
 */
export function sceneStatus(args: {
  runStatus: string
  eventKind: string | null
  toolName?: string | null
}): SceneStatus {
  if (args.runStatus === 'waiting_approval') return { label: 'needs you', tone: 'waiting', activity: 'waiting' }
  if (args.runStatus === 'waiting_reply') return { label: 'waiting', tone: 'waiting', activity: 'waiting' }

  const tool = (args.toolName ?? '').toLowerCase()
  if (tool.startsWith('browser_')) return { label: 'browsing', tone: 'busy', activity: 'reading' }
  if (tool === 'read_page' || tool === 'read_webpage') return { label: 'reading', tone: 'busy', activity: 'reading' }
  if (tool === 'web_search' || tool === 'search_memory') return { label: 'searching', tone: 'busy', activity: 'searching' }
  if (tool.startsWith('netsuite') || tool.includes('_ns_')) return { label: 'in NetSuite', tone: 'busy', activity: 'searching' }
  if (tool === 'place_call' || tool === 'end_call') return { label: 'on a call', tone: 'active', activity: 'talking' }
  if (tool.includes('email') || tool.includes('sms') || tool.includes('colleague')) {
    return { label: 'writing', tone: 'busy', activity: 'writing' }
  }
  if (tool.startsWith('create_') || tool.includes('document') || tool.includes('spreadsheet')) {
    return { label: 'drafting', tone: 'busy', activity: 'writing' }
  }
  if (tool.startsWith('run_') || tool.includes('workspace')) return { label: 'at the keyboard', tone: 'busy', activity: 'working' }
  if (tool === 'save_memory') return { label: 'taking notes', tone: 'busy', activity: 'writing' }

  if (args.eventKind === 'message' || args.eventKind === 'thought') {
    return { label: 'thinking', tone: 'busy', activity: 'working' }
  }
  if (args.eventKind === 'error') return { label: 'stuck', tone: 'trouble', activity: 'waiting' }
  if (args.eventKind === 'approval_request') return { label: 'needs you', tone: 'waiting', activity: 'waiting' }
  return { label: 'working', tone: 'busy', activity: 'working' }
}
