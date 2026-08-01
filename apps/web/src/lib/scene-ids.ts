/**
 * Making one drawing's ids its own — the half of the SVG work that belongs on
 * both sides of the wire.
 *
 * This lives apart from `scene-svg.ts` because that module is `server-only`,
 * and rightly so: the sanitiser is a trust boundary, and shipping it to the
 * browser would invite sanitising there, where the result cannot be trusted.
 * Namespacing is not a trust boundary — it is string work on markup that has
 * already been sanitised, and it has to run at render time, in the client
 * component that draws the room. Importing it from the server-only module put
 * `server-only` into the client graph and failed the production build, while
 * dev carried on happily.
 */
/**
 * Make a drawing's internal ids its own.
 *
 * Every generated room names its gradients for what they are — `floorLight`,
 * `wallLight`, `windowSky` — because that is what a model calls them and the
 * brief never said otherwise. Put two rooms in one document and those ids
 * collide: `url(#floorLight)` resolves to whichever came first, so the second
 * room quietly paints its floor, wall and sky with the first room's gradients.
 * It is not an error anywhere — the drawing is valid, the reference resolves,
 * and the room is simply wrong. Caught with a dim room and a bright one side
 * by side, where the bright one rendered its whole floor near-black.
 *
 * Namespacing at render time rather than when the drawing is saved means every
 * room already in the database is fixed too, and a room stays correct however
 * many of it end up on one page.
 */
export function namespaceSvgIds(svg: string, namespace: string): string {
  const ids = new Set<string>()
  for (const match of svg.matchAll(/\sid="([^"]+)"/g)) ids.add(match[1]!)
  if (ids.size === 0) return svg

  const rename = (id: string) => `${namespace}-${id}`
  let out = svg
  for (const id of ids) {
    // Escaped because a model is free to name a gradient anything at all, and
    // an unescaped id containing regex punctuation would rewrite the wrong
    // thing — or nothing.
    const quoted = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    out = out
      .replace(new RegExp(`(\\sid=")${quoted}(")`, 'g'), `$1${rename(id)}$2`)
      .replace(new RegExp(`(url\\(#)${quoted}(\\))`, 'g'), `$1${rename(id)}$2`)
      .replace(new RegExp(`((?:xlink:)?href="#)${quoted}(")`, 'g'), `$1${rename(id)}$2`)
  }
  return out
}
