import 'server-only'
import { generateText } from 'ai'
import { getModel } from '@braedonsaunders/appkit-ai'
import { resolveAgentAiConfig } from './ai'

/**
 * Name a conversation from its opening exchange.
 *
 * The fallback title is the reader's own first line, which is a fair guess and
 * frequently a bad one: an opening line is usually a greeting, an instruction,
 * or a paste, and a list of those reads as a list of openings rather than a
 * list of topics. Once the agent has answered, the pair says what the
 * conversation is actually about, and one small model call is enough to say it
 * in a few words.
 *
 * Deliberately cheap and deliberately optional. It runs on the fast model, is
 * bounded hard in both directions, and every failure path — no config, no key,
 * a refusal, a timeout, a model that ignores the instruction and writes a
 * sentence — returns null and leaves the derived title alone. A conversation
 * that keeps a mediocre name is a small thing; a reply that got slower or
 * failed because naming it went wrong is not.
 */

const TITLE_MAX = 72
const TITLE_TIMEOUT_MS = 8_000
/** Enough of each side to know the subject; nowhere near enough to be a cost. */
const SAMPLE_CHARS = 1_200

export async function proposeThreadTitle(args: {
  tenantId: string
  personId: string
  asked: string
  answered: string
}): Promise<string | null> {
  try {
    const ai = await resolveAgentAiConfig(args.tenantId, args.personId)
    if (!ai) return null
    const model = getModel(ai, 'fast') ?? getModel(ai, 'smart')
    if (!model) return null

    const result = await generateText({
      model,
      abortSignal: AbortSignal.timeout(TITLE_TIMEOUT_MS),
      system:
        'You name conversations for a list in a work application. '
        + 'Reply with the subject of the exchange as a short noun phrase of two to six words. '
        + 'No quotes, no trailing punctuation, no prefix like "Conversation about". '
        + 'Use the words the people used. Reply with the title and nothing else.',
      prompt:
        `Person: ${args.asked.slice(0, SAMPLE_CHARS)}\n\n`
        + `Agent: ${args.answered.slice(0, SAMPLE_CHARS)}`,
    })
    return cleanProposedTitle(result.text)
  } catch {
    return null
  }
}

/**
 * Hold the model to the shape a list can render.
 *
 * A model asked for a title sometimes returns a sentence, a quoted string, or
 * a preamble. Everything recoverable is recovered; anything still wrong — long
 * prose, or an empty answer — is refused outright rather than clipped into
 * something that reads like a truncated thought.
 */
export function cleanProposedTitle(raw: string): string | null {
  const firstLine = raw.trim().split('\n').find((line) => line.trim().length > 0)
  if (!firstLine) return null
  const flat = firstLine
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
    .replace(/[.,;:]+$/, '')
    .trim()
  if (!flat) return null
  // A model that wrote a sentence did not follow the instruction, and half of
  // its sentence is not a title.
  if (flat.length > TITLE_MAX) return null
  return flat
}
