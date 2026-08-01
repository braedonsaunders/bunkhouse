import assert from 'node:assert/strict'

/**
 * The call's sounds, exercised against a stub Web Audio implementation.
 *
 * The real thing can only be judged by ear, and a phone call is exactly the
 * wrong place to find out that a sound misbehaves — so what is checked here is
 * the contract the module makes about itself: that it stays quiet when it
 * cannot play, that nothing it exposes can throw at any point in a call's life,
 * that starting twice does not stack two keyboards on top of each other, and
 * that everything it starts, it stops.
 */

type Scheduled = { at: number; value: number; kind: 'set' | 'linear' | 'exp' }

const gains: { events: Scheduled[]; disconnected: boolean }[] = []
const sources: { started: boolean; stopped: boolean; loop: boolean }[] = []
let contexts = 0
let closed = 0

function param() {
  const events: Scheduled[] = []
  return {
    events,
    value: 0,
    setValueAtTime: (value: number, at: number) => events.push({ at, value, kind: 'set' }),
    linearRampToValueAtTime: (value: number, at: number) => events.push({ at, value, kind: 'linear' }),
    exponentialRampToValueAtTime: (value: number, at: number) => events.push({ at, value, kind: 'exp' }),
    cancelScheduledValues: () => {},
  }
}

class StubAudioContext {
  currentTime = 0
  sampleRate = 48_000
  state = 'running'
  destination = {}
  constructor() {
    contexts += 1
  }
  createGain() {
    const gain = param()
    const node = { gain, connect: () => {}, disconnect: () => (record.disconnected = true) }
    const record = { events: gain.events, disconnected: false }
    gains.push(record)
    return node
  }
  createOscillator() {
    return {
      type: '',
      frequency: param(),
      connect: () => {},
      start: () => {},
      stop: () => {},
      onended: null as (() => void) | null,
    }
  }
  createBiquadFilter() {
    return { type: '', frequency: param(), Q: param(), connect: () => {}, disconnect: () => {} }
  }
  createBufferSource() {
    const record = { started: false, stopped: false, loop: false }
    sources.push(record)
    return {
      buffer: null as unknown,
      set loop(value: boolean) {
        record.loop = value
      },
      get loop() {
        return record.loop
      },
      connect: () => {},
      start: () => (record.started = true),
      stop: () => (record.stopped = true),
      onended: null as (() => void) | null,
    }
  }
  createBuffer(_channels: number, frames: number) {
    const data = new Float32Array(frames)
    return { getChannelData: () => data }
  }
  async close() {
    closed += 1
  }
  async resume() {}
}

;(globalThis as { AudioContext?: unknown }).AudioContext = StubAudioContext

const { createCallTones } = await import('../src/lib/call-tones.ts')

// --- the keyboard ------------------------------------------------------------
const tones = createCallTones()
tones.startTyping()

assert.equal(sources.length, 1, 'typing runs on one looped noise source, not one per keystroke')
assert.equal(sources[0]!.started, true, 'the source is started')
assert.equal(sources[0]!.loop, true, 'and looped, so a two-second buffer covers a long wait')

const keyboard = gains.at(-1)!
const strikes = keyboard.events.filter((e) => e.kind === 'linear' && e.value > 0)
assert.ok(strikes.length > 300, `a couple of minutes of typing is a lot of keystrokes, got ${strikes.length}`)
assert.ok(strikes.length < 5_000, `but not an implausible machine-gun, got ${strikes.length}`)

// Quieter than every other sound on the call: it is the only one that lasts.
const loudest = Math.max(...strikes.map((e) => e.value))
assert.ok(loudest <= 0.05, `typing stays under the ring and the figures, peaked at ${loudest}`)

// A hand, not a metronome. Identical gaps are what gives a loop away.
const gaps = strikes.slice(1).map((e, i) => e.at - strikes[i]!.at)
const distinct = new Set(gaps.map((g) => g.toFixed(4)))
assert.ok(distinct.size > gaps.length / 2, 'the gaps between keystrokes vary')
assert.ok(Math.max(...gaps) > 0.3, 'and it stops to read something now and again')

// --- starting twice does not stack two keyboards -----------------------------
tones.startTyping()
assert.equal(sources.length, 1, 'a second start while already typing is ignored')

// --- everything it starts, it stops ------------------------------------------
tones.stopTyping()
assert.equal(sources[0]!.stopped, true, 'stopping typing stops the source')
assert.equal(keyboard.events.at(-1)!.value, 0, 'on a ramp down to silence rather than a cut')
tones.stopTyping()
assert.equal(sources.length, 1, 'stopping twice is harmless')

// --- a call cannot end with someone still typing -----------------------------
tones.startTyping()
assert.equal(sources.length, 2, 'typing can start again after it stopped')
tones.hangup()
assert.equal(sources[1]!.stopped, true, 'hanging up takes the hands off the keys')

// --- and none of it survives the call ----------------------------------------
tones.startTyping()
tones.dispose()
assert.equal(sources.at(-1)!.stopped, true, 'disposing stops typing that was still running')
assert.equal(closed, 1, 'and closes the context')
tones.dispose()
assert.equal(closed, 1, 'disposing twice closes nothing twice')
tones.startTyping()
assert.equal(sources.length, 3, 'a spent player makes no more sound')

// --- a browser that will not play anything -----------------------------------
;(globalThis as { AudioContext?: unknown }).AudioContext = undefined
const silent = createCallTones()
const before = contexts
for (const call of [
  () => silent.startRinging(),
  () => silent.startTyping(),
  () => silent.connected(),
  () => silent.stopTyping(),
  () => silent.stopRinging(),
  () => silent.hangup(),
  () => silent.dispose(),
]) {
  assert.doesNotThrow(call, 'every method absorbs its own failure')
}
assert.equal(contexts, before, 'and none of them conjured a context that cannot exist')

console.log(`call-tones: ok (${strikes.length} keystrokes scheduled, peak ${loudest.toFixed(3)})`)
