import { redirect } from 'next/navigation'
import { and, asc, eq, sql } from 'drizzle-orm'
import { AI_PROVIDER_SPECS } from '@appkit/ai'
import { autonomySettings, mailboxAccounts, people } from '../../../db/schema'
import { db } from '../../../db/client'
import { SettingsView } from '../../../components/settings-view'
import type { AgentDial } from '../../../components/autonomy-settings'
import { ACTION_CATEGORIES, DEFAULT_AUTONOMY_LEVEL } from '../../../lib/autonomy'
import { listAiProviders } from '../../../lib/ai'
import { getVoiceProviders } from '../../../lib/voice'
import { listPhoneNumbers, listSipTrunks, sipIngressAddress } from '../../../lib/pbx'
import { listPrices, unpricedModelsInUse } from '../../../lib/pricing'
import { billingKeyStatus, listReconciliations } from '../../../lib/cost-reconciliation'
import { getImageProviderSetting, listAvatarPartRows, loadAvatarPartLibrary } from '../../../lib/avatars'
import { getResearchSettings } from '../../../lib/research'
import { getDocumentBranding } from '../../../lib/documents'
import { getCompanyIdentity } from '../../../lib/company-identity'
import { getSmsSettings } from '../../../lib/sms'
import { getWorkspacePolicy, workspaceRuntimeView } from '../../../lib/workspace'
import { chatWebhookUrls, listChatChannelRoutes, listChatConnections } from '../../../lib/chat-bridge'
import { getVoiceRetention } from '../../../lib/voice-recording'
import { getVoicePricing } from '../../../lib/voice-pricing'
import { listDocumentTemplates } from '../../../lib/document-templates'
import { getFilingSettingsView, listRecentFilings } from '../../../lib/filing'
import { listMailOauthApps, mailOauthRedirectUri } from '../../../lib/mail-oauth'
import { getMailSignature } from '../../../lib/mail-signature'
import { AVATAR_PART_CATEGORIES, avatarPartCategory } from '../../../lib/avatar-parts'
import { IMAGE_MODELS } from '@appkit/avatars'
import { runHealthChecks } from '../../../lib/health'
import { getTenantAccess } from '../../../lib/tenant'
import { listDepartments, wanderingEnabled } from '../../../lib/departments'
import { SCENE_KINDS, SCENE_LABELS } from '../../../components/scene-kinds'
import {  } from '../../../lib/auth'

export const dynamic = 'force-dynamic'

