import type { PermissionGroup } from '@braedonsaunders/appkit-iam'

/**
 * The complete tenant permission catalogue. Keep keys coarse enough that an
 * operator can understand the role matrix, but separate observation from
 * mutation and keep security administration behind its own grant.
 */
export const PERMISSION_GROUPS = [
  {
    key: 'organization',
    label: 'Organization',
    permissions: [
      { key: 'people.read', label: 'View people', description: 'Read the directory, org chart, and agent profiles.' },
      { key: 'people.manage', label: 'Manage people', description: 'Hire, update, move, and offboard people and agents.' },
      { key: 'roles.read', label: 'View role packs', description: 'Read candidate role packs and their procedures.' },
      { key: 'roles.manage', label: 'Manage role packs', description: 'Create, change, install, and remove role packs.' },
    ],
  },
  {
    key: 'work',
    label: 'Work and communication',
    permissions: [
      { key: 'work.read', label: 'View work', description: 'Read runs, assignments, and operational activity.' },
      { key: 'work.manage', label: 'Manage work', description: 'Create assignments and control agent work.' },
      { key: 'approvals.read', label: 'View approvals', description: 'Read requested decisions and their evidence.' },
      { key: 'approvals.decide', label: 'Decide approvals', description: 'Approve or reject governed agent actions.' },
      { key: 'mail.read', label: 'View mail', description: 'Read company mail threads handled by agents.' },
      { key: 'mail.manage', label: 'Manage mail', description: 'Send mail and change mailbox connections.' },
      { key: 'calls.manage', label: 'Manage calls', description: 'Start calls and administer live meetings.' },
      { key: 'observatory.read', label: 'View observatory', description: 'Inspect agent runs and recorded sessions.' },
    ],
  },
  {
    key: 'knowledge',
    label: 'Knowledge and procedures',
    permissions: [
      { key: 'resources.read', label: 'View resources', description: 'Read company knowledge, procedures, skills, and systems.' },
      { key: 'resources.manage', label: 'Manage resources', description: 'Publish and change governed resources.' },
    ],
  },
  {
    key: 'administration',
    label: 'Administration',
    permissions: [
      { key: 'settings.read', label: 'View settings', description: 'Read company configuration and connection status.' },
      { key: 'settings.manage', label: 'Manage settings', description: 'Change providers, channels, autonomy, storage, and company configuration.' },
      { key: 'access.manage', label: 'Manage access', description: 'Create roles and control member permissions.' },
    ],
  },
] as const satisfies readonly PermissionGroup[]

export const PERMISSION_CATALOGUE = PERMISSION_GROUPS.flatMap((group) =>
  group.permissions.map((permission) => permission.key),
)

export type TenantPermission = (typeof PERMISSION_CATALOGUE)[number]

