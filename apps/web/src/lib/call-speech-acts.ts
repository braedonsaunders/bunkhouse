/**
 * What the work has to say, as a shape rather than a sentence.
 *
 * The worker used to hand the talker a string and the talker decided what to do
 * with it. That is how "Checking NetSuite" — a status note containing no answer
 * at all — became "Just got it, our biggest customer is a major steel
 * processing client", and then a company that does not exist. A model handed
 * prose and asked to put it in its own words will fill whatever gap the
 * conversation has left open, and the gap that afternoon was an unanswered
 * question about a customer name.
 *
 * The fix is not a better instruction, it is a smaller opening. A speech act
 * says what KIND of thing happened, and the kind decides how it reaches the
 * caller:
 *
 *   progress  — presence, not information. Contains no answer, so it is never
 *               given to a model to phrase. Rendered here, or covered by a
 *               fixed filler line.
 *   result    — the answer. The one act that carries facts, and the only one
 *               a model is allowed to voice.
 *   approval  — parked on a human decision. Must be heard, must not be
 *               embellished.
 *   failed    — trouble the caller can act on. Same.
 *
 * Pure: no framework, no database, no model. The rendering is a function of the
 * act and nothing else, which is what makes it testable and what makes it
 * impossible for it to invent anything.
 */

/** What happened, in a shape. */
export type SpeechAct =
  /** Where the work has got to. Carries no answer, by construction. */
  | { type: 'progress'; workId: string; activity: string }
  /** The answer. The only act whose words came from the work itself. */
  | { type: 'result'; workId: string; answer: string }
  /** Parked on a human decision. */
  | { type: 'approval'; workId: string; action: string }
  /** It ran into trouble. */
  | { type: 'failed'; workId: string; trouble: string }

/** The mailbox's priority kinds, which are the act types by another name. */
export type SpeechActKind = SpeechAct['type']

/**
 * Whether a model is allowed to choose the words for this act.
 *
 * Only a result. Everything else is either presence (progress) or something
 * that must reach the caller exactly as it is (approval, failure) — and every
 * one of those was, at some point, embellished into something untrue.
 */
export function mayBeVoicedByModel(act: SpeechAct): boolean {
  return act.type === 'result'
}

/**
 * Whether this act carries anything the caller does not already have. Progress
 * is the only act that can be skipped entirely without losing information, and
 * on a session where the model would have to speak it, skipping is safer than
 * asking.
 */
export function isPresenceOnly(act: SpeechAct): boolean {
  return act.type === 'progress'
}

/** Trim a rendered line to something sayable, on a word boundary. */
function clip(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (clean.length <= max) return clean
  const cut = clean.slice(0, max)
  const lastSpace = cut.lastIndexOf(' ')
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).replace(/[,;:—-]+$/, '')}…`
}

/**
 * The act, as a sentence — deterministically. No model, no template variables
 * that could carry an instruction, no path by which this returns anything the
 * act did not contain.
 */
export function renderSpeechAct(act: SpeechAct): string {
  switch (act.type) {
    case 'progress':
      return clip(act.activity, 120)
    case 'result':
      return clip(act.answer, 1_200)
    case 'approval':
      return clip(act.action, 240)
    case 'failed':
      return clip(act.trouble, 240)
  }
}

/**
 * Several acts at one boundary, as one thing to say. One line each: these are
 * separate facts and running them into a paragraph is how a status note ends up
 * read as a sentence of an answer.
 */
export function renderDelivery(acts: readonly SpeechAct[]): string {
  return acts.map(renderSpeechAct).filter(Boolean).join('\n')
}
