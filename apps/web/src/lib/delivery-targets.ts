import 'server-only'
import { inArray } from 'drizzle-orm'
import { people, type DeliveryTarget } from '../db/schema'
import { db } from '../db/client'

/**
 * Turning declared recipients into an instruction the agent cannot misread.
 *
 * A duty used to carry its recipients only in prose — "email the report to the
 * Owner" — which the model resolved afresh on every run. That works until the
 * answer changes, and then it fails silently in the worst possible way: the
 * run completes, the mail sends, and it goes to whoever the model still
 * believes the Owner is. Nothing anywhere reports a problem, because from the
 * system's point of view nothing went wrong.
 *
 * Resolution happens at send time, not at save time. A recipient stored as a
 * `personId` follows that person — their address can change, their name can
 * change, and tomorrow's delivery still reaches them. That is the whole reason
 * internal recipients are stored as identities rather than as the address they
 * happened to have when somebody filled in the form.
 */

export type ResolvedTarget = {
  via: 'email' | 'chat' | 'call'
  /** How to address them on that channel: an address, a name, or a number. */
  handle: string
  /** Who they are, for the sentence the agent reads. */
  label: string
  /** Set when this target is an internal person rather than a typed handle. */
  personId?: string
  /** Why this target cannot be delivered to, when it cannot. */
  problem?: string
}

function isPersonTarget(target: DeliveryTarget): target is Extract<DeliveryTarget, { personId: string }> {
  return typeof (target as { personId?: unknown }).personId === 'string'
}

/**
 * Resolve every declared target against the current directory.
 *
 * Unresolvable targets are returned WITH a `problem` rather than dropped. A
 * recipient who has left the company is a fact the agent should say out loud
 * in its report — silently delivering to four people when five were declared
 * is the same class of failure this whole mechanism exists to end.
 */
export async function resolveDeliveryTargets(
  tenantId: string,
  targets: readonly DeliveryTarget[],
): Promise<ResolvedTarget[]> {
  if (targets.length === 0) return []
  const app = db()
  const personIds = [...new Set(targets.filter(isPersonTarget).map((target) => target.personId))]
  const directory = personIds.length === 0
    ? []
    : await app.withTenantContext(tenantId, () =>
        app.db
          .select({
            id: people.id,
            name: people.name,
            email: people.email,
            phone: people.phone,
            status: people.status,
          })
          .from(people)
          .where(inArray(people.id, personIds)))
  const byId = new Map(directory.map((row) => [row.id, row]))

  return targets.map((target): ResolvedTarget => {
    if (!isPersonTarget(target)) {
      if (target.via === 'email') {
        return { via: 'email', handle: target.address, label: target.name?.trim() || target.address }
      }
      return { via: 'call', handle: target.number, label: target.number }
    }

    const person = byId.get(target.personId)
    if (!person) {
      return {
        via: target.via,
        handle: '',
        label: 'a former colleague',
        personId: target.personId,
        problem: 'This recipient is no longer in the directory.',
      }
    }
    const base = { label: person.name, personId: person.id }
    if (target.via === 'email') {
      return person.email
        ? { via: 'email', handle: person.email, ...base }
        : { via: 'email', handle: '', ...base, problem: `${person.name} has no email address on file.` }
    }
    if (target.via === 'call') {
      return person.phone
        ? { via: 'call', handle: person.phone, ...base }
        : { via: 'call', handle: '', ...base, problem: `${person.name} has no phone number on file.` }
    }
    // Chat is addressed by identity, not by a handle: the thread is found from
    // the person and the agent, and there is nothing to type.
    return { via: 'chat', handle: person.name, ...base }
  })
}

const CHANNEL_VERB: Record<ResolvedTarget['via'], string> = {
  email: 'Email',
  chat: 'Post in your conversation with',
  call: 'Call',
}

/**
 * The delivery instruction, in the agent's own reading order.
 *
 * Appended to the duty's own words rather than replacing them, because the
 * instruction still says what to produce and how it should read; this only
 * settles who receives it. Where the two disagree, this wins and says so —
 * otherwise an old sentence naming "the Owner" would go on competing with the
 * declared list, and a model handed two answers picks one.
 */
export function deliveryInstruction(resolved: readonly ResolvedTarget[]): string {
  if (resolved.length === 0) return ''
  const lines = resolved.map((target) => {
    const verb = CHANNEL_VERB[target.via]
    if (target.problem) return `- ${verb} ${target.label} — CANNOT BE DONE: ${target.problem}`
    return target.via === 'chat'
      ? `- ${verb} ${target.label} (use post_to_conversation)`
      : `- ${verb} ${target.label} at ${target.handle}`
  })
  const unreachable = resolved.filter((target) => target.problem)
  return [
    '',
    'DELIVERY — this is the authoritative recipient list for this work.',
    'Deliver the finished work product to every one of these, by the channel named.',
    'If the instruction above names a recipient differently, THIS LIST WINS.',
    ...lines,
    ...(unreachable.length > 0
      ? ['', 'Say plainly in your summary that you could not reach the ones marked CANNOT BE DONE. Do not substitute someone else.']
      : []),
  ].join('\n')
}
