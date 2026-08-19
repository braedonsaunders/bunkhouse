import type { ApprovalPayload } from '../db/schema'

export type ApprovalPresentation = {
  fields: Array<{ label: string; value: string }>
  text: string | null
}

/** `external_email` is storage; “External email” is operator copy. */
export function approvalCategoryLabel(category: string): string {
  const words = category.replace(/_/g, ' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/**
 * The reviewable part of the exact replay payload. Shared by the Approvals
 * queue and inline conversation cards so neither surface asks someone to
 * approve a vague tool label.
 */
export function approvalPresentation(payload: ApprovalPayload): ApprovalPresentation {
  const action = (payload.action as { input?: unknown } | null)?.input
  const input = action && typeof action === 'object' && !Array.isArray(action)
    ? action as Record<string, unknown>
    : {}
  const str = (key: string): string | null => {
    const value = input[key]
    return typeof value === 'string' && value.trim() ? value.trim() : null
  }
  const fields: Array<{ label: string; value: string }> = []
  const add = (label: string, value: string | null): void => {
    if (value) fields.push({ label, value })
  }

  const recipients = input.to
  const to = typeof recipients === 'string'
    ? recipients.trim() || null
    : Array.isArray(recipients)
      ? recipients.map((entry) => {
          if (typeof entry === 'string') return entry.trim()
          if (!entry || typeof entry !== 'object') return ''
          const address = (entry as { address?: unknown }).address
          return typeof address === 'string' ? address.trim() : ''
        }).filter(Boolean).join(', ') || null
      : null

  add('To', to)
  add('Subject', str('subject'))
  add('Name', str('name') ?? str('title'))
  add('Identifier', str('slug'))
  add('Working directory', str('cwd'))

  const definition = input.definition
  if (definition && typeof definition === 'object' && !Array.isArray(definition)) {
    const record = definition as Record<string, unknown>
    add('Base URL', typeof record.baseUrl === 'string' ? record.baseUrl.trim() || null : null)
    const operations = Array.isArray(record.operations) ? record.operations : []
    const operationLabels = operations.map((operation) => {
      if (!operation || typeof operation !== 'object') return ''
      const item = operation as { title?: unknown; name?: unknown }
      const label = typeof item.title === 'string' ? item.title : typeof item.name === 'string' ? item.name : ''
      return label.trim()
    }).filter(Boolean)
    if (operationLabels.length > 0) add('Abilities', operationLabels.join(', '))
  }

  return {
    fields,
    text: str('body')
      ?? str('command')
      ?? str('url')
      ?? str('target')
      ?? str('description')
      ?? str('changeNote')
      ?? str('spec'),
  }
}
