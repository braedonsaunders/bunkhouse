import 'server-only'
import sharp from 'sharp'
import type { A11yNode } from '@braedonsaunders/appkit-desk'

/**
 * Set-of-marks for the desk screen: the accessibility tree, drawn onto the
 * picture as numbered badges.
 *
 * The problem this solves is a cross-reference. observe() already hands the
 * model two descriptions of the same screen — a picture, and a JSON tree whose
 * node ids ("0/3/1") are structural paths. Asking a model to hold both in mind
 * and join them by hand is asking it to do the one thing it is worst at, and
 * the failure is silent: it estimates a coordinate instead, misses by twelve
 * pixels, and reports that it clicked Save.
 *
 * A mark collapses the join. The number on the button in the picture IS the
 * key into the legend, so the model names a control rather than estimating
 * where one is. That matters more here than on a native-resolution desk,
 * because the frame a model sees is shrunk to MODEL_FRAME_WIDTH while
 * coordinates stay in the screen's own 1:1 space — a marked control is the one
 * thing in this system whose targeting does not care about that rescale.
 *
 * Two rules this module does not get to break:
 *
 *   · **The ledger never sees a mark.** Badges are drawn only onto the copy
 *     handed to the model. The recorded frame stays the screen as it actually
 *     was, because that frame is evidence and because the frame deduplicator
 *     hashes it — an overlay that shifted by one node would make every
 *     still screen look like a changed one.
 *   · **Marks are per-observation, exactly like node ids.** The tree is
 *     re-walked on every observe, so mark 7 means nothing against an earlier
 *     picture. Callers resolve marks against the LAST observation or not at
 *     all.
 */

export type DeskMark = {
  /** 1-based, in reading order — the number drawn on the picture. */
  mark: number
  /** The structural path this mark stands for, for a11y-invoke. */
  nodeId: string
  role: string
  name: string | null
  /** AT-SPI actions this node accepts. Empty means it can only be clicked. */
  actions: readonly string[]
  bounds: { x: number; y: number; width: number; height: number }
}

/**
 * Roles worth marking even when the node advertises no AT-SPI action.
 *
 * A text entry is the case that matters: it typically exposes no action at
 * all, yet it is the single most common thing an agent needs to aim at. Left
 * unmarked, every form field would fall back to coordinate estimation, which
 * is the failure this module exists to remove — the mark still pays off,
 * because desktop_click takes one.
 */
const CLICKABLE_ROLES: ReadonlySet<string> = new Set([
  'text',
  'entry',
  'password text',
  'spin button',
  'combo box',
  'list item',
  'menu item',
  'check menu item',
  'radio menu item',
  'check box',
  'radio button',
  'push button',
  'toggle button',
  'link',
  'page tab',
  'slider',
  'table cell',
  'document frame',
])

/**
 * A control smaller than this in either axis is not something a model can aim
 * at meaningfully, and a badge drawn on it would cover it completely.
 */
const MIN_MARK_EDGE = 8

/**
 * Nodes covering more than this fraction of the screen are containers — the
 * window, the workspace, the document frame. Marking them adds a badge in the
 * corner of everything and teaches the model nothing.
 */
const MAX_MARK_AREA_FRACTION = 0.55

/**
 * The picture has to stay readable. Past this many badges the screen is more
 * overlay than screenshot, and the legend costs more context than the
 * coordinates it saves. Reading order means the cap drops the bottom of the
 * screen rather than an arbitrary slice.
 */
const MAX_MARKS = 60

type Candidate = { node: A11yNode; depth: number }

function isTree(value: unknown): value is A11yNode {
  return typeof value === 'object' && value !== null && 'id' in value && 'children' in value
}

/**
 * Flatten the tree to the nodes worth marking, numbered in reading order.
 *
 * Returns an empty list rather than throwing for every degenerate input —
 * a11y is opportunistic everywhere else in the desk and does not get to become
 * load-bearing here. No tree, an unparseable tree, or a tree with nothing
 * actionable in it all mean the same thing: no marks, and the plain picture.
 */