const fmt = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 16).replace('T', ' ') : '')

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ section?: string }>
}) {
  const { section } = await searchParams
  // Connected systems moved to Resources; a bookmarked deep link follows them
  // there rather than landing on a section that no longer exists.
  if (section === 'integrations') redirect('/resources?tab=systems')
  const access = await getTenantAccess()
  if (!access.user.isSuperAdmin && !access.permissions.has('settings.read')) {
    throw new Error('Missing permission: settings.read')
  }
  const tenantId = access.tenantId
  const app = db()
  const [providers, prices, imageSetting, voiceProviders, trunks, agentExtensions, mailboxData, agentDials, partRows, partLibrary] = await Promise.all([
    listAiProviders(tenantId),
    listPrices(tenantId),
    getImageProviderSetting(tenantId),
    getVoiceProviders(tenantId),
    listSipTrunks(tenantId),
    app.withTenantContext(tenantId, () =>
      app.db
        .select({ id: people.id, name: people.name, title: people.title, extension: people.extension })
        .from(people)
        .where(and(eq(people.kind, 'agent'), sql`${people.extension} is not null`))
        .orderBy(asc(people.extension)),
    ),
    app.withTenantContext(tenantId, async () => {
      const boxes = await app.db
        .select({
          id: mailboxAccounts.id,
          personId: mailboxAccounts.personId,
          address: mailboxAccounts.address,
          status: mailboxAccounts.status,
          lastSyncAt: mailboxAccounts.lastSyncAt,
          lastError: mailboxAccounts.lastError,
          personName: people.name,
        })
        .from(mailboxAccounts)
        .innerJoin(people, eq(people.id, mailboxAccounts.personId))
      const unconnected = await app.db
        .select({ id: people.id, name: people.name, title: people.title })
        .from(people)
        .where(
          and(
            eq(people.kind, 'agent'),
            sql`not exists (select 1 from mailbox_accounts ma where ma.person_id = ${people.id})`,
          ),
        )
      return { boxes, unconnected }
    }),
    app.withTenantContext(tenantId, async (): Promise<AgentDial[]> => {
      const agents = await app.db
        .select({ id: people.id, name: people.name, title: people.title, status: people.status })
        .from(people)
        .where(eq(people.kind, 'agent'))
        .orderBy(asc(people.name))
      const dial = await app.db.select().from(autonomySettings)
      return agents.map((agent) => ({
        personId: agent.id,
        name: agent.name,
        title: agent.title,
        status: agent.status,
        levels: Object.fromEntries(
          ACTION_CATEGORIES.map((category) => [
            category,
            dial.find((d) => d.personId === agent.id && d.category === category)?.level ?? DEFAULT_AUTONOMY_LEVEL,
          ]),
        ) as AgentDial['levels'],
      }))
    }),
    listAvatarPartRows(tenantId),
    loadAvatarPartLibrary(tenantId),
  ])
  const research = await getResearchSettings(tenantId)
  const branding = await getDocumentBranding(tenantId)
  const identity = await getCompanyIdentity(tenantId)
  const workspacePolicy = await getWorkspacePolicy(tenantId)
  const workspaceRuntime = await workspaceRuntimeView(tenantId)
  const [voiceRetention, voicePricing, templates, filingSettings, filingActivity] = await Promise.all([
    getVoiceRetention(tenantId),
    getVoicePricing(tenantId),
    listDocumentTemplates(tenantId),
    getFilingSettingsView(tenantId),
    listRecentFilings(tenantId),
  ])
  const [chatConnections, chatRoutes] = await Promise.all([
    listChatConnections(tenantId),
    listChatChannelRoutes(tenantId),
  ])
  const [unpricedModels, billingKeys, reconciliations] = await Promise.all([
    unpricedModelsInUse(tenantId),
    billingKeyStatus(tenantId),
    listReconciliations(tenantId),
  ])
  const smsSettings = await getSmsSettings(tenantId)
  const phoneNumberRows = await listPhoneNumbers(tenantId)
  const activeAgents = await app.withTenantContext(tenantId, () =>
    app.db
      .select({ id: people.id, name: people.name, title: people.title })
      .from(people)
      .where(and(eq(people.kind, 'agent'), eq(people.status, 'active')))
      .orderBy(asc(people.name)),
  )
  const mailOauthApps = await listMailOauthApps(tenantId)
  const mailSignature = await getMailSignature(tenantId)
  // Who thinks on which provider, so Settings → Models can show what a removal
  // would cost before an operator makes one.
  const modelAssignments = await app.withTenantContext(tenantId, () =>
    app.db
      .select({ id: people.id, name: people.name, modelConfig: people.modelConfig })
      .from(people)
      .where(and(eq(people.kind, 'agent'), sql`${people.modelConfig} is not null`))
      .orderBy(asc(people.name)),
  )

  // The company's places, for the Departments section under Company.
  const [departmentList, staffRows, wander] = await Promise.all([
    listDepartments(tenantId),
    app.withTenantContext(tenantId, () =>
      app.db.select({ departmentId: people.departmentId }).from(people).where(eq(people.status, 'active')),
    ),
    wanderingEnabled(tenantId),
  ])
  const counts = new Map<string, number>()
  for (const row of staffRows) {
    if (!row.departmentId) continue
    counts.set(row.departmentId, (counts.get(row.departmentId) ?? 0) + 1)
  }
  const health = await runHealthChecks(tenantId)
  const deskless = staffRows.filter((row) => !row.departmentId).length
  const departmentRows = departmentList.map((department) => ({
    id: department.id,
    name: department.name,
    sceneKind: department.sceneKind,
    backdropSvg: department.backdropSvg,
    backdropSvgLight: department.backdropSvgLight,
    backdropPrompt: department.backdropPrompt,
    headcount: counts.get(department.id) ?? 0,
  }))
  const sceneKinds = SCENE_KINDS.map((kind) => ({ value: kind, label: SCENE_LABELS[kind] }))

  return (
    <SettingsView
      health={health}
      departments={departmentRows}
      deskless={deskless}
      wander={wander}
      sceneKinds={sceneKinds}
      providers={providers.map((p) => ({
        slug: p.slug,
        label: p.label,
        provider: p.provider,
        ...(p.modelSmart ? { modelSmart: p.modelSmart } : {}),
        ...(p.modelFast ? { modelFast: p.modelFast } : {}),
        ...(p.baseUrl ? { baseUrl: p.baseUrl } : {}),
      }))}
      providerAssignments={modelAssignments.flatMap((agent) =>
        agent.modelConfig
          ? [
              {
                personId: agent.id,
                personName: agent.name,
                providerSlug: agent.modelConfig.provider,
                model: agent.modelConfig.model,
              },
            ]
          : [],
      )}
      kinds={AI_PROVIDER_SPECS.map((spec) => ({
        value: spec.value,
        label: spec.label,
        needsBaseUrl: spec.kind === 'openai-compatible' && !spec.baseUrl,
      }))}
      prices={prices.map((p) => ({
        id: p.id,
        model: p.model,
        inputUsdPerMtok: `$${Number(p.inputUsdPerMtok).toFixed(2)}`,
        outputUsdPerMtok: `$${Number(p.outputUsdPerMtok).toFixed(2)}`,
        inputUsd: Number(p.inputUsdPerMtok),
        outputUsd: Number(p.outputUsdPerMtok),
        source: p.source,
        ...(p.sourceRef ? { sourceRef: p.sourceRef } : {}),
        effectiveAt: fmt(p.effectiveAt),
      }))}
      unpricedModels={unpricedModels}
      billing={{
        connected: billingKeys,
        rows: reconciliations.map((row) => ({
          id: row.id,
          provider: row.provider,
          day: row.day,
          model: row.model,
          reportedUsd: row.reportedUsd,
          ledgerUsd: row.ledgerUsd,
          driftUsd: row.driftUsd,
          fetchedAt: fmt(row.fetchedAt),
        })),
      }}
      mailboxes={mailboxData.boxes.map((b) => ({
        id: b.id,
        personId: b.personId,
        personName: b.personName,
        address: b.address,
        status: b.status,
        lastSyncAt: fmt(b.lastSyncAt),
        lastError: b.lastError ?? '',
      }))}
      agentsWithoutMailbox={mailboxData.unconnected}
      mailOauthApps={mailOauthApps}
      mailOauthRedirectUri={await mailOauthRedirectUri()}
      mailSignature={{
        enabled: mailSignature.enabled,
        sourceHtml: mailSignature.sourceHtml,
        accentColor: mailSignature.accentColor ?? '',
      }}
      imageSetting={imageSetting}
      imageFallbackModels={IMAGE_MODELS}
      voiceProviders={{ deepgram: Boolean(voiceProviders.deepgram), elevenlabs: Boolean(voiceProviders.elevenlabs) }}
      research={research}
      documents={{
        companyName: branding.companyName ?? '',
        accentColor: branding.accentColor ?? '',
        footerText: branding.footerText ?? '',
      }}
      companyIdentity={{
        name: identity.name,
        legalName: identity.legalName,
        tagline: identity.tagline,
        websiteUrl: identity.websiteUrl,
        industry: identity.industry,
        description: identity.description,
        services: identity.services,
        serviceArea: identity.serviceArea,
        customers: identity.customers,
        differentiators: identity.differentiators,
        values: identity.values,
        brandVoice: identity.brandVoice,
        hours: identity.hours,
        contact: identity.contact,
        socialLinks: identity.socialLinks,
        notes: identity.notes,
        ...(identity.capture ? { capture: identity.capture } : {}),
      }}
      workspace={{
        retentionDays: workspacePolicy.retentionDays,
        shell: workspacePolicy.shell,
        runtime: workspaceRuntime.runtime,
        sessions: workspaceRuntime.sessions,
      }}
      callCosts={{
        recordingDays: voiceRetention.recordingDays,
        deepgramUsdPerMinute: voicePricing.deepgramUsdPerMinute ?? null,
        elevenLabsUsdPerMinute: voicePricing.elevenLabsUsdPerMinute ?? null,
        realtimeUsdPerMinute: voicePricing.realtimeUsdPerMinute ?? null,
        measuredDeepgram: voicePricing.measured?.deepgram ?? null,
      }}
      templates={templates.map((t) => ({
        id: t.id,
        slug: t.slug,
        name: t.name,
        description: t.description,
        kind: t.kind,
        defaultFormat: t.defaultFormat,
        status: t.status,
        body: t.body,
        mergeFields: t.mergeFields,
        produces: t.kind === 'spreadsheet' ? '.xlsx' : `.${t.defaultFormat}`,
        fieldCount: t.mergeFields.length,
        updatedAt: t.updatedAt.toISOString().slice(0, 16).replace('T', ' '),
      }))}
      filing={{
        settings: filingSettings,
        activity: filingActivity.map((entry) => ({
          id: entry.id,
          fileId: entry.fileId,
          file: entry.filename ?? 'A file no longer in the record',
          status: entry.status,
          destination:
            entry.provider === 'google_drive'
              ? 'Google Drive'
              : entry.provider === 'onedrive'
                ? 'OneDrive / SharePoint'
                : 'Server folder',
          detail:
            entry.status === 'filed'
              ? (entry.location ?? 'Filed')
              : (entry.reason ?? 'The copy did not land.'),
          when: entry.createdAt.toISOString().slice(0, 16).replace('T', ' '),
        })),
      }}
      chat={{
        connections: chatConnections,
        routes: chatRoutes,
        agents: activeAgents,
        webhookUrls: await chatWebhookUrls(),
      }}
      sms={{ provider: smsSettings.provider, fromNumber: smsSettings.fromNumber }}
      phoneSystem={{
        trunks: trunks.map((t) => ({
          id: t.id,
          name: t.name,
          flavor: t.flavor,
          pbxHost: t.pbxHost ?? '',
          pbxPort: t.pbxPort,
          transport: t.transport,
          authUsername: t.authUsername ?? '',
          hasPassword: t.sealedAuthPassword !== null,
          extensionRange: t.extensionRange ?? '',
          status: t.status,
          lastError: t.lastError ?? '',
        })),
        extensions: agentExtensions.map((h) => ({
          personId: h.id,
          name: h.name,
          title: h.title,
          extension: h.extension ?? '',
        })),
        numbers: phoneNumberRows.map((n) => ({
          id: n.id,
          number: n.number,
          label: n.label,
          personName: n.personName,
          provider: n.provider,
        })),
        agents: activeAgents,
        ingress: sipIngressAddress(),
      }}
      agentDials={agentDials}
      initialSection={section ?? 'identity'}
      avatarParts={partRows.map((part) => ({
        id: part.id,
        categoryId: part.categoryId,
        categoryLabel: avatarPartCategory(part.categoryId)?.label ?? part.categoryId,
        name: part.name,
        colorVariant: part.colorVariant ?? '',
        tags: part.tags,
        model: part.model,
        prompt: part.prompt ?? '',
        createdAt: fmt(part.createdAt),
      }))}
      avatarPartCategories={AVATAR_PART_CATEGORIES}
      avatarPartLibrary={partLibrary}
      accessScopes={{
        departments: departmentList.map((department) => ({ value: department.id, label: department.name })),
        people: activeAgents.map((person) => ({ value: person.id, label: person.name })),
      }}
      canManageAccess={access.user.isSuperAdmin || access.permissions.has('access.manage')}
    />
  )
}
