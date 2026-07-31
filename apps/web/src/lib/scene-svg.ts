import 'server-only'

/**
 * Making a model's drawing safe to put on the page.
 *
 * A department backdrop is SVG written by a language model and rendered inside
 * the application's own origin. That is untrusted markup in a trusted context,
 * which is the textbook shape of a cross-site scripting hole: `<script>` runs,
 * `onload=` runs, `<foreignObject>` smuggles arbitrary HTML in, `<use>` and
 * `<image>` can pull a remote document, and a `javascript:` href is a link that
 * executes. None of that is hypothetical — it is what an SVG sanitiser exists
 * for, and a model does not have to be malicious to produce it, only helpful
 * about "making the sign clickable".
 *
 * So this is an ALLOWLIST, not a blocklist. Anything not named here is dropped,
 * which means a novel trick fails closed rather than passing because nobody
 * thought to ban it. What survives is shapes, paths, text, gradients and
 * transforms — enough to draw a room, and nothing that can act.
 */

/** Elements a backdrop may use. Everything else is removed entirely. */
const ALLOWED_ELEMENTS = new Set([
  'svg',
  'g',
  'defs',
  'title',
  'desc',
  'path',
  'rect',
  'circle',
  'ellipse',
  'line',
  'polyline',
  'polygon',
  'text',
  'tspan',
  'linearGradient',
  'radialGradient',
  'stop',
  'clipPath',
  'mask',
  'pattern',
  'filter',
  'feGaussianBlur',
  'feOffset',
  'feBlend',
  'feColorMatrix',
  'feComposite',
  'feMerge',
  'feMergeNode',
])

/** Attributes those elements may carry. */
const ALLOWED_ATTRIBUTES = new Set([
  'viewBox', 'xmlns', 'width', 'height', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry',
  'd', 'points', 'transform', 'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity',
  'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray', 'opacity', 'offset', 'stop-color', 'stop-opacity',
  'gradientUnits', 'gradientTransform', 'patternUnits', 'patternTransform', 'clip-path', 'clip-rule', 'mask',
  'filter', 'stdDeviation', 'in', 'in2', 'result', 'mode', 'type', 'values', 'operator', 'dx', 'dy',
  'font-size', 'font-family', 'font-weight', 'text-anchor', 'dominant-baseline', 'letter-spacing',
  'preserveAspectRatio', 'id', 'class', 'style',
])

/**
 * Values that may appear in an allowed attribute.
 *
 * `style` and `fill` can both reach outside the document — `url(...)` to a
 * remote sheet, `javascript:` in anything that resolves as a URL, `expression()`
 * in old engines. Only `url(#local)` is kept, because gradients and clip paths
 * genuinely need it.
 */
const DANGEROUS_VALUE = /(?:javascript:|data:text\/html|expression\s*\(|@import|<\s*script)/i
const REMOTE_URL = /url\(\s*['"]?\s*(?!#)/i

export type SanitisedSvg = { svg: string; removed: string[] } | { svg: null; reason: string }

/**
 * Strip everything that can act, keep everything that can only be looked at.
 *
 * Deliberately a parser-free, conservative pass: it works on the source text so
 * it can run on the server with no DOM, and anything it cannot confidently
 * understand it removes. A backdrop that comes out plainer than asked for is a
 * disappointment; one that comes out executable is an incident.
 */
export function sanitiseSceneSvg(input: string, options?: { maxBytes?: number }): SanitisedSvg {
  const maxBytes = options?.maxBytes ?? 120_000
  const raw = input.trim()
  if (!raw) return { svg: null, reason: 'Nothing came back.' }
  if (raw.length > maxBytes) {
    return { svg: null, reason: `That drawing is ${Math.round(raw.length / 1024)}KB, over the ${Math.round(maxBytes / 1024)}KB ceiling for a backdrop.` }
  }

  // Only the <svg> element itself, ignoring any prose the model wrapped it in.
  const opening = raw.search(/<svg[\s>]/i)
  const closing = raw.toLowerCase().lastIndexOf('</svg>')
  if (opening === -1 || closing === -1) return { svg: null, reason: 'That was not an SVG.' }
  let body = raw.slice(opening, closing + 6)

  const removed: string[] = []

  // Comments and CDATA first: both can hide markup from a naive tag scan.
  body = body.replace(/<!--[\s\S]*?-->/g, '').replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '')

  // Whole elements that are never allowed, contents and all.
  body = body.replace(/<\s*(script|foreignObject|iframe|object|embed|animate|set|handler|audio|video)\b[\s\S]*?<\s*\/\s*\1\s*>/gi, (m, tag) => {
    removed.push(String(tag))
    return ''
  })

  // Then any remaining tag whose name is not on the list — including the
  // self-closing form of the elements above.
  body = body.replace(/<\s*\/?\s*([a-zA-Z][\w:-]*)\b([^>]*)>/g, (match, tag: string, attrs: string) => {
    if (!ALLOWED_ELEMENTS.has(tag)) {
      removed.push(tag)
      return ''
    }
    if (match.startsWith('</')) return `</${tag}>`

    const kept: string[] = []
    // Attributes, one at a time. Anything unquoted, unknown, or carrying a
    // value that can reach outside the document is dropped.
    const attrPattern = /([a-zA-Z][\w:-]*)\s*=\s*("([^"]*)"|'([^']*)')/g
    let found: RegExpExecArray | null
    while ((found = attrPattern.exec(attrs)) !== null) {
      const name = found[1]!
      const value = found[3] ?? found[4] ?? ''
      // Every event handler in one line: they all start this way.
      if (/^on/i.test(name) || name.toLowerCase() === 'href' || name.toLowerCase() === 'xlink:href') {
        removed.push(`${tag}@${name}`)
        continue
      }
      if (!ALLOWED_ATTRIBUTES.has(name)) {
        removed.push(`${tag}@${name}`)
        continue
      }
      if (DANGEROUS_VALUE.test(value) || REMOTE_URL.test(value)) {
        removed.push(`${tag}@${name}`)
        continue
      }
      kept.push(`${name}="${value.replace(/"/g, '&quot;')}"`)
    }
    const selfClosing = /\/\s*>$/.test(match) ? ' /' : ''
    return `<${tag}${kept.length ? ' ' + kept.join(' ') : ''}${selfClosing}>`
  })

  if (!/^<svg[\s>]/i.test(body.trim())) return { svg: null, reason: 'Nothing drawable survived.' }
  return { svg: body.trim(), removed: [...new Set(removed)] }
}
