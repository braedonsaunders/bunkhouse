/**
 * Contractions, spelled out the long way. STT writes whichever form it heard
 * best: the agent's "I am on it" comes back as "I'm on it", and the containment
 * check below reads that one-character difference as a different sentence.
 * Both sides are expanded before comparison so the same words are the same
 * words whichever way they were transcribed.
 */
const CONTRACTIONS: [RegExp, string][] = [
  [/\bwon't\b/g, 'will not'],
  [/\bcan't\b/g, 'cannot'],
  [/\bain't\b/g, 'is not'],
  [/\blet's\b/g, 'let us'],
  [/\b(\w+)n't\b/g, '$1 not'],
  [/\b(i|you|we|they)'m\b/g, '$1 am'],
  [/\b(\w+)'re\b/g, '$1 are'],
  [/\b(\w+)'ve\b/g, '$1 have'],
  [/\b(\w+)'ll\b/g, '$1 will'],
  [/\b(\w+)'d\b/g, '$1 would'],
  // 's is genuinely ambiguous (is/has/possessive); "it's"/"that's"/"what's"
  // and friends are overwhelmingly "is" in speech, and a wrong expansion of a
  // possessive costs nothing — both sides go through the same rule.
  [/\b(\w+)'s\b/g, '$1 is'],
]

const tidy = (value: string): string[] => {
  let text = value.toLowerCase()
  for (const [pattern, replacement] of CONTRACTIONS) text = text.replace(pattern, replacement)
  return text
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
}

/**
 * Did the microphone just pick the agent's own voice back up?
 *
 * A caller turn on one call read "What dates are you needing? Tomorrow." — the
 * first half was the agent's own question from two turns earlier, transcribed
 * as the caller. It then asked for dates a second time and the caller swore at
 * it, because from its side the caller had asked the question. On another, the
 * agent's "I am on it, Braedon" came back as a caller turn reading "I'm on
 * it." — the contraction defeated an exact-substring check, the fake turn
 * barged in, and the agent was cut off mid-sentence twice in a row. Echo
 * cancellation is the first defence and the framework's warmup covers the
 * opening seconds; this is the second, for the case where a speaker in a room
 * feeds the agent back to itself mid-call.
 *
 * Takes the agent's recent lines, newest first, not only the last one: echo
 * arrives seconds late, and by then the line it echoes may be one or two
 * utterances back.
 *
 * Deliberately conservative: a caller quoting the agent back ("you said the
 * Travelodge?") is a real turn and must survive, so this asks whether what
 * came in is essentially CONTAINED in what was just said (after both sides
 * have their contractions expanded), not merely similar. A mistranscribed
 * echo — "I'm taking" for "I am digging" — stays undetectable by text alone;
 * that case belongs to acoustic echo cancellation, not to this check.
 */
export function echoOfAgent(heard: string, recentAgentLines: string | readonly string[] | null): boolean {
  const lines = recentAgentLines === null ? [] : typeof recentAgentLines === 'string' ? [recentAgentLines] : recentAgentLines
  const back = tidy(heard)
  // Too short to judge: "yes" after the agent said "yes" is a person agreeing.
  if (back.length < 4) return false
  const phrase = back.join(' ')
  return lines.some((line) => {
    const said = tidy(line)
    return said.length >= 4 && said.join(' ').includes(phrase)
  })
}


/**
 * Does this sound like the end of a phone call?
 *
 * A person does not stop talking and put the receiver down; they say something
 * first, and the something is short and recognisable. An agent that answers the
 * last question and immediately hangs up is technically finished and reads, to
 * the person holding the phone, as a dropped line — the call simply stops.
 *
 * Deliberately generous about what counts. The cost of getting this wrong in
 * one direction is that the agent is asked to say goodbye when it already has,
 * once, and says it again; in the other, the caller is hung up on. The caller
 * matters more, so anything that is plainly a farewell passes and everything
 * else is asked to sign off first.
 */
export function soundsLikeGoodbye(line: string | null): boolean {
  if (!line) return false
  const said = line.toLowerCase()
  return [
    /\bbye\b/,
    /\bgoodbye\b/,
    /\btake care\b/,
    /\b(talk|speak|catch)\s+(to\s+you\s+|with\s+you\s+)?(soon|later|then|tomorrow)\b/,
    /\bsee you\b/,
    /\bhave a (good|great|lovely|nice)\b/,
    /\bhave a good one\b/,
    /\ball the best\b/,
    /\bcheers\b/,
    /\bthanks for (calling|your time|the call)\b/,
    /\bgood (night|evening)\b/,
    /\benjoy (your|the)\b/,
    /\byou too\b/,
    /\blook after yourself\b/,
  ].some((pattern) => pattern.test(said))
}
