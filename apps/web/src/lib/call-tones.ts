/**
 * The four sounds a call makes around the talking: the ringing tone while the
 * far side is being rung, the short blip of a line connecting when they pick
 * up, the keyboard under an agent that has gone away to do something, and the
 * fall of a receiver going down when it is over. All are synthesised here on
 * the spot — the app ships no audio files and fetches nothing at runtime — and
 * all are deliberately quiet, a long way under speech, because a caller is
 * very often already wearing headphones by the time they hear them. Browsers
 * expose no "less audio" preference to consult the way they do for motion, so
 * being quiet by default is the whole of that courtesy.
 *
 * Framework-free on purpose: a factory and seven methods, no React and no
 * bunkhouse types, so the call surface can lift out with its sound intact.
 * Every method is safe to call at any time and none of them can throw — a
 * browser that refuses to make a sound leaves the call itself untouched.
 */

/**
 * Peak amplitude of the ringing tone, taken across its two oscillators
 * together — present in a quiet room, startling in nobody's headphones.
 */
const RING_LEVEL = 0.06
/** The short figures, quieter still: they are punctuation, not announcements. */
const FIGURE_LEVEL = 0.05
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

/**
 * The keyboard, for the stretches when the agent has stopped talking and gone
 * off to look something up.
 *
 * Silence on a phone call is not neutral: a caller who hears nothing assumes
 * the line has dropped, and starts saying "hello?" into it. A person in that
 * position types, and the other end can hear them doing it, which is why it
 * never needs explaining. So this plays only while an action is genuinely in
 * flight — it is a report of work, not a comfort noise, and an agent that is
 * idle stays silent.
 *
 * Quieter than every other sound here, because unlike them it is the only one
 * that goes on for any length of time.
 */
const TYPING_LEVEL = 0.028
/**
 * One keystroke, envelope only: a hard attack and a short decay, struck out of
 * a noise source that runs underneath. Shaping the gain rather than starting a
 * source per key is the same trick the ring cadence uses — one node, many
 * scheduled events, nothing to clean up per keystroke.
 */
const KEY_ATTACK_SECONDS = 0.001
const KEY_DECAY_SECONDS = 0.014
/**
 * The gaps. Real typing is not a metronome: a fast hand lands somewhere in
 * here, and every so often stops dead to read something, which is the pause
 * that makes it sound like a person rather than a printer.
 */
const KEY_GAP_MIN_SECONDS = 0.055
const KEY_GAP_MAX_SECONDS = 0.16
const THINK_PAUSE_CHANCE = 0.055
const THINK_PAUSE_MIN_SECONDS = 0.4
const THINK_PAUSE_MAX_SECONDS = 1.1
/** Where a plastic key sits: enough top to click, not enough to hiss. */
const KEY_FILTER_HZ = 1_900
const KEY_FILTER_Q = 0.9
/**
 * How far ahead the keystrokes are written when typing starts.
 *
 * Same reasoning as the ring cadence: scheduling it up front means no timer
 * runs while the call does, so there is nothing to leak and nothing to tidy up
 * if the page goes away mid-word. Two minutes is longer than any single action
 * an agent takes on a live call; a burst that somehow outlasts it simply falls
 * quiet, which is what a person who has stopped typing sounds like anyway.
 */
const TYPING_SECONDS = 120
/** One noise buffer, looped. Long enough that the loop is not a pitch. */
const NOISE_BUFFER_SECONDS = 2

/**
 * One note of a short figure: what to sound, when it starts relative to the
 * figure, and how long it lasts. A note is never shorter than twice the
 * figure's fade, so its envelope always has room for both edges.
 */
type ToneNote = { frequency: number; atSeconds: number; forSeconds: number }

/** The connect blip: a receiver lifted — two short notes, rising. */
const CONNECT_BLIP: readonly ToneNote[] = [
  { frequency: 659.25, atSeconds: 0, forSeconds: 0.07 },
  { frequency: 987.77, atSeconds: 0.07, forSeconds: 0.11 },
]
/** Crisp edges: enough to take the click off the blip, no more. */
const CONNECT_FADE_SECONDS = 0.012

/**
 * The hang-up: the blip's rise inverted — it opens on the same note the blip
 * did and falls a fifth from it, onto a tone held a beat longer than it is
 * struck. Two notes down and away is what a receiver going back on its cradle
 * sounds like; the tail on the second is the line let go rather than cut.
 */
const HANGUP_TONE: readonly ToneNote[] = [
  { frequency: 659.25, atSeconds: 0, forSeconds: 0.1 },
  { frequency: 440, atSeconds: 0.1, forSeconds: 0.22 },
]
/** Softer edges than the blip's, which is what makes the last note release. */
const HANGUP_FADE_SECONDS = 0.035

export type CallTones = {
  /** Begins the ringing cadence. Ringing already under way is left alone. */
  startRinging(): void
  /** Silences the cadence on a short fade. Safe when nothing is ringing. */
  stopRinging(): void
  /** Sounds the connect blip once. */
  connected(): void
  /** Starts the keyboard under an agent at work. Already typing is left alone. */
  startTyping(): void
  /** Lifts the hands off the keys on a short fade. Safe when nothing is typing. */
  stopTyping(): void
  /** Sounds the hang-up tone once — the line released. Under a third of a second. */
  hangup(): void
  /** Stops everything and closes the context. The player is spent afterwards. */
  dispose(): void
}

