'use client'

import * as React from 'react'
import { ComposedAvatar } from '@braedonsaunders/appkit-avatars/react'
import {
  CANVAS_HEIGHT,
  CANVAS_WIDTH,
  sortLayers,
  type AvatarComposition,
  type AvatarPart,
  type AvatarPartCategory,
} from '@braedonsaunders/appkit-avatars/composition'

/**
 * A composed figure standing *on* the floor rather than above it.
 *
 * The scene draws its contact shadow at the bottom edge of the figure's box,
 * which is right only if the figure's feet reach that edge. They don't. Parts
 * arrive from the generator as square PNGs with the drawing floating inside its
 * own transparent margin, and each part is then `object-contain`-fitted into a
 * category frame that is much taller than it is wide — so a square of art gets
 * letterboxed with a deep empty band above and below. Stack that up and a
 * finished figure's feet land well short of the 512×768 stage's bottom edge.
 * Everyone hovers a few inches over their own shadow.
 *
 * None of that is recoverable from the composition numbers, because the margin
 * inside each PNG is whatever the image model drew. So measure it: composite
 * the layers once into a small offscreen canvas, find the lowest row that has
 * any ink in it, and slide the stage down by exactly the empty remainder. The
 * feet land on the shadow, and nothing about the figure's size or proportion
 * changes — the scene's shadow is sized from the same box it always was.
 *
 * The measurement is keyed by the artwork and its placement, so re-mounting the
 * same figure (a re-render, another screen, a second person wearing the same
 * parts in the same spots) is a map lookup, not another canvas.
 */

/** Height of the offscreen sample. Ink rows only need to be found, not read. */
const SAMPLE_HEIGHT = 192
const SAMPLE_WIDTH = Math.round((SAMPLE_HEIGHT * CANVAS_WIDTH) / CANVAS_HEIGHT)
/** Below this alpha a pixel is the PNG's cut-out margin, not the drawing. */
const INK_ALPHA = 12

/** Where the drawing ends, as a fraction of the 512×768 stage height. */
const footLine = new Map<string, number>()
const inFlight = new Map<string, Promise<number>>()

type LayerBox = { url: string; left: number; top: number; width: number; height: number }

function signatureOf(layers: LayerBox[]): string {
  return layers
    .map((l) => `${l.url}@${Math.round(l.left)},${Math.round(l.top)},${Math.round(l.width)},${Math.round(l.height)}`)
    .join('|')
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.decoding = 'async'
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error(`avatar part failed to load: ${url}`))
    image.src = url
  })
}

/**
 * Paint the layers small and report the lowest row carrying ink.
 *
 * The part images are served from this app's own origin, so the canvas stays
 * readable. If that ever stops being true — a CDN without CORS headers, say —
 * `getImageData` throws and we fall back to the unseated figure rather than
 * blanking the floor.
 */
async function measureFootLine(layers: LayerBox[]): Promise<number> {
  const canvas = document.createElement('canvas')
  canvas.width = SAMPLE_WIDTH
  canvas.height = SAMPLE_HEIGHT
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) return 1

  const sx = SAMPLE_WIDTH / CANVAS_WIDTH
  const sy = SAMPLE_HEIGHT / CANVAS_HEIGHT
  const images = await Promise.all(layers.map((layer) => loadImage(layer.url)))

  images.forEach((image, index) => {
    const layer = layers[index]!
    // `object-contain`: the source keeps its aspect ratio and is centred in the
    // layer box, which is the whole reason the empty band exists.
    const fit = Math.min(layer.width / image.naturalWidth, layer.height / image.naturalHeight)
    const drawnWidth = image.naturalWidth * fit
    const drawnHeight = image.naturalHeight * fit
    context.drawImage(
      image,
      (layer.left + (layer.width - drawnWidth) / 2) * sx,
      (layer.top + (layer.height - drawnHeight) / 2) * sy,
      drawnWidth * sx,
      drawnHeight * sy,
    )
  })

  const { data } = context.getImageData(0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT)
  for (let row = SAMPLE_HEIGHT - 1; row >= 0; row--) {
    const start = row * SAMPLE_WIDTH * 4
    for (let column = 0; column < SAMPLE_WIDTH; column++) {
      if (data[start + column * 4 + 3]! > INK_ALPHA) return (row + 1) / SAMPLE_HEIGHT
    }
  }
  return 1
}

export type SeatedFigureProps = {
  composition: AvatarComposition
  parts: readonly AvatarPart[]
  categories: readonly AvatarPartCategory[]
  /** Figure width in pixels; the stage is 1.5× that tall, as `ComposedAvatar`. */
  size: number
  name: string
}

export function SeatedFigure({ composition, parts, categories, size, name }: SeatedFigureProps) {
  const layers = React.useMemo<LayerBox[]>(
    () =>
      sortLayers(composition, parts, categories).map((layer) => ({
        url: layer.url,
        left: layer.box.left,
        top: layer.box.top,
        width: layer.box.width,
        height: layer.box.height,
      })),
    [composition, parts, categories],
  )
  const signature = React.useMemo(() => signatureOf(layers), [layers])

  // Seated on the first paint for anyone measured earlier this session; a
  // first-time figure settles the moment its artwork decodes, which is roughly
  // when it becomes visible anyway. That is close enough to cover with nothing
  // — no fade, no transition, one less moving part in a subtree that already
  // re-renders every animation frame.
  //
  // The module cache is the source of truth but is not reactive, so this map
  // holds what this instance measured itself, purely to re-render when the
  // measurement lands. Reading the cache during render means a figure whose
  // signature changes is seated immediately, with no resync pass.
  const [measured, setMeasured] = React.useState<Record<string, number>>({})
  const foot = measured[signature] ?? footLine.get(signature) ?? 1

  React.useEffect(() => {
    if (footLine.has(signature) || layers.length === 0) return

    let live = true
    let work = inFlight.get(signature)
    if (!work) {
      work = measureFootLine(layers)
        .catch(() => 1)
        .then((value) => {
          footLine.set(signature, value)
          inFlight.delete(signature)
          return value
        })
      inFlight.set(signature, work)
    }
    void work.then((value) => {
      if (live) setMeasured((previous) => ({ ...previous, [signature]: value }))
    })
    return () => {
      live = false
    }
  }, [signature, layers])

  const stageHeight = (size * CANVAS_HEIGHT) / CANVAS_WIDTH

  return (
    <div
      style={{
        // Drop the figure by the empty band under its feet, so the feet land
        // where the scene draws its contact shadow. Nothing clips it — the
        // scene's figure slot is a plain bottom-aligned flex box.
        transform: `translateY(${(1 - foot) * stageHeight}px)`,
        // …then lift it a hair, because that shadow is an ellipse centred just
        // above the box's bottom edge. Seated dead-on the edge, the figure
        // covers the ellipse and reads as having no shadow at all; three
        // percent up leaves the near half of it on the floor in front of the
        // feet. A percentage, not pixels: it resolves against the character
        // box, which is what shrinks with depth.
        position: 'relative',
        top: '-3%',
      }}
    >
      <ComposedAvatar
        composition={composition}
        parts={parts}
        categories={categories}
        variant="full"
        size={size}
        animate="idle"
        name={name}
      />
    </div>
  )
}
