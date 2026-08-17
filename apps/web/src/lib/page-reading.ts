import 'server-only'
import { generateText } from 'ai'
import { getModel, isAiProvider, providerSpec } from '@braedonsaunders/appkit-ai'
import { z } from 'zod'
import { defineAbility, takeAbilityFrame, type Ability, type AbilityFrame } from '@bunkhouse/runtime'
import { listAiProviders, resolveProviderAiConfig } from './ai'
import { readWebpage } from './research'

/**
 * Looking at a page — one contract, one answer.
 *
 * Perception used to be three incompatible things and the MODEL chose between
 * them: a fetch (quick, invisible, empty on anything that needs JavaScript or
 * is built from images), a browser visit (real, watchable, but gated by the
 * desktop dial), and a screenshot handed over as a picture (which a
 * text-only model refuses outright). Every failure that split produced earned
 * its own special case, and the special cases were the bug:
 *
 * - four fetches before a browser was opened, on a menu that is images, while
 *   the caller could see that menu on their own screen and was told "still
 *   looking";
 * - the fetch withdrawn to force a visit, which left any agent whose dial
 *   parks the browser unable to read ANY page, degrading to search snippets
 *   in silence;
 * - a working model refusing a screenshot, so sight switched off for the rest
 *   of the call and the agent narrated a screen it could not see.
 *
 * So the model no longer chooses. It asks to look at a page and gets what is
 * on the page. HOW is this module's business: fetch first because it is cheap;
 * the browser when the fetch comes back thin, blocked, or empty; and when the
 * page is visual and there is still no text, a model that CAN see describes
 * the picture and that description IS the text. A text-only model still learns
 * what is on the page. Whether an agent can see is a property of the system,
 * not of whichever model an operator happened to assign it.
 */

/** Below this, a page's text is not an answer — it is an empty room. */
const THIN_TEXT = 200

/**
 * How many frames one call may pay a seeing model to describe. A long browse
 * must not quietly run up a bill, and a page that needs describing twice is
 * rare; a page that needs it forty times is a loop, not a task.
 */
const DESCRIBE_BUDGET = 6

const DESCRIBE_PROMPT =
  'Describe what is on this page for someone who cannot see it and needs to act on it. Read out the text that carries meaning — headings, items, prices, hours, availability, form labels, buttons, error messages — in the order it appears. Say plainly what kind of page it is and what can be done on it. Do not speculate about anything not visible, and do not describe styling.'

/** What came back, and by which route — the caller's own screen may show it. */
export type PageReading = {
  url: string
  title: string
  text: string
  /** Which route answered, for the record and for honesty about what was seen. */
  route: 'fetched' | 'visited' | 'described'
  /** Set when nothing could read the page; the text is whatever little there was. */
  unreadable?: string
}

/**
 * A model that can look at a picture, from whatever the company has connected.
 * Resolved once per call: the answer cannot change mid-call, and asking the
 * provider list per frame would be a database round trip per screenshot.
 */
export type SeeingModel = { describe: (frame: AbilityFrame) => Promise<string> } | null

export async function resolveSeeingModel(tenantId: string): Promise<SeeingModel> {
  const providers = await listAiProviders(tenantId)
  // OpenAI and Google both take images on their ordinary text models. A
  // provider whose kind we do not recognise is not assumed to.
  const seeing = providers.find((entry) => {
    if (!isAiProvider(entry.provider)) return false
    const kind = providerSpec(entry.provider).kind
    return kind === 'openai' || kind === 'google'
  })
  if (!seeing) return null
  const config = await resolveProviderAiConfig(tenantId, seeing.slug)
  if (!config) return null
  const model = getModel(config, 'fast') ?? getModel(config, 'smart')
  if (!model) return null
  let spent = 0
  return {
    describe: async (frame) => {
      if (spent >= DESCRIBE_BUDGET) return ''
      spent += 1
      const { text } = await generateText({
        model,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: DESCRIBE_PROMPT },
              { type: 'image', image: `data:${frame.mediaType};base64,${frame.data}` },
            ],
          },
        ],
      })
      return text.trim()
    },
  }
}

