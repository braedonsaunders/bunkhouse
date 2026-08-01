'use client'

// The room names live outside this module: a server component importing a
// value from a 'use client' file gets a proxy, not the value.
export { SCENE_KINDS, SCENE_LABELS, type SceneKind } from './scene-kinds'
import { SCENE_KINDS, type SceneKind } from './scene-kinds'

import * as React from 'react'
import type { SceneGroundConfig } from '@appkit/scene'

/**
 * The rooms the staff work in.
 *
 * `@appkit/scene` ships a set of painted stages, but they were drawn as
 * backdrops for a small hero panel: a flat colour band, a handful of props
 * floating on it, no architecture. Filling a whole screen with one shows every
 * seam — desks hanging in the sky, no ceiling, no walls, props sized for a
 * different figure. These are the same six environments rebuilt for the floor
 * they actually occupy.
 *
 * The method is the same throughout:
 *
 *  - **A real room.** One-point perspective: a back wall inset from the frame,
 *    two side walls running out to the screen corners, a ceiling plane above
 *    and a floor below, all converging on a vanishing point at the middle of
 *    the horizon. That single box is what the old stages were missing, and it
 *    does most of the work.
 *  - **Depth by contrast, not just size.** Anything near the horizon is
 *    lower-contrast and pulled toward the wall colour; anything downstage is
 *    saturated and hard-edged. Every prop gets a contact shadow, so it sits on
 *    the floor instead of hovering over it.
 *  - **A light source you can point at.** Troffers, high bays, pendants, a low
 *    sun — each throws a pool onto the floor and picks out the edges facing it.
 *    Day and night are two different lighting rigs, not two palettes.
 *  - **Scale set by the cast.** A figure at the front of the room is about
 *    210px tall, so a desk is ~95px high and a rack is ~185px. Props are drawn
 *    against that, then scaled by depth.
 *
 * Motion is CSS keyframes (`globals.css`, "Scene art"), never a JS animation
 * library: a room holds a hundred or so animated elements and the compositor
 * should own all of them. Everything is deterministic — no `Math.random()` at
 * render — so the server and client markup agree.
 */


// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/** Where the back wall meets the floor, in percent from the top. */
const HORIZON: Record<SceneKind, number> = {
  office: 40,
  executive: 40,
  warehouse: 38,
  serverroom: 42,
  breakroom: 40,
  rooftop: 36,
}

/** How far the back wall is inset from each edge — the side walls' near edge. */
const WALL_INSET: Record<SceneKind, number> = {
  office: 9,
  executive: 7,
  warehouse: 11,
  serverroom: 10,
  breakroom: 9,
  rooftop: 0,
}

/**
 * Walk geometry. `minX`/`maxX` stay inside the side walls so nobody stands in
 * a wall at the back of the room, and `minY` sits a little below the horizon
 * so nobody stands *on* it.
 */
const WALK: Record<SceneKind, Pick<SceneGroundConfig, 'walkableArea' | 'scaleRange'>> = {
  office: { walkableArea: { minX: 14, maxX: 86, minY: 46, maxY: 88 }, scaleRange: { min: 0.5, max: 1.25 } },
  executive: { walkableArea: { minX: 13, maxX: 87, minY: 46, maxY: 88 }, scaleRange: { min: 0.5, max: 1.25 } },
  warehouse: { walkableArea: { minX: 16, maxX: 84, minY: 45, maxY: 88 }, scaleRange: { min: 0.48, max: 1.25 } },
  serverroom: { walkableArea: { minX: 15, maxX: 85, minY: 48, maxY: 88 }, scaleRange: { min: 0.52, max: 1.2 } },
  breakroom: { walkableArea: { minX: 14, maxX: 86, minY: 46, maxY: 88 }, scaleRange: { min: 0.5, max: 1.25 } },
  rooftop: { walkableArea: { minX: 8, maxX: 92, minY: 44, maxY: 88 }, scaleRange: { min: 0.48, max: 1.28 } },
}

/** The air above the horizon — sky, or the far end of the room. */
const BACKDROP: Record<SceneKind, { day: string; night: string }> = {
  office: {
    day: 'linear-gradient(to bottom, #e9eef5 0%, #dfe6ef 60%, #d3dbe6 100%)',
    night: 'linear-gradient(to bottom, #0e141f 0%, #131a27 60%, #18202f 100%)',
  },
  executive: {
    day: 'linear-gradient(to bottom, #2b1f1a 0%, #3a2a22 60%, #4a352a 100%)',
    night: 'linear-gradient(to bottom, #14100e 0%, #1b1512 60%, #241b16 100%)',
  },
  warehouse: {
    day: 'linear-gradient(to bottom, #d8dade 0%, #cbced4 60%, #b9bdc4 100%)',
    night: 'linear-gradient(to bottom, #14171c 0%, #1a1e24 60%, #22262e 100%)',
  },
  serverroom: {
    day: 'linear-gradient(to bottom, #1b2634 0%, #16202c 60%, #121a25 100%)',
    night: 'linear-gradient(to bottom, #060c15 0%, #08101c 60%, #0a1421 100%)',
  },
  breakroom: {
    day: 'linear-gradient(to bottom, #f3ece2 0%, #ece3d6 60%, #e2d7c7 100%)',
    night: 'linear-gradient(to bottom, #1d1815 0%, #241d19 60%, #2c231d 100%)',
  },
  rooftop: {
    day: 'linear-gradient(to bottom, #5fa8e0 0%, #8cc6ef 34%, #c3e2f7 62%, #f2e2c8 88%, #f6d9ae 100%)',
    night: 'linear-gradient(to bottom, #050a17 0%, #0b1226 34%, #16203c 66%, #2a2a45 88%, #46374a 100%)',
  },
}

/** The floor plane. Scene art lays light, seams and reflections over this. */
const GROUND: Record<SceneKind, { day: string; night: string }> = {
  office: {
    day: 'linear-gradient(to bottom, #9aa3ae 0%, #8e97a3 34%, #7d8794 100%)',
    night: 'linear-gradient(to bottom, #232a35 0%, #1d232d 40%, #161b23 100%)',
  },
  executive: {
    day: 'linear-gradient(to bottom, #6b4a32 0%, #5b3e2a 40%, #472f20 100%)',
    night: 'linear-gradient(to bottom, #2a1d14 0%, #22170f 45%, #17100a 100%)',
  },
  warehouse: {
    day: 'linear-gradient(to bottom, #a8aab0 0%, #9a9ca3 40%, #86888f 100%)',
    night: 'linear-gradient(to bottom, #2c3038 0%, #24282f 45%, #1b1f25 100%)',
  },
  serverroom: {
    day: 'linear-gradient(to bottom, #2b3644 0%, #232d39 45%, #1a222c 100%)',
    night: 'linear-gradient(to bottom, #101a26 0%, #0c141e 45%, #080e16 100%)',
  },
  breakroom: {
    day: 'linear-gradient(to bottom, #d9d1c6 0%, #cdc4b7 40%, #b9afa0 100%)',
    night: 'linear-gradient(to bottom, #34302c 0%, #2b2724 45%, #211e1b 100%)',
  },
  rooftop: {
    day: 'linear-gradient(to bottom, #a8825c 0%, #96714d 40%, #7d5c3d 100%)',
    night: 'linear-gradient(to bottom, #392b20 0%, #2e2119 45%, #221810 100%)',
  },
}

/**
 * The full ground config for a stage: our walk geometry with the room's own
 * day-or-night planes. Pass alongside `<BunkhouseSceneArt />`.
 */
export function bunkhouseSceneGround(kind: SceneKind): SceneGroundConfig {
  return {
    horizonY: HORIZON[kind],
    ...WALK[kind],
    // Deliberately blank. The scene's own backdrop and floor planes are painted
    // by the art layer instead (see `SceneLayer`), because switching rooms
    // wipes one whole picture over another — and a plane owned by the stage
    // underneath would snap to the new room while the wipe was still running.
    backdropStyle: { css: 'transparent' },
    groundStyle: { css: 'transparent' },
  }
}

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

type SceneProps = { isDark: boolean }

/** A deterministic sequence — the same room on the server and in the browser. */
function seeded(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 4294967296
  }
}

const pick = <T,>(day: T, night: T, isDark: boolean): T => (isDark ? night : day)

/**
 * The breathing range for a `.bhs-glow` element.
 *
 * That class animates `opacity`, and a running CSS animation outranks both the
 * SVG `opacity` presentation attribute and an inline `opacity` style — so a
 * lamp cone set to `opacity={0.07}` paints at full strength anyway. The
 * keyframes read these two custom properties instead, which is the only channel
 * the animation does not overwrite.
 */
function glow(low: number, high = 1): React.CSSProperties {
  return { '--bhs-lo': low, '--bhs-hi': high } as React.CSSProperties
}

/** Distance-hazed colour: things near the horizon lose contrast, not detail. */
function haze(color: string, air: string, amount: number): string {
  return `color-mix(in srgb, ${color} ${Math.round((1 - amount) * 100)}%, ${air})`
}

/**
 * A prop pinned to the floor. `x`/`y` are percentages of the stage; the art is
 * drawn at its natural pixel size and scaled by depth, and the anchor is the
 * bottom centre — where it touches the ground.
 */
function Prop({
  x,
  y,
  scale = 1,
  z = 0,
  flip = false,
  shadow,
  children,
}: {
  x: number
  y: number
  scale?: number
  /** Paint order inside the art layer. Characters always sit above all of it. */
  z?: number
  flip?: boolean
  /** Contact shadow: [width, height] in the prop's own pixel units. */
  shadow?: [number, number]
  children: React.ReactNode
}) {
  return (
    <div
      className="absolute"
      style={{
        left: `${x}%`,
        top: `${y}%`,
        zIndex: z,
        transform: `translate(-50%, -100%) scale(${scale})${flip ? ' scaleX(-1)' : ''}`,
        transformOrigin: '50% 100%',
      }}
    >
      {shadow ? (
        <div
          className="absolute left-1/2 rounded-[50%]"
          style={{
            bottom: -shadow[1] * 0.34,
            width: shadow[0],
            height: shadow[1],
            marginLeft: -shadow[0] / 2,
            background:
              'radial-gradient(ellipse at center, rgba(0,0,0,0.34) 0%, rgba(0,0,0,0.14) 55%, transparent 72%)',
            filter: 'blur(3px)',
          }}
        />
      ) : null}
      <div className="relative">{children}</div>
    </div>
  )
}

/**
 * The room box. One-point perspective around a vanishing point at the centre
 * of the horizon: back wall, two side walls out to the screen corners, a
 * ceiling plane, and the skirting where the walls meet the floor.
 */
function RoomBox({
  horizon,
  inset,
  ceiling,
  back,
  backLow,
  left,
  right,
  ceilingFill,
  skirting,
}: {
  horizon: number
  inset: number
  /** Depth of the ceiling plane, in percent from the top. */
  ceiling: number
  back: string
  backLow?: string
  left: string
  right: string
  ceilingFill: string
  skirting: string
}) {
  const far = 100 - inset
  return (
    <svg
      className="absolute inset-0 h-full w-full"
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      aria-hidden
    >
      <defs>
        <linearGradient id="rb-back" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={back} />
          <stop offset="100%" stopColor={backLow ?? back} />
        </linearGradient>
      </defs>
      <polygon points={`0,0 ${inset},${ceiling} ${far},${ceiling} 100,0`} fill={ceilingFill} />
      <rect x={inset} y={ceiling} width={far - inset} height={horizon - ceiling} fill="url(#rb-back)" />
      <polygon points={`0,0 ${inset},${ceiling} ${inset},${horizon} 0,100`} fill={left} />
      <polygon points={`100,0 ${far},${ceiling} ${far},${horizon} 100,100`} fill={right} />
      {/* Skirting: straight across the back, raking away down each side wall. */}
      <rect x={inset} y={horizon - 1.1} width={far - inset} height={1.1} fill={skirting} />
      <polygon points={`0,100 0,96.5 ${inset},${horizon - 1.1} ${inset},${horizon}`} fill={skirting} />
      <polygon points={`100,100 100,96.5 ${far},${horizon - 1.1} ${far},${horizon}`} fill={skirting} />
    </svg>
  )
}

/** Floor seams converging on the vanishing point, plus transverse joints. */
function FloorGrid({
  horizon,
  columns = 13,
  rows = 6,
  stroke,
  width = 0.16,
  spread = 2.4,
}: {
  horizon: number
  columns?: number
  rows?: number
  stroke: string
  width?: number
  /** How far past the frame the seams fan out at the near edge. */
  spread?: number
}) {
  const depth = 100 - horizon
  return (
    <svg
      className="absolute inset-0 h-full w-full"
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      aria-hidden
    >
      {Array.from({ length: columns }, (_, i) => {
        const at = (i + 0.5) / columns
        return (
          <line
            key={`c${i}`}
            x1={at * 100}
            y1={horizon}
            x2={(at * 100 - 50) * spread + 50}
            y2={100}
            stroke={stroke}
            strokeWidth={width}
          />
        )
      })}
      {Array.from({ length: rows }, (_, i) => {
        // Joints crowd toward the horizon, exactly as a receding floor does.
        const y = horizon + depth * Math.pow((i + 1) / (rows + 1), 2.1)
        return <line key={`r${i}`} x1="0" y1={y} x2="100" y2={y} stroke={stroke} strokeWidth={width * 0.85} />
      })}
    </svg>
  )
}

/**
 * Carpet tile, in perspective. Every other tile is laid a shade off its
 * neighbour — the reason a real office floor reads as a weave from across the
 * room rather than as one flat sweep of colour.
 */
function CarpetTiles({ horizon, isDark }: { horizon: number; isDark: boolean }) {
  const depth = 100 - horizon
  const rows = 9
  const columns = 22
  const shade = pick('rgba(255,255,255,0.05)', 'rgba(255,255,255,0.03)', isDark)
  return (
    <svg
      className="absolute inset-0 h-full w-full"
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      aria-hidden
    >
      {Array.from({ length: rows }, (_, row) => {
        const yNear = horizon + depth * Math.pow((row + 1) / rows, 2.1)
        const yFar = horizon + depth * Math.pow(row / rows, 2.1)
        // The seams fan out from the vanishing point, so a tile is a trapezoid.
        const spreadNear = 0.36 + ((yNear - horizon) / depth) * 2.05
        const spreadFar = 0.36 + ((yFar - horizon) / depth) * 2.05
        return Array.from({ length: columns }, (_, column) => {
          if ((row + column) % 2 === 0) return null
          const a = ((column / columns) * 100 - 50) * spreadFar + 50
          const b = (((column + 1) / columns) * 100 - 50) * spreadFar + 50
          const c = (((column + 1) / columns) * 100 - 50) * spreadNear + 50
          const d = ((column / columns) * 100 - 50) * spreadNear + 50
          return (
            <polygon
              key={`${row}-${column}`}
              points={`${a},${yFar} ${b},${yFar} ${c},${yNear} ${d},${yNear}`}
              fill={shade}
            />
          )
        })
      })}
    </svg>
  )
}

/** A pool of light thrown onto the floor by a fixture overhead. */
function FloorPool({
  x,
  y,
  width,
  height,
  color,
  opacity = 0.3,
  pulse,
}: {
  x: number
  y: number
  width: number
  height: number
  color: string
  opacity?: number
  /** Set to breathe the pool with the fixture above it. */
  pulse?: boolean
}) {
  return (
    <div
      className={pulse ? 'bhs-glow' : undefined}
      style={{
        position: 'absolute',
        left: `${x}%`,
        top: `${y}%`,
        width: `${width}%`,
        height: `${height}%`,
        transform: 'translate(-50%, -50%)',
        background: `radial-gradient(ellipse at center, ${color} 0%, transparent 70%)`,
        mixBlendMode: 'screen',
        ...(pulse ? glow(opacity * 0.72, opacity) : { opacity }),
      }}
    />
  )
}

