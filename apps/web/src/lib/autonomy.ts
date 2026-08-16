import type { ActionCategory, AutonomyLevel } from '@bunkhouse/runtime'

/**
 * The one vocabulary for the autonomy dial: the governed action categories, the
 * trust levels, and how each reads to an operator. Mirrors the `action_category`
 * and `autonomy_level` enums — enforcement itself lives in the runtime.
 */
export const ACTION_CATEGORIES = [
  'external_email',
  'internal_email',
  'record_write',
  'money_adjacent',
  'file_write',
  'phone_call',
  'sandbox',
  'desktop',
  'shared_folder',
  'background_job',
] as const satisfies readonly ActionCategory[]

export const AUTONOMY_LEVELS = ['forbidden', 'approval', 'notify', 'trusted'] as const satisfies readonly AutonomyLevel[]

/** The level an agent falls back to wherever the dial has no explicit setting. */
export const DEFAULT_AUTONOMY_LEVEL: AutonomyLevel = 'approval'

export const CATEGORY_LABELS: Record<ActionCategory, string> = {
  external_email: 'External email',
  internal_email: 'Internal email',
  record_write: 'Record changes',
  money_adjacent: 'Money-adjacent',
  file_write: 'File writes',
  phone_call: 'Phone calls',
  sandbox: 'Sandbox machine',
  desktop: 'Desktop screen',
  shared_folder: 'Shared folder',
  background_job: 'Background jobs',
}

/** What each level means, in the operator's terms. */
export const LEVEL_DESCRIPTIONS: Record<AutonomyLevel, string> = {
  forbidden: 'Blocked outright — the agent cannot take this action.',
  approval: 'Pauses and waits for a human decision every time.',
  notify: 'Proceeds on its own and tells you afterwards.',
  trusted: 'Proceeds on its own, no notification.',
}

export const LEVEL_BADGES: Record<AutonomyLevel, 'default' | 'secondary' | 'outline' | 'destructive'> = {
  trusted: 'default',
  notify: 'secondary',
  approval: 'outline',
  forbidden: 'destructive',
}

export function isActionCategory(value: string): value is ActionCategory {
  return (ACTION_CATEGORIES as readonly string[]).includes(value)
}

export function isAutonomyLevel(value: string): value is AutonomyLevel {
  return (AUTONOMY_LEVELS as readonly string[]).includes(value)
}
