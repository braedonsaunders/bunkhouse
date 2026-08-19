import type { RunOutcome } from '@bunkhouse/runtime'

/**
 * What the person on the other end is told, for every way a governed run can
 * end.
 *
 * One translation, shared by every chat surface: the Slack/Teams bridge
 * (lib/chat-bridge.ts) and the in-app chat page (lib/chat-threads.ts). An
 * agent that has parked on an approval, or spent its salary, says the same
 * thing wherever it was reached — and there is one place to change it.
 *
 * Deliberately dependency-free (the `RunOutcome` import is types only), so
 * anything that needs a reply string can have one without pulling the run
 * engine in behind it.
 */
export function replyTextForOutcome(outcome: RunOutcome): string {
  switch (outcome.status) {
    case 'completed':
      return outcome.summary
    case 'waiting_approval':
      return "It's ready for your approval. Review the request below; once you approve it, I'll continue automatically."
    case 'waiting_reply':
      return `I'm waiting to hear back from ${outcome.wait.to} before I can finish this — I'll follow up here.`
    case 'budget_paused':
      return "I've reached my token budget for this month, so I can't take this on right now — please flag it to an operator."
    case 'cancelled':
      return 'An operator stopped this before I finished — nothing further is happening on it from my side.'
    case 'failed':
      return `I ran into a problem and couldn't finish that: ${outcome.error}`
  }
}

const comparable = (value: string): string => value.replace(/\s+/g, ' ').trim()

/**
 * A streamed preamble is not a final answer. Persisted outcome copy is appended
 * whenever it adds something the stream did not already say; containment keeps
 * providers that stream the same answer with different whitespace from
 * duplicating it.
 */
export function shouldAppendPersistedAnswer(streamedText: string, persistedAnswer: string): boolean {
  const streamed = comparable(streamedText)
  const persisted = comparable(persistedAnswer)
  if (!persisted) return false
  if (!streamed) return true
  return !streamed.includes(persisted) && !persisted.includes(streamed)
}
