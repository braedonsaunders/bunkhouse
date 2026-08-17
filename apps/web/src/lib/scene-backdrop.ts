import 'server-only'
import { generateText } from 'ai'
import { getModel } from '@braedonsaunders/appkit-ai'
import { resolveProviderAiConfig, listAiProviders } from './ai'
import { sanitiseSceneSvg } from './scene-svg'
import { toLightBackdrop } from './scene-recolour'
import { paletteFor, type BackdropPalette, type PaletteTones } from './scene-palette'
import { BACKDROP_MOTION, MOTION_RANGE } from './scene-motion'
import { shotFor, type Shot } from './scene-shot'
import { scoreBackdrop, FRAME, type BackdropScore } from './scene-score'

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
 *
 * Three things were added after the first version shipped looking thinner than
 * the rooms beside it:
 *
 *  - **The constraints are marked, not just stated.** Three drawings are raced,
 *    scored against the brief (scene-score.ts), and the winner gets one pass to
 *    fix what it lost marks for. Asking once and hoping was the single biggest
 *    difference between a generated room and a hand-drawn one.
 *  - **A shot.** Every room used to be asked for in identical words, so every
 *    room came back the same shape. scene-shot.ts samples the things a director
 *    would decide — where the camera stands, what the back wall does, what is
 *    lighting it — and each of the three candidates gets a different one.
 *  - **Motion.** The vocabulary in scene-motion.ts, which is the same CSS the
 *    hand-drawn rooms breathe with.
 */

/** The shape every backdrop is drawn into, matching the stage's aspect. */
const VIEWBOX = `0 0 ${FRAME.width} ${FRAME.height}`

/**
 * How many drawings are raced.
 *
 * Three, because the spread between the best and worst of three is wide and
 * the spread between the best of three and the best of six is not — and every
 * one of these is a model call somebody is waiting on.
 */
const CANDIDATES = 3

/**
 * Room for the drawing to be finished.
 *
 * 170 to 280 shapes is a great deal of markup, and a default output ceiling cuts it off
 * mid-path — which arrives here as "That was not an SVG", because a truncated
 * drawing has no closing tag. Asking for the detail and not leaving room for it
 * is the kind of bug that looks like the model being bad at drawing.
 */
const MAX_OUTPUT_TOKENS = 40_000

function motionVocabulary(): string {
  return Object.entries(BACKDROP_MOTION)
    .map(([name, what]) => `  - class="${name}" — ${what}`)
    .join('\n')
}

