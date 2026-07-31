'use client'

import * as React from 'react'
import { Button, Card, CardContent, Input, Select } from '@appkit/ui'
import { draftBackdrop, saveBackdrop, clearBackdrop } from '../app/organization/department-actions'

/**
 * Having a room drawn, and looking at it before keeping it.
 *
 * The preview is the whole point. A model draws a dud often enough that
 * committing unseen would be a lottery, and the difference between a backdrop
 * that belongs on this floor and one that does not is entirely visual — no
 * amount of validation catches "that looks wrong".
 *
 * The preview is rendered exactly as the floor renders it, at the floor's
 * aspect, so what is approved is what appears.
 */
export function BackdropStudio({
  departmentId,
  currentSvg,
  currentPrompt,
  sceneKinds,
}: {
  departmentId: string
  currentSvg: string | null
  currentPrompt: string | null
  sceneKinds: { value: string; label: string }[]
}) {
  const [state, action, pending] = React.useActionState(draftBackdrop, {} as { svg?: string; error?: string; prompt?: string })
  const preview = state.svg ?? null

  return (
    <div className="space-y-3">
      <form action={action} className="flex flex-wrap items-end gap-2">
        <label className="min-w-[260px] flex-1 space-y-1">
          <span className="text-xs text-fg-muted">Describe the room</span>
          <Input
            name="description"
            defaultValue={state.prompt ?? currentPrompt ?? ''}
            placeholder="a warm workshop with pegboard tools and a roller door"
            maxLength={400}
          />
        </label>
        <label className="space-y-1">
          <span className="text-xs text-fg-muted">Light</span>
          <Select name="theme" defaultValue="dark" className="w-28">
            <option value="dark">Dim</option>
            <option value="light">Bright</option>
          </Select>
        </label>
        <Button type="submit" disabled={pending}>
          {pending ? 'Drawing…' : 'Draw it'}
        </Button>
      </form>

      {state.error ? <p className="text-sm text-danger">{state.error}</p> : null}

      {preview ? (
        <Card>
          <CardContent className="space-y-3 pt-4">
            {/*
              The same aspect and the same slice behaviour the stage uses, so
              this is genuinely what the floor will look like rather than an
              approximation of it.
            */}
            <div
              className="aspect-[16/9] w-full overflow-hidden rounded-lg border border-border [&>svg]:h-full [&>svg]:w-full"
              dangerouslySetInnerHTML={{ __html: preview }}
            />
            <div className="flex items-center gap-2">
              <form action={saveBackdrop}>
                <input type="hidden" name="id" value={departmentId} />
                <input type="hidden" name="svg" value={preview} />
                <input type="hidden" name="prompt" value={state.prompt ?? ''} />
                <Button type="submit" size="sm">
                  Use this
                </Button>
              </form>
              <form action={action}>
                <input type="hidden" name="description" value={state.prompt ?? ''} />
                <input type="hidden" name="theme" value="dark" />
                <Button type="submit" variant="outline" size="sm" disabled={pending}>
                  Try again
                </Button>
              </form>
              <span className="text-xs text-fg-subtle">Nothing is saved until you keep it.</span>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {currentSvg ? (
        <div className="flex items-center gap-2">
          <span className="text-xs text-fg-muted">This department uses a drawn backdrop.</span>
          <form action={clearBackdrop} className="flex items-center gap-2">
            <input type="hidden" name="id" value={departmentId} />
            <Select name="sceneKind" defaultValue={sceneKinds[0]?.value} className="w-40">
              {sceneKinds.map((kind) => (
                <option key={kind.value} value={kind.value}>
                  {kind.label}
                </option>
              ))}
            </Select>
            <Button type="submit" variant="outline" size="sm">
              Go back to a built-in room
            </Button>
          </form>
        </div>
      ) : null}
    </div>
  )
}
