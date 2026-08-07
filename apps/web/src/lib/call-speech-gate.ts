/**
 * The speech boundary: the last thing between a language model and a caller's ear.
 *
 * Every defect this module exists for is the same event — a model asked to
 * produce speech with nothing grounded to say, filling the gap from its own
 * weights. In one evening on one deployment:
 *
 *   • handed the progress note "Checking NetSuite", an agent said "Just got it
 *     — our biggest customer is a major steel processing client", then named
 *     "Hamilton Steel Group". No such customer exists. Corrected by the caller,
 *     it named "Imperial Metals" instead and called it "the confirmed name from
 *     our records". The real answer, Birla Carbon Canada Ltd, was sitting in
 *     the run record at the time.
 *   • asked for "one short line of company" to cover a silence, an agent spoke
 *     a phishing message out of its training data — "your account has been
 *     flagged... may be in violation of the User Agreement" — to a caller, in
 *     their colleague's voice, on a finance call.
 *   • a reasoning model's scratchpad arrived in the content field and went
 *     straight to the speaker: 595 characters of "do not mention any of this in
 *     your answer... start with a thought block" said out loud as a greeting.
 *
 * None of these are fixable with another prompt rule, and the attempt is what
 * produced a 13KB instruction block that models increasingly ignore. Worse,
 * fabrication is self-reinforcing: once an agent has invented an entity,
 * feeding it the truth does not reliably stop it — which is exactly what the
 * caller above saw when their correction produced a second invented name.
 *
 * So the rule is mechanical instead:
 *
 *      THE MODEL CHOOSES WORDS. IT NEVER CHOOSES FACTS.
 *
 * Anything specific enough to act on — a name, a figure — must have arrived on
 * this call from somewhere trustworthy: a tool result, or the caller's own
 * mouth. The ledger remembers what arrived; the gate refuses to speak anything
 * else. A model may still phrase things however it likes, round $4,347,898.35
 * to "about four and a third million", and be as warm as it wants. It simply
 * cannot introduce a fact that nothing gave it.
 *
 * Deliberately pure — no database, no framework, no network — so the whole of
 * it is testable without a call, and so the same screening can run anywhere.
 */

/** What the caller may hear, once it has been screened. */
export type SpeechVerdict =
  /** Safe to say. `text` may differ from the input: reasoning is stripped. */
  | { ok: true; text: string }
  /**
   * Do not say this. `reason` is for the operator and the run record; the
   * caller never hears it. `offending` names what could not be grounded, which
   * is what makes a blocked utterance debuggable instead of mysterious.
   */
  | { ok: false; reason: string; offending: string[] }

/**
 * Everything that has arrived on this call from somewhere that can be trusted:
 * tool results, and what the caller actually said. Seeded with the things that
 * are true before anyone speaks — the company's own name, the roster, the
 * agent's own identity — because those are facts too, they just did not arrive
 * through a tool.
 */
export type FactLedger = {
  /** Record something trustworthy. Objects are flattened; size is bounded. */
  learn: (value: unknown) => void
  /** Does this phrase appear in what arrived? Substring, case-insensitive. */
  knowsPhrase: (phrase: string) => boolean
  /** Is there a known figure that rounds to this one at its own precision? */
  knowsNumber: (value: number, significantDigits: number) => boolean
  /** How much has been learned, in characters. For the record, and for tests. */
  size: () => number
}

/**
 * How much learned text one call may hold. A NetSuite report is megabytes and a
 * long call makes many; past this the oldest is dropped rather than growing the
 * process without limit. Generous enough that nothing realistic is forgotten
 * while it still matters.
 */
const LEDGER_CAP_CHARS = 4_000_000

/** Flatten anything a tool returned into the text it might contain. */
function textOf(value: unknown, depth = 0): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (depth > 6) return ''
  if (Array.isArray(value)) return value.map((entry) => textOf(entry, depth + 1)).join(' ')
  if (typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .map(([key, entry]) => `${key} ${textOf(entry, depth + 1)}`)
      .join(' ')
  }
  return ''
}

