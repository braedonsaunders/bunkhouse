'use client'

import * as React from 'react'
import { lightPools } from '../lib/scene-lighting'
import { PALETTES } from '../lib/scene-palette'
import { FRAME } from '../lib/scene-score'

/**
 * A department's own drawing, lit.
 *
 * The markup a model returns is flat by construction — shapes with fills, no
 * atmosphere — and it sat on the floor next to hand-drawn rooms that have a
 * pool of light under every fitting, haze along the horizon and a vignette over
 * the whole frame. Those are wide soft gradients: no model places them well
 * inside an SVG, and one that tried would spend a third of its shape budget on
 * three rectangles.
 *
 * So they are laid over the top here instead, positioned from where the
 * drawing's own lit shapes ended up (see lib/scene-lighting.ts). Nothing is
 * baked into the saved markup, which means every backdrop already in the
 * database gets this too, without being redrawn.
 *
 * The drawing itself is inserted as HTML because it IS markup — sanitised on
 * the way in and again on the way out of the form that saved it (lib/scene-svg.ts),
 * which is the only reason that is not reckless.
 */
export function DrawnRoom({
  svg,
  isDark,
  /** Held still for thumbnails — see `.bh-scene-still` in globals.css. */
  still = false,
  className = '',
}: {
  svg: string
  isDark: boolean
  still?: boolean
  className?: string
}) {
  // Reading the shapes back out is a pass over a few tens of kilobytes of
  // markup. Once per drawing, not once per render.
  const pools = React.useMemo(
    () => lightPools(svg, isDark ? PALETTES.dark.lit : PALETTES.light.lit),
    [svg, isDark],
  )
  const horizon = (FRAME.horizon / FRAME.height) * 100

  return (
    <div className={`bh-drawn-room absolute inset-0 overflow-hidden ${still ? 'bh-scene-still' : ''} ${className}`}>
      <div className="absolute inset-0 [&>svg]:h-full [&>svg]:w-full" dangerouslySetInnerHTML={{ __html: svg }} />

      {/* Light on the floor, under whatever is glowing above it. Half of each
          pool sits above the horizon so it reads as light falling rather than
          an ellipse painted on the ground. */}
      {pools.map((pool, index) => (
        <div
          key={index}
          className="pointer-events-none absolute"
          style={{
            left: `${(pool.x - pool.spread) * 100}%`,
            width: `${pool.spread * 200}%`,
            top: `${horizon - 6}%`,
            height: '46%',
            // Weaker in daylight, and it is not a fudge: a pool is the
            // difference between the lit floor and the unlit floor, and a pale
            // floor has less room above it to be brighter in. At the dim
            // room's strength it reads as fog rather than light.
            background: `radial-gradient(60% 100% at 50% 0%, rgb(${isDark ? '150 199 240' : '255 244 216'} / ${
              (isDark ? 0.16 : 0.2) * pool.strength
            }), transparent 72%)`,
          }}
          aria-hidden
        />
      ))}

      {/* Haze where the floor meets the wall. Depth is contrast before it is
          anything else: the far end of a room is never as sharp as the near.
          Faded at BOTH ends — a gradient that starts at full strength draws a
          hard line across the frame at the exact place it is meant to soften. */}
      <div
        className="pointer-events-none absolute inset-x-0"
        style={{
          top: `${horizon - 12}%`,
          height: '24%',
          background: isDark
            ? 'linear-gradient(to bottom, transparent, rgb(120 150 190 / 0.16) 42%, transparent)'
            : 'linear-gradient(to bottom, transparent, rgb(255 255 255 / 0.18) 42%, transparent)',
        }}
        aria-hidden
      />

      {/* The corner darkening every one of the hand-drawn rooms ends with. */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background: `radial-gradient(120% 90% at 50% 42%, transparent 42%, rgba(0,0,0,${isDark ? 0.55 : 0.28}) 100%)`,
        }}
        aria-hidden
      />
    </div>
  )
}
