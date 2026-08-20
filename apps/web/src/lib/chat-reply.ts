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
    case 'waiting_credential':
      return "The secure credential form is ready below. Once you submit it, I'll continue automatically without putting the credential in this conversation."
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

/**
 * What the agent said in its own words before it stopped.
 *
 * A parked run's persisted reply used to be nothing but the canned line above,
 * which reads as a form letter arriving out of nowhere: the reader is shown an
 * approval card for a phone call without the sentence explaining why a call is
 * being made at all. The model almost always said that — it is the text of the
 * assistant turn that carries the tool call — and the outcome has been handing
 * the whole transcript over the whole time.
 *
 * Only the LAST assistant turn, because earlier ones are steps the agent has
 * already narrated; and only its text parts, because the tool call itself is
 * the card underneath, not prose.
 */
export function preambleForOutcome(outcome: RunOutcome): string {
  const messages = outcome.messages ?? []
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!message || message.role !== 'assistant') continue
    const { content } = message
    const text = typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content
            .filter((part): part is { type: 'text'; text: string } =>
              typeof part === 'object' && part !== null && (part as { type?: unknown }).type === 'text'
              && typeof (part as { text?: unknown }).text === 'string')
            .map((part) => part.text)
            .join('\n')
        : ''
    return text.trim()
  }
  return ''
}

/**
 * The reply as the reader should see it: the agent's own sentence, then what
 * the surface needs to say about the state the run is in. Deduplicated,
 * because a model that already said "I'll continue once you approve" should
 * not have it said back to it.
 */
export function replyBodyForOutcome(outcome: RunOutcome): string {
  const stated = replyTextForOutcome(outcome)
  if (outcome.status === 'completed' || outcome.status === 'failed') return stated
  const preamble = preambleForOutcome(outcome)
  if (!preamble) return stated
  return shouldAppendPersistedAnswer(preamble, stated) ? `${preamble}\n\n${stated}` : preamble
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