/** Lowercased, punctuation flattened to spaces — how phrases are compared. */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/** A number's significant digits, as an integer count. */
function significantDigits(token: string): number {
  const digits = token.replace(/[^0-9]/g, '').replace(/^0+/, '')
  const trimmed = digits.replace(/0+$/, '')
  return Math.max(1, (trimmed || digits).length)
}

/** Round to N significant figures, so a rounded quote can match its source. */
function toSignificant(value: number, sig: number): number {
  if (value === 0 || !Number.isFinite(value)) return 0
  const magnitude = Math.ceil(Math.log10(Math.abs(value)))
  const factor = 10 ** (sig - magnitude)
  return Math.round(value * factor) / factor
}

const MAGNITUDES: Record<string, number> = {
  k: 1_000,
  thousand: 1_000,
  m: 1_000_000,
  mm: 1_000_000,
  million: 1_000_000,
  bn: 1_000_000_000,
  b: 1_000_000_000,
  billion: 1_000_000_000,
}

/** Every number in a piece of text, with the magnitude word applied. */
function numbersIn(text: string): { token: string; value: number; percent: boolean }[] {
  const found: { token: string; value: number; percent: boolean }[] = []
  const pattern = /(\$\s*)?(\d[\d,]*(?:\.\d+)?)\s*(k|thousand|mm|m|million|bn|b|billion)?\s*(%)?/gi
  for (const match of text.matchAll(pattern)) {
    const [, currency, digits = '', magnitude, percent] = match
    const base = Number(digits.replace(/,/g, ''))
    if (!Number.isFinite(base)) continue
    const scale = magnitude ? (MAGNITUDES[magnitude.toLowerCase()] ?? 1) : 1
    found.push({
      token: `${currency ?? ''}${digits}${magnitude ?? ''}`,
      value: base * scale,
      percent: Boolean(percent),
    })
  }
  return found
}

export function createFactLedger(seed: readonly string[] = []): FactLedger {
  let learned = ''
  const numbers: number[] = []

  const ledger: FactLedger = {
    learn: (value) => {
      const text = textOf(value)
      if (!text) return
      learned += ` ${normalize(text)}`
      if (learned.length > LEDGER_CAP_CHARS) learned = learned.slice(-LEDGER_CAP_CHARS)
      for (const number of numbersIn(text)) numbers.push(number.value)
    },
    knowsPhrase: (phrase) => {
      const needle = normalize(phrase)
      if (!needle) return true
      return learned.includes(needle)
    },
    knowsNumber: (value, sig) => {
      const wanted = toSignificant(value, sig)
      return numbers.some((known) => toSignificant(known, sig) === wanted)
    },
    size: () => learned.length,
  }
  for (const entry of seed) ledger.learn(entry)
  return ledger
}

// --- What must never be spoken, whatever the ledger says --------------------

/**
 * A reasoning model's scratchpad, in every wrapper seen in the wild. Some
 * providers return it in the content field rather than a separate channel, and
 * a cascade speaks whatever it is handed.
 */
const REASONING_BLOCKS = [
  /<think>[\s\S]*?<\/think>/gi,
  /<thinking>[\s\S]*?<\/thinking>/gi,
  /<reasoning>[\s\S]*?<\/reasoning>/gi,
  /<scratchpad>[\s\S]*?<\/scratchpad>/gi,
  /<\|begin_of_thought\|>[\s\S]*?<\|end_of_thought\|>/gi,
  /^\s*thought\s*:[\s\S]*?(?=\n\s*(?:answer|reply|response)\s*:)/gi,
]

/** An unterminated opener — the stream was cut mid-thought. Drop the tail. */
const REASONING_OPENERS = [/<think>[\s\S]*$/i, /<thinking>[\s\S]*$/i, /<\|begin_of_thought\|>[\s\S]*$/i]

/**
 * Language that only exists inside instructions. A colleague on the phone does
 * not say "in your answer" or "do not mention any of this" — a model reciting
 * its own brief does. Matching one of these means the scaffolding escaped, and
 * no amount of it is safe to read out.
 */
