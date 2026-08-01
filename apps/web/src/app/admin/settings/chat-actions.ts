'use server'

import { revalidatePath } from 'next/cache'
import {
  removeChatChannelRoute,
  removeSlackConnection,
  removeTeamsInbound,
  removeTeamsWebhook,
  saveChatChannelRoute,
  saveSlackConnection,
  saveTeamsInbound,
  saveTeamsWebhook,
  testSlackConnection,
  testTeamsWebhook,
} from '../../../lib/chat-bridge'
import { resolveTenantId as resolveTenant } from '../../../lib/tenant'
const resolveTenantId = () => resolveTenant('settings.manage')

// --- Slack --------------------------------------------------------------

export async function saveSlackConnectionAction(input: {
  botToken: string
  signingSecret: string
}): Promise<{ ok: true; teamName: string } | { ok: false; message: string }> {
  const tenantId = await resolveTenantId()
  const result = await saveSlackConnection({ tenantId, ...input })
  if (result.ok) revalidatePath('/admin/settings')
  return result
}

export async function removeSlackConnectionAction(): Promise<void> {
  const tenantId = await resolveTenantId()
  await removeSlackConnection(tenantId)
  revalidatePath('/admin/settings')
}

export async function testSlackConnectionAction(): Promise<
  { ok: true; teamName: string } | { ok: false; message: string }
> {
  const tenantId = await resolveTenantId()
  return testSlackConnection(tenantId)
}

// --- Microsoft Teams — outbound (Incoming Webhook) -----------------------

export async function saveTeamsWebhookAction(input: {
  webhookUrl: string
}): Promise<{ ok: true } | { ok: false; message: string }> {
  const tenantId = await resolveTenantId()
  const result = await saveTeamsWebhook({ tenantId, ...input })
  if (result.ok) revalidatePath('/admin/settings')
  return result
}

export async function removeTeamsWebhookAction(): Promise<void> {
  const tenantId = await resolveTenantId()
  await removeTeamsWebhook(tenantId)
  revalidatePath('/admin/settings')
}

export async function testTeamsWebhookAction(): Promise<{ ok: true } | { ok: false; message: string }> {
  const tenantId = await resolveTenantId()
  return testTeamsWebhook(tenantId)
}

// --- Microsoft Teams — optional inbound (Outgoing Webhook) ---------------

export async function saveTeamsInboundAction(input: {
  securityToken: string
  msTenantId?: string
  appId?: string
}): Promise<{ ok: true } | { ok: false; message: string }> {
  const tenantId = await resolveTenantId()
  const result = await saveTeamsInbound({ tenantId, ...input })
  if (result.ok) revalidatePath('/admin/settings')
  return result
}

export async function removeTeamsInboundAction(): Promise<void> {
  const tenantId = await resolveTenantId()
  await removeTeamsInbound(tenantId)
  revalidatePath('/admin/settings')
}

// --- Channel → agent routing ----------------------------------------------

export async function saveChatChannelRouteAction(input: {
  provider: 'slack' | 'teams'
  channelId: string
  channelLabel?: string
  personId: string
}): Promise<{ ok: true } | { ok: false; message: string }> {
  const tenantId = await resolveTenantId()
  const result = await saveChatChannelRoute({ tenantId, ...input })
  if (result.ok) revalidatePath('/admin/settings')
  return result
}

export async function removeChatChannelRouteAction(routeId: string): Promise<void> {
  const tenantId = await resolveTenantId()
  await removeChatChannelRoute(tenantId, routeId)
  revalidatePath('/admin/settings')
}
