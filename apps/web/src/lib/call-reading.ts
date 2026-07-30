/**
 * What this call can actually do about a web page — and the words that say so.
 *
 * The third contract: an agent is never told it has something it does not
 * have. That sounds obvious. It has been broken three separate ways, each one
 * a caller being promised something to their face:
 *
 * - the fetch ability was taken off every call so pages would be VISITED where
 *   the caller can watch, and an agent whose computer_use dial sits on
 *   'approval' then parked every browser_open awaiting a sign-off nobody gives
 *   mid-call — three for three on one call — with no route left and nothing
 *   saying so;
 * - the instruction written to patch that told the agent to "read pages with
 *   read_webpage instead", which by then had been folded into one perception
 *   ability and was no longer in the set at all: a sentence naming a tool that
 *   does not exist, handed to the worker AND spoken by the talker;
 * - and the kit sentence promised every caller a real browser to drive
 *   whatever the dial said, so an agent forbidden computer use still told them
 *   it would pull the page up.
 *
 * So one resolution decides the route, and the SAME resolution writes the
 * words — for the work's brief and for the talker's mouth, in plain English,
 * naming no tools at all. What is never named cannot be falsely promised.
 * `toolsPromisedButAbsent` holds the same line at both seams for the sentences
 * that are not written here.
 *
 * The route itself is a narrower question than it was. Reading a page is one
 * ability with its own internal routes (page-reading.ts), and the fetch inside
 * it is not an ability that can be withdrawn — so "it cannot read a page at
 * all" is no longer reachable. What an unusable browser costs this call is
 * real but bounded: nothing appears on the caller's screen, and nothing behind
 * a click or a sign-in can be reached while the line is open.
 *
 * Pure and framework-free: no database, no runtime, no browser. The voice
 * process resolves it once per call and records the answer on the run.
 */

/** The autonomy levels this decision turns on, as the dial reports them. */
export type PageAccessLevel = 'forbidden' | 'approval' | 'notify' | 'trusted'

export type PageAccess = {
  /**
   * How pages get read on this call. 'browser' means a real page on a real
   * screen the caller can watch; 'fetch' means the reading ability's own
   * quieter routes, because the browser cannot be driven here.
   */
  route: 'browser' | 'fetch'
  /** One plain sentence: why this call has this route. Goes on the record. */
  reason: string
  /**
   * What the work's brief should say about it, in the words it should reason
   * with. Empty when the browser is usable and nothing needs saying.
   */
  work: string
  /**
   * What the talker should know, and may have to tell the caller. Empty when
   * the browser is usable and nothing needs saying.
   */
  talk: string
}

/**
 * Whether the browser is genuinely usable on this call.
 *
 * `browserApproval` is the ability's own approval mode: an ability marked
 * 'continues' is governed by the dial but files no request of its own, so an
 * 'approval' dial does not park it. `browser_open` is not one of those — it is
 * what opens the session — so on 'approval' it parks, every time.
 */
export function resolvePageAccess(args: {
  /** Every ability name the call assembled — the platform's own answer on Chromium. */
  abilityNames: readonly string[]
  /** The computer_use dial for this agent. */
  computerUse: PageAccessLevel
  /** How the browser's opening ability applies the dial. */
  browserApproval?: 'each-call' | 'continues'
}): PageAccess {
  const opens = args.abilityNames.includes('browser_open')

  const unusable = ((): string | null => {
    // No Chromium on the box means browserAbilities() returned nothing at all.
    if (!opens) return 'this deployment has no browser for the agent to drive'
    if (args.computerUse === 'forbidden') return 'computer use is switched off for this agent'
    if (args.computerUse === 'approval' && args.browserApproval !== 'continues') {
      return 'every page this agent opens in the browser parks awaiting a human sign-off, which will not arrive mid-call'
    }
    return null
  })()

  if (!unusable) {
    return {
      route: 'browser',
      reason: 'the browser is usable on this call, so pages are visited where the caller can watch',
      work: '',
      talk: '',
    }
  }
  return {
    route: 'fetch',
    reason: `${unusable}, so pages are read the quiet way instead`,
    work: 'Your browser is not available to you on this call. Reading a page still works and you should keep doing it — but nobody can watch it happen, and anything that only appears after a click, a form, or a sign-in will come back with little on it. When a page comes back thin, say what you did see and go to another source; never fill the gap with what the page probably said.',
    talk: 'You cannot open the browser on this call, so nothing appears on their screen while you work — tell them what you are finding in words rather than expecting them to see it. You can still read pages perfectly well; what you cannot do while you are on the line is click through one, fill anything in, or sign in anywhere. If something genuinely needs that, say so plainly and offer to finish it afterwards.',
  }
}

/**
 * Which tool names a piece of instruction text promises that this call does
 * not actually hold.
 *
 * The enforceable half of the contract. Instructions are prose and tools are a
 * set, and the two drifted apart in silence: an agent was told to read pages
 * with `read_webpage` long after that name had stopped existing, so it had no
 * way at all to do the thing it had just been told to do. Snake_case in an
 * English sentence is a tool name — anything named here that is not held is a
 * promise the resolution did not grant, and it goes on the record at the seam
 * rather than being discovered one dead end at a time.
 */
export function toolsPromisedButAbsent(text: string, available: readonly string[]): string[] {
  const held = new Set(available)
  const named = text.match(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g) ?? []
  return [...new Set(named.filter((name) => !held.has(name)))]
}
