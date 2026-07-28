'use client'

import * as React from 'react'
import { Boxes, Trash2 } from 'lucide-react'
import {
  Badge,
  Button,
  Drawer,
  EmptyState,
  Input,
  Label,
  PagedTable,
  SearchSelect,
  SubtabNav,
  Textarea,
  type PagedColumn,
} from '@appkit/ui'
import { ComposedAvatar } from '@appkit/avatars/react'
import { createEmptyComposition, type AvatarPart, type AvatarPartCategory } from '@appkit/avatars/composition'
import {
  deleteAvatarPartAction,
  generateAvatarPartsAction,
  keepAvatarPartAction,
  updateAvatarPartAction,
} from '../app/admin/settings/avatar-part-actions'

export type AvatarPartRowView = {
  id: string
  categoryId: string
  categoryLabel: string
  name: string
  colorVariant: string
  tags: string[]
  model: string
  prompt: string
  createdAt: string
}

const PART_COLUMNS: PagedColumn<AvatarPartRowView>[] = [
  {
    key: 'name',
    header: 'Part',
    cell: (row) => (
      <span className="flex items-center gap-2 font-medium text-primary">
        <span className="size-8 shrink-0 overflow-hidden rounded border border-border bg-bg-subtle">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={`/api/avatar-parts/${row.id}`} alt="" className="h-full w-full object-contain" />
        </span>
        {row.name}
      </span>
    ),
    search: (row) => row.name,
    sortValue: (row) => row.name,
  },
  {
    key: 'categoryLabel',
    header: 'Slot',
    cell: (row) => row.categoryLabel,
    search: (row) => row.categoryLabel,
    sortValue: (row) => row.categoryLabel,
  },
  {
    key: 'colorVariant',
    header: 'Colour',
    cell: (row) => row.colorVariant || <span className="text-fg-muted">—</span>,
    search: (row) => row.colorVariant,
    sortValue: (row) => row.colorVariant,
  },
  {
    key: 'tags',
    header: 'Tags',
    cell: (row) =>
      row.tags.length === 0 ? (
        <span className="text-fg-muted">—</span>
      ) : (
        <span className="flex flex-wrap gap-1">
          {row.tags.map((tag) => (
            <Badge key={tag} variant="outline">
              {tag}
            </Badge>
          ))}
        </span>
      ),
    search: (row) => row.tags.join(' '),
  },
  { key: 'model', header: 'Model', cell: (row) => row.model, search: (row) => row.model, sortValue: (row) => row.model },
  { key: 'createdAt', header: 'Added', cell: (row) => row.createdAt, sortValue: (row) => row.createdAt },
]

/**
 * The parts library — the raw material every figure in the company is built
 * from. Parts are shared: one good safety vest is worn by the whole crew.
 */
export function AvatarPartsView({
  parts,
  categories,
  library,
  imageProviderConfigured,
}: {
  parts: AvatarPartRowView[]
  categories: AvatarPartCategory[]
  /** The same parts shaped for the preview renderer. */
  library: AvatarPart[]
  imageProviderConfigured: boolean
}) {
  const [categoryFilter, setCategoryFilter] = React.useState('all')
  const [generateOpen, setGenerateOpen] = React.useState(false)
  const [editing, setEditing] = React.useState<AvatarPartRowView | null>(null)

  const visible =
    categoryFilter === 'all' ? parts : parts.filter((part) => part.categoryId === categoryFilter)

  return (
    <div className="space-y-4 px-5 py-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="w-52">
          <SearchSelect
            value={categoryFilter}
            onChange={setCategoryFilter}
            options={[
              { value: 'all', label: 'Every slot' },
              ...categories.map((category) => ({ value: category.id, label: category.label })),
            ]}
            ariaLabel="Filter by slot"
          />
        </div>
        <Button type="button" onClick={() => setGenerateOpen(true)} disabled={!imageProviderConfigured}>
          Generate parts
        </Button>
      </div>

      <PagedTable
        columns={PART_COLUMNS}
        rows={visible}
        rowKey={(row) => row.id}
        pageSize={15}
        searchable
        defaultSort={{ key: 'createdAt', dir: 'desc' }}
        onRowClick={(row) => setEditing(row)}
        labels={{ searchPlaceholder: 'Search parts…', searchLabel: 'Search parts' }}
        empty={
          <EmptyState
            icon={<Boxes />}
            title={parts.length === 0 ? 'The library is empty' : 'No parts in this slot'}
            description={
              parts.length === 0
                ? imageProviderConfigured
                  ? 'Generate a set of parts — bodies, outfits, faces, hair — and everyone in the company is built from them.'
                  : 'Choose an image provider under Intelligence → Image generation first; parts are generated with the same key.'
                : 'Pick another slot, or generate parts for this one.'
            }
            {...(imageProviderConfigured
              ? { action: <Button onClick={() => setGenerateOpen(true)}>Generate parts</Button> }
              : {})}
          />
        }
      />

      <GeneratePartsDrawer
        open={generateOpen}
        onClose={() => setGenerateOpen(false)}
        categories={categories}
      />

      {editing ? (
        <EditPartDrawer
          key={editing.id}
          part={editing}
          onClose={() => setEditing(null)}
          library={library}
          categories={categories}
        />
      ) : null}
    </div>
  )
}

