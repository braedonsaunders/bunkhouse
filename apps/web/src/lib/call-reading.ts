/**
 * How the agent reads a web page on a live call — and the guarantee that it
 * always can.
 *
 * A page the caller is waiting on should be VISITED, not fetched: the browser
 * copes with sites whose menu is an image or needs a click, and the caller
 * watches it happen on their screen. So the fetch ability (`read_webpage`) is
 * taken off a call when the browser is genuinely usable, because asking the
 * model nicely in a tool description did not move it off the fast, invisible
 * path.
 *
 * Taking it off *unconditionally* was a regression, and a whole call proved it:
 * an agent whose computer_use dial sits on 'approval' parked every single
 * `browser_open` awaiting sign-off — foodeist.com, wanderlog.com,
 * lagoportdover.ca, three for three — and, with no fetch path left, silently
 * degraded to answering from search snippets. It had no way to read any page at
 * all and nothing said so.
 *
 * The rule this module holds is therefore: prefer the browser, but never leave
 * the worker with no way to read a page. Three things can make the browser
 * unusable on a call, and each one has to be checked before the fetch path is
 * withdrawn — the dial forbids computer use, the dial would park every open on
 * an approval nobody will sign off mid-call, or the platform has no Chromium
 * (`browserSupported()` in browser-use.ts) so there are no browser abilities to
 * begin with.
 *
 * Pure and framework-free: no database, no runtime, no browser. The voice
 * process resolves it once per call, records the answer on the run, and tells
 * the agent which route it has — and the test runs it without either.
 */

/** The autonomy levels this decision turns on, as the dial reports them. */
export type PageAccessLevel = 'forbidden' | 'approval' | 'notify' | 'trusted'

export type PageAccess = {
  /**
   * The route the work will actually read pages by. 'browser' means the fetch
   * ability is withdrawn for this call; 'fetch' means it stays, because the
   * browser cannot do the job here.
   */
  route: 'browser' | 'fetch'
  /** True while `read_webpage` is left in the ability set. */
  fetchAvailable: boolean
  /** One plain sentence: why this call has this route. Goes on the record. */
  reason: string
  /**
   * What to tell the agent about reading pages, in the words it should reason
   * with. Empty when the browser is usable and nothing needs saying.
   */
  instruction: string
}

/**
 * Whether the browser is genuinely usable on this call, and therefore whether
 * the fetch path may be withdrawn.
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
  const fetches = args.abilityNames.includes('read_webpage')
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
      fetchAvailable: false,
      reason: 'the browser is usable on this call, so pages are visited where the caller can watch',
      instruction: '',
    }
  }
  if (!fetches) {
    // Both routes gone. Nothing here can conjure one, but the agent must know
    // it is blind to pages rather than discovering it one dead end at a time,
    // and the operator must find the reason on the record.
    return {
      route: 'fetch',
      fetchAvailable: false,
      reason: `${unusable}, and this agent has no page-fetching ability either — it cannot read a web page on this call`,
      instruction:
        'You cannot read a web page at all on this call: your browser is not available to you and you have no page fetch. Work from search results and what you already know, say plainly that you could not open the page itself, and offer to follow up afterwards. Never describe a page you have not read.',
    }
  }
  return {
    route: 'fetch',
    fetchAvailable: true,
    reason: `${unusable}, so the page fetch stays available — an agent with no way to read a page answers from search snippets and nobody is told`,
    instruction:
      'Your browser is not available to you on this call, so read pages with read_webpage instead. The caller cannot watch you do it, so say what you are looking at as you go, and if a page comes back empty or needs a click or a sign-in, say so plainly and try another source rather than guessing at what it said.',
  }
}