/** Slow motes hanging in a shaft of light. */
function Motes({
  seed,
  count = 16,
  left,
  top,
  width,
  height,
  color,
}: {
  seed: number
  count?: number
  left: number
  top: number
  width: number
  height: number
  color: string
}) {
  const rnd = seeded(seed)
  const motes = Array.from({ length: count }, () => ({
    x: rnd() * 100,
    y: rnd() * 100,
    size: 1.4 + rnd() * 2.2,
    delay: -rnd() * 18,
    duration: 12 + rnd() * 12,
  }))
  return (
    <div
      className="pointer-events-none absolute overflow-hidden"
      style={{ left: `${left}%`, top: `${top}%`, width: `${width}%`, height: `${height}%` }}
      aria-hidden
    >
      {motes.map((mote, index) => (
        <span
          key={index}
          className="bhs-mote absolute rounded-full"
          style={{
            left: `${mote.x}%`,
            top: `${mote.y}%`,
            width: mote.size,
            height: mote.size,
            background: color,
            animationDelay: `${mote.delay}s`,
            animationDuration: `${mote.duration}s`,
          }}
        />
      ))}
    </div>
  )
}

/** The corner darkening that keeps a wide room from reading as a flat card. */
function Vignette({ strength = 0.4 }: { strength?: number }) {
  return (
    <div
      className="pointer-events-none absolute inset-0"
      style={{
        background: `radial-gradient(120% 90% at 50% 42%, transparent 42%, rgba(0,0,0,${strength}) 100%)`,
      }}
      aria-hidden
    />
  )
}

/** A potted plant. The one prop every one of these rooms wants. */
function Plant({ isDark, tall = false }: { isDark: boolean; tall?: boolean }) {
  const leaf = pick('#3f9a52', '#2a6238', isDark)
  const leafDark = pick('#2f7a40', '#1d4a2a', isDark)
  const pot = pick('#c1663a', '#7c3f24', isDark)
  const potLip = pick('#d9784a', '#94502e', isDark)
  return (
    <svg width="76" height={tall ? 132 : 104} viewBox={tall ? '0 0 76 132' : '0 0 76 104'} aria-hidden>
      <g className="bhs-sway" style={{ transformOrigin: '38px 100%' }}>
        {tall ? (
          <>
            <path d="M38 90 C24 66 16 50 20 22 C32 34 38 58 40 84 Z" fill={leafDark} />
            <path d="M38 92 C52 68 60 52 58 20 C44 34 40 58 38 86 Z" fill={leaf} />
            <path d="M38 94 C28 78 14 72 6 56 C22 56 34 70 39 86 Z" fill={leaf} />
            <path d="M38 94 C48 78 62 72 70 56 C54 56 42 70 37 86 Z" fill={leafDark} />
            <path d="M38 96 C36 70 34 44 39 12 C46 40 42 72 40 94 Z" fill={leaf} />
          </>
        ) : (
          <>
            <path d="M38 70 C26 56 14 50 12 30 C26 34 34 46 39 62 Z" fill={leafDark} />
            <path d="M38 70 C50 54 62 48 64 28 C50 32 42 46 37 62 Z" fill={leaf} />
            <path d="M38 68 C36 48 32 34 38 14 C46 30 42 50 39 66 Z" fill={leaf} />
            <path d="M38 72 C30 64 18 62 10 54 C22 52 33 60 38 68 Z" fill={leafDark} />
          </>
        )}
      </g>
      <g transform={tall ? 'translate(0,28)' : 'translate(0,0)'}>
        <path d="M25 72 L51 72 L47 102 L29 102 Z" fill={pot} />
        <rect x="23" y="68" width="30" height="7" rx="2.5" fill={potLip} />
        <path d="M25 72 L31 72 L28 102 L29 102 Z" fill="rgba(255,255,255,0.14)" />
      </g>
    </svg>
  )
}

/** A rolling office chair, seen from behind. */
function Chair({ isDark, tint }: { isDark: boolean; tint?: string }) {
  const body = tint ?? pick('#3b4655', '#232b36', isDark)
  const dark = pick('#26303c', '#161c25', isDark)
  return (
    <svg width="74" height="96" viewBox="0 0 74 96" aria-hidden>
      <rect x="14" y="0" width="46" height="46" rx="10" fill={body} />
      <rect x="19" y="6" width="36" height="12" rx="6" fill="rgba(255,255,255,0.08)" />
      <rect x="8" y="20" width="8" height="22" rx="4" fill={dark} />
      <rect x="58" y="20" width="8" height="22" rx="4" fill={dark} />
      <rect x="12" y="46" width="50" height="12" rx="5" fill={body} />
      <rect x="34" y="58" width="6" height="20" fill={dark} />
      <path d="M37 78 L14 92 M37 78 L60 92 M37 78 L37 94 M37 78 L18 82 M37 78 L56 82" stroke={dark} strokeWidth="4" strokeLinecap="round" />
    </svg>
  )
}

/** A desk with a monitor that is doing something. */
function Desk({
  isDark,
  // Not `glow` — that name belongs to the breathing-range helper above, and a
  // prop by the same name shadows it inside this component.
  screenGlow,
  seed,
  lamp = false,
}: {
  isDark: boolean
  screenGlow: string
  seed: number
  lamp?: boolean
}) {
  const rnd = seeded(seed)
  const top = pick('#c9b79c', '#5b4a38', isDark)
  const topEdge = pick('#b09a7c', '#463829', isDark)
  const leg = pick('#8b8f97', '#3a3f48', isDark)
  const bezel = pick('#2a3038', '#12161c', isDark)
  const bars = Array.from({ length: 6 }, () => 8 + rnd() * 42)
  return (
    <svg width="176" height="128" viewBox="0 0 176 128" className="overflow-visible" aria-hidden>
      {/* Screen spill on the desk surface */}
      <ellipse cx="88" cy="72" rx="52" ry="9" fill={screenGlow} opacity={isDark ? 0.35 : 0.16} />
      {/* Monitor */}
      <rect x="52" y="6" width="72" height="46" rx="3" fill={bezel} />
      <rect x="55" y="9" width="66" height="40" rx="2" fill={screenGlow} opacity={isDark ? 0.95 : 0.75} />
      <g opacity={isDark ? 0.5 : 0.42}>
        <rect x="58" y="12" width="26" height="3" rx="1.5" fill="#0b1017" />
        {bars.map((width, index) => (
          <rect key={index} x="58" y={19 + index * 5} width={width} height="2.4" rx="1.2" fill="#0b1017" />
        ))}
      </g>
      <rect x="55" y="9" width="66" height="40" rx="2" fill="none" stroke="rgba(255,255,255,0.16)" strokeWidth="1" />
      <rect x="83" y="52" width="10" height="12" fill={bezel} />
      <rect x="70" y="63" width="36" height="4" rx="2" fill={bezel} />
      {lamp ? (
        <g>
          <rect x="27" y="66" width="14" height="3" rx="1.5" fill={leg} />
          <path d="M34 66 L34 40 L48 32" stroke={leg} strokeWidth="3" fill="none" strokeLinecap="round" />
          <path d="M44 26 L58 34 L52 40 L40 32 Z" fill={pick('#4a5563', '#2b333d', isDark)} />
          <ellipse className="bhs-glow" cx="50" cy="38" rx="6" ry="4" fill="#ffd88a" style={glow(isDark ? 0.75 : 0.3, isDark ? 1 : 0.45)} />
        </g>
      ) : null}
      {/* Keyboard, mouse, mug, papers */}
      <rect x="60" y="70" width="46" height="7" rx="2" fill={pick('#e6e2da', '#2e343c', isDark)} />
      <ellipse cx="116" cy="74" rx="5" ry="3.5" fill={pick('#e6e2da', '#2e343c', isDark)} />
      <rect x="34" y="66" width="14" height="11" rx="2" fill={pick('#e8623d', '#a03f27', isDark)} />
      <path d="M48 68 q 6 3 0 7" stroke={pick('#e8623d', '#a03f27', isDark)} strokeWidth="2.4" fill="none" />
      <rect x="128" y="70" width="22" height="6" rx="1" fill={pick('#f2efe8', '#3a4049', isDark)} transform="rotate(-6 139 73)" />
      {/* Desk top + legs */}
      <rect x="6" y="77" width="164" height="9" rx="3" fill={top} />
      <rect x="6" y="86" width="164" height="3" fill={topEdge} />
      <rect x="18" y="89" width="7" height="34" rx="2" fill={leg} />
      <rect x="151" y="89" width="7" height="34" rx="2" fill={leg} />
      <rect x="22" y="104" width="132" height="4" rx="2" fill={leg} opacity="0.65" />
      {/* Cable spill under the desk */}
      <path d="M92 89 C 96 104, 84 108, 88 122" stroke={pick('#6b7078', '#20252c', isDark)} strokeWidth="2" fill="none" />
    </svg>
  )
}

/** A skyline layer — the further back, the more it dissolves into the air. */
function Skyline({
  seed,
  count,
  color,
  air,
  fade,
  heights,
  lit,
  isDark,
}: {
  seed: number
  count: number
  color: string
  air: string
  /** 0 = full contrast, 1 = gone. */
  fade: number
  heights: [number, number]
  lit: boolean
  isDark: boolean
}) {
  const rnd = seeded(seed)
  const towers = Array.from({ length: count }, (_, index) => ({
    x: (index / count) * 108 - 4 + rnd() * 3,
    width: 4 + rnd() * 6,
    height: heights[0] + rnd() * (heights[1] - heights[0]),
    spire: rnd() > 0.78,
    windows: Array.from({ length: 22 }, () => rnd() > 0.42),
    beacon: rnd() > 0.7,
  }))
  const fill = haze(color, air, fade)
  return (
    <svg
      className="absolute inset-0 h-full w-full"
      viewBox="0 0 100 60"
      preserveAspectRatio="none"
      aria-hidden
    >
      {towers.map((tower, index) => (
        <g key={index}>
          <rect x={tower.x} y={60 - tower.height} width={tower.width} height={tower.height} fill={fill} />
          {tower.spire ? (
            <rect
              x={tower.x + tower.width / 2 - 0.35}
              y={60 - tower.height - 5}
              width={0.7}
              height={5}
              fill={fill}
            />
          ) : null}
          {lit && isDark
            ? tower.windows.map((on, w) =>
                on ? (
                  <rect
                    key={w}
                    x={tower.x + 0.9 + (w % 3) * (tower.width / 3.4)}
                    y={60 - tower.height + 2 + Math.floor(w / 3) * 3.1}
                    width={0.8}
                    height={1.5}
                    fill="#ffdf9c"
                    opacity={(1 - fade) * 0.85}
                  />
                ) : null,
              )
            : null}
          {tower.beacon ? (
            <circle
              className="bhs-blink"
              cx={tower.x + tower.width / 2}
              cy={60 - tower.height - (tower.spire ? 5 : 0.6)}
              r="0.55"
              fill="#ff5a4a"
              style={{ animationDelay: `${index * 0.37}s` }}
            />
          ) : null}
        </g>
      ))}
    </svg>
  )
}

/** Glass: sky and city behind, mullions and a reflection sheen in front. */
function WindowWall({
  isDark,
  left,
  top,
  width,
  height,
  bays = 4,
  seed,
  sky,
  children,
}: {
  isDark: boolean
  left: number
  top: number
  width: number
  height: number
  bays?: number
  seed: number
  sky: string
  children?: React.ReactNode
}) {
  const frame = pick('#8d949e', '#1a1f27', isDark)
  return (
    <div
      className="absolute overflow-hidden"
      style={{ left: `${left}%`, top: `${top}%`, width: `${width}%`, height: `${height}%` }}
    >
      <div className="absolute inset-0" style={{ background: sky }} />
      {children}
      {/* Layered city, hazier the further away it is. */}
      <div className="absolute inset-x-0 bottom-0 h-[72%]">
        <Skyline
          seed={seed}
          count={11}
          color={pick('#7f93ab', '#1c2637', isDark)}
          air={pick('#cfe0ef', '#111a2b', isDark)}
          fade={0.62}
          heights={[16, 40]}
          lit
          isDark={isDark}
        />
      </div>
      <div className="absolute inset-x-0 bottom-0 h-[54%]">
        <Skyline
          seed={seed + 77}
          count={8}
          color={pick('#5d738f', '#141d2b', isDark)}
          air={pick('#cfe0ef', '#111a2b', isDark)}
          fade={0.28}
          heights={[14, 34]}
          lit
          isDark={isDark}
        />
      </div>
      {/* Reflection sheen across the glass. */}
      <div
        className="absolute inset-0"
        style={{
          background: isDark
            ? 'linear-gradient(115deg, rgba(255,255,255,0.07) 0%, transparent 34%, rgba(255,255,255,0.04) 52%, transparent 78%)'
            : 'linear-gradient(115deg, rgba(255,255,255,0.42) 0%, transparent 34%, rgba(255,255,255,0.24) 52%, transparent 78%)',
        }}
      />
      {/* Mullions and frame. */}
      {Array.from({ length: bays - 1 }, (_, index) => (
        <div
          key={index}
          className="absolute inset-y-0"
          style={{ left: `${((index + 1) / bays) * 100}%`, width: 5, marginLeft: -2.5, background: frame }}
        />
      ))}
      <div className="absolute inset-x-0 top-0" style={{ height: 6, background: frame }} />
      <div className="absolute inset-x-0 bottom-0" style={{ height: 7, background: frame }} />
      <div className="absolute inset-y-0 left-0" style={{ width: 6, background: frame }} />
      <div className="absolute inset-y-0 right-0" style={{ width: 6, background: frame }} />
      <div
        className="absolute inset-x-0"
        style={{ top: '46%', height: 4, background: frame, opacity: 0.9 }}
      />
    </div>
  )
}

