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

