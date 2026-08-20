'use client'

import * as React from 'react'
import { Mail, MessageSquare, Phone, X } from 'lucide-react'
import { Button, Input, Label, cn } from '@braedonsaunders/appkit-ui'

/**
 * Who a standing deliverable goes to, as something an operator can see.
 *
 * The alternative this replaces is a sentence — "email the report to the
 * Owner" — which reads perfectly and is a guess the model re-makes on every
 * run. A list of named people and channels cannot drift the way a phrase can.
 *
 * Two kinds of recipient, and the difference matters. Somebody in the
 * directory is held as an identity, so their report follows them when their
 * address changes. A typed address is held verbatim, because there is nothing
 * behind it to follow and pretending otherwise would lose what was written.
 */

export type DeliveryTargetValue =
  | { via: 'email'; personId: string }
  | { via: 'email'; address: string; name?: string }
  | { via: 'chat'; personId: string }
  | { via: 'call'; personId: string }
  | { via: 'call'; number: string }

export type DirectoryEntry = {
  id: string
  name: string
  kind: 'human' | 'agent'
  email: string | null
  phone: string | null
}

const CHANNELS = [
  { via: 'email' as const, label: 'Email', Icon: Mail },
  { via: 'chat' as const, label: 'Chat', Icon: MessageSquare },
  { via: 'call' as const, label: 'Call', Icon: Phone },
]

function personIdOf(target: DeliveryTargetValue): string | null {
  return 'personId' in target ? target.personId : null
}

/** Stable enough to key a list and to compare for "already added". */
function identityOf(target: DeliveryTargetValue): string {
  const person = personIdOf(target)
  if (person) return `${target.via}:person:${person}`
  if (target.via === 'email' && 'address' in target) return `email:addr:${target.address.toLowerCase()}`
  if (target.via === 'call' && 'number' in target) return `call:num:${target.number}`
  return `${target.via}:unknown`
}

function describe(target: DeliveryTargetValue, directory: readonly DirectoryEntry[]): {
  label: string
  detail: string
  problem?: string
} {
  const personId = personIdOf(target)
  if (!personId) {
    if (target.via === 'email' && 'address' in target) {
      return { label: target.name?.trim() || target.address, detail: target.address }
    }
    if (target.via === 'call' && 'number' in target) return { label: target.number, detail: 'typed number' }
    return { label: 'unknown', detail: '' }
  }
  const person = directory.find((entry) => entry.id === personId)
  if (!person) return { label: 'Former colleague', detail: '', problem: 'No longer in the directory.' }
  if (target.via === 'email') {
    return person.email
      ? { label: person.name, detail: person.email }
      : { label: person.name, detail: '', problem: 'No email address on file.' }
  }
  if (target.via === 'call') {
    return person.phone
      ? { label: person.name, detail: person.phone }
      : { label: person.name, detail: '', problem: 'No phone number on file.' }
  }
  return { label: person.name, detail: 'in your conversation with them' }
}

export function DeliveryTargetsField({
  value,
  onChange,
  directory,
}: {
  value: DeliveryTargetValue[]
  onChange: (next: DeliveryTargetValue[]) => void
  directory: DirectoryEntry[]
}) {
  const [via, setVia] = React.useState<'email' | 'chat' | 'call'>('email')
  const [typed, setTyped] = React.useState('')
  const chosen = new Set(value.map(identityOf))

  const add = (target: DeliveryTargetValue): void => {
    if (chosen.has(identityOf(target))) return
    onChange([...value, target])
  }
  const remove = (target: DeliveryTargetValue): void => {
    onChange(value.filter((entry) => identityOf(entry) !== identityOf(target)))
  }

  const addTyped = (): void => {
    const raw = typed.trim()
    if (!raw) return
    // Chat has no typed form: a conversation is with somebody in the
    // directory, and there is no address that could stand for one.
    if (via === 'chat') return
    add(via === 'email' ? { via: 'email', address: raw } : { via: 'call', number: raw })
    setTyped('')
  }

  // Chat reaches a person in the app, so an agent is not a candidate: an agent
  // has no conversation of its own to be posted into.
  const candidates = directory.filter((entry) => (via === 'chat' ? entry.kind === 'human' : true))

  return (
    <div className="space-y-3">
      <div>
        <Label>Who gets the work product</Label>
        <p className="mt-1 text-xs text-fg-muted">
          Named here rather than described in the instruction, so it cannot drift. Leave empty to let the
          instruction’s own wording stand.
        </p>
      </div>

      {value.length > 0 ? (
        <ul className="flex flex-wrap gap-2">
          {value.map((target) => {
            const { label, detail, problem } = describe(target, directory)
            const channel = CHANNELS.find((entry) => entry.via === target.via)!
            return (
              <li
                key={identityOf(target)}
                className={cn(
                  'flex items-center gap-2 rounded-full border py-1 pl-2.5 pr-1 text-xs',
                  problem ? 'border-danger/40 bg-danger-subtle text-danger' : 'border-border bg-surface-muted',
                )}
              >
                <channel.Icon size={13} className="shrink-0" />
                <span className="font-medium">{label}</span>
                {detail ? <span className="text-fg-muted">{detail}</span> : null}
                {problem ? <span>— {problem}</span> : null}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label={`Remove ${label}`}
                  onClick={() => remove(target)}
                  className="size-5 rounded-full p-0"
                >
                  <X size={13} />
                </Button>
              </li>
            )
          })}
        </ul>
      ) : (
        <p className="text-xs text-fg-subtle">Nobody named yet.</p>
      )}

      <div className="flex flex-wrap gap-1">
        {CHANNELS.map(({ via: channel, label, Icon }) => (
          <Button
            key={channel}
            type="button"
            size="sm"
            variant={via === channel ? 'default' : 'outline'}
            onClick={() => setVia(channel)}
          >
            <Icon size={14} />
            {label}
          </Button>
        ))}
      </div>

      <div className="rounded-lg border border-border p-2">
        <p className="mb-1.5 text-xs font-medium text-fg-muted">
          {via === 'chat' ? 'People in this workspace' : 'From the directory'}
        </p>
        <div className="flex flex-wrap gap-1.5">
          {candidates.map((entry) => {
            const target = { via, personId: entry.id } as DeliveryTargetValue
            const already = chosen.has(identityOf(target))
            return (
              <Button
                key={entry.id}
                type="button"
                variant="outline"
                size="sm"
                disabled={already}
                onClick={() => add(target)}
                className="h-auto rounded-full px-2.5 py-1 text-xs font-normal"
              >
                {entry.name}
                {entry.kind === 'agent' ? <span className="ml-1 text-fg-subtle">(agent)</span> : null}
              </Button>
            )
          })}
          {candidates.length === 0 ? <span className="text-xs text-fg-subtle">Nobody available.</span> : null}
        </div>

        {via !== 'chat' ? (
          <div className="mt-2 flex gap-2">
            <Input
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              placeholder={via === 'email' ? 'or type an address' : 'or type a number'}
              // Enter inside a duty form would otherwise submit the whole duty
              // rather than add the recipient being typed.
              onKeyDown={(event) => {
                if (event.key !== 'Enter') return
                event.preventDefault()
                addTyped()
              }}
            />
            <Button type="button" variant="outline" onClick={addTyped} disabled={!typed.trim()}>
              Add
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  )
}
