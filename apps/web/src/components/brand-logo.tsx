'use client'

// Bunkhouse brand lockup: the word set in the app's own sans, with a roofline
// drawn over "house" — eaves spanning from the h's stem to the e's ink edge,
// square-cut eave returns, a chimney on the right slope with smoke, an amber
// attic light under the ridge, and an amber full stop. The roof is measured
// off the rendered glyphs at runtime (a canvas ink scan finds the h stem's
// exact weight and center, the e's true right edge, and the ascender height;
// a zero-size inline probe finds the baseline), so the roof stroke always
// matches the type's stem weight and the alignment holds at any size.
//
//   <Logo />          static lockup (smoke curls held at rest)
//   <Logo animated /> smoke drifts and the attic light breathes (header)
//   <Logo draw />     one-shot build-in for the splash screen
//
// Keyframes live in globals.css under "Brand logo animation"; all motion
// respects prefers-reduced-motion.

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'

const AMBER = '#F5A623'

// Roof geometry, in ems of the wordmark's font size.
const GAP = 0.06 // daylight between the eave returns and the h
const HOOK = 0.13 // eave return length
const RISE = 0.56 // ridge height above the eave line
const HEAD = 0.62 // sky above the ridge for the chimney and smoke

type Metrics = {
  stem: number // h stem ink width
  bearing: number // h left side bearing (glyph box → stem)
  eRight: number // e's rightmost ink, from the e glyph origin
  ascH: number // h ascender ink height above the baseline
}

const FALLBACK: Metrics = { stem: 0.095, bearing: 0.06, eRight: 0.52, ascH: 0.73 }

function measureFont(font: string): Metrics {
  try {
    const canvas = document.createElement('canvas')
    canvas.width = 300
    canvas.height = 200
    const g = canvas.getContext('2d', { willReadFrequently: true })
    if (!g) return FALLBACK
    g.font = `500 100px ${font}`
    g.textBaseline = 'alphabetic'
    g.fillStyle = '#000'
    g.fillText('h', 50, 150)
    let data = g.getImageData(0, 0, 300, 200).data
    const on = (x: number, y: number) => (data[(y * 300 + x) * 4 + 3] ?? 0) > 128
    // Stem width + bearing: first ink run on a row through the lower half.
    let stemStart = -1
    let stemEnd = -1
    for (let x = 0; x < 300; x++) {
      if (on(x, 125)) {
        stemStart = x
        while (x < 300 && on(x, 125)) x++
        stemEnd = x
        break
      }
    }
    if (stemStart < 0) return FALLBACK
    // Ascender ink top.
    let hTop = 0
    outer: for (let y = 0; y < 150; y++) {
      for (let x = 40; x < 200; x++) {
        if (on(x, y)) {
          hTop = y
          break outer
        }
      }
    }
    g.clearRect(0, 0, 300, 200)
    g.fillText('e', 50, 150)
    data = g.getImageData(0, 0, 300, 200).data
    let right = 0
    outer2: for (let x = 299; x >= 0; x--) {
      for (let y = 60; y <= 150; y += 2) {
        if (on(x, y)) {
          right = x
          break outer2
        }
      }
    }
    return {
      stem: (stemEnd - stemStart) / 100,
      bearing: (stemStart - 50) / 100,
      eRight: right ? (right - 50 + 1) / 100 : FALLBACK.eRight,
      ascH: (150 - hTop) / 100,
    }
  } catch {
    return FALLBACK
  }
}

type Geom = {
  sw: number
  W: number
  H: number
  xA: number
  padTop: number
  apX: number
  topY: number
  baseY: number
  botY: number
  xL: number
  xR: number
  yL: number
  yR: number
  yT: number
  capX: number
  dotY: number
  dotR: number
  xs: number
  ssw: number
}

const bd = (s: number) => ({ '--bd': `${s}s` }) as CSSProperties
const sd = (s: number) => ({ '--sd': `${s}s` }) as CSSProperties

export type LogoProps = {
  /** Wordmark font size in px. The whole lockup scales from this. */
  size?: number
  /** Loop the smoke drift + attic-light breathing. */
  animated?: boolean
  /** Build the lockup in once, then keep the smoke going (splash). */
  draw?: boolean
  className?: string
}