export function collectMarks(
  tree: unknown,
  screen: { width: number; height: number },
): DeskMark[] {
  if (!isTree(tree)) return []
  if (!(screen.width > 0) || !(screen.height > 0)) return []
  const screenArea = screen.width * screen.height

  const candidates: Candidate[] = []
  const walk = (node: A11yNode, depth: number): void => {
    if (!node || typeof node !== 'object') return
    candidates.push({ node, depth })
    const children = Array.isArray(node.children) ? node.children : []
    for (const child of children) walk(child, depth + 1)
  }
  walk(tree, 0)

  const keep = candidates.filter(({ node }) => {
    const bounds = node.bounds
    if (!bounds) return false
    const { x, y, width, height } = bounds
    if (![x, y, width, height].every((n) => Number.isFinite(n))) return false
    if (width < MIN_MARK_EDGE || height < MIN_MARK_EDGE) return false
    // Off-screen widgets legitimately report negative coordinates; a node that
    // does not intersect the screen at all cannot be marked on it.
    if (x + width <= 0 || y + height <= 0) return false
    if (x >= screen.width || y >= screen.height) return false
    if (width * height > screenArea * MAX_MARK_AREA_FRACTION) return false
    const actionable = Array.isArray(node.actions) && node.actions.length > 0
    return actionable || CLICKABLE_ROLES.has((node.role ?? '').toLowerCase())
  })

  // Wrappers report their child's exact rectangle constantly — a push button
  // inside a filler inside a panel is three nodes and one control. Keep the
  // deepest, which is the one that actually carries the action.
  const byRect = new Map<string, Candidate>()
  for (const candidate of keep) {
    const b = candidate.node.bounds
    if (!b) continue
    const key = `${b.x}:${b.y}:${b.width}:${b.height}`
    const existing = byRect.get(key)
    if (!existing || candidate.depth > existing.depth) byRect.set(key, candidate)
  }

  return [...byRect.values()]
    .sort((a, b) => {
      const ab = a.node.bounds!
      const bb = b.node.bounds!
      return ab.y - bb.y || ab.x - bb.x
    })
    .slice(0, MAX_MARKS)
    .map((candidate, index) => ({
      mark: index + 1,
      nodeId: candidate.node.id,
      role: candidate.node.role,
      name: candidate.node.name ?? null,
      actions: candidate.node.actions ?? [],
      bounds: candidate.node.bounds!,
    }))
}

/**
 * Badge geometry. Sized for what happens to this picture downstream: it is
 * scaled to MODEL_FRAME_WIDTH and JPEG-compressed at a low quality before any
 * model sees it, so a badge that is merely legible at full resolution is a
 * smear by the time it arrives.
 */
const BADGE_HEIGHT = 20
const BADGE_FONT_SIZE = 14
const MARK_STROKE = 2
/**
 * Magenta, not the brand amber: this overlay is an instrument, not chrome, and
 * it has to survive lossy compression on top of an arbitrary desktop. Amber
 * sits in the middle of the range real UI chrome occupies — titlebars, folder
 * icons, selection highlights — and a mark that can be confused with the thing
 * it is marking is worse than no mark.
 */
const MARK_COLOR = '#FF0066'

/**
 * Draw the badges onto a copy of the frame.
 *
 * Returns the original bytes unchanged when there is nothing to draw or the
 * overlay fails — a desk whose marks cannot be rendered still shows the model
 * its screen, exactly as a desk whose a11y tree is unavailable still returns
 * pixels.
 */
export async function drawMarks(
  png: Uint8Array,
  marks: readonly DeskMark[],
  screen: { width: number; height: number },
): Promise<Uint8Array> {
  if (marks.length === 0) return png
  try {
    const parts: string[] = []
    for (const { mark, bounds } of marks) {
      // Clamp into the frame so a partly off-screen control still gets a badge
      // that is fully visible rather than one sliced off at the edge.
      const x = Math.max(0, Math.min(bounds.x, screen.width - 1))
      const y = Math.max(0, Math.min(bounds.y, screen.height - 1))
      const width = Math.max(1, Math.min(bounds.width, screen.width - x))
      const height = Math.max(1, Math.min(bounds.height, screen.height - y))
      const label = String(mark)
      const badgeWidth = 12 + label.length * 9
      // Prefer the badge just above the control; tuck it inside when the
      // control is already at the top of the screen.
      const badgeY = y >= BADGE_HEIGHT ? y - BADGE_HEIGHT : y
      const badgeX = Math.min(x, screen.width - badgeWidth)
      parts.push(
        `<rect x="${x + MARK_STROKE / 2}" y="${y + MARK_STROKE / 2}" width="${Math.max(1, width - MARK_STROKE)}" height="${Math.max(1, height - MARK_STROKE)}" fill="none" stroke="${MARK_COLOR}" stroke-width="${MARK_STROKE}"/>`,
        `<rect x="${badgeX}" y="${badgeY}" width="${badgeWidth}" height="${BADGE_HEIGHT}" fill="${MARK_COLOR}"/>`,
        `<text x="${badgeX + badgeWidth / 2}" y="${badgeY + BADGE_HEIGHT - 6}" font-family="sans-serif" font-size="${BADGE_FONT_SIZE}" font-weight="bold" fill="#FFFFFF" text-anchor="middle">${label}</text>`,
      )
    }
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${screen.width}" height="${screen.height}">${parts.join('')}</svg>`
    const composited = await sharp(Buffer.from(png))
      .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
      .png()
      .toBuffer()
    return composited
  } catch {
    return png
  }
}

/**
 * The legend the model reads beside the picture — every mark it can name, with
 * what the control is and what it accepts. Bounds are deliberately omitted:
 * they are the coordinates this whole mechanism exists to stop the model from
 * doing arithmetic on.
 */
export function markLegend(marks: readonly DeskMark[]): {
  mark: number
  role: string
  name: string | null
  actions: readonly string[]
}[] {
  return marks.map(({ mark, role, name, actions }) => ({ mark, role, name, actions }))
}
