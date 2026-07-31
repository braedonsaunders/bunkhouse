'use client'

import * as React from 'react'
import { Alert, Badge, Button, Label, Select, Spinner, Textarea, useTheme } from '@appkit/ui'
import { BunkhouseSceneArt } from './scene-art'
import type { SceneKind } from './scene-kinds'
import { draftBackdrop, saveBackdrop, clearBackdrop } from '../app/organization/department-actions'

/**
 * Having a room drawn, and looking at it properly before keeping it.
 *
 * The first version was a single-line input and a preview squeezed into a card
 * that shared a page with five other departments' controls — far too small to
 * judge a picture by, which is the only thing this screen is for. In a drawer
 * there is room, so the picture IS the screen: one large frame at the stage's
 * own aspect showing either what is saved or what has just been drawn, with
 * everything else underneath it.
 *
 * Nothing is saved until it is kept. A model draws a dud often enough that
 * committing unseen would be a lottery.
 */
export function BackdropStudio({
  departmentId,
  currentSvg,
  currentPrompt,
  sceneKind,
  sceneKinds,
}: {
  departmentId: string
  currentSvg: string | null
  currentPrompt: string | null
  /** The built-in room this department uses when it has no drawing of its own. */
  sceneKind: string | null
  sceneKinds: { value: string; label: string }[]
}) {
  const { resolvedTheme } = useTheme()
  const isDark = resolvedTheme === 'dark'
  const [state, draw, drawing] = React.useActionState(
    draftBackdrop,
    {} as { svg?: string; error?: string; prompt?: string },
  )
  const [dismissed, setDismissed] = React.useState(false)
  const draft = dismissed ? null : (state.svg ?? null)
  const showing = draft ?? currentSvg

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label>Backdrop</Label>
          {draft ? <Badge variant="warning">Draft — not saved</Badge> : currentSvg ? <Badge>Saved</Badge> : null}
        </div>

        {/* The stage's own aspect, so what is approved here is exactly what
            appears on the floor rather than an approximation of it. */}
        <div className="relative aspect-[16/9] w-full overflow-hidden rounded-xl border border-border bg-canvas">
          {showing ? (
            <div className="h-full w-full [&>svg]:h-full [&>svg]:w-full" dangerouslySetInnerHTML={{ __html: showing }} />
          ) : (
            // The built-in room, drawn exactly as the floor draws it. Telling
            // somebody in words which room they are using, on a screen whose
            // entire job is showing them a room, was daft.
            <BunkhouseSceneArt kind={(sceneKind ?? 'office') as SceneKind} isDark={isDark} />
          )}
          {drawing ? (
            <div className="absolute inset-0 flex items-center justify-center gap-3 bg-canvas/70 backdrop-blur-sm">
              <Spinner />
              <span className="text-sm text-fg">Drawing the room…</span>
            </div>
          ) : null}
        </div>

        {draft ? (
          <div className="flex flex-wrap items-center gap-2">
            <form action={saveBackdrop} onSubmit={() => setDismissed(true)}>
              <input type="hidden" name="id" value={departmentId} />
              <input type="hidden" name="svg" value={draft} />
              <input type="hidden" name="prompt" value={state.prompt ?? ''} />
              <Button type="submit">Use this backdrop</Button>
            </form>
            <Button type="button" variant="outline" onClick={() => setDismissed(true)}>
              Discard
            </Button>
            <span className="text-xs text-fg-subtle">Or draw another below for a different take.</span>
          </div>
        ) : null}
      </div>

      {state.error && !dismissed ? <Alert variant="destructive">{state.error}</Alert> : null}

      <form action={draw} className="space-y-3" onSubmit={() => setDismissed(false)}>
        <div>
          <Label htmlFor="backdrop-description">Describe the room</Label>
          <Textarea
            id="backdrop-description"
            name="description"
            rows={2}
            maxLength={400}
            defaultValue={state.prompt ?? currentPrompt ?? ''}
            placeholder="a warm workshop with a pegboard of tools, a roller door and a workbench"
          />
          <p className="mt-1 text-xs text-fg-subtle">
            Say what is in the room and what it feels like. Composition, palette and perspective are handled for you.
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <div>
            <Label htmlFor="backdrop-theme">Light</Label>
            <Select id="backdrop-theme" name="theme" defaultValue="dark" className="w-32">
              <option value="dark">Dim</option>
              <option value="light">Bright</option>
            </Select>
          </div>
          <Button type="submit" disabled={drawing}>
            {drawing ? 'Drawing…' : draft || currentSvg ? 'Draw another' : 'Draw it'}
          </Button>
        </div>
      </form>

      {currentSvg ? (
        <form action={clearBackdrop} className="flex flex-wrap items-end gap-2 border-t border-border pt-4">
          <input type="hidden" name="id" value={departmentId} />
          <div>
            <Label htmlFor="backdrop-builtin">Or go back to a built-in room</Label>
            <Select id="backdrop-builtin" name="sceneKind" defaultValue={sceneKinds[0]?.value} className="w-48">
              {sceneKinds.map((kind) => (
                <option key={kind.value} value={kind.value}>
                  {kind.label}
                </option>
              ))}
            </Select>
          </div>
          <Button type="submit" variant="outline">
            Use built-in room
          </Button>
        </form>
      ) : null}
    </div>
  )
}
