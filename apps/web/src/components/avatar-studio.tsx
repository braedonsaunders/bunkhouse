'use client'

import * as React from 'react'
import { Avatar, Badge, Button, Drawer, SubtabNav } from '@appkit/ui'
import { chooseAvatarAction, generateAvatarsAction } from '../app/people/actions'

type Kind = 'portrait' | 'full_body'

const KIND_COPY: Record<Kind, { label: string; blurb: string }> = {
  portrait: {
    label: 'Portrait',
    blurb: 'The face shown in the directory, on records, and during calls.',
  },
  full_body: {
    label: 'Full body',
    blurb: 'The standing figure that appears in the lobby on the home page.',
  },
}

/**
 * The likeness studio: generate portrait and full-body art for anyone in the
 * directory in one house style, and pick the take that fits.
 */
export function AvatarStudio({
  personId,
  name,
  hasPortrait,
  hasFullBody,
  model,
  size = 44,
}: {
  personId: string
  name: string
  hasPortrait: boolean
  hasFullBody: boolean
  model: string
  size?: number
}) {
  const [open, setOpen] = React.useState(false)
  const [kind, setKind] = React.useState<Kind>('portrait')
  const [candidates, setCandidates] = React.useState<Record<Kind, string[]>>({ portrait: [], full_body: [] })
  const [error, setError] = React.useState<string | null>(null)
  const [generating, startGenerating] = React.useTransition()
  const [saving, startSaving] = React.useTransition()
  // Bust the image cache after a save so the new art shows immediately.
  const [version, setVersion] = React.useState(0)

  const has = kind === 'portrait' ? hasPortrait : hasFullBody
  const src = (forKind: Kind) => `/api/avatars/${personId}?kind=${forKind}&v=${version}`

  const generate = () =>
    startGenerating(async () => {
      setError(null)
      const result = await generateAvatarsAction(personId, kind)
      if (!result.ok) {
        setError(result.message)
        return
      }
      setCandidates((prev) => ({ ...prev, [kind]: result.images }))
    })

  const choose = (dataUri: string) =>
    startSaving(async () => {
      setError(null)
      const form = new FormData()
      form.set('personId', personId)
      form.set('dataUri', dataUri)
      form.set('model', model)
      form.set('kind', kind)
      try {
        await chooseAvatarAction(form)
        setCandidates((prev) => ({ ...prev, [kind]: [] }))
        setVersion((v) => v + 1)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    })

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Open the likeness studio"
        className="rounded-full transition-opacity hover:opacity-80"
      >
        <Avatar name={name} size={size} {...(hasPortrait ? { src: src('portrait') } : {})} />
      </button>
      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        title={`Likeness — ${name}`}
        description="Generated in one house style so the whole roster looks like one team."
        size="lg"
      >
        <div className="space-y-4">
          <SubtabNav
            tabs={[
              { key: 'portrait', label: KIND_COPY.portrait.label },
              { key: 'full_body', label: KIND_COPY.full_body.label },
            ]}
            active={kind}
            onSelect={(key) => {
              setKind(key as Kind)
              setError(null)
            }}
            ariaLabel="Likeness kind"
          />

          <div className="flex flex-wrap items-center gap-3">
            {has ? (
              kind === 'portrait' ? (
                <Avatar name={name} size={64} src={src('portrait')} />
              ) : (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={src('full_body')} alt="" className="h-32 w-auto object-contain" />
              )
            ) : (
              <Badge variant="outline">none yet</Badge>
            )}
            <div className="min-w-0 flex-1">
              <p className="text-sm text-fg-muted">{KIND_COPY[kind].blurb}</p>
            </div>
            <Button type="button" onClick={generate} disabled={generating}>
              {generating ? 'Generating…' : candidates[kind].length > 0 ? 'Generate again' : 'Generate'}
            </Button>
          </div>

          {candidates[kind].length > 0 ? (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {candidates[kind].map((uri, index) => (
                <button
                  key={index}
                  type="button"
                  disabled={saving}
                  onClick={() => choose(uri)}
                  className="overflow-hidden rounded-lg border border-border transition-colors hover:border-primary"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={uri} alt={`Option ${index + 1}`} className="aspect-square w-full object-contain" />
                </button>
              ))}
            </div>
          ) : null}

          {error ? <p className="text-sm text-danger">{error}</p> : null}
        </div>
      </Drawer>
    </>
  )
}
