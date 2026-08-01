/**
 * The motion a drawn room is allowed to ask for.
 *
 * The hand-drawn rooms are full of small loops — screens breathing, an LED
 * blinking, a plant swaying — and every one of them is a CSS class in
 * globals.css that the compositor owns. A generated backdrop was a still
 * picture next to them, which is most of why it read as the cheaper thing on
 * the same screen.
 *
 * So a model may put these class names on its shapes, and nothing else. The
 * list is the contract in both directions: the brief quotes it when asking, and
 * the sanitiser matches against it when a drawing comes back — a `class` it
 * does not recognise is dropped, so a drawing cannot reach into the app's own
 * stylesheet and dress itself as, say, a fixed-position overlay.
 */

/** Class name → what it is for, in the words the brief uses to ask for it. */
export const BACKDROP_MOTION: Record<string, string> = {
  'bhs-glow': 'breathes brighter and dimmer — a screen, a lamp shade, a lit doorway',
  'bhs-blink': 'blinks on and off — a status LED, an indicator, a charging light',
  'bhs-twinkle': 'twinkles faintly — a distant window, a light across the street, a star',
  'bhs-sway': 'rocks slowly on its base — a plant, a hanging sign, a cable',
  'bhs-shaft': 'swells and fades — a sunbeam, light spilling from a doorway',
  'bhs-spin': 'turns steadily — a ceiling fan, a wheel, a turbine vent',
  'bhs-steam': 'rises and fades — steam from a mug, a wisp from a vent',
  'bhs-drift': 'crosses the frame very slowly — a cloud past a window',
}

export const BACKDROP_MOTION_CLASSES: ReadonlySet<string> = new Set(Object.keys(BACKDROP_MOTION))

/** How many moving shapes a room should have. Enough to live, few enough to ignore. */
export const MOTION_RANGE = { min: 4, max: 14 } as const

/** Keep only the motion classes; drop anything else a drawing tried to carry. */
export function keepMotionClasses(value: string): string {
  return value
    .split(/\s+/)
    .filter((name) => BACKDROP_MOTION_CLASSES.has(name))
    .join(' ')
}
