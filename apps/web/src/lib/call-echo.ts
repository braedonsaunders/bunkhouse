/**
 * Did the microphone just pick the agent's own voice back up?
 *
 * A caller turn on one call read "What dates are you needing? Tomorrow." — the
 * first half was the agent's own question from two turns earlier, transcribed
 * as the caller. It then asked for dates a second time and the caller swore at
 * it, because from its side the caller had asked the question. Echo
 * cancellation is the first defence and the framework's warmup covers the
 * opening seconds; this is the second, for the case where a speaker in a room
 * feeds the agent back to itself mid-call.
 *
 * Deliberately conservative: a caller quoting the agent back ("you said the
 * Travelodge?") is a real turn and must survive, so this asks whether what
 * came in is essentially CONTAINED in what was just said, not merely similar.
 */
export function echoOfAgent(heard: string, lastAgentLine: string | null): boolean {
  if (!lastAgentLine) return false
  const tidy = (value: string) =>
    value
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(Boolean)
  const said = tidy(lastAgentLine)
  const back = tidy(heard)
  // Too short to judge: "yes" after the agent said "yes" is a person agreeing.
  if (back.length < 4 || said.length < 4) return false
  const window = said.join(' ')
  return window.includes(back.join(' '))
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