export function Logo({ size = 17, animated = false, draw = false, className = '' }: LogoProps) {
  const wrapRef = useRef<HTMLSpanElement>(null)
  const wordRef = useRef<HTMLSpanElement>(null)
  const hRef = useRef<HTMLSpanElement>(null)
  const eRef = useRef<HTMLSpanElement>(null)
  const blRef = useRef<HTMLSpanElement>(null)
  const [geom, setGeom] = useState<Geom | null>(null)
  const [fontsReady, setFontsReady] = useState(false)

  useEffect(() => {
    let alive = true
    document.fonts?.ready.then(() => {
      if (alive) setFontsReady(true)
    })
    return () => {
      alive = false
    }
  }, [])

  useLayoutEffect(() => {
    const wrap = wrapRef.current
    const word = wordRef.current
    const h = hRef.current
    const e = eRef.current
    const bl = blRef.current
    if (!wrap || !word || !h || !e || !bl) return
    const fs = size
    const m = measureFont(getComputedStyle(word).fontFamily)
    const sw = fs * m.stem
    // Eave endpoints: the h stem's center, and the e's ink edge (stroke tucked
    // inside it). Horizontal positions are padding-independent.
    const xA = h.offsetLeft + fs * (m.bearing + m.stem / 2)
    const xB = e.offsetLeft + fs * m.eRight - sw / 2
    const W = xB - xA
    // Vertical layout, in SVG-local coordinates (the SVG mounts at top: 0).
    const topY = fs * HEAD + sw / 2
    const baseY = topY + fs * RISE
    const botY = baseY + fs * HOOK
    // Wrapper padding places the eave returns GAP above the h's ink top. The
    // ink top's offset within the content box is invariant under padding, so
    // one measurement pass is enough.
    const curPad = parseFloat(getComputedStyle(wrap).paddingTop) || 0
    const inkOffset = bl.offsetTop - fs * m.ascH - curPad
    const padTop = Math.max(0, botY + fs * GAP - inkOffset)
    // Chimney on the right slope, crown slightly proud of the flues.
    const apX = W / 2
    const slope = (baseY - topY) / (W - apX)
    const xL = apX + (W - apX) * 0.4
    const xR = Math.min(xL + fs * 0.26, W - fs * 0.14)
    setGeom({
      sw,
      W,
      H: botY,
      xA,
      padTop,
      apX,
      topY,
      baseY,
      botY,
      xL,
      xR,
      yL: topY + (xL - apX) * slope,
      yR: topY + (xR - apX) * slope,
      yT: topY + fs * 0.05,
      capX: fs * 0.055,
      dotY: topY + fs * RISE * 0.58,
      dotR: fs * 0.082,
      xs: (xL + xR) / 2,
      ssw: sw * 0.6,
    })
  }, [size, fontsReady])

  const fs = size
  const mode = draw ? 'bh-draw' : animated ? 'bh-loop' : ''
  return (
    <span
      ref={wrapRef}
      role="img"
      aria-label="Bunkhouse"
      className={`${mode} ${className}`.trim()}
      style={{
        position: 'relative',
        display: 'inline-block',
        fontSize: fs,
        lineHeight: 1.1,
        paddingTop: geom?.padTop ?? fs * 1.1,
      }}
    >
      {geom && (
        <svg
          aria-hidden
          viewBox={`0 0 ${geom.W} ${geom.H}`}
          style={{
            position: 'absolute',
            top: 0,
            left: geom.xA,
            width: geom.W,
            height: geom.H,
            overflow: 'visible',
            pointerEvents: 'none',
          }}
        >
          <path
            d={`M0 ${geom.botY}L0 ${geom.baseY}L${geom.apX} ${geom.topY}L${geom.W} ${geom.baseY}L${geom.W} ${geom.botY}`}
            pathLength={1}
            className="bh-s"
            style={bd(0.15)}
            fill="none"
            stroke="currentColor"
            strokeWidth={geom.sw}
            strokeLinecap="butt"
            strokeLinejoin="round"
          />
          <path
            d={`M${geom.xL} ${geom.yL}L${geom.xL} ${geom.yT}`}
            pathLength={1}
            className="bh-s"
            style={bd(0.65)}
            fill="none"
            stroke="currentColor"
            strokeWidth={geom.sw}
            strokeLinecap="round"
          />
          <path
            d={`M${geom.xR} ${geom.yR}L${geom.xR} ${geom.yT}`}
            pathLength={1}
            className="bh-s"
            style={bd(0.72)}
            fill="none"
            stroke="currentColor"
            strokeWidth={geom.sw}
            strokeLinecap="round"
          />
          <path
            d={`M${geom.xL - geom.capX} ${geom.yT}L${geom.xR + geom.capX} ${geom.yT}`}
            pathLength={1}
            className="bh-s"
            style={bd(0.8)}
            fill="none"
            stroke="currentColor"
            strokeWidth={geom.sw}
            strokeLinecap="round"
          />
          <circle
            cx={geom.apX}
            cy={geom.dotY}
            r={geom.dotR * 2.5}
            fill={AMBER}
            opacity={0.22}
            className="bh-halo"
            style={bd(0.95)}
          />
          <circle
            cx={geom.apX}
            cy={geom.dotY}
            r={geom.dotR}
            fill={AMBER}
            className="bh-dot"
            style={bd(0.95)}
          />
          <path
            d={`M${geom.xs} ${geom.yT - fs * 0.14}c${fs * 0.09} ${-fs * 0.08} ${-fs * 0.09} ${-fs * 0.16} 0 ${-fs * 0.24}`}
            fill="none"
            stroke="currentColor"
            strokeWidth={geom.ssw}
            strokeLinecap="round"
            className="bh-smoke1"
            style={sd(1.4)}
          />
          <path
            d={`M${geom.xs + fs * 0.09} ${geom.yT - fs * 0.2}c${fs * 0.08} ${-fs * 0.07} ${-fs * 0.08} ${-fs * 0.14} 0 ${-fs * 0.21}`}
            fill="none"
            stroke="currentColor"
            strokeWidth={geom.ssw * 0.85}
            strokeLinecap="round"
            className="bh-smoke2"
            style={sd(2.6)}
          />
        </svg>
      )}
      <span
        ref={wordRef}
        aria-hidden
        className="bh-word"
        style={{ display: 'inline-block', fontWeight: 500, letterSpacing: '-0.015em' }}
      >
        bunk
        <span ref={hRef}>h</span>ous
        <span ref={eRef}>e</span>
        <span style={{ color: AMBER }}>.</span>
        <span ref={blRef} style={{ display: 'inline-block', width: 0, height: 0 }} />
      </span>
    </span>
  )
}

/** Full-screen brand splash: the lockup builds itself in, then the smoke
 *  keeps drifting. Used as the root route-loading fallback. */
export function BrandSplash() {
  return (
    <div className="flex h-dvh w-full items-center justify-center bg-bg">
      <Logo draw size={40} />
    </div>
  )
}
