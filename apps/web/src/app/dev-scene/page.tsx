import { CharacterStatus, CharacterSpeech } from '@appkit/scene'

/**
 * The status pill and speech bubble, every state, on one page.
 *
 * Not a product surface — a place to LOOK at them. The floor they live on is
 * behind a sign-in and needs a populated database, so the first version of
 * these shipped never having been seen by anybody, and it showed: a pill that
 * clipped its own text into "needs… waiting on a deci…" for every character.
 * Cheap to keep, and the only thing that would have caught that.
 */
const STATES = [
  { label: 'working', tone: 'busy', activity: 'working' },
  { label: 'reading', tone: 'busy', activity: 'reading' },
  { label: 'browsing', tone: 'busy', activity: 'reading' },
  { label: 'searching', tone: 'busy', activity: 'searching' },
  { label: 'in NetSuite', tone: 'busy', activity: 'searching' },
  { label: 'writing', tone: 'busy', activity: 'writing' },
  { label: 'drafting', tone: 'busy', activity: 'writing' },
  { label: 'taking notes', tone: 'busy', activity: 'writing' },
  { label: 'at the keyboard', tone: 'busy', activity: 'working' },
  { label: 'on a call', tone: 'active', activity: 'talking' },
  { label: 'needs you', tone: 'waiting', activity: 'waiting' },
  { label: 'stuck', tone: 'trouble', activity: 'waiting' },
  { label: 'free', tone: 'idle', activity: 'idle' },
] as const

export default function DevScenePage() {
  return (
    <main className="min-h-dvh bg-canvas p-10">
      <h1 className="mb-6 text-lg font-semibold text-fg">Scene badges</h1>

      <section className="mb-10">
        <h2 className="mb-3 text-sm text-fg-muted">Status pills — every state, at three depths</h2>
        {[1, 0.8, 0.62].map((scale) => (
          <div key={scale} className="mb-4 flex flex-wrap items-center gap-3">
            {STATES.map((status) => (
              <CharacterStatus key={`${scale}-${status.label}`} status={{ ...status }} scale={scale} />
            ))}
          </div>
        ))}
      </section>

      <section className="flex flex-wrap items-end gap-10 pt-16">
        <CharacterSpeech
          speech={{ text: 'Can I send this quote over to Birla Carbon?', kind: 'say' }}
          scale={1}
        />
        <CharacterSpeech
          speech={{
            text: 'Three suppliers so far — the third is cheapest but the lead time is six weeks, so I am checking whether that still lands before the deadline.',
            kind: 'think',
          }}
          scale={1}
        />
        <CharacterSpeech speech={{ text: 'Reading foodeist.com', kind: 'think' }} scale={0.7} />
      </section>
    </main>
  )
}