function brief(description: string, palette: BackdropPalette, shot: Shot): string {
  const tones = palette.dark
  return `Draw one SVG backdrop for a room in a small company's office, seen straight on, as the background of an animated scene where cartoon staff walk about in front of it.

THE ROOM: ${description}

THE SHOT — how this particular room is composed. Follow it unless the description above contradicts it; the description always wins.
- ${shot.architecture}
- ${shot.light}
- ${shot.camera}
- ${shot.material}

This is a BACKDROP, not an illustration. It sits behind moving characters and must never compete with them.

Hard requirements — a drawing that breaks any of these is unusable:
- Exactly one <svg> element, viewBox="${VIEWBOX}", no width or height attributes.
- The horizon — where the back wall meets the floor — sits at y=${FRAME.horizon}, spanning the full width. Above it is wall and whatever is on it; below it is floor.
- The lower half is where people walk. Keep it CALM: floor, a rug, maybe a shadow or a floor edge. No furniture taller than about 120 units below the horizon, and nothing at all in the middle third of the floor.
- No text, no letters, no numbers, no logos. At this size they read as noise.
- Flat vector shapes only: rect, path, circle, ellipse, polygon, line, and linear gradients. No filters, no images, no patterns of photographic detail.
- A dim room, lit from within. Structure and surfaces — walls, floor, furniture, machinery — use these six: ${tones.colours.join(', ')}. The lightest of them, ${tones.colours[5]}, is for EDGES: panel seams, the lit top of a bench, the near corner of a cabinet. Use it constantly and thinly. It is what stops the drawing being flat blocks.
- THE ROOM IS MADE OF ${palette.materials.toUpperCase()}. Two colours carry that: ${tones.material} and ${tones.material2}. Between them put material on TWELVE TO TWENTY-EIGHT shapes, spread across all three depth layers — the gear, the fittings, the cable, the hardware, the small parts on the bench. This is where the room's colour lives and it is the single thing that stops it looking like every other room. Not on the walls, not on the floor, and never as one large flat field.
- ${tones.lit} is LIT — anything glowing from within, on six to fourteen shapes. ${tones.hot} is HOT: the two or three fiercest sources only — an arc, an LED head-on, a screen at full brightness. Every light being equally bright reads as wallpaper.
- ${tones.accent} is the brand accent, for one or two small things and nothing else.
- Those eleven colours are the whole palette. Nothing else, and no white.

What makes it look composed rather than like clip art — do all of these:
- BUILD IT IN THREE DEPTH LAYERS. Far: the back wall itself, and openings in it — windows, a doorway, a roller door, shelving recessed into it. Middle: things standing against that wall, their bases ON the horizon line so they sit in the room. Near: one or two large objects at the far LEFT and far RIGHT edges, cropped by the frame, no more than 300 units wide. That cropping is what creates depth; without it the picture looks like a sticker.
- GIVE THE FLOOR PERSPECTIVE. Draw four to eight faint lines fanning from the horizon down toward the bottom corners, and one or two horizontal bands. They should be barely darker or lighter than the floor — a suggestion of a receding surface, not a grid.
- LIGHT SOMETHING. Three to six small shapes lit from within — screens, a lamp shade, a doorway with light behind it — in ${tones.lit}. These are the focal points a flat drawing needs. Keep every one of them above the horizon or at the far edges.
- LAYER THE WALL. The back wall should not be one flat rectangle: band it into a lower dado, a main field and a narrower ceiling strip, each a slightly different value from the palette.
- REPEAT WITH VARIATION. Where something repeats — shelves, slats, panes, pegboard holes — vary the spacing or length slightly. Perfect repetition reads as a texture swatch.
- 170 to 280 shapes. This is the difference between a diagram of a room and a room, and almost all of it is small parts rather than more furniture.
- DRAW THE SMALL PARTS. On every large object, put the things that are actually on it: panel seams and shut lines, hinges, handles, fixings, feet, a label plate, the gap under a door. Four to ten small shapes on each major object. This is the single biggest lever on whether it looks drawn or generated.
- RUN SOMETHING THROUGH THE ROOM. Conduit, cable tray, ducting, pipework or a hose — one or two continuous runs crossing the wall horizontally, with brackets at intervals and a bend where it turns down. A room with no services in it reads as a stage flat.
- CLUSTER, DO NOT SCATTER. Real rooms have busy corners and empty stretches. Put two or three dense clusters of small objects — a bench top with tools on it, a shelf of parts, a board of hanging hardware — and leave the wall between them comparatively plain. Even distribution is what makes a drawing read as a texture.

MAKE IT MOVE. The rooms this sits beside are full of small loops, and a still picture next to them looks like a photograph of a room rather than the room. Put a class on ${MOTION_RANGE.min} to 8 shapes that would plausibly move — no more, and never on a large structural shape:
${motionVocabulary()}
A class may go on a shape or on a <g> holding a few of them. These are the only class names that survive; anything else is stripped. Nothing else animates — no <animate>, no SMIL, no CSS.

Return ONLY the SVG markup. No prose, no explanation, no code fence.`
}

