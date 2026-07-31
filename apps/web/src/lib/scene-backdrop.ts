import 'server-only'
import { generateText } from 'ai'
import { getModel } from '@appkit/ai'
import { resolveProviderAiConfig, listAiProviders } from './ai'
import { sanitiseSceneSvg } from './scene-svg'
import { toLightBackdrop } from './scene-recolour'
import { PALETTES, type BackdropTheme } from './scene-palette'

/**
 * Having a room drawn.
 *
 * The built-in scenes are hand-composed React — dozens of small SVGs placed
 * with absolute positioning, tuned over time. A generated backdrop cannot be
 * that and should not pretend to be: it is ONE full-bleed picture that sits
 * behind the characters. What makes it look like it belongs is not detail, it
 * is obeying the same rules the hand-drawn rooms obey — a horizon in the same
 * place, a calm band where people walk, flat shapes, and a palette that does
 * not fight the interface.
 *
 * So the prompt is mostly constraints. A model asked for "an office" returns a
 * clip-art desk; asked for a backdrop with a horizon at 52%, nothing busy below
 * it, no text, and six named colours, it returns something that looks composed.
 * The constraints are the design.
 */

/** The shape every backdrop is drawn into, matching the stage's aspect. */
const VIEWBOX = '0 0 1600 900'

/**
 * Where the floor meets the wall, as a fraction of height.
 *
 * The stage's own ground config puts the horizon near here and scales
 * characters by depth against it. A backdrop whose horizon disagrees makes
 * everybody look like they are standing in the wall.
 */
const HORIZON = 0.52


function brief(description: string, theme: BackdropTheme): string {
  const palette = PALETTES[theme]
  return `Draw one SVG backdrop for a room in a small company's office, seen straight on, as the background of an animated scene where cartoon staff walk about in front of it.

THE ROOM: ${description}

This is a BACKDROP, not an illustration. It sits behind moving characters and must never compete with them.

Hard requirements — a drawing that breaks any of these is unusable:
- Exactly one <svg> element, viewBox="${VIEWBOX}", no width or height attributes.
- The horizon — where the back wall meets the floor — sits at y=${Math.round(900 * HORIZON)}, spanning the full width. Above it is wall and whatever is on it; below it is floor.
- The lower half is where people walk. Keep it CALM: floor, a rug, maybe a shadow or a floor edge. No furniture taller than about 120 units below the horizon, and nothing at all in the middle third of the floor.
- No text, no letters, no numbers, no logos. At this size they read as noise.
- Flat vector shapes only: rect, path, circle, ellipse, polygon, line, and linear gradients. No filters, no images, no patterns of photographic detail.
- ${palette.note}. Structure and surfaces use ONLY these: ${palette.colours.join(', ')}.
- Two colours sit outside that set and are the only exceptions. ${palette.lit} is LIT — anything glowing from within. ${palette.accent} is the accent, for one or two small things and nothing else.

What makes it look composed rather than like clip art — do all of these:
- BUILD IT IN THREE DEPTH LAYERS. Far: the back wall itself, and openings in it — windows, a doorway, a roller door, shelving recessed into it. Middle: things standing against that wall, their bases ON the horizon line so they sit in the room. Near: one or two large objects at the far LEFT and far RIGHT edges, cropped by the frame, no more than 300 units wide. That cropping is what creates depth; without it the picture looks like a sticker.
- GIVE THE FLOOR PERSPECTIVE. Draw four to eight faint lines fanning from the horizon down toward the bottom corners, and one or two horizontal bands. They should be barely darker or lighter than the floor — a suggestion of a receding surface, not a grid.
- LIGHT SOMETHING. Three to six small shapes lit from within — screens, a lamp shade, a doorway with light behind it — in ${palette.lit}. These are the focal points a flat drawing needs. Keep every one of them above the horizon or at the far edges.
- LAYER THE WALL. The back wall should not be one flat rectangle: band it into a lower dado, a main field and a narrower ceiling strip, each a slightly different value from the palette.
- REPEAT WITH VARIATION. Where something repeats — shelves, slats, panes, pegboard holes — vary the spacing or length slightly. Perfect repetition reads as a texture swatch.
- 90 to 160 shapes. Below 90 it looks unfinished at this size; above 160 it turns to noise.

Return ONLY the SVG markup. No prose, no explanation, no code fence.`
}

export type BackdropResult =
  | { ok: true; dark: string; light: string; removed: string[] }
  | { ok: false; reason: string }

/**
 * Ask whichever model this company has connected, then put what comes back
 * through the sanitiser before it goes anywhere near the page.
 *
 * The sanitiser is not a formality here. This is markup written by a model and
 * rendered in the app's own origin, so it is untrusted until something has made
 * it safe — see scene-svg.ts.
 */
export async function generateBackdrop(args: {
  tenantId: string
  description: string
}): Promise<BackdropResult> {
  const description = args.description.trim()
  if (description.length < 3) return { ok: false, reason: 'Say a little more about the room.' }
  if (description.length > 400) return { ok: false, reason: 'Keep the description under 400 characters.' }

  const providers = await listAiProviders(args.tenantId)
  const first = providers[0]
  if (!first) return { ok: false, reason: 'No AI provider is connected for this company yet.' }
  const config = await resolveProviderAiConfig(args.tenantId, first.slug)
  const model = config ? (getModel(config, 'smart') ?? getModel(config, 'fast')) : null
  if (!model) return { ok: false, reason: 'That provider has no model assigned that can draw this.' }

  /** One theme's worth. */
  const drawOne = async (theme: BackdropTheme): Promise<{ svg: string; removed: string[] } | { error: string }> => {
    let text: string
    try {
      const result = await generateText({
        model,
        messages: [{ role: 'user', content: brief(description, theme) }],
      })
      text = result.text
    } catch (error) {
      return { error: `The model could not draw it: ${error instanceof Error ? error.message : String(error)}` }
    }
    const cleaned = sanitiseSceneSvg(text)
    if (!('svg' in cleaned) || !cleaned.svg) {
      return { error: 'reason' in cleaned ? cleaned.reason : 'Nothing drawable came back.' }
    }
    // A backdrop that ignored the viewBox would be stretched or cropped wrongly
    // on the stage, so it is corrected rather than rejected — the shapes are
    // usually fine even when the frame is not.
    const svg = cleaned.svg.replace(/<svg\b[^>]*>/i, (open) => {
      const withBox = /viewBox\s*=/.test(open) ? open : open.replace(/<svg/i, `<svg viewBox="${VIEWBOX}"`)
      return withBox
        .replace(/\swidth\s*=\s*"[^"]*"/i, '')
        .replace(/\sheight\s*=\s*"[^"]*"/i, '')
        .replace(/<svg/i, '<svg preserveAspectRatio="xMidYMid slice"')
    })
    const shapes = (svg.match(/<(rect|path|circle|ellipse|polygon|polyline|line)\b/g) ?? []).length
    if (shapes < 6) return { error: 'That came back nearly empty — try describing the room differently.' }
    return { svg, removed: cleaned.removed }
  }

  // Drawn once, in the dim palette, then recoloured. Drawing it twice gave two
  // different rooms — see toLightBackdrop.
  const dark = await drawOne('dark')
  if ('error' in dark) return { ok: false, reason: dark.error }

  return { ok: true, dark: dark.svg, light: toLightBackdrop(dark.svg), removed: dark.removed }
}