/** Slow clouds behind glass or over a roof. */
function Clouds({ seed, opacity = 0.75 }: { seed: number; opacity?: number }) {
  const rnd = seeded(seed)
  const clouds = Array.from({ length: 5 }, () => ({
    top: 4 + rnd() * 34,
    scale: 0.6 + rnd() * 0.9,
    delay: -rnd() * 200,
    duration: 150 + rnd() * 160,
  }))
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
      {clouds.map((cloud, index) => (
        <svg
          key={index}
          className="bhs-drift absolute"
          width="150"
          height="52"
          viewBox="0 0 150 52"
          style={{
            top: `${cloud.top}%`,
            opacity,
            transform: `scale(${cloud.scale})`,
            animationDelay: `${cloud.delay}s`,
            animationDuration: `${cloud.duration}s`,
          }}
        >
          <g fill="currentColor">
            <ellipse cx="46" cy="34" rx="40" ry="16" />
            <ellipse cx="76" cy="26" rx="30" ry="20" />
            <ellipse cx="104" cy="34" rx="32" ry="14" />
          </g>
        </svg>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// OFFICE — open plan: glazed back wall, desk pods, a meeting pod, carpet tile
// ---------------------------------------------------------------------------

function OfficeScene({ isDark }: SceneProps) {
  const horizon = HORIZON.office
  const inset = WALL_INSET.office
  const glowBlue = pick('#8fd0f5', '#4fb8f0', isDark)

  return (
    <div className="absolute inset-0 overflow-hidden" aria-hidden>
      <RoomBox
        horizon={horizon}
        inset={inset}
        ceiling={7}
        back={pick('#eef1f5', '#1d2530', isDark)}
        backLow={pick('#dfe4ec', '#252e3a', isDark)}
        left={pick('#d3d9e2', '#171e27', isDark)}
        right={pick('#c9d0da', '#141b23', isDark)}
        ceilingFill={pick('#f4f6f9', '#131922', isDark)}
        skirting={pick('#b6bec9', '#0f141b', isDark)}
      />

      {/* --- Ceiling: troffers, diffusers, a sprinkler run ------------------ */}
      <svg className="absolute inset-0 h-full w-full" viewBox="0 0 100 100" preserveAspectRatio="none">
        {[0.22, 0.5, 0.78].map((at, row) => (
          <g key={row}>
            {[1.4, 3.2, 5.4].map((depth, band) => {
              const t = depth / 7
              const halfWidth = (5.5 + band * 3.4) / 2
              const x = 50 + (at * 100 - 50) * (0.36 + t * 0.9)
              return (
                <rect
                  key={band}
                  className="bhs-glow"
                  x={x - halfWidth}
                  y={depth}
                  width={halfWidth * 2}
                  height={0.5 + band * 0.22}
                  rx="0.2"
                  fill={pick('#ffffff', '#fff6d8', isDark)}
                  style={{ ...glow(isDark ? 0.78 : 0.72, isDark ? 1 : 0.92), animationDelay: `${row * 1.3 + band * 0.4}s` }}
                />
              )
            })}
          </g>
        ))}
        {/* Air diffusers between the light rows. */}
        {[0.36, 0.64].map((at, index) => (
          <rect
            key={index}
            x={50 + (at * 100 - 50) * 0.7 - 1.6}
            y="3.6"
            width="3.2"
            height="1.1"
            rx="0.2"
            fill={pick('#d8dde4', '#0e131a', isDark)}
          />
        ))}
        <line x1="0" y1="6.2" x2="100" y2="6.2" stroke={pick('#c8ced7', '#0d1219', isDark)} strokeWidth="0.25" />
      </svg>

      {/* --- Back wall: the glazed band ------------------------------------- */}
      <WindowWall
        isDark={isDark}
        left={inset + 3}
        top={10}
        width={100 - 2 * (inset + 3)}
        height={horizon - 10 - 7}
        bays={5}
        seed={4101}
        sky={
          isDark
            ? 'linear-gradient(to bottom, #060b18 0%, #0d1730 55%, #16233f 100%)'
            : 'linear-gradient(to bottom, #79bdea 0%, #a9d6f2 55%, #d9ecf8 100%)'
        }
      >
        {!isDark ? (
          <div
            className="bhs-glow absolute rounded-full"
            style={{
              left: '72%',
              top: '16%',
              width: '9%',
              height: '26%',
              background: 'radial-gradient(circle, #fff8d6 0%, #ffe9a3 46%, transparent 72%)',
            }}
          />
        ) : (
          <div
            className="absolute rounded-full"
            style={{
              left: '18%',
              top: '14%',
              width: '6%',
              height: '18%',
              background: 'radial-gradient(circle, #f4f6ff 0%, #cdd8f0 48%, transparent 74%)',
              opacity: 0.9,
            }}
          />
        )}
        <div style={{ color: isDark ? 'rgba(150,170,210,0.16)' : 'rgba(255,255,255,0.8)' }}>
          <Clouds seed={919} opacity={isDark ? 0.5 : 0.8} />
        </div>
      </WindowWall>

      {/* Blinds tucked above the glass, and the sill below it. */}
      <div
        className="absolute"
        style={{
          left: `${inset + 3}%`,
          top: '10%',
          width: `${100 - 2 * (inset + 3)}%`,
          height: '2.4%',
          background: `repeating-linear-gradient(to bottom, ${pick('#c3c9d2', '#151a22', isDark)} 0 2px, ${pick(
            '#aeb5c0',
            '#0f141b',
            isDark,
          )} 2px 4px)`,
        }}
      />
      <div
        className="absolute"
        style={{
          left: `${inset + 1.6}%`,
          top: `${horizon - 7}%`,
          width: `${100 - 2 * (inset + 1.6)}%`,
          height: '1.3%',
          background: pick('#cdd3db', '#161c25', isDark),
        }}
      />

      {/* --- Back wall furniture ------------------------------------------- */}
      {/* A low credenza run under the window, with clutter along the top. */}
      <Prop x={50} y={horizon + 0.5} scale={0.82} shadow={[320, 22]}>
        <svg width="320" height="80" viewBox="0 0 320 80">
          {/* Clutter along the top before the carcass, so it sits behind. */}
          <rect x="30" y="0" width="26" height="12" rx="2" fill={pick('#8fa8bd', '#2f4152', isDark)} />
          <rect x="62" y="4" width="14" height="8" rx="1" fill={pick('#c9793f', '#5f371c', isDark)} />
          <rect x="240" y="2" width="34" height="10" rx="1.5" fill={pick('#f2efe8', '#3a4049', isDark)} />
          <rect x="0" y="12" width="320" height="46" rx="3" fill={pick('#b0b8c3', '#2a323d', isDark)} />
          <rect x="0" y="8" width="320" height="7" rx="3" fill={pick('#d6dbe2', '#39434f', isDark)} />
          {[10, 89, 168, 247].map((x) => (
            <g key={x}>
              <rect x={x} y="20" width="64" height="32" rx="2" fill={pick('#9fa8b4', '#222932', isDark)} />
              <rect x={x + 24} y="34" width="16" height="3" rx="1.5" fill={pick('#767f8b', '#4b5563', isDark)} />
            </g>
          ))}
          <rect x="0" y="58" width="320" height="9" fill={pick('#8b95a2', '#1a2027', isDark)} />
        </svg>
      </Prop>
      <Prop x={20} y={horizon + 1} scale={0.55} shadow={[46, 10]}>
        <Plant isDark={isDark} />
      </Prop>
      <Prop x={80} y={horizon + 1} scale={0.55} shadow={[46, 10]}>
        <Plant isDark={isDark} />
      </Prop>

      {/* Wall clock and acoustic panels on the left wall, raked with it. */}
      <div className="absolute" style={{ left: '2.6%', top: '17%', transform: 'skewY(11deg)' }}>
        <svg width="50" height="50" viewBox="0 0 54 54">
          <circle cx="27" cy="27" r="24" fill={pick('#f7f8fa', '#2b333e', isDark)} stroke={pick('#8d96a2', '#151b22', isDark)} strokeWidth="3" />
          {[0, 90, 180, 270].map((angle) => (
            <line
              key={angle}
              x1="27"
              y1="8"
              x2="27"
              y2="12"
              stroke={pick('#8d96a2', '#5d6772', isDark)}
              strokeWidth="2"
              transform={`rotate(${angle} 27 27)`}
            />
          ))}
          <circle cx="27" cy="27" r="2" fill={pick('#39414b', '#cbd3dd', isDark)} />
          <line x1="27" y1="27" x2="27" y2="14" stroke={pick('#39414b', '#cbd3dd', isDark)} strokeWidth="2.6" strokeLinecap="round" />
          <line className="bhs-tick" x1="27" y1="27" x2="39" y2="27" stroke={pick('#39414b', '#cbd3dd', isDark)} strokeWidth="2" strokeLinecap="round" style={{ transformOrigin: '27px 27px' }} />
        </svg>
      </div>
      {[24, 30.5].map((top, index) => (
        <div
          key={index}
          className="absolute"
          style={{
            left: '1.6%',
            top: `${top}%`,
            width: '5%',
            height: '5.4%',
            borderRadius: 2,
            background: pick('#c9bcaa', '#3a3128', isDark),
            border: `1px solid ${pick('#ab9c88', '#241d18', isDark)}`,
            boxShadow: 'inset 0 0 12px rgba(0,0,0,0.14)',
            transform: `skewY(${10 + index}deg)`,
          }}
        />
      ))}

      {/* Whiteboard on the right wall, angled with the wall. */}
      <div
        className="absolute"
        style={{ right: '1.5%', top: '14%', width: '7.5%', height: '15%', transform: 'skewY(-11deg)' }}
      >
        <div
          className="h-full w-full rounded-sm"
          style={{
            background: pick('#fbfcfd', '#c9cfd8', isDark),
            border: `3px solid ${pick('#98a1ac', '#4b545f', isDark)}`,
          }}
        >
          <svg className="h-full w-full" viewBox="0 0 60 44" preserveAspectRatio="none">
            <path d="M7 10 H36 M7 18 H46 M7 26 H28" stroke="#2f9ad6" strokeWidth="2" strokeLinecap="round" />
            <path d="M38 30 L52 20" stroke="#e0554b" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </div>
      </div>

      {/* --- The floor ------------------------------------------------------ */}
      {/* Carpet tiles: the seams, then every other tile a shade off, so the
          floor has a weave instead of being one flat sweep of colour. */}
      <CarpetTiles horizon={horizon} isDark={isDark} />
      <FloorGrid horizon={horizon} columns={15} rows={7} stroke={pick('rgba(30,34,42,0.16)', 'rgba(0,0,0,0.38)', isDark)} />
      {/* Light pools under the troffer rows. Daylight barely registers on
          carpet, so these stay faint by day and do the lighting at night. */}
      <FloorPool x={22} y={horizon + 24} width={42} height={38} color={pick('rgba(255,255,255,0.16)', 'rgba(255,238,196,0.2)', isDark)} />
      <FloorPool x={50} y={horizon + 34} width={52} height={46} color={pick('rgba(255,255,255,0.18)', 'rgba(255,238,196,0.22)', isDark)} />
      <FloorPool x={78} y={horizon + 24} width={42} height={38} color={pick('rgba(255,255,255,0.16)', 'rgba(255,238,196,0.2)', isDark)} />
      {/* Daylight off the window wall: a single wash along the back of the
          floor. Cast wedges were tried here and read as pale bands lying over
          the room rather than light falling into it — a glazed wall this size
          gives flat fill, not shafts. */}
      {!isDark ? (
        <div
          className="absolute inset-x-0"
          style={{
            top: `${horizon}%`,
            height: '22%',
            background: 'linear-gradient(to bottom, rgba(255,247,225,0.3), transparent 90%)',
          }}
        />
      ) : null}

      {/* --- Desk pods ------------------------------------------------------ */}
      {/* Back row, small and low-contrast. */}
      <Prop x={26} y={horizon + 9} scale={0.5} shadow={[176, 20]}>
        <Desk isDark={isDark} screenGlow={glowBlue} seed={11} />
      </Prop>
      <Prop x={50} y={horizon + 9} scale={0.5} shadow={[176, 20]}>
        <Desk isDark={isDark} screenGlow={glowBlue} seed={12} lamp />
      </Prop>
      <Prop x={74} y={horizon + 9} scale={0.5} shadow={[176, 20]}>
        <Desk isDark={isDark} screenGlow={glowBlue} seed={13} />
      </Prop>
      <Prop x={33} y={horizon + 7.5} scale={0.42} shadow={[74, 12]}>
        <Chair isDark={isDark} />
      </Prop>
      <Prop x={65} y={horizon + 7.5} scale={0.42} flip shadow={[74, 12]}>
        <Chair isDark={isDark} />
      </Prop>

      {/* Mid row, out at the sides so the middle of the floor stays walkable. */}
      <Prop x={12} y={horizon + 27} scale={0.78} shadow={[176, 24]}>
        <Desk isDark={isDark} screenGlow={glowBlue} seed={21} lamp />
      </Prop>
      <Prop x={88} y={horizon + 27} scale={0.78} flip shadow={[176, 24]}>
        <Desk isDark={isDark} screenGlow={glowBlue} seed={22} />
      </Prop>
      <Prop x={22} y={horizon + 24} scale={0.62} shadow={[74, 14]}>
        <Chair isDark={isDark} tint={pick('#4b6b8a', '#2b3a4a', isDark)} />
      </Prop>

      {/* Downstage pair, right at the edges of the walkable floor. */}
      <Prop x={4} y={96} scale={1.15} shadow={[176, 30]}>
        <Desk isDark={isDark} screenGlow={glowBlue} seed={31} />
      </Prop>
      <Prop x={96} y={93} scale={1.05} flip shadow={[176, 28]}>
        <Desk isDark={isDark} screenGlow={glowBlue} seed={32} lamp />
      </Prop>

      {/* --- Odds and ends -------------------------------------------------- */}
      {/* Water cooler. */}
      <Prop x={16} y={horizon + 6} scale={0.85} shadow={[52, 12]}>
        <svg width="60" height="130" viewBox="0 0 60 130">
          <path d="M16 4 L44 4 L40 44 L20 44 Z" fill={pick('#9ed3ec', '#2a5a72', isDark)} opacity="0.92" />
          <path d="M16 4 L24 4 L21 44 L20 44 Z" fill="rgba(255,255,255,0.4)" />
          <rect x="14" y="42" width="32" height="66" rx="4" fill={pick('#dfe5ec', '#39424d', isDark)} />
          <rect x="21" y="64" width="18" height="10" rx="2" fill={pick('#7f8894', '#1c222a', isDark)} />
          <path d="M26 74 L26 82 M34 74 L34 82" stroke={pick('#9aa3ae', '#2a323b', isDark)} strokeWidth="3" strokeLinecap="round" />
          <rect x="14" y="108" width="32" height="18" rx="3" fill={pick('#b7bfc9', '#262d36', isDark)} />
          <circle className="bhs-blink" cx="39" cy="54" r="2.2" fill="#5ad07f" />
        </svg>
      </Prop>
      {/* Printer on a stand. */}
      <Prop x={84} y={horizon + 6} scale={0.85} shadow={[80, 14]}>
        <svg width="94" height="110" viewBox="0 0 94 110">
          <rect x="8" y="20" width="78" height="38" rx="4" fill={pick('#aeb7c2', '#333c46', isDark)} />
          <rect x="16" y="8" width="62" height="14" rx="3" fill={pick('#8f99a6', '#262e37', isDark)} />
          <rect x="20" y="58" width="54" height="9" rx="2" fill={pick('#e6eaef', '#454f5b', isDark)} />
          <rect x="24" y="55" width="46" height="5" rx="1" fill={pick('#fbfcfd', '#59636f', isDark)} />
          <circle className="bhs-blink" cx="74" cy="30" r="2.6" fill="#4ec3f0" style={{ animationDelay: '0.7s' }} />
          <rect x="18" y="67" width="58" height="36" fill={pick('#98a2ae', '#232a33', isDark)} />
          <rect x="24" y="76" width="46" height="20" rx="2" fill={pick('#87919e', '#1a2027', isDark)} />
        </svg>
      </Prop>
      {/* Filing cabinets on the left. */}
      <Prop x={9} y={horizon + 21} scale={0.95} shadow={[96, 18]}>
        <svg width="104" height="118" viewBox="0 0 104 118">
          <rect x="0" y="4" width="104" height="108" rx="3" fill={pick('#9ba5b1', '#2a323d', isDark)} />
          <rect x="0" y="0" width="104" height="7" rx="2" fill={pick('#bcc4cd', '#39434f', isDark)} />
          {[12, 46, 80].map((y) => (
            <g key={y}>
              <rect x="6" y={y} width="92" height="30" rx="2" fill={pick('#8b95a2', '#222932', isDark)} />
              <rect x="38" y={y + 13} width="28" height="4" rx="2" fill={pick('#6d7885', '#4b5563', isDark)} />
            </g>
          ))}
        </svg>
      </Prop>
      {/* A stray chair someone left in the middle of the room. */}
      <Prop x={92} y={horizon + 40} scale={0.9} shadow={[74, 18]}>
        <Chair isDark={isDark} tint={pick('#6b7a52', '#3a4430', isDark)} />
      </Prop>
      <Prop x={7} y={horizon + 46} scale={1.25} shadow={[70, 16]}>
        <Plant isDark={isDark} tall />
      </Prop>

      {isDark ? <Motes seed={3311} count={14} left={20} top={horizon - 24} width={60} height={40} color="rgba(255,240,200,0.5)" /> : null}
      {!isDark ? <Motes seed={3312} count={18} left={24} top={horizon - 20} width={56} height={44} color="rgba(255,250,225,0.85)" /> : null}
      <Vignette strength={isDark ? 0.52 : 0.28} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// EXECUTIVE — corner office: two glass walls, a walnut slab, a good rug
// ---------------------------------------------------------------------------

/**
 * The corner office's second wall of glass, cut into the right-hand wall quad.
 *
 * The wall runs from the back corner `(100 - inset, ceiling…horizon)` out to
 * the frame's right edge `(100, 0…100)`, so the glazing is a trapezoid on that
 * plane and its mullions are lines that lean with it. The city inside is
 * clipped to the same shape.
 */
function RightWallGlass({ isDark, horizon, inset }: { isDark: boolean; horizon: number; inset: number }) {
  const near = 100 - inset
  // The glazed opening: inset a little from the wall's own edges.
  const topFar = 8.5
  const bottomFar = horizon - 1.6
  const topNear = 1.5
  const bottomNear = 92
  const frame = pick('#7c644f', '#141a22', isDark)
  return (
    <svg className="absolute inset-0 h-full w-full" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
      <defs>
        <clipPath id="exec-return" clipPathUnits="userSpaceOnUse">
          <polygon points={`${near},${topFar} 100,${topNear} 100,${bottomNear} ${near},${bottomFar}`} />
        </clipPath>
        <linearGradient id="exec-return-sky" x1="0" y1="0" x2="0" y2="1">
          {isDark ? (
            <>
              <stop offset="0%" stopColor="#070d1c" />
              <stop offset="60%" stopColor="#131e3a" />
              <stop offset="100%" stopColor="#1e2b4a" />
            </>
          ) : (
            <>
              <stop offset="0%" stopColor="#f0a75e" />
              <stop offset="45%" stopColor="#f2c893" />
              <stop offset="100%" stopColor="#e2d7c2" />
            </>
          )}
        </linearGradient>
      </defs>
      <g clipPath="url(#exec-return)">
        <rect x={near} y="0" width={inset} height="100" fill="url(#exec-return-sky)" />
        {/* A few towers, leaning with the wall so they read as seen through it. */}
        {[0.18, 0.4, 0.58, 0.78].map((t, index) => {
          const x = near + inset * t
          const width = inset * 0.13
          const base = bottomFar + (bottomNear - bottomFar) * t
          const height = 9 + ((index * 7) % 11)
          return (
            <g key={t}>
              <rect x={x} y={base - height} width={width} height={height} fill={pick('#c39a6d', '#131b2c', isDark)} />
              {isDark
                ? Array.from({ length: 6 }, (_, w) => (
                    <rect
                      key={w}
                      x={x + width * 0.2}
                      y={base - height + 1.4 + w * 1.5}
                      width={width * 0.28}
                      height="0.7"
                      fill="#ffdf9c"
                      opacity="0.7"
                    />
                  ))
                : null}
            </g>
          )
        })}
        {/* Mullions leaning out with the wall. */}
        {[0.3, 0.62].map((t) => (
          <line
            key={t}
            x1={near + inset * t}
            y1={topFar + (topNear - topFar) * t}
            x2={near + inset * t}
            y2={bottomFar + (bottomNear - bottomFar) * t}
            stroke={frame}
            strokeWidth="0.55"
          />
        ))}
        {/* Transom, and the sheen off the glass. */}
        <line x1={near} y1={topFar + 13} x2="100" y2={topNear + 15} stroke={frame} strokeWidth="0.45" />
        <polygon
          points={`${near},${topFar} 100,${topNear} 100,${topNear + 26} ${near},${topFar + 22}`}
          fill={isDark ? 'rgba(255,255,255,0.05)' : 'rgba(255,255,255,0.28)'}
        />
      </g>
      {/* The corner mullion — the one heavy vertical in the room. */}
      <line x1={near} y1={topFar - 1} x2={near} y2={bottomFar} stroke={frame} strokeWidth="0.9" />
      {/* The wall darkens as it turns away from the window. */}
      <polygon
        points={`${near},${topFar} 100,${topNear} 100,${bottomNear} ${near},${bottomFar}`}
        fill="url(#exec-return-shade)"
      />
      <defs>
        <linearGradient id="exec-return-shade" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="rgba(0,0,0,0.34)" />
          <stop offset="55%" stopColor="rgba(0,0,0,0.06)" />
          <stop offset="100%" stopColor="rgba(0,0,0,0)" />
        </linearGradient>
      </defs>
    </svg>
  )
}

function ExecutiveScene({ isDark }: SceneProps) {
  const horizon = HORIZON.executive
  const inset = WALL_INSET.executive
  const woodDark = pick('#4a3324', '#241811', isDark)

  return (
    <div className="absolute inset-0 overflow-hidden" aria-hidden>
      <RoomBox
        horizon={horizon}
        inset={inset}
        ceiling={6}
        back={pick('#3c2b21', '#1c1512', isDark)}
        backLow={pick('#4a3628', '#241a15', isDark)}
        left={pick('#3a2a20', '#191211', isDark)}
        right={pick('#312319', '#150f0d', isDark)}
        ceilingFill={pick('#2e211a', '#120e0c', isDark)}
        skirting={woodDark}
      />

      {/* Coffered ceiling with downlights. */}
      <svg className="absolute inset-0 h-full w-full" viewBox="0 0 100 100" preserveAspectRatio="none">
        {[1.4, 3.1, 5.0].map((y, index) => (
          <line key={index} x1={50 - (16 + index * 12)} y1={y} x2={50 + (16 + index * 12)} y2={y} stroke={pick('#513a2c', '#2a1e18', isDark)} strokeWidth="0.35" />
        ))}
        {[24, 38, 50, 62, 76].map((x, index) => (
          <ellipse
            key={x}
            className="bhs-glow"
            cx={50 + (x - 50) * 0.66}
            cy="4.4"
            rx="1.1"
            ry="0.5"
            fill="#ffdca4"
            style={{ ...glow(isDark ? 0.76 : 0.4, isDark ? 1 : 0.6), animationDelay: `${index * 0.6}s` }}
          />
        ))}
      </svg>

      {/* The corner: glass on the back wall and running down the right wall. */}
      <WindowWall
        isDark={isDark}
        left={inset + 1.5}
        top={8}
        // Run the glass right up to the corner mullion, so the two walls of
        // glazing actually meet — that meeting is the whole point of a corner
        // office.
        width={100 - inset - (inset + 1.5)}
        height={horizon - 8 - 4}
        bays={4}
        seed={5201}
        sky={
          isDark
            ? 'linear-gradient(to bottom, #060a16 0%, #101a33 50%, #1d2a48 100%)'
            : 'linear-gradient(to bottom, #f7b26a 0%, #f5cf9a 40%, #e8dcc4 75%, #d8d9d0 100%)'
        }
      >
        {!isDark ? (
          <div
            className="bhs-glow absolute rounded-full"
            style={{
              left: '24%',
              top: '58%',
              width: '16%',
              height: '34%',
              background: 'radial-gradient(circle, #fff3c9 0%, #ffcf7a 45%, transparent 72%)',
            }}
          />
        ) : (
          <div
            className="absolute rounded-full"
            style={{
              left: '76%',
              top: '12%',
              width: '7%',
              height: '20%',
              background: 'radial-gradient(circle, #ffffff 0%, #d5dcf2 50%, transparent 74%)',
            }}
          />
        )}
      </WindowWall>
      {/* The return wall of glass, glazed into the right-hand wall's own
          geometry. A CSS 3D rotation was tried and could not be made to agree
          with the room box — it overshot the wall and ran off the frame. Drawn
          as a polygon in the same non-uniform viewBox, it cannot disagree. */}
      <RightWallGlass isDark={isDark} horizon={horizon} inset={inset} />

      {/* Floor: dark plank + a mirror-sheen of the window. */}
      <FloorGrid horizon={horizon} columns={19} rows={5} stroke={pick('rgba(0,0,0,0.24)', 'rgba(0,0,0,0.45)', isDark)} width={0.13} />
      <div
        className="absolute"
        style={{
          left: `${inset + 4}%`,
          top: `${horizon}%`,
          width: '52%',
          height: '34%',
          background: isDark
            ? 'linear-gradient(to bottom, rgba(160,190,255,0.16), transparent 72%)'
            : 'linear-gradient(to bottom, rgba(255,214,150,0.42), transparent 72%)',
          filter: 'blur(6px)',
        }}
      />

      {/* Rug. */}
      <div
        className="absolute"
        style={{
          left: '50%',
          top: `${horizon + 26}%`,
          width: '52%',
          height: '30%',
          transform: 'translateX(-50%)',
          borderRadius: '46%',
          background: isDark
            ? 'radial-gradient(ellipse, rgba(112,45,38,0.62) 0%, rgba(78,32,28,0.42) 58%, transparent 76%)'
            : 'radial-gradient(ellipse, rgba(170,72,55,0.55) 0%, rgba(140,60,46,0.32) 58%, transparent 76%)',
        }}
      />
      {/* A border and a scatter of medallions, not concentric rings — rings at
          this scale read as a running track painted on the floor. */}
      <svg
        className="absolute"
        style={{ left: '50%', top: `${horizon + 26}%`, width: '52%', height: '30%', transform: 'translateX(-50%)' }}
        viewBox="0 0 100 60"
        preserveAspectRatio="none"
      >
        <ellipse cx="50" cy="30" rx="39" ry="21" fill="none" stroke={pick('#e6c48a', '#8a6a3e', isDark)} strokeWidth="0.7" opacity="0.4" />
        <ellipse cx="50" cy="30" rx="36" ry="19" fill="none" stroke={pick('#e6c48a', '#8a6a3e', isDark)} strokeWidth="0.35" opacity="0.28" />
        {[
          [50, 30, 7, 4],
          [26, 26, 4, 2.4],
          [74, 26, 4, 2.4],
          [38, 42, 3.4, 2],
          [62, 42, 3.4, 2],
        ].map(([cx, cy, rx, ry], index) => (
          <ellipse
            key={index}
            cx={cx}
            cy={cy}
            rx={rx}
            ry={ry}
            fill="none"
            stroke={pick('#e6c48a', '#8a6a3e', isDark)}
            strokeWidth="0.5"
            opacity="0.3"
          />
        ))}
      </svg>

      {/* The desk. */}
      <Prop x={31} y={horizon + 26} scale={1.05} shadow={[290, 34]}>
        <svg width="290" height="150" viewBox="0 0 290 150" className="overflow-visible">
          {isDark ? <ellipse className="bhs-glow" cx="222" cy="52" rx="60" ry="30" fill="#ffca6e" style={glow(0.14, 0.24)} /> : null}
          {/* Banker's lamp */}
          <path d="M200 34 L246 34 L236 16 L210 16 Z" fill={pick('#1f6b45', '#123f29', isDark)} />
          <rect x="220" y="34" width="5" height="26" fill={pick('#b98a3d', '#7a5a26', isDark)} />
          <rect x="210" y="58" width="26" height="5" rx="2" fill={pick('#b98a3d', '#7a5a26', isDark)} />
          <ellipse className="bhs-glow" cx="223" cy="36" rx="17" ry="6" fill="#ffe6ad" style={glow(isDark ? 0.75 : 0.3, isDark ? 1 : 0.45)} />
          {/* Laptop */}
          <path d="M64 52 L128 52 L136 62 L56 62 Z" fill={pick('#8d949e', '#39424d', isDark)} />
          <rect x="68" y="24" width="56" height="28" rx="2" fill={pick('#4a525c', '#1a2027', isDark)} />
          <rect x="71" y="27" width="50" height="22" rx="1" fill={pick('#bfe4f7', '#3aa7e0', isDark)} opacity={isDark ? 0.9 : 0.8} />
          {/* Papers, pen cup, phone */}
          <rect x="146" y="52" width="34" height="10" rx="1" fill={pick('#f4efe4', '#4a525c', isDark)} transform="rotate(-5 163 57)" />
          <rect x="152" y="48" width="30" height="10" rx="1" fill={pick('#fbf7ee', '#535c67', isDark)} transform="rotate(4 167 53)" />
          <rect x="20" y="44" width="16" height="18" rx="2" fill={pick('#5d4a35', '#2e2419', isDark)} />
          <path d="M24 44 L24 32 M28 44 L29 30 M32 44 L33 34" stroke={pick('#c9a55f', '#8a7440', isDark)} strokeWidth="2" strokeLinecap="round" />
          {/* Walnut slab and legs */}
          <rect x="4" y="62" width="282" height="14" rx="4" fill={pick('#7a5334', '#3f2a1b', isDark)} />
          <rect x="4" y="76" width="282" height="5" fill={pick('#5f3f26', '#2c1c12', isDark)} />
          <rect x="4" y="62" width="282" height="4" fill="rgba(255,255,255,0.12)" />
          <rect x="26" y="81" width="12" height="62" fill={pick('#5f3f26', '#2c1c12', isDark)} />
          <rect x="252" y="81" width="12" height="62" fill={pick('#5f3f26', '#2c1c12', isDark)} />
          <rect x="30" y="81" width="230" height="26" fill={pick('#6b4a2d', '#341f14', isDark)} opacity="0.85" />
        </svg>
      </Prop>
      {/* Leather chair behind the desk. */}
      <Prop x={31} y={horizon + 15} scale={0.8} shadow={[80, 16]}>
        <Chair isDark={isDark} tint={pick('#4a3324', '#241811', isDark)} />
      </Prop>

      {/* Credenza with awards and a decanter, along the left wall. */}
      <Prop x={11} y={horizon + 12} scale={0.86} shadow={[150, 20]}>
        <svg width="150" height="96" viewBox="0 0 150 96">
          <rect x="0" y="26" width="150" height="52" rx="3" fill={pick('#6b4a2d', '#33210f', isDark)} />
          <rect x="0" y="22" width="150" height="6" rx="2" fill={pick('#8a6540', '#432c17', isDark)} />
          {[8, 56, 104].map((x) => (
            <rect key={x} x={x} y="34" width="38" height="36" rx="2" fill={pick('#5b3d24', '#291a0d', isDark)} />
          ))}
          <rect x="0" y="78" width="150" height="8" fill={pick('#4a3120', '#1e1309', isDark)} />
          {/* Decanter + glasses */}
          <path d="M26 22 L26 12 L22 6 L38 6 L34 12 L34 22 Z" fill={pick('#c9a55f', '#8a7440', isDark)} opacity="0.85" />
          <rect x="42" y="14" width="7" height="8" rx="1" fill={pick('#dfe6ee', '#5b636d', isDark)} opacity="0.8" />
          <rect x="52" y="14" width="7" height="8" rx="1" fill={pick('#dfe6ee', '#5b636d', isDark)} opacity="0.8" />
          {/* Award */}
          <path d="M104 22 L112 4 L120 22 Z" fill={pick('#d9c47e', '#8d7a3e', isDark)} />
          <rect x="102" y="22" width="20" height="4" fill={pick('#4a3120', '#241708', isDark)} />
        </svg>
      </Prop>

      {/* Framed art on the left wall, raked with the wall. */}
      <div className="absolute" style={{ left: '2%', top: '15%', width: '5.5%', height: '13%', transform: 'skewY(11deg)' }}>
        <div
          className="h-full w-full"
          style={{
            border: `4px solid ${pick('#c9a55f', '#6a5326', isDark)}`,
            background: isDark
              ? 'linear-gradient(160deg, #1d2a44, #33223a)'
              : 'linear-gradient(160deg, #6d94b8, #c98f6a)',
          }}
        />
      </div>

      {/* Floor lamp and plants. */}
      <Prop x={92} y={horizon + 22} scale={0.9} shadow={[46, 12]}>
        <svg width="70" height="180" viewBox="0 0 70 180" className="overflow-visible">
          <ellipse className="bhs-glow" cx="35" cy="26" rx="40" ry="26" fill="#ffd79a" style={glow(isDark ? 0.16 : 0.05, isDark ? 0.26 : 0.09)} />
          <path d="M16 34 L54 34 L46 10 L24 10 Z" fill={pick('#e0d4bd', '#4a4133', isDark)} />
          <rect x="33" y="34" width="4" height="128" fill={pick('#6d5642', '#2a231b', isDark)} />
          <ellipse cx="35" cy="164" rx="20" ry="6" fill={pick('#6d5642', '#2a231b', isDark)} />
        </svg>
      </Prop>
      <Prop x={6} y={94} scale={1.3}>
        <Plant isDark={isDark} tall />
      </Prop>
      <Prop x={72} y={horizon + 9} scale={0.62}>
        <Plant isDark={isDark} />
      </Prop>

      <Vignette strength={isDark ? 0.62 : 0.42} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// WAREHOUSE — racking in perspective, clerestory shafts, a forklift
// ---------------------------------------------------------------------------

/** A run of pallet racking. `depth` fades and shrinks it toward the horizon. */
function Racking({ isDark, seed, bays = 3 }: { isDark: boolean; seed: number; bays?: number }) {
  const rnd = seeded(seed)
  const upright = pick('#2f5fa8', '#16305a', isDark)
  const beam = pick('#e07a2a', '#8a4514', isDark)
  const levels = 3
  const width = bays * 96
  const height = 250
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="overflow-visible">
      {Array.from({ length: bays + 1 }, (_, i) => (
        <rect key={i} x={i * 96} y="0" width="10" height={height} fill={upright} />
      ))}
      {Array.from({ length: levels }, (_, level) => {
        const y = 62 + level * 62
        return (
          <g key={level}>
            <rect x="0" y={y} width={width} height="9" fill={beam} />
            {Array.from({ length: bays }, (_, bay) => {
              const present = rnd() > 0.16
              if (!present) return null
              const boxWidth = 54 + rnd() * 26
              const boxHeight = 30 + rnd() * 18
              const tone = rnd()
              const card = isDark ? (tone > 0.5 ? '#7a5836' : '#63472b') : tone > 0.5 ? '#d3a570' : '#bd8c56'
              return (
                <g key={bay}>
                  {/* Pallet */}
                  <rect x={bay * 96 + 14} y={y - 8} width={68} height="8" fill={pick('#a98a63', '#4c3a26', isDark)} />
                  {/* Load */}
                  <rect
                    x={bay * 96 + 14 + (68 - boxWidth) / 2}
                    y={y - 8 - boxHeight}
                    width={boxWidth}
                    height={boxHeight}
                    fill={card}
                    stroke={pick('#9c7448', '#3a2a1a', isDark)}
                    strokeWidth="1.5"
                  />
                  <line
                    x1={bay * 96 + 14 + 34}
                    y1={y - 8 - boxHeight}
                    x2={bay * 96 + 14 + 34}
                    y2={y - 8}
                    stroke={pick('#9c7448', '#3a2a1a', isDark)}
                    strokeWidth="2"
                  />
                  {rnd() > 0.5 ? (
                    <rect x={bay * 96 + 24} y={y - 8 - boxHeight + 6} width="14" height="9" fill={pick('#f4efe2', '#8f9299', isDark)} />
                  ) : null}
                </g>
              )
            })}
          </g>
        )
      })}
    </svg>
  )
}

function WarehouseScene({ isDark }: SceneProps) {
  const horizon = HORIZON.warehouse
  const inset = WALL_INSET.warehouse

  return (
    <div className="absolute inset-0 overflow-hidden" aria-hidden>
      <RoomBox
        horizon={horizon}
        inset={inset}
        ceiling={9}
        back={pick('#c5c8ce', '#232830', isDark)}
        backLow={pick('#b0b4bb', '#1b2028', isDark)}
        left={pick('#b7bbc2', '#1a1e25', isDark)}
        right={pick('#aeb2b9', '#161a20', isDark)}
        ceilingFill={pick('#9fa3aa', '#101318', isDark)}
        skirting={pick('#8b8f96', '#0f1318', isDark)}
      />
      {/* A painted kick rail along the base of the walls — a stripe, not the
          whole skirting, which read as a hazard band around the entire room. */}
      <svg className="absolute inset-0 h-full w-full" viewBox="0 0 100 100" preserveAspectRatio="none">
        <rect x={inset} y={horizon - 0.9} width={100 - 2 * inset} height="0.45" fill={pick('#e2a02f', '#6d4a12', isDark)} />
        <polygon points={`0,97.4 0,96.9 ${inset},${horizon - 0.9} ${inset},${horizon - 0.45}`} fill={pick('#e2a02f', '#6d4a12', isDark)} />
        <polygon
          points={`100,97.4 100,96.9 ${100 - inset},${horizon - 0.9} ${100 - inset},${horizon - 0.45}`}
          fill={pick('#e2a02f', '#6d4a12', isDark)}
        />
      </svg>

      {/* Steel roof: trusses and purlins receding to the vanishing point. */}
      <svg className="absolute inset-0 h-full w-full" viewBox="0 0 100 100" preserveAspectRatio="none">
        {[1.2, 2.9, 4.8, 6.9].map((y, index) => {
          const half = 50 - (index + 1) * 1.4
          return (
            <g key={index} stroke={pick('#8b8f96', '#0e1116', isDark)} strokeWidth={0.5 - index * 0.07}>
              <line x1={50 - half} y1={y} x2={50 + half} y2={y} />
              <path
                d={`M${50 - half} ${y} L50 ${y - 1.6} L${50 + half} ${y}`}
                fill="none"
              />
              {Array.from({ length: 8 }, (_, t) => (
                <line
                  key={t}
                  x1={50 - half + (half * 2 * t) / 8}
                  y1={y}
                  x2={50 - half + (half * 2 * (t + 0.5)) / 8}
                  y2={y - 1.2}
                  strokeWidth={0.24}
                />
              ))}
            </g>
          )
        })}
      </svg>

      {/* Clerestory glazing high on the back wall. */}
      {[16, 32, 48, 64, 80].map((x) => (
        <div
          key={x}
          className="absolute"
          style={{
            left: `${x}%`,
            top: '11%',
            width: '10%',
            height: '6%',
            background: isDark
              ? 'linear-gradient(to bottom, #16233a, #0d1522)'
              : 'linear-gradient(to bottom, #cfe6f6, #a9cfe8)',
            border: `2px solid ${pick('#7c828b', '#0d1015', isDark)}`,
            borderRadius: 2,
          }}
        />
      ))}
      {/* Daylight shafts through them. */}
      {!isDark
        ? [21, 53, 85].map((x, index) => (
            <div
              key={index}
              className="bhs-shaft absolute"
              style={{
                left: `${x}%`,
                top: '17%',
                width: '11%',
                height: '62%',
                transform: 'translateX(-50%) skewX(-13deg)',
                background:
                  'linear-gradient(to bottom, rgba(255,250,224,0.42), rgba(255,250,224,0.08) 60%, transparent)',
                animationDelay: `${index * 2.6}s`,
              }}
            />
          ))
        : null}

      {/* Roller door and man door on the back wall. */}
      <Prop x={50} y={horizon} scale={0.86}>
        <svg width="270" height="182" viewBox="0 0 270 182">
          <rect x="0" y="0" width="270" height="182" rx="2" fill={pick('#8e959e', '#232a33', isDark)} />
          {Array.from({ length: 12 }, (_, i) => (
            <rect key={i} x="6" y={6 + i * 14} width="258" height="10" rx="2" fill={pick('#b3bac3', '#2f3841', isDark)} />
          ))}
          <rect x="0" y="0" width="270" height="8" fill={pick('#5f666e', '#171c22', isDark)} />
          <rect x="112" y="160" width="46" height="8" rx="3" fill={pick('#5f666e', '#171c22', isDark)} />
        </svg>
      </Prop>
      <Prop x={22} y={horizon} scale={0.72}>
        <svg width="90" height="150" viewBox="0 0 90 150">
          <rect x="0" y="0" width="90" height="150" rx="2" fill={pick('#7d848c', '#1c222a', isDark)} />
          <rect x="6" y="6" width="78" height="138" rx="2" fill={pick('#98a0a8', '#262e37', isDark)} />
          <circle cx="72" cy="80" r="4" fill={pick('#4d545c', '#0f1319', isDark)} />
          <rect x="24" y="18" width="42" height="26" rx="2" fill={pick('#2f7a45', '#144d29', isDark)} />
        </svg>
      </Prop>
      {/* Safety signage. */}
      <div className="absolute" style={{ left: '68%', top: '26%' }}>
        <svg width="46" height="46" viewBox="0 0 46 46">
          <path d="M23 3 L44 41 L2 41 Z" fill="#f0c020" stroke="#2c2410" strokeWidth="3" strokeLinejoin="round" />
          <rect x="21" y="16" width="4" height="13" rx="2" fill="#2c2410" />
          <circle cx="23" cy="34" r="2.4" fill="#2c2410" />
        </svg>
      </div>

      {/* High-bay lamps with cones. */}
      {[20, 50, 80].map((x, index) => (
        <div key={x} className="absolute" style={{ left: `${x}%`, top: '8%', transform: 'translateX(-50%)' }}>
          <div className="mx-auto" style={{ width: 3, height: 26, background: pick('#6e747c', '#0f1318', isDark) }} />
          <svg width="96" height="150" viewBox="0 0 96 150" className="-translate-x-1/2 overflow-visible" style={{ marginLeft: '50%' }}>
            <path d="M26 20 L70 20 L60 4 L36 4 Z" fill={pick('#4d545c', '#191e24', isDark)} />
            <ellipse className="bhs-glow" cx="48" cy="23" rx="16" ry="5" fill="#ffeeb8" style={{ ...glow(isDark ? 0.8 : 0.34, isDark ? 1 : 0.5), animationDelay: `${index * 0.9}s` }} />
            <path
              className="bhs-glow"
              d="M28 24 L68 24 L94 150 L2 150 Z"
              fill="#ffeeb8"
              style={{ ...glow(isDark ? 0.11 : 0.04, isDark ? 0.18 : 0.08), animationDelay: `${index * 1.4}s` }}
            />
          </svg>
        </div>
      ))}

      {/* Floor: sealed concrete, joints, lane markings. */}
      <FloorGrid horizon={horizon} columns={9} rows={6} stroke={pick('rgba(0,0,0,0.14)', 'rgba(0,0,0,0.4)', isDark)} width={0.22} spread={2.8} />
      <svg className="absolute inset-0 h-full w-full" viewBox="0 0 100 100" preserveAspectRatio="none">
        {/* Two lane lines converging on the door. */}
        {[-1, 1].map((side) => (
          <polygon
            key={side}
            points={`${50 + side * 9},${horizon} ${50 + side * 9.6},${horizon} ${50 + side * 42},100 ${50 + side * 39},100`}
            fill={pick('#e0b429', '#7a5c0e', isDark)}
            opacity="0.45"
          />
        ))}
        {/* A hatched keep-clear box at the front. */}
        {Array.from({ length: 7 }, (_, i) => (
          <line
            key={i}
            x1={6 + i * 4}
            y1={94}
            x2={12 + i * 4}
            y2={82}
            stroke={pick('#e0b429', '#7a5c0e', isDark)}
            strokeWidth="0.5"
            opacity="0.3"
          />
        ))}
      </svg>
      {/* Oil marks. */}
      {[
        [64, 78, 9],
        [36, 88, 12],
      ].map(([x, y, w], index) => (
        <div
          key={index}
          className="absolute rounded-[50%]"
          style={{
            left: `${x}%`,
            top: `${y}%`,
            width: `${w}%`,
            height: `${w! * 0.28}%`,
            transform: 'translate(-50%, -50%)',
            background: 'radial-gradient(ellipse, rgba(0,0,0,0.22) 0%, transparent 70%)',
          }}
        />
      ))}

      {/* Racking: a far run against each side wall, a near run downstage. */}
      <div className="absolute" style={{ left: '13%', top: `${horizon}%`, transform: 'translate(-50%, -100%) scale(0.52)', transformOrigin: '50% 100%', opacity: 0.92 }}>
        <Racking isDark={isDark} seed={801} bays={3} />
      </div>
      <div className="absolute" style={{ left: '87%', top: `${horizon}%`, transform: 'translate(-50%, -100%) scale(0.52) scaleX(-1)', transformOrigin: '50% 100%', opacity: 0.92 }}>
        <Racking isDark={isDark} seed={802} bays={3} />
      </div>
      <div className="absolute" style={{ left: '2%', top: '99%', transform: 'translate(-50%, -100%) scale(1.05)', transformOrigin: '50% 100%' }}>
        <Racking isDark={isDark} seed={803} bays={2} />
      </div>
      <div className="absolute" style={{ left: '98%', top: '96%', transform: 'translate(-50%, -100%) scale(0.98) scaleX(-1)', transformOrigin: '50% 100%' }}>
        <Racking isDark={isDark} seed={804} bays={2} />
      </div>

      {/* Forklift, parked off the walking lane against the right-hand racking. */}
      <Prop x={90} y={horizon + 30} scale={1.05} shadow={[150, 26]}>
        <svg width="172" height="150" viewBox="0 0 172 150" className="overflow-visible">
          {/* Mast */}
          <rect x="16" y="10" width="8" height="106" fill={pick('#6b7078', '#2a2f36', isDark)} />
          <rect x="28" y="16" width="6" height="100" fill={pick('#585d64', '#22272d', isDark)} />
          <rect x="6" y="104" width="42" height="8" fill={pick('#6b7078', '#2a2f36', isDark)} />
          <path d="M10 112 L10 126 L46 126 L46 112 Z" fill={pick('#585d64', '#22272d', isDark)} />
          {/* Body */}
          <rect x="52" y="58" width="88" height="52" rx="6" fill={pick('#f0a52c', '#8a5c12', isDark)} />
          <rect x="60" y="40" width="52" height="24" rx="4" fill={pick('#d98f1e', '#6f4a0e', isDark)} />
          <rect x="96" y="66" width="40" height="26" rx="3" fill={pick('#2e343c', '#14181d', isDark)} />
          {/* Overhead guard */}
          <rect x="58" y="4" width="76" height="6" rx="2" fill={pick('#3c424a', '#1a1e23', isDark)} />
          <rect x="60" y="8" width="5" height="34" fill={pick('#3c424a', '#1a1e23', isDark)} />
          <rect x="128" y="8" width="5" height="52" fill={pick('#3c424a', '#1a1e23', isDark)} />
          {/* Wheels */}
          <circle cx="72" cy="118" r="18" fill={pick('#22262b', '#0d1014', isDark)} />
          <circle cx="72" cy="118" r="7" fill={pick('#8d939b', '#3a4048', isDark)} />
          <circle cx="130" cy="120" r="14" fill={pick('#22262b', '#0d1014', isDark)} />
          <circle cx="130" cy="120" r="5" fill={pick('#8d939b', '#3a4048', isDark)} />
          {/* Beacon */}
          <circle className="bhs-blink" cx="96" cy="0" r="5" fill="#ffb020" />
        </svg>
      </Prop>

      {/* Loose pallets, a stretch-wrapped stack, a drum. */}
      <Prop x={30} y={horizon + 40} scale={1} shadow={[130, 22]}>
        <svg width="140" height="120" viewBox="0 0 140 120">
          <rect x="22" y="26" width="52" height="44" fill={pick('#d3a570', '#63472b', isDark)} stroke={pick('#9c7448', '#3a2a1a', isDark)} strokeWidth="2" />
          <rect x="66" y="8" width="46" height="62" fill={pick('#bd8c56', '#523a22', isDark)} stroke={pick('#9c7448', '#3a2a1a', isDark)} strokeWidth="2" />
          <rect x="18" y="70" width="106" height="12" fill={pick('#a98a63', '#4c3a26', isDark)} />
          {[22, 66, 108].map((x) => (
            <rect key={x} x={x} y="82" width="14" height="14" fill={pick('#8f7050', '#3b2c1c', isDark)} />
          ))}
          <rect x="18" y="96" width="106" height="8" fill={pick('#a98a63', '#4c3a26', isDark)} />
        </svg>
      </Prop>
      <Prop x={9} y={horizon + 20} scale={0.7} shadow={[54, 14]}>
        <svg width="56" height="82" viewBox="0 0 56 82">
          <rect x="4" y="6" width="48" height="70" rx="5" fill={pick('#2f6ea8', '#173a56', isDark)} />
          <rect x="4" y="20" width="48" height="5" fill={pick('#25587f', '#102a3f', isDark)} />
          <rect x="4" y="56" width="48" height="5" fill={pick('#25587f', '#102a3f', isDark)} />
          <ellipse cx="28" cy="7" rx="24" ry="5" fill={pick('#3d84c4', '#1e4a6c', isDark)} />
        </svg>
      </Prop>

      {isDark ? null : <Motes seed={4404} count={22} left={14} top={18} width={72} height={54} color="rgba(255,252,232,0.9)" />}
      <Vignette strength={isDark ? 0.6 : 0.34} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// SERVER ROOM — cold aisle, blinking racks, raised floor
// ---------------------------------------------------------------------------

function ServerRack({ isDark, seed, height = 210 }: { isDark: boolean; seed: number; height?: number }) {
  const rnd = seeded(seed)
  const units = 7
  const shell = pick('#2b3542', '#0d141d', isDark)
  const face = pick('#1e2732', '#111923', isDark)
  const unitHeight = (height - 16) / units
  return (
    <svg width="118" height={height} viewBox={`0 0 118 ${height}`} className="overflow-visible">
      <rect x="0" y="0" width="118" height={height} rx="4" fill={shell} stroke={pick('#4a5765', '#1c2733', isDark)} strokeWidth="2" />
      {Array.from({ length: units }, (_, unit) => {
        const y = 8 + unit * unitHeight
        const leds = Array.from({ length: 7 }, () => ({
          color: rnd() > 0.78 ? '#ff6b5a' : rnd() > 0.36 ? '#57e08a' : '#4fc7f5',
          blink: rnd() > 0.4,
          delay: rnd() * 2.6,
        }))
        return (
          <g key={unit}>
            <rect x="6" y={y} width="106" height={unitHeight - 4} rx="2" fill={face} />
            <rect x="6" y={y} width="106" height="1.5" fill="rgba(255,255,255,0.07)" />
            {leds.map((led, index) => (
              <circle
                key={index}
                className={led.blink ? 'bhs-blink' : undefined}
                cx={13 + index * 7}
                cy={y + unitHeight / 2 - 2}
                r="2.1"
                fill={led.color}
                opacity={led.blink ? 1 : 0.85}
                style={{ animationDelay: `${led.delay}s`, animationDuration: `${1.1 + led.delay}s` }}
              />
            ))}
            {[70, 78, 86, 94, 102].map((x) => (
              <rect key={x} x={x} y={y + 4} width="4" height={unitHeight - 12} rx="1.5" fill={pick('#101822', '#060b12', isDark)} />
            ))}
          </g>
        )
      })}
      {/* Cable tails out of the top. */}
      <path d="M20 6 C 26 -12, 46 -8, 54 -18" stroke={pick('#3f8ad0', '#1f4a72', isDark)} strokeWidth="2.5" fill="none" />
      <path d="M32 6 C 40 -10, 58 -4, 68 -16" stroke={pick('#d07a3f', '#72421f', isDark)} strokeWidth="2.5" fill="none" />
    </svg>
  )
}

function ServerRoomScene({ isDark }: SceneProps) {
  const horizon = HORIZON.serverroom
  const inset = WALL_INSET.serverroom
  const cyan = isDark ? 'rgba(80,210,255,0.5)' : 'rgba(150,225,255,0.42)'

  return (
    <div className="absolute inset-0 overflow-hidden" aria-hidden>
      <RoomBox
        horizon={horizon}
        inset={inset}
        ceiling={8}
        back={pick('#233040', '#0d1622', isDark)}
        backLow={pick('#1b2634', '#0a121c', isDark)}
        left={pick('#1d2836', '#0a111a', isDark)}
        right={pick('#182231', '#080e17', isDark)}
        ceilingFill={pick('#141d29', '#060b12', isDark)}
        skirting={pick('#0f1720', '#04080d', isDark)}
      />

      {/* Ladder-rack cable trays overhead, running to the vanishing point. */}
      <svg className="absolute inset-0 h-full w-full" viewBox="0 0 100 100" preserveAspectRatio="none">
        {[-1, 1].map((side) => (
          <g key={side}>
            <polygon
              points={`${50 + side * 13},8 ${50 + side * 17},8 ${50 + side * 58},0 ${50 + side * 44},0`}
              fill={pick('#2c3d52', '#0f1a27', isDark)}
            />
            {Array.from({ length: 9 }, (_, i) => {
              const t = i / 9
              const x1 = 50 + side * (13 + t * 45)
              const x2 = 50 + side * (17 + t * 41)
              const y = 8 - t * 8
              return <line key={i} x1={x1} y1={y} x2={x2} y2={y} stroke={pick('#43596f', '#1b2937', isDark)} strokeWidth="0.35" />
            })}
          </g>
        ))}
        {/* Cable bundles slung along the trays. */}
        <path d="M6 2 C 26 8, 42 5, 50 8 C 58 5, 74 8, 94 2" stroke={pick('#3f8ad0', '#1c4468', isDark)} strokeWidth="0.7" fill="none" opacity="0.8" />
        <path d="M6 4 C 28 10, 44 7, 50 9.5 C 56 7, 72 10, 94 4" stroke={pick('#d07a3f', '#6a3d1c', isDark)} strokeWidth="0.6" fill="none" opacity="0.8" />
      </svg>

      {/* Cold-aisle strip lights down the middle of the ceiling. */}
      {[0.18, 0.42, 0.68].map((t, index) => {
        const halfWidth = 4 + t * 16
        return (
          <div
            key={index}
            className="bhs-glow absolute"
            style={{
              left: '50%',
              top: `${1.6 + t * 6}%`,
              width: `${halfWidth * 2}%`,
              height: 3 + index * 1.5,
              transform: 'translateX(-50%)',
              borderRadius: 3,
              background: pick('#eaf6ff', '#cdf1ff', isDark),
              boxShadow: `0 0 ${18 + index * 10}px ${6 + index * 4}px rgba(120,220,255,${isDark ? 0.4 : 0.22})`,
              animationDelay: `${index * 1.1}s`,
            }}
          />
        )
      })}

      {/* Back wall: door with a card reader, a power panel, the CRAC unit. */}
      <Prop x={50} y={horizon} scale={0.72}>
        <svg width="120" height="190" viewBox="0 0 120 190">
          <rect x="0" y="0" width="120" height="190" rx="2" fill={pick('#2c3a4b', '#101a26', isDark)} />
          <rect x="7" y="7" width="106" height="176" rx="2" fill={pick('#3a4b60', '#16222f', isDark)} />
          <rect x="20" y="20" width="80" height="60" rx="2" fill={pick('#5f8fb4', '#1d3b52', isDark)} opacity="0.55" />
          <circle cx="98" cy="104" r="4" fill={pick('#8d97a3', '#2c3846', isDark)} />
          <rect x="104" y="86" width="12" height="20" rx="2" fill={pick('#1b2530', '#0a1119', isDark)} />
          <circle className="bhs-blink" cx="110" cy="92" r="2" fill="#57e08a" />
        </svg>
      </Prop>
      <Prop x={22} y={horizon - 1} scale={0.66}>
        <svg width="90" height="130" viewBox="0 0 90 130">
          <rect x="0" y="0" width="90" height="130" rx="3" fill={pick('#37485c', '#131f2b', isDark)} />
          <rect x="8" y="8" width="74" height="114" rx="2" fill={pick('#263444', '#0c151f', isDark)} />
          {Array.from({ length: 5 }, (_, i) => (
            <rect key={i} x="16" y={16 + i * 22} width="58" height="14" rx="2" fill={pick('#4a5f78', '#1a2836', isDark)} />
          ))}
          <circle className="bhs-blink" cx="70" cy="23" r="2.4" fill="#ff6b5a" style={{ animationDelay: '1.3s' }} />
        </svg>
      </Prop>
      <Prop x={80} y={horizon - 1} scale={0.7}>
        <svg width="110" height="150" viewBox="0 0 110 150">
          <rect x="0" y="0" width="110" height="150" rx="3" fill={pick('#33445a', '#111c28', isDark)} />
          {Array.from({ length: 16 }, (_, i) => (
            <rect key={i} x="10" y={10 + i * 8} width="90" height="4" rx="2" fill={pick('#243244', '#080f17', isDark)} />
          ))}
          <circle className="bhs-spin" cx="55" cy="70" r="26" fill="none" stroke={pick('#4a5f78', '#1a2836', isDark)} strokeWidth="3" strokeDasharray="10 8" style={{ transformOrigin: '55px 70px' }} />
        </svg>
      </Prop>

      {/* The two rack rows, converging: far pair small, near pair large. */}
      {[
        { x: 24, y: horizon + 4, scale: 0.46, seed: 9001 },
        { x: 76, y: horizon + 4, scale: 0.46, seed: 9002 },
        { x: 14, y: horizon + 20, scale: 0.72, seed: 9003 },
        { x: 86, y: horizon + 20, scale: 0.72, seed: 9004 },
        { x: 3, y: horizon + 48, scale: 1.15, seed: 9005 },
        { x: 97, y: horizon + 48, scale: 1.15, seed: 9006 },
      ].map((rack) => (
        <Prop key={rack.seed} x={rack.x} y={rack.y} scale={rack.scale} shadow={[112, 20]}>
          <ServerRack isDark={isDark} seed={rack.seed} />
        </Prop>
      ))}

      {/* Raised floor: perforated tiles down the cold aisle. */}
      <FloorGrid horizon={horizon} columns={11} rows={6} stroke={pick('rgba(0,0,0,0.3)', 'rgba(120,200,240,0.13)', isDark)} width={0.22} spread={2.6} />
      {/* Perforated tiles down the cold aisle: trapezoids, so they lie in the
          floor's perspective instead of sitting on it as flat bars. */}
      <svg className="absolute inset-0 h-full w-full" viewBox="0 0 100 100" preserveAspectRatio="none">
        {Array.from({ length: 5 }, (_, row) => {
          const near = (row + 1) / 5
          const far = row / 5 + 0.06
          const yNear = horizon + (100 - horizon) * Math.pow(near, 1.9)
          const yFar = horizon + (100 - horizon) * Math.pow(far, 1.9)
          const halfNear = 5 + near * 22
          const halfFar = 5 + far * 22
          return (
            <polygon
              key={row}
              points={`${50 - halfFar},${yFar} ${50 + halfFar},${yFar} ${50 + halfNear},${yNear} ${50 - halfNear},${yNear}`}
              fill={pick('#7fd8f5', '#3aa9d8', isDark)}
              opacity={0.07 + near * 0.06}
            />
          )
        })}
      </svg>
      <FloorPool x={50} y={horizon + 26} width={60} height={54} color={cyan} opacity={0.5} pulse />
      {/* Rack LEDs bleeding onto the floor at the edges. */}
      <FloorPool x={8} y={horizon + 46} width={26} height={34} color={cyan} opacity={0.4} />
      <FloorPool x={92} y={horizon + 46} width={26} height={34} color={cyan} opacity={0.4} />

      {/* Cold haze hanging in the aisle. */}
      <div
        className="bhs-glow absolute inset-x-0"
        style={{
          top: `${horizon - 6}%`,
          height: '34%',
          background: `linear-gradient(to bottom, transparent, ${isDark ? 'rgba(90,200,240,0.10)' : 'rgba(150,225,255,0.14)'} 60%, transparent)`,
        }}
      />
      <Motes seed={7707} count={12} left={26} top={horizon - 10} width={48} height={40} color="rgba(150,225,255,0.55)" />
      <Vignette strength={isDark ? 0.66 : 0.5} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// BREAK ROOM — kitchenette, communal table, the good corner of the office
// ---------------------------------------------------------------------------

function BreakRoomScene({ isDark }: SceneProps) {
  const horizon = HORIZON.breakroom
  const inset = WALL_INSET.breakroom
  const tile = pick('#eef1f3', '#2b3238', isDark)
  const grout = pick('#cfd6da', '#1b2126', isDark)

  return (
    <div className="absolute inset-0 overflow-hidden" aria-hidden>
      <RoomBox
        horizon={horizon}
        inset={inset}
        ceiling={7}
        back={pick('#efe7da', '#2a231e', isDark)}
        backLow={pick('#e3d8c8', '#332a23', isDark)}
        left={pick('#e0d5c4', '#241e1a', isDark)}
        right={pick('#d7cbb8', '#1f1915', isDark)}
        ceilingFill={pick('#f6f1e8', '#191413', isDark)}
        skirting={pick('#b9a889', '#15100d', isDark)}
      />

      {/* Subway tile behind the counter — running bond, so the vertical joints
          break every other course rather than lining up into a grid. */}
      <div
        className="absolute overflow-hidden"
        style={{
          left: `${inset}%`,
          top: '17%',
          width: `${100 - 2 * inset}%`,
          height: `${horizon - 17 - 9}%`,
          background: tile,
        }}
      >
        <svg className="h-full w-full" viewBox="0 0 200 40" preserveAspectRatio="none">
          {Array.from({ length: 8 }, (_, row) => (
            <g key={row}>
              <line x1="0" y1={row * 5} x2="200" y2={row * 5} stroke={grout} strokeWidth="0.5" />
              {Array.from({ length: 26 }, (_, column) => (
                <line
                  key={column}
                  x1={column * 8 + (row % 2 ? 4 : 0)}
                  y1={row * 5}
                  x2={column * 8 + (row % 2 ? 4 : 0)}
                  y2={row * 5 + 5}
                  stroke={grout}
                  strokeWidth="0.4"
                />
              ))}
            </g>
          ))}
        </svg>
        {/* Light bouncing off the glaze, brightest under the pendants. */}
        <div
          className="absolute inset-0"
          style={{
            background: isDark
              ? 'linear-gradient(to bottom, rgba(255,220,170,0.10), transparent 70%)'
              : 'linear-gradient(to bottom, rgba(255,246,224,0.55), transparent 70%)',
          }}
        />
      </div>
      {/* Upper cabinets. */}
      <div className="absolute" style={{ left: `${inset}%`, top: '7.5%', width: `${100 - 2 * inset}%`, height: '10%' }}>
        <div className="flex h-full w-full">
          {Array.from({ length: 8 }, (_, index) => (
            <div
              key={index}
              className="h-full flex-1"
              style={{
                background: pick('#dfd2bd', '#3a2f26', isDark),
                borderRight: `2px solid ${pick('#c3b295', '#241c16', isDark)}`,
                borderBottom: `3px solid ${pick('#b9a889', '#1d1712', isDark)}`,
              }}
            >
              <div
                className="mx-auto mt-[62%] h-[6%] w-[46%] rounded-full"
                style={{ background: pick('#9c8a6c', '#6b5a48', isDark) }}
              />
            </div>
          ))}
        </div>
      </div>

      {/* Window on the left wall, raked with it. */}
      <div
        className="absolute overflow-hidden"
        style={{ left: '1%', top: '13%', width: '7%', height: '17%', transform: 'skewY(12deg)' }}
      >
        <div
          className="absolute inset-0"
          style={{
            background: isDark
              ? 'linear-gradient(to bottom, #0d1526, #1a2338)'
              : 'linear-gradient(to bottom, #a9d6f2, #dcefdc)',
          }}
        />
        <div className="absolute inset-x-0 bottom-0 h-1/2" style={{ background: pick('#8fb37c', '#1c3324', isDark), opacity: 0.8 }} />
        <div className="absolute inset-y-0 left-1/2 w-[3px] -translate-x-1/2" style={{ background: pick('#b9a889', '#3a2f26', isDark) }} />
        <div className="absolute inset-x-0 top-1/2 h-[3px]" style={{ background: pick('#b9a889', '#3a2f26', isDark) }} />
      </div>

      {/* Menu board and corkboard on the right wall. */}
      <div className="absolute" style={{ right: '1.5%', top: '14%', width: '6.5%', height: '14%', transform: 'skewY(-12deg)' }}>
        <div className="h-full w-full rounded-sm" style={{ background: '#26201b', border: `4px solid ${pick('#8a6f4a', '#4a3a26', isDark)}` }}>
          <svg className="h-full w-full" viewBox="0 0 60 44">
            <text x="30" y="14" textAnchor="middle" fontSize="9" fontFamily="Georgia, serif" fill="#f0d79a">
              COFFEE
            </text>
            <path d="M10 22 H40 M10 28 H46 M10 34 H32" stroke="#e6ddcb" strokeWidth="1.6" strokeLinecap="round" opacity="0.65" />
          </svg>
        </div>
      </div>

      {/* Pendant lamps over the table. */}
      {[36, 50, 64].map((x, index) => (
        <div key={x} className="absolute" style={{ left: `${x}%`, top: '7%', transform: 'translateX(-50%)' }}>
          <div className="mx-auto" style={{ width: 2, height: 46 + index * 6, background: pick('#9c8a6c', '#3a2f26', isDark) }} />
          <svg width="70" height="110" viewBox="0 0 70 110" className="-translate-x-1/2 overflow-visible" style={{ marginLeft: '50%' }}>
            <path d="M14 24 L56 24 L46 6 L24 6 Z" fill={pick('#c9793f', '#6d3f1f', isDark)} />
            <path d="M14 24 L56 24 L52 28 L18 28 Z" fill={pick('#e09a5f', '#8a5228', isDark)} />
            <ellipse className="bhs-glow" cx="35" cy="27" rx="13" ry="5" fill="#ffe2ad" style={{ ...glow(isDark ? 0.82 : 0.38, isDark ? 1 : 0.55), animationDelay: `${index * 0.7}s` }} />
            <path className="bhs-glow" d="M16 28 L54 28 L70 110 L0 110 Z" fill="#ffe2ad" style={{ ...glow(isDark ? 0.1 : 0.035, isDark ? 0.17 : 0.07), animationDelay: `${index}s` }} />
          </svg>
        </div>
      ))}

      {/* The counter run: espresso machine, kettle, sink, fruit, mugs. */}
      <Prop x={50} y={horizon + 1} scale={0.86} shadow={[420, 24]}>
        <svg width="430" height="150" viewBox="0 0 430 150" className="overflow-visible">
          {/* Espresso machine */}
          <rect x="164" y="24" width="76" height="46" rx="5" fill={pick('#5c636b', '#2b3036', isDark)} />
          <rect x="170" y="12" width="64" height="14" rx="4" fill={pick('#3f454c', '#1a1e23', isDark)} />
          <rect x="176" y="34" width="52" height="16" rx="2" fill={pick('#8f979f', '#454c54', isDark)} />
          <rect x="180" y="70" width="8" height="12" fill={pick('#2a2f35', '#131619', isDark)} />
          <rect x="214" y="70" width="8" height="12" fill={pick('#2a2f35', '#131619', isDark)} />
          <circle className="bhs-blink" cx="230" cy="34" r="3.2" fill="#57e08a" />
          <rect x="174" y="82" width="20" height="13" rx="2" fill={pick('#f7f4ee', '#c9cdd2', isDark)} />
          <rect x="208" y="82" width="20" height="13" rx="2" fill={pick('#f7f4ee', '#c9cdd2', isDark)} />
          <path className="bhs-steam" d="M184 80 q 5 -9 0 -18 q -5 -9 0 -18" stroke="rgba(255,255,255,0.6)" strokeWidth="3" strokeLinecap="round" fill="none" />
          <path className="bhs-steam" d="M218 80 q 5 -9 0 -18 q -5 -9 0 -18" stroke="rgba(255,255,255,0.55)" strokeWidth="3" strokeLinecap="round" fill="none" style={{ animationDelay: '1.5s' }} />
          {/* Kettle + jars */}
          <path d="M266 96 L266 74 q 16 -10 32 0 L298 96 Z" fill={pick('#3f454c', '#22272c', isDark)} />
          <path d="M298 80 q 12 4 2 14" stroke={pick('#3f454c', '#22272c', isDark)} strokeWidth="4" fill="none" />
          <rect x="316" y="66" width="24" height="30" rx="4" fill={pick('#cfd8de', '#4a545c', isDark)} opacity="0.5" />
          <rect x="319" y="74" width="18" height="20" fill={pick('#a9773f', '#5e4322', isDark)} />
          <rect x="348" y="72" width="20" height="24" rx="4" fill={pick('#cfd8de', '#4a545c', isDark)} opacity="0.5" />
          <rect x="351" y="80" width="14" height="14" fill={pick('#6b4a2d', '#3a2718', isDark)} />
          {/* Sink */}
          <rect x="60" y="82" width="70" height="14" rx="3" fill={pick('#aeb6bd', '#3c434a', isDark)} />
          <path d="M96 82 L96 62 q 0 -8 12 -8" stroke={pick('#8f979f', '#565f68', isDark)} strokeWidth="5" fill="none" />
          {/* Fruit bowl */}
          <path d="M20 96 q 22 16 44 0 Z" fill={pick('#8a6540', '#3f2c19', isDark)} />
          <circle cx="32" cy="90" r="8" fill="#e0913a" />
          <circle cx="48" cy="88" r="8" fill="#cf4b3c" />
          <circle cx="40" cy="82" r="8" fill="#7fae3c" />
          {/* Counter slab + cabinet fronts */}
          <rect x="0" y="96" width="430" height="12" rx="3" fill={pick('#d6cdbe', '#4e463c', isDark)} />
          <rect x="0" y="108" width="430" height="4" fill={pick('#b9ac96', '#332d26', isDark)} />
          <rect x="6" y="112" width="418" height="34" fill={pick('#c4b69c', '#3b332b', isDark)} />
          {[24, 116, 208, 300, 380].map((x) => (
            <rect key={x} x={x} y="118" width="72" height="24" rx="2" fill={pick('#d5c9b2', '#463d33', isDark)} />
          ))}
        </svg>
      </Prop>

      {/* Fridge, against the right wall. */}
      <Prop x={88} y={horizon + 12} scale={0.9} shadow={[110, 20]}>
        <svg width="118" height="212" viewBox="0 0 118 212">
          <rect x="0" y="0" width="118" height="212" rx="8" fill={pick('#d3d9de', '#3b434b', isDark)} />
          <rect x="0" y="76" width="118" height="4" fill={pick('#a9b2ba', '#242b32', isDark)} />
          <rect x="96" y="20" width="7" height="42" rx="3.5" fill={pick('#8e979f', '#5a636c', isDark)} />
          <rect x="96" y="94" width="7" height="56" rx="3.5" fill={pick('#8e979f', '#5a636c', isDark)} />
          <rect x="16" y="14" width="34" height="24" rx="2" fill="#e8c34a" opacity="0.85" transform="rotate(-4 33 26)" />
          <rect x="22" y="44" width="26" height="16" rx="2" fill="#6fb4d8" opacity="0.8" transform="rotate(3 35 52)" />
          <rect x="0" y="0" width="26" height="212" fill="rgba(255,255,255,0.07)" />
        </svg>
      </Prop>

      {/* Communal table with stools and mugs. */}
      <Prop x={50} y={horizon + 40} scale={1} shadow={[300, 32]}>
        <svg width="320" height="130" viewBox="0 0 320 130" className="overflow-visible">
          {/* Things on the table */}
          <rect x="112" y="6" width="52" height="30" rx="2" fill={pick('#8d949e', '#39424d', isDark)} />
          <rect x="116" y="9" width="44" height="24" rx="1" fill={pick('#bfe4f7', '#3aa7e0', isDark)} />
          <rect x="106" y="36" width="64" height="6" rx="2" fill={pick('#a9b2ba', '#2a323b', isDark)} />
          <rect x="52" y="24" width="18" height="16" rx="2" fill="#cf4b3c" />
          <path d="M70 27 q 8 5 0 10" stroke="#cf4b3c" strokeWidth="3" fill="none" />
          <rect x="212" y="26" width="16" height="14" rx="2" fill="#3f8ad0" />
          <path d="M228 29 q 7 4 0 8" stroke="#3f8ad0" strokeWidth="2.6" fill="none" />
          <rect x="244" y="30" width="34" height="10" rx="1" fill={pick('#f4efe4', '#4a525c', isDark)} transform="rotate(-4 261 35)" />
          {/* Table */}
          <rect x="0" y="42" width="320" height="12" rx="4" fill={pick('#cbb894', '#4a3c2a', isDark)} />
          <rect x="0" y="54" width="320" height="4" fill={pick('#ab9772', '#33291c', isDark)} />
          <rect x="30" y="58" width="10" height="60" fill={pick('#ab9772', '#33291c', isDark)} />
          <rect x="280" y="58" width="10" height="60" fill={pick('#ab9772', '#33291c', isDark)} />
          <rect x="34" y="80" width="252" height="6" fill={pick('#ab9772', '#33291c', isDark)} opacity="0.8" />
        </svg>
      </Prop>
      {[
        { x: 30, y: horizon + 44, flip: false },
        { x: 70, y: horizon + 44, flip: true },
      ].map((stool) => (
        <Prop key={stool.x} x={stool.x} y={stool.y} scale={0.8} flip={stool.flip} shadow={[56, 14]}>
          <svg width="64" height="108" viewBox="0 0 64 108">
            <rect x="10" y="6" width="44" height="42" rx="8" fill={pick('#c9793f', '#5f371c', isDark)} />
            <rect x="6" y="46" width="52" height="10" rx="4" fill={pick('#e09a5f', '#7a4824', isDark)} />
            <path d="M14 56 L10 104 M50 56 L54 104 M14 56 L50 56" stroke={pick('#5c636b', '#2b3036', isDark)} strokeWidth="5" strokeLinecap="round" />
          </svg>
        </Prop>
      ))}

      {/* Floor: chequer tile with a sheen. */}
      <FloorGrid horizon={horizon} columns={13} rows={7} stroke={pick('rgba(0,0,0,0.12)', 'rgba(0,0,0,0.34)', isDark)} />
      <FloorPool x={50} y={horizon + 34} width={54} height={46} color={pick('rgba(255,246,222,0.6)', 'rgba(255,224,170,0.22)', isDark)} />
      <FloorPool x={16} y={horizon + 22} width={30} height={30} color={pick('rgba(255,255,255,0.4)', 'rgba(180,215,255,0.12)', isDark)} />

      <Prop x={6} y={horizon + 34} scale={1.05}>
        <Plant isDark={isDark} tall />
      </Prop>
      <Prop x={94} y={horizon + 46} scale={1}>
        <Plant isDark={isDark} />
      </Prop>

      {!isDark ? <Motes seed={5505} count={14} left={4} top={16} width={40} height={46} color="rgba(255,252,236,0.85)" /> : null}
      <Vignette strength={isDark ? 0.55 : 0.3} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// ROOFTOP — no walls: sky, a city in layers, a parapet, a timber deck
// ---------------------------------------------------------------------------

function RooftopScene({ isDark }: SceneProps) {
  const horizon = HORIZON.rooftop
  const rnd = seeded(6001)
  const stars = Array.from({ length: 70 }, () => ({
    x: rnd() * 100,
    y: rnd() * (horizon - 6),
    size: 0.8 + rnd() * 1.6,
    delay: rnd() * 6,
  }))
  const bulbs = Array.from({ length: 22 }, (_, index) => index)

  return (
    <div className="absolute inset-0 overflow-hidden" aria-hidden>
      {/* Sky glow behind the city. */}
      <div
        className="absolute inset-x-0 top-0"
        style={{
          height: `${horizon + 4}%`,
          background: isDark
            ? 'radial-gradient(120% 90% at 50% 100%, rgba(255,170,90,0.22) 0%, transparent 62%)'
            : 'radial-gradient(120% 90% at 62% 96%, rgba(255,208,140,0.6) 0%, transparent 62%)',
        }}
      />
      {isDark
        ? stars.map((star, index) => (
            <span
              key={index}
              className="bhs-twinkle absolute rounded-full"
              style={{
                left: `${star.x}%`,
                top: `${star.y}%`,
                width: star.size,
                height: star.size,
                background: '#ffffff',
                animationDelay: `${star.delay}s`,
              }}
            />
          ))
        : null}
      {/* Sun or moon, with the halo it burns into the haze around it. */}
      <div
        className="bhs-glow absolute rounded-full"
        style={{
          left: isDark ? '78%' : '66%',
          top: isDark ? '6%' : '14%',
          width: isDark ? '13%' : '20%',
          height: isDark ? '24%' : '34%',
          transform: 'translate(-50%, -50%)',
          background: isDark
            ? 'radial-gradient(circle, rgba(220,230,255,0.5) 0%, rgba(160,185,240,0.16) 34%, transparent 66%)'
            : 'radial-gradient(circle, rgba(255,244,205,0.85) 0%, rgba(255,214,140,0.4) 32%, transparent 66%)',
          ...glow(0.7, 1),
        }}
      />
      <div
        className="absolute rounded-full"
        style={{
          left: isDark ? '78%' : '66%',
          top: isDark ? '6%' : '14%',
          width: isDark ? '3.4%' : '5%',
          height: isDark ? '6.2%' : '9%',
          transform: 'translate(-50%, -50%)',
          background: isDark
            ? 'radial-gradient(circle, #f8f9ff 0%, #dbe3f8 60%, transparent 74%)'
            : 'radial-gradient(circle, #fffdf2 0%, #ffe9a8 52%, transparent 74%)',
        }}
      />
      {/* Clouds belong to the sky, so they are clipped to it — left loose over
          the whole stage they drift across the deck. */}
      <div
        className="absolute inset-x-0 top-0 overflow-hidden"
        style={{ height: `${horizon - 6}%`, color: isDark ? 'rgba(120,140,190,0.18)' : 'rgba(255,255,255,0.85)' }}
      >
        <Clouds seed={2222} opacity={isDark ? 0.55 : 0.9} />
      </div>

      {/* Three skyline layers, each hazier than the one in front. */}
      <div className="absolute inset-x-0" style={{ top: `${horizon - 30}%`, height: '30%' }}>
        <Skyline seed={3001} count={13} color={pick('#8fb2cf', '#1a2540', isDark)} air={pick('#cfe3f4', '#0d1526', isDark)} fade={0.6} heights={[18, 46]} lit isDark={isDark} />
      </div>
      <div className="absolute inset-x-0" style={{ top: `${horizon - 24}%`, height: '24%' }}>
        <Skyline seed={3002} count={10} color={pick('#5f7f9f', '#141d33', isDark)} air={pick('#cfe3f4', '#0d1526', isDark)} fade={0.34} heights={[16, 44]} lit isDark={isDark} />
      </div>
      <div className="absolute inset-x-0" style={{ top: `${horizon - 17}%`, height: '17%' }}>
        <Skyline seed={3003} count={8} color={pick('#3b566f', '#0d1524', isDark)} air={pick('#cfe3f4', '#0d1526', isDark)} fade={0.1} heights={[14, 38]} lit isDark={isDark} />
      </div>

      {/* Water tower on the neighbouring roof. */}
      <Prop x={13} y={horizon - 1} scale={0.72}>
        <svg width="120" height="190" viewBox="0 0 120 190">
          <path d="M22 44 L98 44 L86 26 L34 26 Z" fill={pick('#6b5442', '#191313', isDark)} />
          <rect x="22" y="44" width="76" height="62" fill={pick('#7d6450', '#1e1716', isDark)} />
          {[52, 66, 82, 98].map((y) => (
            <rect key={y} x="22" y={y} width="76" height="3" fill={pick('#5c4838', '#120e0e', isDark)} />
          ))}
          <path d="M30 106 L20 188 M90 106 L100 188 M42 106 L38 188 M78 106 L82 188" stroke={pick('#4a3a2e', '#100c0c', isDark)} strokeWidth="5" />
          <circle className="bhs-blink" cx="60" cy="22" r="3.4" fill="#ff5a4a" />
        </svg>
      </Prop>

      {/* Parapet along the horizon, with coping. */}
      <div
        className="absolute inset-x-0"
        style={{
          top: `${horizon - 5.5}%`,
          height: '5.5%',
          background: pick(
            'linear-gradient(to bottom, #b3907a 0%, #9b7861 60%, #866550 100%)',
            'linear-gradient(to bottom, #2e241d 0%, #241b16 60%, #1a130f 100%)',
            isDark,
          ),
        }}
      />
      <div
        className="absolute inset-x-0"
        style={{
          top: `${horizon - 6.4}%`,
          height: '1.1%',
          background: pick('#d6c1ac', '#3c2f26', isDark),
        }}
      />
      {/* Brick coursing on the parapet. */}
      <svg className="absolute inset-x-0" style={{ top: `${horizon - 5.5}%`, height: '5.5%', width: '100%' }} viewBox="0 0 100 10" preserveAspectRatio="none">
        {[2.4, 5, 7.6].map((y) => (
          <line key={y} x1="0" y1={y} x2="100" y2={y} stroke={pick('rgba(0,0,0,0.16)', 'rgba(0,0,0,0.4)', isDark)} strokeWidth="0.3" />
        ))}
      </svg>

      {/* String lights strung across the deck. */}
      <svg className="absolute inset-x-0" style={{ top: '4%', height: '20%', width: '100%' }} viewBox="0 0 100 20" preserveAspectRatio="none">
        <path d="M-2 3 Q 50 17 102 4" stroke={pick('#6b5b4a', '#1d1713', isDark)} strokeWidth="0.28" fill="none" />
        <path d="M-2 9 Q 50 22 102 10" stroke={pick('#6b5b4a', '#1d1713', isDark)} strokeWidth="0.24" fill="none" opacity="0.8" />
      </svg>
      {bulbs.map((index) => {
        const t = index / (bulbs.length - 1)
        const x = -2 + t * 104
        const y = 4 + Math.sin(Math.PI * t) * 13.6 - 1
        return (
          <span
            key={index}
            className="bhs-bulb absolute rounded-full"
            style={{
              left: `${x}%`,
              top: `${y}%`,
              width: 8,
              height: 8,
              marginLeft: -4,
              background: 'radial-gradient(circle, #fff3cf 0%, #ffc86a 55%, rgba(255,180,90,0.25) 75%, transparent 82%)',
              boxShadow: isDark ? '0 0 14px 5px rgba(255,190,110,0.42)' : '0 0 8px 2px rgba(255,200,130,0.28)',
              animationDelay: `${(index % 5) * 0.5}s`,
            }}
          />
        )
      })}

      {/* Deck: timber boards running to the vanishing point. */}
      <FloorGrid horizon={horizon} columns={21} rows={4} stroke={pick('rgba(60,35,18,0.34)', 'rgba(0,0,0,0.5)', isDark)} width={0.2} spread={2.9} />
      <div
        className="absolute inset-x-0 bottom-0"
        style={{
          top: `${horizon}%`,
          background: isDark
            ? 'radial-gradient(90% 70% at 50% 0%, rgba(255,190,110,0.16) 0%, transparent 62%)'
            : 'radial-gradient(90% 70% at 62% 0%, rgba(255,214,150,0.34) 0%, transparent 62%)',
        }}
      />

      {/* HVAC units and a vent stack along the parapet. */}
      <Prop x={80} y={horizon + 4} scale={0.8} shadow={[150, 20]}>
        <svg width="160" height="100" viewBox="0 0 160 100">
          <rect x="0" y="18" width="160" height="70" rx="4" fill={pick('#9aa1a8', '#232a31', isDark)} />
          <rect x="0" y="12" width="160" height="10" rx="3" fill={pick('#b4bbc2', '#2f373f', isDark)} />
          {Array.from({ length: 9 }, (_, i) => (
            <rect key={i} x={10 + i * 17} y="30" width="10" height="46" rx="2" fill={pick('#7b838b', '#161c22', isDark)} />
          ))}
          <circle className="bhs-spin" cx="132" cy="6" r="14" fill="none" stroke={pick('#6f767d', '#141a20', isDark)} strokeWidth="4" strokeDasharray="8 6" style={{ transformOrigin: '132px 6px' }} />
        </svg>
      </Prop>
      <Prop x={95} y={horizon + 2} scale={0.75}>
        <svg width="70" height="140" viewBox="0 0 70 140">
          <rect x="22" y="26" width="26" height="112" fill={pick('#8a9199', '#1d2329', isDark)} />
          <path d="M12 26 L58 26 L48 8 L22 8 Z" fill={pick('#a2a9b1', '#2a323a', isDark)} />
          <ellipse cx="35" cy="8" rx="23" ry="6" fill={pick('#b6bdc5', '#333c45', isDark)} />
        </svg>
      </Prop>

      {/* Planters, lounge chairs, a low table. */}
      <Prop x={22} y={horizon + 12} scale={0.8} shadow={[120, 18]}>
        <svg width="130" height="110" viewBox="0 0 130 110">
          <rect x="0" y="52" width="130" height="52" rx="4" fill={pick('#8a6a4c', '#2c2117', isDark)} />
          <rect x="0" y="48" width="130" height="8" rx="3" fill={pick('#a3805e', '#3a2c1f', isDark)} />
          <g className="bhs-sway" style={{ transformOrigin: '65px 52px' }}>
            {[16, 34, 52, 70, 88, 106].map((x, index) => (
              <path
                key={x}
                d={`M${x} 52 C ${x - 8} 32, ${x - 4} 16, ${x + (index % 2 ? 6 : -6)} 2`}
                stroke={pick('#6fa04a', '#2c4a25', isDark)}
                strokeWidth="4"
                fill="none"
                strokeLinecap="round"
              />
            ))}
          </g>
        </svg>
      </Prop>
      <Prop x={7} y={horizon + 40} scale={1} shadow={[130, 22]}>
        <svg width="150" height="110" viewBox="0 0 150 110">
          <path d="M18 62 L128 62 L120 44 L44 44 Z" fill={pick('#d9c9a8', '#3d3527', isDark)} />
          <path d="M44 44 L52 12 L120 12 L120 44 Z" fill={pick('#c9b892', '#332c20', isDark)} />
          <rect x="14" y="62" width="120" height="10" rx="4" fill={pick('#8a6a4c', '#241b12', isDark)} />
          <path d="M24 72 L20 104 M124 72 L128 104" stroke={pick('#6b5138', '#1a130c', isDark)} strokeWidth="6" strokeLinecap="round" />
        </svg>
      </Prop>
      <Prop x={92} y={horizon + 44} scale={0.9} shadow={[90, 16]}>
        <svg width="100" height="70" viewBox="0 0 100 70">
          <rect x="0" y="14" width="100" height="10" rx="4" fill={pick('#8a6a4c', '#241b12', isDark)} />
          <path d="M12 24 L10 62 M88 24 L90 62" stroke={pick('#6b5138', '#1a130c', isDark)} strokeWidth="6" strokeLinecap="round" />
          <rect x="38" y="0" width="18" height="16" rx="3" fill="#cf4b3c" />
          <path d="M56 3 q 8 5 0 10" stroke="#cf4b3c" strokeWidth="3" fill="none" />
        </svg>
      </Prop>
      <Prop x={35} y={horizon + 50} scale={1.1}>
        <Plant isDark={isDark} tall />
      </Prop>

      <Vignette strength={isDark ? 0.6 : 0.3} />
    </div>
  )
}

// ---------------------------------------------------------------------------

const SCENES: Record<SceneKind, React.FC<SceneProps>> = {
  office: OfficeScene,
  executive: ExecutiveScene,
  warehouse: WarehouseScene,
  serverroom: ServerRoomScene,
  breakroom: BreakRoomScene,
  rooftop: RooftopScene,
}

/**
 * One complete room: its sky-or-far-wall plane, its floor plane, and the art
 * standing on them. Self-contained on purpose — a wipe slides one of these over
 * another, so a room has to carry its own ground with it.
 */
const SceneLayer = React.memo(function SceneLayer({ kind, isDark }: { kind: SceneKind; isDark: boolean }) {
  const Scene = SCENES[kind]
  return (
    <div className="absolute inset-0">
      <div
        className="absolute inset-0"
        style={{ background: isDark ? BACKDROP[kind].night : BACKDROP[kind].day }}
      />
      <div
        className="absolute inset-x-0 bottom-0"
        style={{ top: `${HORIZON[kind]}%`, background: isDark ? GROUND[kind].night : GROUND[kind].day }}
      />
      <Scene isDark={isDark} />
    </div>
  )
})

/**
 * The painted room, and the wipe between rooms.
 *
 * Picking a stage sweeps the new room in from the side it sits on in the
 * picker: a room further right in the list arrives from the right. The
 * outgoing room does not move — only the edge between the two travels, because
 * the staff standing on the floor are a separate layer that stays put, and a
 * room sliding out from under stationary people looks like a mistake. A lit
 * seam rides the edge so the sweep reads as one gesture.
 */
/** Kept in step with `--bh-wipe-duration` in globals.css. */
const WIPE_MS = 620

export function BunkhouseSceneArt({ kind, isDark }: { kind: SceneKind; isDark: boolean }) {
  const [wipe, setWipe] = React.useState<{
    shown: SceneKind
    leaving: SceneKind | null
    from: 'left' | 'right'
  }>({ shown: kind, leaving: null, from: 'right' })

  // Derived during render rather than in an effect: an effect would paint one
  // frame of the new room un-clipped before the animation started, which reads
  // as a flash of the destination just before it wipes in.
  if (wipe.shown !== kind) {
    setWipe({
      shown: kind,
      leaving: wipe.shown,
      from: SCENE_KINDS.indexOf(kind) > SCENE_KINDS.indexOf(wipe.shown) ? 'right' : 'left',
    })
  }

  const done = React.useCallback(
    () => setWipe((current) => (current.leaving ? { ...current, leaving: null } : current)),
    [],
  )

  // A backstop for retiring the outgoing room. `animationend` is the prompt
  // path, but it is not a guarantee: a background tab freezes the document
  // timeline and never dispatches it, and an interrupted or reduced-motion
  // animation can skip it too. What is left behind if it never arrives is a
  // whole second room mounted and animating under the visible one, so this
  // does not get to depend on an event that might not come.
  React.useEffect(() => {
    if (!wipe.leaving) return
    const timer = setTimeout(done, WIPE_MS + 150)
    return () => clearTimeout(timer)
  }, [wipe.leaving, wipe.shown, done])

  return (
    <div className="absolute inset-0 overflow-hidden">
      {wipe.leaving ? <SceneLayer kind={wipe.leaving} isDark={isDark} /> : null}
      <div
        // Keyed by room, and by room alone: a new pick remounts this and so
        // restarts the sweep from the beginning even mid-wipe, while clearing
        // `leaving` at the end leaves the key untouched and does not throw away
        // the room that just arrived.
        key={kind}
        className={`absolute inset-0 ${wipe.leaving ? `bh-wipe-${wipe.from}` : ''}`}
        // Animation events bubble, and every room is full of looping keyframes
        // — only the wipe's own end means the transition is over.
        onAnimationEnd={(event) => {
          if (event.animationName.startsWith('bh-wipe')) done()
        }}
      >
        <SceneLayer kind={kind} isDark={isDark} />
      </div>
      {wipe.leaving ? <div className={`bh-wipe-seam bh-wipe-seam-${wipe.from}`} /> : null}
    </div>
  )
}

/**
 * One of the built-in rooms, small.
 *
 * These rooms are laid out for a stage the size of a screen — a figure is
 * about 210px tall and every prop is drawn against that — so they cannot
 * simply be rendered into a small box. Dropped straight into a 56x32 table
 * cell the first attempt escaped the cell entirely and painted over the whole
 * page, because everything inside positions absolutely and there was no
 * full-size stage to position against.
 *
 * So the room is built at its proper size and the whole stage is scaled down,
 * which is what makes it a miniature of the room rather than a crop of one
 * corner. Held still, because a list of these should not be a thousand
 * animating elements.
 */
export function BunkhouseSceneThumbnail({
  kind,
  isDark,
  width,
  className = '',
}: {
  kind: SceneKind
  isDark: boolean
  /** Rendered width in pixels. The stage is scaled to meet it exactly. */
  width: number
  className?: string
}) {
  // The size the room is actually built at, and the 16:9 the floor uses.
  const STAGE_WIDTH = 1280
  const height = Math.round((width * 9) / 16)
  return (
    <span
      className={`bh-scene-still relative block shrink-0 overflow-hidden ${className}`}
      style={{ width, height }}
      aria-hidden
    >
      <span
        className="absolute left-0 top-0 block origin-top-left"
        style={{
          width: STAGE_WIDTH,
          height: Math.round((STAGE_WIDTH * 9) / 16),
          transform: `scale(${width / STAGE_WIDTH})`,
        }}
      >
        <SceneLayer kind={kind} isDark={isDark} />
      </span>
    </span>
  )
}