export function createCallTones(): CallTones {
  let context: AudioContext | null = null
  let ringing: { gain: GainNode; oscillators: OscillatorNode[] } | null = null
  let typing: { gain: GainNode; source: AudioBufferSourceNode; filter: BiquadFilterNode } | null = null
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
   * Nudge a suspended context awake. The call workspace is reached by a click, so
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

  /**
   * Sound a short figure: every note on its own oscillator and envelope, the
   * whole thing scheduled in one go so no timer is left running behind it.
   * Each node tears itself down when its note is over, so a call that opens
   * and closes a dozen times still holds nothing.
   */
  const figure = (notes: readonly ToneNote[], fade: number) => {
    const audio = open()
    if (!audio) return
    try {
      const start = audio.currentTime + fade
      notes.forEach((note) => {
        const at = start + note.atSeconds
        const gain = audio.createGain()
        gain.gain.setValueAtTime(0, at)
        gain.gain.linearRampToValueAtTime(FIGURE_LEVEL, at + fade)
        gain.gain.setValueAtTime(FIGURE_LEVEL, at + note.forSeconds - fade)
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
      // A figure that cannot sound is not worth a word to anybody.
    }
  }

  const connected = () => figure(CONNECT_BLIP, CONNECT_FADE_SECONDS)

  /** A span of white noise to strike the keys out of, made once per context. */
  const noiseBuffer = (audio: AudioContext): AudioBuffer => {
    const frames = Math.floor(audio.sampleRate * NOISE_BUFFER_SECONDS)
    const buffer = audio.createBuffer(1, frames, audio.sampleRate)
    const channel = buffer.getChannelData(0)
    for (let frame = 0; frame < frames; frame += 1) channel[frame] = Math.random() * 2 - 1
    return buffer
  }

  const startTyping = () => {
    if (typing) return
    const audio = open()
    if (!audio) return
    try {
      const gain = audio.createGain()
      gain.gain.setValueAtTime(0, audio.currentTime)
      // Bandpassed so it reads as a key rather than as static: noise straight
      // to the destination is a hiss, and a hiss under a phone call is a fault.
      const filter = audio.createBiquadFilter()
      filter.type = 'bandpass'
      filter.frequency.setValueAtTime(KEY_FILTER_HZ, audio.currentTime)
      filter.Q.setValueAtTime(KEY_FILTER_Q, audio.currentTime)
      filter.connect(gain)
      gain.connect(audio.destination)

      const source = audio.createBufferSource()
      source.buffer = noiseBuffer(audio)
      source.loop = true
      source.connect(filter)

      // Every keystroke is one strike of this envelope. Levels wander a little
      // either side of the nominal — a hand does not hit every key equally,
      // and identical keys are the thing that gives a loop away.
      let at = audio.currentTime + FADE_SECONDS
      const until = at + TYPING_SECONDS
      while (at < until) {
        const level = TYPING_LEVEL * (0.72 + Math.random() * 0.56)
        gain.gain.setValueAtTime(0, at)
        gain.gain.linearRampToValueAtTime(level, at + KEY_ATTACK_SECONDS)
        gain.gain.exponentialRampToValueAtTime(0.0001, at + KEY_ATTACK_SECONDS + KEY_DECAY_SECONDS)
        const pause =
          Math.random() < THINK_PAUSE_CHANCE
            ? THINK_PAUSE_MIN_SECONDS + Math.random() * (THINK_PAUSE_MAX_SECONDS - THINK_PAUSE_MIN_SECONDS)
            : KEY_GAP_MIN_SECONDS + Math.random() * (KEY_GAP_MAX_SECONDS - KEY_GAP_MIN_SECONDS)
        at += pause
      }
      gain.gain.setValueAtTime(0, until)
      source.start()
      typing = { gain, source, filter }
      wake(audio)
    } catch {
      // A keyboard that will not sound costs the call nothing.
      typing = null
    }
  }

  const stopTyping = () => {
    const current = typing
    typing = null
    if (!current || !context) return
    try {
      const now = context.currentTime
      current.gain.gain.cancelScheduledValues(now)
      current.gain.gain.setValueAtTime(current.gain.gain.value, now)
      current.gain.gain.linearRampToValueAtTime(0, now + FADE_SECONDS)
      current.source.onended = () => {
        current.filter.disconnect()
        current.gain.disconnect()
      }
      current.source.stop(now + FADE_SECONDS)
    } catch {
      // The context went away underneath us; there is nothing left to silence.
    }
  }

  // The ring and the hang-up are mutually exclusive by definition — a call
  // that ends while it is still ringing stops ringing at that moment — so the
  // cadence is silenced first and the receiver goes down over the quiet.
  const hangup = () => {
    stopRinging()
    // Hands off the keys too: a call cannot end with someone still typing on
    // the other end of it.
    stopTyping()
    figure(HANGUP_TONE, HANGUP_FADE_SECONDS)
  }

  const dispose = () => {
    if (disposed) return
    stopRinging()
    stopTyping()
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

  return { startRinging, stopRinging, connected, startTyping, stopTyping, hangup, dispose }
}
