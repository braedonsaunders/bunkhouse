'use client'

// Guarantees the brand splash stays up long enough for the build-in animation
// to complete, even when the route resolves instantly. <SplashScreen /> is a
// fixed overlay mounted once in the root layout: it renders visible on every
// document load, then fades out once BOTH the minimum duration has elapsed
// The minimum counts from hydration, because the logo's roof geometry is
// measured client-side — the draw can't start any earlier. Route fallbacks
// render their own bounded spinner and never control this document overlay.
//
// The splash is a COLD-START moment and nothing else. It used to re-show
// whenever a hold arrived, which sounds reasonable until you notice that
// `app/loading.tsx` is the root segment's fallback: every internal link took
// the whole app back to the logo for two seconds. So once the splash has
// finished its life it retires for the rest of the document — later holds are
// ignored, and route changes are left to the page transition in the shell.

import { useEffect, useRef, useState } from 'react'
import { BrandSplash } from './brand-logo'

const MIN_VISIBLE_MS = 2000 // full build-in completes at ~1.5s
const REDUCED_MOTION_MIN_MS = 500 // static logo — no reason to linger
const FADE_MS = 400

/** Set once the splash has faded out. It never comes back in this document. */
let retired = false

type Phase = 'visible' | 'fading' | 'gone'

export function SplashScreen() {
  const [phase, setPhase] = useState<Phase>('visible')
  const shownAt = useRef(0)

  useEffect(() => {
    if (shownAt.current === 0) shownAt.current = performance.now()
    let fadeT: ReturnType<typeof setTimeout> | undefined
    let goneT: ReturnType<typeof setTimeout> | undefined
    const apply = (p: Phase) => {
      setPhase(p)
    }

    const sync = () => {
      if (retired) return
      clearTimeout(fadeT)
      clearTimeout(goneT)
      const min = window.matchMedia('(prefers-reduced-motion: reduce)').matches
        ? REDUCED_MOTION_MIN_MS
        : MIN_VISIBLE_MS
      const remaining = Math.max(0, shownAt.current + min - performance.now())
      fadeT = setTimeout(() => {
        apply('fading')
        goneT = setTimeout(() => {
          retired = true
          apply('gone')
        }, FADE_MS)
      }, remaining)
    }

    sync()
    return () => {
      clearTimeout(fadeT)
      clearTimeout(goneT)
    }
  }, [])

  if (phase === 'gone') return null
  return (
    <div
      aria-hidden
      className={`fixed inset-0 z-[100] transition-opacity ease-out ${
        phase === 'visible' ? 'opacity-100' : 'pointer-events-none opacity-0'
      }`}
      style={{ transitionDuration: `${FADE_MS}ms` }}
    >
      <BrandSplash />
    </div>
  )
}
