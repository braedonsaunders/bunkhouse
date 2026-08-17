/**
 * Exhaustive request-boundary classification. The matching test discovers
 * server-action and route modules from disk, so adding a new endpoint without
 * adding it here fails the ordinary test command.
 */

export type ServerActionModule =
  | 'app/admin/settings/actions.ts'
  | 'app/admin/settings/avatar-part-actions.ts'
  | 'app/admin/settings/chat-actions.ts'
  | 'app/admin/settings/company-actions.ts'
  | 'app/admin/settings/filing-actions.ts'
  | 'app/admin/settings/pbx-actions.ts'
  | 'app/admin/settings/template-actions.ts'
  | 'app/admin/settings/voice-actions.ts'
  | 'app/approvals/actions.ts'
  | 'app/call/actions.ts'
  | 'app/chat/actions.ts'
  | 'app/mail/actions.ts'
  | 'app/meet/actions.ts'
  | 'app/organization/actions.ts'
  | 'app/organization/avatar-actions.ts'
  | 'app/organization/department-actions.ts'
  | 'app/organization/voice-preview-actions.ts'
  | 'app/resources/actions.ts'
  | 'app/resources/procedure-actions.ts'
  | 'app/resources/skill-actions.ts'
  | 'app/resources/system-actions.ts'
  | 'app/roles/actions.ts'
  | 'app/runs/run-actions.ts'
  | 'app/superadmin/actions.ts'
  | 'app/tenant-actions.ts'

export type RouteModule =
  | 'app/api/auth/[...all]/route.ts'
  | 'app/api/avatar-parts/[partId]/route.ts'
  | 'app/api/chat/[threadId]/route.ts'
  | 'app/api/chat/slack/route.ts'
  | 'app/api/chat/teams/route.ts'
  | 'app/api/desk/[personId]/frame/route.ts'
  | 'app/api/desk/[personId]/frames/route.ts'
  | 'app/api/desk/[personId]/video/route.ts'
  | 'app/api/files/[fileId]/route.ts'
  | 'app/api/filing-oauth/callback/route.ts'
  | 'app/api/filing-oauth/start/route.ts'
  | 'app/api/iam/route.ts'
  | 'app/api/mail-oauth/callback/route.ts'
  | 'app/api/mail-oauth/start/route.ts'
  | 'app/api/mcp-oauth/callback/route.ts'

export type AuthorizationBoundary =
  | 'tenant_session'
  | 'superadmin_session'
  | 'signed_webhook'
  | 'capability_token'
  | 'auth_provider'

export const SERVER_ACTION_AUTHORIZATION = {
  'app/admin/settings/actions.ts': 'tenant_session',
  'app/admin/settings/avatar-part-actions.ts': 'tenant_session',
  'app/admin/settings/chat-actions.ts': 'tenant_session',
  'app/admin/settings/company-actions.ts': 'tenant_session',
  'app/admin/settings/filing-actions.ts': 'tenant_session',
  'app/admin/settings/pbx-actions.ts': 'tenant_session',
  'app/admin/settings/template-actions.ts': 'tenant_session',
  'app/admin/settings/voice-actions.ts': 'tenant_session',
  'app/approvals/actions.ts': 'tenant_session',
  'app/call/actions.ts': 'tenant_session',
  'app/chat/actions.ts': 'tenant_session',
  'app/mail/actions.ts': 'tenant_session',
  'app/meet/actions.ts': 'capability_token',
  'app/organization/actions.ts': 'tenant_session',
  'app/organization/avatar-actions.ts': 'tenant_session',
  'app/organization/department-actions.ts': 'tenant_session',
  'app/organization/voice-preview-actions.ts': 'tenant_session',
  'app/resources/actions.ts': 'tenant_session',
  'app/resources/procedure-actions.ts': 'tenant_session',
  'app/resources/skill-actions.ts': 'tenant_session',
  'app/resources/system-actions.ts': 'tenant_session',
  'app/roles/actions.ts': 'tenant_session',
  'app/runs/run-actions.ts': 'tenant_session',
  'app/superadmin/actions.ts': 'superadmin_session',
  'app/tenant-actions.ts': 'tenant_session',
} as const satisfies Record<ServerActionModule, AuthorizationBoundary>

export const ROUTE_AUTHORIZATION = {
  'app/api/auth/[...all]/route.ts': 'auth_provider',
  'app/api/avatar-parts/[partId]/route.ts': 'tenant_session',
  'app/api/chat/[threadId]/route.ts': 'tenant_session',
  'app/api/chat/slack/route.ts': 'signed_webhook',
  'app/api/chat/teams/route.ts': 'signed_webhook',
  'app/api/desk/[personId]/frame/route.ts': 'tenant_session',
  'app/api/desk/[personId]/frames/route.ts': 'tenant_session',
  'app/api/desk/[personId]/video/route.ts': 'tenant_session',
  'app/api/files/[fileId]/route.ts': 'tenant_session',
  'app/api/filing-oauth/callback/route.ts': 'capability_token',
  'app/api/filing-oauth/start/route.ts': 'tenant_session',
  'app/api/iam/route.ts': 'tenant_session',
  'app/api/mail-oauth/callback/route.ts': 'capability_token',
  'app/api/mail-oauth/start/route.ts': 'tenant_session',
  'app/api/mcp-oauth/callback/route.ts': 'capability_token',
} as const satisfies Record<RouteModule, AuthorizationBoundary>