const PROMPT_LEAK = [
  /\bdo not mention (any of )?this\b/i,
  /\binternal reasoning\b/i,
  /\bthought block\b/i,
  /\bin (your|the) (answer|reply|response)\b/i,
  /\byour (system )?(prompt|instructions|persona)\b/i,
  /\bas an ai\b/i,
  /\blanguage model\b/i,
  /\bfirst write\b.*\bthen write\b/i,
  /\bkeep (it|your) (first )?greeting short\b/i,
  /\bthe caller says\b/i,
  /\btool call\b/i,
  /\b(do_work|check_work|take_assignment|reply_to_thread|run_script|end_call|save_memory)\b/i,
]

/**
 * Unsolicited alarm. An agent has no business telling a caller their account is
 * suspended, flagged, or under investigation — that claim belongs to a human
 * and a legal process, never to a filler line. This exists because one was
 * spoken to a real caller.
 */
const ALARMING = [
  /\baccount (has been |is |was )?(flagged|suspended|locked|terminated|under (review|investigation))\b/i,
  /\bviolation of\b.*\b(user )?(agreement|policy|terms)\b/i,
  /\bverification process\b/i,
  /\bcontact .{0,30}support\b/i,
  /\bsecurity (alert|warning|breach)\b/i,
]

/** Strip a model's scratchpad out of what it means to say. */
export function stripReasoning(text: string): string {
  let cleaned = text
  for (const block of REASONING_BLOCKS) cleaned = cleaned.replace(block, ' ')
  for (const opener of REASONING_OPENERS) cleaned = cleaned.replace(opener, ' ')
  return cleaned.replace(/\s+/g, ' ').trim()
}

/**
 * Capitalized runs of two or more words — the shape a company, product or
 * person's name takes. Two words is the floor on purpose: single capitalized
 * words are mostly sentence openings and ordinary nouns, and flagging them
 * would block more real speech than it saved. Sentence-leading words are
 * dropped from the front of a run for the same reason.
 */
