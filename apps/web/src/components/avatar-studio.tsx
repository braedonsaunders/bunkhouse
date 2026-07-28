'use client'

import * as React from 'react'
import { Avatar, Button, Drawer } from '@appkit/ui'
import { chooseAvatarAction, generateAvatarsAction } from '../app/people/actions'

/**
 * The hand's portrait: click to open the studio drawer, generate candidate
 * portraits with the tenant's image provider, pick one. Uniform style comes
 * from the shared portrait prompt in @appkit/avatars.
 */
export function AvatarStudio({
  personId,
  name,
  hasAvatar,
  model,
}: {
  personId: string
  name: string
  hasAvatar: boolean
  model: string
}) {
  const [open, setOpen] = React.useState(false)
  const [candidates, setCandidates] = React.useState<string[]>([])
  const [error, setError] = React.useState<string | null>(null)
  const [generating, startGenerating] = React.useTransition()
  const [saving, startSaving] = React.useTransition()

  const generate = () =>
    startGenerating(async () => {
      setError(null)
      const result = await generateAvatarsAction(personId)
      if (!result.ok) {
        setError(result.message)
        return
      }
      setCandidates(result.images)
    })

  const choose = (dataUri: string) =>
    startSaving(async () => {
      setError(null)
      const form = new FormData()
      form.set('personId', personId)
      form.set('dataUri', dataUri)
      form.set('model', model)
      try {
        await chooseAvatarAction(form)
        setOpen(false)
        setCandidates([])
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    })

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Open the avatar studio"
        className="rounded-full transition-opacity hover:opacity-80"
      >
        <Avatar name={name} size={44} {...(hasAvatar ? { src: `/api/avatars/${personId}` } : {})} />
      </button>
      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        title={`Avatar — ${name}`}
        description="Generate portrait candidates with the company image provider, then pick one."
        size="md"
      >
        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <Avatar name={name} size={56} {...(hasAvatar ? { src: `/api/avatars/${personId}` } : {})} />
            <Button type="button" onClick={generate} disabled={generating}>
              {generating ? 'Generating…' : candidates.length > 0 ? 'Generate again' : 'Generate portraits'}
            </Button>
          </div>
          {candidates.length > 0 ? (
            <div className="grid grid-cols-2 gap-3">
              {candidates.map((uri, index) => (
                <button
                  key={index}
                  type="button"
                  disabled={saving}
                  onClick={() => choose(uri)}
                  className="overflow-hidden rounded-lg border border-border transition-colors hover:border-primary"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={uri} alt={`Portrait candidate ${index + 1}`} className="aspect-square w-full object-cover" />
                </button>
              ))}
            </div>
          ) : (
            <p className="text-sm text-fg-muted">
              Portraits render in a uniform flat-illustration style so the whole roster looks like one team.
            </p>
          )}
          {error ? <p className="text-sm text-danger">{error}</p> : null}
        </div>
      </Drawer>
    </>
  )
}
