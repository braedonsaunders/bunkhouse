/**
 * The two sounds a call makes before anyone speaks: the ringing tone while the
 * far side is being rung, and the short blip of a line connecting when they
 * pick up. Both are synthesised here on the spot — the app ships no audio
 * files and fetches nothing at runtime — and both are deliberately quiet, a
 * long way under speech, because a caller is very often already wearing
 * headphones by the time they hear them. Browsers expose no "less audio"
 * preference to consult the way they do for motion, so being quiet by default
 * is the whole of that courtesy.
 *
 * Framework-free on purpose: a factory and four methods, no React and no
 * bunkhouse types, so the call surface can lift out with its sound intact.
 * Every method is safe to call at any time and none of them can throw — a
 * browser that refuses to make a sound leaves the call itself untouched.
 */

/**
 * Peak amplitude of the ringing tone, taken across its two oscillators
 * together — present in a quiet room, startling in nobody's headphones.
 */
const RING_LEVEL = 0.06
/** The connect blip, quieter still: it is punctuation, not an announcement. */
const CONNECT_LEVEL = 0.05
/** North American ringback: 440 Hz and 480 Hz sounded together. */
const RING_FREQUENCIES = [440, 480]
/** Its cadence, unaltered — two seconds of ring, four of silence. */
const RING_SECONDS = 2
const SILENCE_SECONDS = 4
/**
 * How much of that cadence is written into the envelope the moment ringing
 * starts. Scheduling it all up front means no timer runs for the length of the
 * call and there is nothing left to leak; thirty cadences is three minutes,
 * and an agent that has not picked up by then is not going to.
 */
const RING_CADENCES = 30
/** Long enough to take the click off a tone's edge, short enough to stay crisp. */
const FADE_SECONDS = 0.02

/** The connect blip: a receiver lifted — two short notes, rising. */
const CONNECT_BLIP = [
  { frequency: 659.25, atSeconds: 0, forSeconds: 0.07 },
  { frequency: 987.77, atSeconds: 0.07, forSeconds: 0.11 },
]
const CONNECT_FADE_SECONDS = 0.012

export type CallTones = {
  /** Begins the ringing cadence. Ringing already under way is left alone. */
  startRinging(): void
  /** Silences the cadence on a short fade. Safe when nothing is ringing. */
  stopRinging(): void
  /** Sounds the connect blip once. */
  connected(): void
  /** Stops everything and closes the context. The player is spent afterwards. */
  dispose(): void
}

export function createCallTones(): CallTones {
  let context: AudioContext | null = null
  let ringing: { gain: GainNode; oscillators: OscillatorNode[] } | null = null
  let disposed = false

  /**
   * The audio context, opened on first use and never before — one opened at
   * page load is one the autoplay policy has already suspended. Null whenever
   * sound is unavailable, which every caller below reads as "stay quiet".
   */
  const open = (): AudioContext | null => {
    if (disposed) return null
    if (context) return context
    if (typeof AudioContext === 'undefined') return null
    try {
      context = new AudioContext()
    } catch {
      // No output device, or too many contexts open. The call is unaffected.
      return null
    }
    return context
  }

  /**
   * Nudge a suspended context awake. The call page is reached by a click, so
   * this normally succeeds; when the policy refuses, the promise rejects and
   * the call simply runs silent. Nothing here is allowed to reach the caller.
   */
  const wake = (audio: AudioContext) => {
    if (audio.state !== 'suspended') return
    try {
      void audio.resume().catch(() => {
        // Autoplay refused. The call carries on without its tones.
      })
    } catch {
      // Older implementations throw where they should reject. Same answer.
    }
  }

  const startRinging = () => {
    if (ringing) return
    const audio = open()
    if (!audio) return
    try {
      const gain = audio.createGain()
      gain.gain.setValueAtTime(0, audio.currentTime)
      gain.connect(audio.destination)
      const oscillators = RING_FREQUENCIES.map((frequency) => {
        const oscillator = audio.createOscillator()
        oscillator.type = 'sine'
        oscillator.frequency.setValueAtTime(frequency, audio.currentTime)
        oscillator.connect(gain)
        return oscillator
      })
      // One envelope carries both tones, so the level is the pair's rather
      // than each one's: two sines in phase would otherwise sum to twice it.
      const level = RING_LEVEL / RING_FREQUENCIES.length
      const first = audio.currentTime + FADE_SECONDS
      for (let cadence = 0; cadence < RING_CADENCES; cadence += 1) {
        const at = first + cadence * (RING_SECONDS + SILENCE_SECONDS)
        gain.gain.setValueAtTime(0, at)
        gain.gain.linearRampToValueAtTime(level, at + FADE_SECONDS)
        gain.gain.setValueAtTime(level, at + RING_SECONDS - FADE_SECONDS)
        gain.gain.linearRampToValueAtTime(0, at + RING_SECONDS)
      }
      oscillators.forEach((oscillator) => oscillator.start())
      ringing = { gain, oscillators }
      wake(audio)
    } catch {
      // Whatever the context refused, the call does not depend on it.
      ringing = null
    }
  }

  const stopRinging = () => {
    const current = ringing
    ringing = null
    if (!current || !context) return
    try {
      const now = context.currentTime
      current.gain.gain.cancelScheduledValues(now)
      current.gain.gain.setValueAtTime(current.gain.gain.value, now)
      current.gain.gain.linearRampToValueAtTime(0, now + FADE_SECONDS)
      current.oscillators.forEach((oscillator) => {
        oscillator.onended = () => current.gain.disconnect()
        oscillator.stop(now + FADE_SECONDS)
      })
    } catch {
      // The context went away underneath us; there is nothing left to silence.
    }
  }

  const connected = () => {
    const audio = open()
    if (!audio) return
    try {
      const start = audio.currentTime + CONNECT_FADE_SECONDS
      CONNECT_BLIP.forEach((note) => {
        const at = start + note.atSeconds
        const gain = audio.createGain()
        gain.gain.setValueAtTime(0, at)
        gain.gain.linearRampToValueAtTime(CONNECT_LEVEL, at + CONNECT_FADE_SECONDS)
        gain.gain.setValueAtTime(CONNECT_LEVEL, at + note.forSeconds - CONNECT_FADE_SECONDS)
        gain.gain.linearRampToValueAtTime(0, at + note.forSeconds)
        gain.connect(audio.destination)
        const oscillator = audio.createOscillator()
        oscillator.type = 'sine'
        oscillator.frequency.setValueAtTime(note.frequency, at)
        oscillator.connect(gain)
        oscillator.onended = () => gain.disconnect()
        oscillator.start(at)
        oscillator.stop(at + note.forSeconds)
      })
      wake(audio)
    } catch {
      // A blip that cannot sound is not worth a word to anybody.
    }
  }

  const dispose = () => {
    if (disposed) return
    stopRinging()
    disposed = true
    const audio = context
    context = null
    if (!audio) return
    try {
      void audio.close().catch(() => {
        // The browser closed it first. Nothing left to do.
      })
    } catch {
      // Likewise.
    }
  }

  return { startRinging, stopRinging, connected, dispose }
}