function properNounPhrases(text: string): string[] {
  const phrases: string[] = []
  // Split on sentence boundaries so a run cannot start with the capital that
  // merely began a sentence.
  for (const sentence of text.split(/(?<=[.!?])\s+|\n+/)) {
    const words = sentence.trim().split(/\s+/)
    let run: string[] = []
    const flush = () => {
      if (run.length >= 2) phrases.push(run.join(' '))
      run = []
    }
    words.forEach((raw, index) => {
      const word = raw.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '')
      const capitalized = /^[A-Z][A-Za-z0-9&./'-]*$/.test(word)
      // The first word of a sentence is capitalized by grammar, not by name.
      if (capitalized && !(index === 0 && run.length === 0)) {
        run.push(word)
        // Punctuation ends a name. Without this, "Hey Braedon, Bill here"
        // reads as one three-word name that no ledger will ever contain, and
        // an ordinary greeting gets refused.
        if (/[^A-Za-z0-9&./'-]$/.test(raw)) flush()
      } else flush()
    })
    flush()
  }
  return phrases
}

/**
 * Below this, a figure is a count, an ordinal, a date or a quantity — "give me
 * two seconds", "173 invoices" — and gating it costs more in false alarms than
 * it earns. Above it, a figure is the sort of number somebody acts on.
 */
const NUMBER_FLOOR = 1_000

export type ScreenOptions = {
  /**
   * False for lines the process wrote itself — fixed filler, deterministic
   * renderings — which need the safety checks but cannot be ungrounded, since
   * nothing generated them. Defaults to true.
   */
  grounded?: boolean
}

/**
 * Screen one utterance. Returns the text to say, or a refusal and what could
 * not be grounded.
 *
 * The order matters: scaffolding and alarm are refused whatever the ledger
 * holds, because a phishing line quoted out of a tool result is not safe just
 * because a tool result contained it.
 */
export function screenUtterance(
  text: string,
  ledger: FactLedger,
  options: ScreenOptions = {},
): SpeechVerdict {
  const cleaned = stripReasoning(text)
  if (!cleaned) return { ok: false, reason: 'nothing was left once the model’s scratchpad was removed', offending: [] }

  for (const pattern of PROMPT_LEAK) {
    const hit = cleaned.match(pattern)
    if (hit) {
      return { ok: false, reason: 'the instructions leaked into what was about to be said', offending: [hit[0]] }
    }
  }
  for (const pattern of ALARMING) {
    const hit = cleaned.match(pattern)
    if (hit) {
      return { ok: false, reason: 'an alarming claim no agent may make unprompted', offending: [hit[0]] }
    }
  }

  if (options.grounded === false) return { ok: true, text: cleaned }

  const offending: string[] = []
  for (const phrase of properNounPhrases(cleaned)) {
    if (!ledger.knowsPhrase(phrase)) offending.push(phrase)
  }
  for (const number of numbersIn(cleaned)) {
    // A percentage is almost always computed from figures that ARE grounded,
    // and demanding it appear verbatim would block the most useful sentence an
    // analyst says. The figures it was computed from are still screened.
    if (number.percent) continue
    if (Math.abs(number.value) < NUMBER_FLOOR) continue
    if (!ledger.knowsNumber(number.value, significantDigits(number.token))) offending.push(number.token)
  }

  if (offending.length > 0) {
    return {
      ok: false,
      reason: 'nothing that arrived on this call backs this up',
      offending,
    }
  }
  return { ok: true, text: cleaned }
}

/**
 * What is said instead, when everything an utterance contained was refused.
 *
 * Silence is not an option — dead air is the defect that started all of this,
 * and a caller who asked a question and got nothing assumes the line dropped.
 * This is the honest thing to say: the agent does not have it yet, and is not
 * going to guess. It is deliberately the sentence the model SHOULD have
 * produced on its own.
 */
export const UNGROUNDED_FALLBACK =
  'Let me get you the exact figure rather than guess at it — give me a moment.'

/** A sentence ending, or a line break. Where an utterance may be cut safely. */
const SENTENCE_END = /([.!?]+["')\]]?\s+|\n+)/

/**
 * Screen a stream of text on its way to the voice, sentence by sentence.
 *
 * Buffered per sentence rather than per utterance on purpose: screening needs
 * a whole claim to judge ("that top customer is X" means nothing in three-token
 * fragments), but waiting for the entire reply before speaking any of it would
 * cost the streaming handoff that keeps time-to-first-audio down. A sentence is
 * the smallest unit that is both judgable and natural to speak.
 *
 * A refused sentence is dropped and reported; the rest of the utterance still
 * goes out, because one ungrounded claim in an otherwise good answer should
 * cost that claim and not the answer. If EVERY sentence is refused, the
 * fallback goes out instead, so a refusal never becomes silence.
 */
export async function* screenSpeechStream(
  chunks: AsyncIterable<string>,
  ledger: FactLedger,
  onRefused: (verdict: Extract<SpeechVerdict, { ok: false }>, sentence: string) => void,
  options: ScreenOptions = {},
): AsyncGenerator<string> {
  let buffer = ''
  let spoke = false
  let refused = false

  const flush = function* (sentence: string): Generator<string> {
    const trimmed = sentence.trim()
    if (!trimmed) return
    let verdict: SpeechVerdict
    try {
      verdict = screenUtterance(trimmed, ledger, options)
    } catch {
      // FAIL OPEN, on purpose, and this is the most important decision in the
      // file. This generator sits in the middle of the pipe that turns words
      // into audio: a throw here does not produce a caught error somewhere
      // useful, it produces a call where the agent answers and then says
      // nothing — which is a worse failure than the fabrication this exists to
      // prevent, and one that is far harder to notice. A screen that cannot
      // run lets the words past.
      spoke = true
      yield sentence
      return
    }
    if (verdict.ok) {
      spoke = true
      yield verdict.text.endsWith(' ') ? verdict.text : `${verdict.text} `
      return
    }
    refused = true
    try {
      onRefused(verdict, trimmed)
    } catch {
      // Reporting must never be able to stop the call talking either.
    }
  }

  for await (const chunk of chunks) {
    buffer += chunk
    // Cut on every completed sentence the buffer now holds.
    let match = buffer.match(SENTENCE_END)
    while (match?.index !== undefined) {
      const end = match.index + match[0].length
      const sentence = buffer.slice(0, end)
      buffer = buffer.slice(end)
      yield* flush(sentence)
      match = buffer.match(SENTENCE_END)
    }
  }
  yield* flush(buffer)

  if (!spoke && refused) yield UNGROUNDED_FALLBACK
}