/** What to fix, in the model's own drawing. */
function repairBrief(svg: string, notes: string[], palette: BackdropPalette): string {
  const tones = palette.dark
  return `Here is an SVG backdrop you drew. It is close, but it misses some of the brief. Return a corrected version of THIS drawing — keep its composition, its room and its palette, and change only what is listed.

${notes.map((note, index) => `${index + 1}. ${note}`).join('\n')}

Rules that still hold: one <svg>, viewBox="${VIEWBOX}", no width or height, horizon at y=${FRAME.horizon}, no text, flat shapes only, colours from ${tones.colours.join(', ')} plus ${tones.material} and ${tones.material2} for what the room is made of, ${tones.lit} and ${tones.hot} for what glows, and ${tones.accent} for accents, and motion only via the class names already in the drawing (${Object.keys(BACKDROP_MOTION).join(', ')}).

THE DRAWING:
${svg}

Return ONLY the corrected SVG markup. No prose, no explanation, no code fence.`
}

export type BackdropResult =
  | { ok: true; dark: string; light: string; removed: string[] }
  | { ok: false; reason: string }

/** A drawing that came back, cleaned up and marked. */
type Candidate = { svg: string; removed: string[]; score: BackdropScore }

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
  /**
   * Fixes the shots the candidates are drawn from. Left out in the app, where
   * every press should be able to come back with a different room; passed by
   * tests that need the same three shots twice.
   */
  seed?: string
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

  // Read off the room itself, before anything is drawn, so all three
  // candidates and the repair pass are working in the same material — and so a
  // redraw of the same room comes back the same colour.
  const palette = paletteFor(description)
  const tones: PaletteTones = palette.dark
  // A fresh seed per press, so "draw another" is another room rather than the
  // same one again. Tests pass their own.
  const seed = args.seed ?? crypto.randomUUID()

  const ask = async (prompt: string): Promise<string | { error: string }> => {
    try {
      const result = await generateText({ model, maxOutputTokens: MAX_OUTPUT_TOKENS, messages: [{ role: 'user', content: prompt }] })
      return result.text
    } catch (error) {
      return { error: `The model could not draw it: ${error instanceof Error ? error.message : String(error)}` }
    }
  }

  /** Sanitise, straighten the frame, and mark. */
  const prepare = (text: string): Candidate | { error: string } => {
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
    return { svg, removed: cleaned.removed, score: scoreBackdrop(svg, tones) }
  }

  // Three rooms at once, each from a different shot. Racing them is what turns
  // the brief's rules from a paragraph the model has read into something it has
  // to have obeyed to be the one that ships.
  const drawn = await Promise.all(
    Array.from({ length: CANDIDATES }, async (_unused, index) => {
      const text = await ask(brief(description, palette, shotFor(`${seed}#${index}`)))
      return typeof text === 'string' ? prepare(text) : text
    }),
  )

  const candidates = drawn.filter((one): one is Candidate => !('error' in one))
  if (candidates.length === 0) {
    const firstError = drawn.find((one): one is { error: string } => 'error' in one)
    return { ok: false, reason: firstError?.error ?? 'Nothing drawable came back.' }
  }

  let best = candidates.reduce((winner, one) => (one.score.total > winner.score.total ? one : winner))

  // One pass to fix what it lost marks for. Only what it lost marks for: a
  // model handed its own drawing and a short list of specific faults improves
  // it, and a model asked to "make it better" redraws something else entirely.
  if (best.score.notes.length > 0) {
    const repaired = await ask(repairBrief(best.svg, best.score.notes.slice(0, 6), palette))
    if (typeof repaired === 'string') {
      const marked = prepare(repaired)
      // Kept only if it actually improved. A repair pass can come back worse,
      // and the drawing that was already the best of three is not worth losing
      // to a second opinion.
      if (!('error' in marked) && marked.score.total > best.score.total) best = marked
    }
  }

  return {
    ok: true,
    dark: best.svg,
    // Drawn once, in the dim palette, then recoloured. Drawing it twice gave two
    // different rooms — see toLightBackdrop.
    light: toLightBackdrop(best.svg, palette),
    removed: best.removed,
  }
}