/**
 * Generate candidates for one slot and keep the ones worth keeping.
 *
 * The prompt discipline is not optional: parts stack, so every candidate is
 * asked for as an isolated, alpha-cut object. The category supplies what the
 * part is; the operator supplies the character of it.
 */
function GeneratePartsDrawer({
  open,
  onClose,
  categories,
}: {
  open: boolean
  onClose: () => void
  categories: AvatarPartCategory[]
}) {
  const [categoryId, setCategoryId] = React.useState(categories[0]?.id ?? '')
  const [description, setDescription] = React.useState('')
  const [candidates, setCandidates] = React.useState<string[]>([])
  const [meta, setMeta] = React.useState<{ model: string; prompt: string } | null>(null)
  const [name, setName] = React.useState('')
  const [colorVariant, setColorVariant] = React.useState('')
  const [tags, setTags] = React.useState('')
  const [error, setError] = React.useState<string | null>(null)
  const [kept, setKept] = React.useState<number[]>([])
  const [generating, startGenerating] = React.useTransition()
  const [keeping, startKeeping] = React.useTransition()

  const category = categories.find((c) => c.id === categoryId)

  const reset = () => {
    setCandidates([])
    setMeta(null)
    setKept([])
    setError(null)
  }

  const generate = () =>
    startGenerating(async () => {
      reset()
      const result = await generateAvatarPartsAction(categoryId, description)
      if (!result.ok) {
        setError(result.message)
        return
      }
      setCandidates(result.images)
      setMeta({ model: result.model, prompt: result.prompt })
      if (!name.trim()) setName(description.trim())
    })

  const keep = (index: number) =>
    startKeeping(async () => {
      if (!meta) return
      setError(null)
      const result = await keepAvatarPartAction({
        categoryId,
        name: name.trim() || description.trim(),
        dataUri: candidates[index]!,
        model: meta.model,
        prompt: meta.prompt,
        ...(colorVariant.trim() ? { colorVariant: colorVariant.trim() } : {}),
        tags: tags
          .split(',')
          .map((tag) => tag.trim())
          .filter(Boolean),
      })
      if (!result.ok) {
        setError(result.message)
        return
      }
      setKept((previous) => [...previous, index])
    })

  return (
    <Drawer
      open={open}
      onClose={() => {
        reset()
        onClose()
      }}
      title="Generate parts"
      description="One slot at a time. Keep the takes that fit; the rest are discarded."
      size="lg"
    >
      <div className="space-y-4">
        <div>
          <Label htmlFor="part-slot">Slot</Label>
          <SearchSelect
            id="part-slot"
            value={categoryId}
            onChange={(value) => {
              setCategoryId(value)
              reset()
            }}
            options={categories.map((c) => ({
              value: c.id,
              label: c.label,
              ...(c.promptAddition ? { hint: c.promptAddition } : {}),
            }))}
            ariaLabel="Slot"
          />
          {category?.promptAddition ? (
            <p className="mt-1.5 text-xs text-fg-muted">
              Every part in this slot is drawn as {category.promptAddition}.
            </p>
          ) : null}
        </div>

        <div>
          <Label htmlFor="part-description">What should it look like?</Label>
          <Textarea
            id="part-description"
            rows={2}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder={
              category?.id === 'hair' ? 'short curly hair, swept to one side' : 'a navy quilted work jacket'
            }
          />
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <Label htmlFor="part-name">Name</Label>
            <Input
              id="part-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Short crop"
            />
          </div>
          <div>
            <Label htmlFor="part-variant">Colour (optional)</Label>
            <Input
              id="part-variant"
              value={colorVariant}
              onChange={(event) => setColorVariant(event.target.value)}
              placeholder="auburn"
            />
          </div>
          <div>
            <Label htmlFor="part-tags">Tags (optional)</Label>
            <Input
              id="part-tags"
              value={tags}
              onChange={(event) => setTags(event.target.value)}
              placeholder="short, tidy"
            />
          </div>
        </div>
        <p className="text-xs text-fg-muted">
          Give a part the same name as an existing one and set a colour to add it as a colour option on that part
          rather than a separate entry.
        </p>

        <Button type="button" onClick={generate} disabled={generating || !description.trim()}>
          {generating ? 'Generating…' : candidates.length > 0 ? 'Generate again' : 'Generate'}
        </Button>

        {error ? <p className="text-sm text-danger">{error}</p> : null}

        {candidates.length > 0 ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {candidates.map((uri, index) => (
              <div key={index} className="space-y-2">
                <div className="overflow-hidden rounded-lg border border-border bg-bg-subtle">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={uri} alt={`Option ${index + 1}`} className="aspect-square w-full object-contain" />
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant={kept.includes(index) ? 'outline' : 'default'}
                  className="w-full"
                  disabled={keeping || kept.includes(index) || !name.trim()}
                  onClick={() => keep(index)}
                >
                  {kept.includes(index) ? 'In the library' : 'Keep'}
                </Button>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </Drawer>
  )
}

/** Rename, retag, preview in place, or remove a part. */
function EditPartDrawer({
  part,
  onClose,
  library,
  categories,
}: {
  part: AvatarPartRowView
  onClose: () => void
  library: AvatarPart[]
  categories: AvatarPartCategory[]
}) {
  // Keyed on the part by the caller, so opening another one remounts with its
  // own values rather than syncing state in an effect.
  const [tab, setTab] = React.useState('details')
  const [name, setName] = React.useState(part.name)
  const [tags, setTags] = React.useState(part.tags.join(', '))
  const [error, setError] = React.useState<string | null>(null)
  const [busy, startBusy] = React.useTransition()

  const category = categories.find((c) => c.id === part.categoryId)
  const libraryPart = library.find((p) => p.id === part.id)

  // A one-part composition, so the operator sees the part where it will land
  // on the figure rather than floating in a square thumbnail.
  const preview = createEmptyComposition()
  if (libraryPart && category) {
    preview.parts[category.id] = {
      partId: libraryPart.id,
      transform: { ...category.defaultTransform },
    }
  }

  const save = () =>
    startBusy(async () => {
      const result = await updateAvatarPartAction({
        partId: part.id,
        name,
        tags: tags
          .split(',')
          .map((tag) => tag.trim())
          .filter(Boolean),
      })
      if (!result.ok) {
        setError(result.message)
        return
      }
      onClose()
    })

  const remove = () =>
    startBusy(async () => {
      const result = await deleteAvatarPartAction(part.id)
      if (!result.ok) {
        setError(result.message)
        return
      }
      onClose()
    })

  return (
    <Drawer open onClose={onClose} title={part.name} description={`${part.categoryLabel} · ${part.model}`} size="md">
      <div className="space-y-4">
        <SubtabNav
          tabs={[
            { key: 'details', label: 'Details' },
            { key: 'placement', label: 'Placement' },
            { key: 'provenance', label: 'Provenance' },
          ]}
          active={tab}
          onSelect={setTab}
          ariaLabel="Part sections"
        />

        {tab === 'details' ? (
          <div className="space-y-3">
            <div>
              <Label htmlFor="edit-part-name">Name</Label>
              <Input id="edit-part-name" value={name} onChange={(event) => setName(event.target.value)} />
            </div>
            <div>
              <Label htmlFor="edit-part-tags">Tags</Label>
              <Input id="edit-part-tags" value={tags} onChange={(event) => setTags(event.target.value)} />
            </div>
            {part.colorVariant ? (
              <p className="text-sm text-fg-muted">
                This is the <strong>{part.colorVariant}</strong> colour of {part.name}. It appears as a colour
                option on that part in the composer.
              </p>
            ) : null}
            <div className="flex items-center gap-2">
              <Button type="button" onClick={save} disabled={busy}>
                {busy ? 'Saving…' : 'Save'}
              </Button>
              <Button type="button" variant="destructive" onClick={remove} disabled={busy}>
                <Trash2 className="mr-1.5 size-4" /> Remove
              </Button>
            </div>
            <p className="text-xs text-fg-muted">
              Removing a part leaves the figures wearing it intact — the slot simply empties, and the composer shows
              it ready to refill.
            </p>
          </div>
        ) : null}

        {tab === 'placement' ? (
          <div className="flex flex-wrap items-start gap-6">
            <ComposedAvatar
              composition={preview}
              parts={library}
              categories={categories}
              variant="full"
              size={200}
              name={part.name}
            />
            <div className="min-w-0 flex-1 space-y-1 text-sm text-fg-muted">
              <p>Where this part lands on a fresh figure, before anyone moves it.</p>
              {category ? (
                <p>
                  The {category.label.toLowerCase()} slot sits at {Math.round(category.defaultTransform.x)},{' '}
                  {Math.round(category.defaultTransform.y)} on the 512 × 768 stage, {category.frame.width} ×{' '}
                  {category.frame.height} units.
                </p>
              ) : null}
              <p>Each person&apos;s composer moves, scales, and rotates it from there.</p>
            </div>
          </div>
        ) : null}

        {tab === 'provenance' ? (
          <div className="space-y-3 text-sm">
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-fg-muted">Added</p>
              <p className="text-fg">{part.createdAt}</p>
            </div>
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-fg-muted">Model</p>
              <p className="text-fg">{part.model}</p>
            </div>
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-fg-muted">Prompt</p>
              {part.prompt ? (
                <p className="rounded-md border border-border bg-bg-subtle p-3 leading-6 text-fg">{part.prompt}</p>
              ) : (
                <p className="text-fg-muted">Imported from an earlier avatar, before parts were prompted.</p>
              )}
            </div>
          </div>
        ) : null}

        {error ? <p className="text-sm text-danger">{error}</p> : null}
      </div>
    </Drawer>
  )
}