/** The page's own text, as the browser step reported it. */
function pageText(output: unknown): { text: string; title: string; url: string } {
  const record = output !== null && typeof output === 'object' ? (output as Record<string, unknown>) : {}
  return {
    text: typeof record.text === 'string' ? record.text.trim() : '',
    title: typeof record.title === 'string' ? record.title : '',
    url: typeof record.url === 'string' ? record.url : '',
  }
}

/**
 * The one ability. `visit` is the browser's own opening step, passed in rather
 * than imported so this module never decides whether the browser may be used —
 * the caller resolved that once, and hands in what it actually has.
 */
export function pageReadingAbility(args: {
  /** Open a page in the browser and report it, or null when there is no browser. */
  visit: ((url: string) => Promise<unknown>) | null
  /** A model that can look at a picture, or null when nothing connected can. */
  seeing: SeeingModel
  /** Where the route taken is written down. */
  onRoute?: (reading: PageReading) => void
}): Ability {
  return defineAbility({
    name: 'read_page',
    description:
      'Look at a web page and get what is on it. Give it a full URL. You always get the page back the same way, whatever the page is made of — a plain article, a site that only renders with JavaScript, or a menu that is a photograph. Use it whenever you need to know what a page says. If you then need to act on that page — click something, fill something in — the browser is already there on it.',
    category: null,
    inputSchema: z.object({ url: z.string().describe('Full URL, including https://') }),
    execute: async ({ url }) => {
      const reading = await readPage({ url, visit: args.visit, seeing: args.seeing })
      args.onRoute?.(reading)
      return {
        url: reading.url,
        title: reading.title,
        text: reading.text,
        ...(reading.unreadable ? { note: reading.unreadable } : {}),
      }
    },
  })
}

/**
 * Read a page by whichever route answers. Exported on its own so the ability
 * above is a thin shell over something testable without a browser or a model.
 */
export async function readPage(args: {
  url: string
  visit: ((url: string) => Promise<unknown>) | null
  seeing: SeeingModel
}): Promise<PageReading> {
  const { url, visit, seeing } = args

  // Cheap first. A fetch that answers with real text is the whole job, and
  // most pages are that.
  let fetched: PageReading | null = null
  try {
    const page = await readWebpage(url)
    fetched = { url: page.url, title: page.title, text: page.text.trim(), route: 'fetched' }
    if (fetched.text.length >= THIN_TEXT) return fetched
  } catch {
    // Blocked, 403, a dead name — not a verdict on the page, just on this
    // route. The browser gets its turn.
  }

  // Thin, blocked or empty. Somebody has to actually go and look.
  if (!visit) {
    if (fetched) return { ...fetched, unreadable: 'Only a plain fetch was available, and it came back with little.' }
    return {
      url,
      title: '',
      text: '',
      route: 'fetched',
      unreadable: 'This page could not be fetched, and there is no browser on this call to visit it with.',
    }
  }

  const raw = await visit(url)
  const { frame } = takeAbilityFrame(raw)
  const visited = pageText(raw)
  const reading: PageReading = {
    url: visited.url || url,
    title: visited.title,
    text: visited.text,
    route: 'visited',
  }
  if (reading.text.length >= THIN_TEXT) return reading

  // On the page, and it still says nothing: it is built from pictures. Some
  // model has to look at it — and if the company connected one, one can.
  if (frame && seeing) {
    try {
      const described = await seeing.describe(frame)
      if (described) return { ...reading, text: described, route: 'described' }
    } catch {
      // An enrichment that failed is not the step failing. Fall through with
      // whatever the page did give, and say so.
    }
  }
  return {
    ...reading,
    unreadable: frame
      ? 'This page carries no readable text and nothing connected here can look at a picture, so what it shows is unknown.'
      : 'This page came back with no readable text.',
  }
}
