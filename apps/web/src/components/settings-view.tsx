'use client'

import * as React from 'react'
import Link from 'next/link'
import {
  Activity, DoorOpen, Boxes, Brain, Building2, FileText, FolderCog, Globe, ImageIcon, Mail, MessageSquare,
  MessagesSquare, Phone, Shield, UserRoundCog } from 'lucide-react'
import {
  Badge,
  Button,
  Drawer,
  EmptyState,
  Input,
  Label,
  PagedTable,
  SettingsRow,
  SettingsSection,
  SettingsShell,
  SubtabNav,
  type LinkRender,
  type PagedColumn,
  type SettingsNavGroup,
} from '@appkit/ui'
import { removeSpeechProviderAction, setSpeechProviderKeyAction } from '../app/admin/settings/actions'
import type { AvatarPart, AvatarPartCategory } from '@appkit/avatars/composition'
import { AvatarPartsView, type AvatarPartRowView } from './avatar-parts-view'
import { type ProviderKindOption } from './add-provider-form'
import {
  ModelSettings,
  type BillingView,
  type PriceRow,
  type ProviderAssignment,
  type ProviderSummary,
} from './model-settings'
import { ImageProviderForm } from './image-provider-form'
import { HealthSettings } from './health-settings'
import type { HealthCheck } from '../lib/health'
import { AutonomySettings, type AgentDial } from './autonomy-settings'
import { CompanyIdentitySettings, type CompanyIdentityView, type IdentityProviderOption } from './company-identity-settings'
import { DepartmentsSettings, type DepartmentRow } from './departments-settings'
import { PhoneSystemRow, type AgentExtensionRow, type AgentOption, type PhoneNumberRowView, type SipTrunkSummary } from './phone-system'
import { MailOauthApps, type MailOauthAppView } from './mail-oauth-apps'
import { MailSignatureSettings, type MailSignatureView } from './mail-signature-settings'
import { DocumentsSection, ResearchSection, SmsSection, WorkspaceSection, type DocumentBrandingView, type SmsSettingsView, type WorkspacePolicyView } from './capability-settings'
import { VoiceCostSettings, type VoiceCostSettingsView } from './voice-cost-settings'
import { DocumentTemplatesView, type TemplateRowView } from './document-templates-view'
import { FilingSection, type FilingActivityRow, type FilingSettingsView } from './filing-settings'
import { ChatSettingsSection, type ChatAgentOption, type ChatChannelRouteRowView, type ChatConnectionsView } from './chat-settings'
import { AccessSettings } from './access-settings'
import type { ScopeOptions } from '@appkit/iam'

const nextLink: LinkRender = ({ href, children, className, title }) => (
  <Link href={href} className={className} title={title}>
    {children}
  </Link>
)

export type { PriceRow, ProviderAssignment, ProviderSummary }

export type MailboxRow = {
  id: string
  personId: string
  personName: string
  address: string
  status: string
  lastSyncAt?: string
  lastError?: string
}

export type AgentWithoutMailbox = { id: string; name: string; title: string }

/**
 * Every agent's mail standing in one table — connected or not. An agent
 * without an address is a row with nothing behind it, not a second list under
 * the table, so the page never stacks two lists on top of each other.
 */
type MailRow = {
  id: string
  personId: string
  personName: string
  address: string
  status: string
  connected: boolean
  title?: string
  lastSyncAt?: string
  lastError?: string
}

export type VoiceProviderState = { deepgram: boolean; elevenlabs: boolean }

const SPEECH_PROVIDERS: {
  provider: 'deepgram' | 'elevenlabs'
  label: string
  stage: string
  line: string
  consoleUrl: string
  consoleLabel: string
}[] = [
  {
    provider: 'deepgram',
    label: 'Deepgram',
    stage: 'Hearing',
    line: 'Transcribes what callers say, live.',
    consoleUrl: 'https://console.deepgram.com/',
    consoleLabel: 'console.deepgram.com',
  },
  {
    provider: 'elevenlabs',
    label: 'ElevenLabs',
    stage: 'Speaking',
    line: "Gives each agent its voice — picked from your account's catalog on the agent's Voice tab.",
    consoleUrl: 'https://elevenlabs.io/app/settings/api-keys',
    consoleLabel: 'elevenlabs.io',
  },
]

/**
 * The settings sidebar, grouped the way an operator thinks about the company:
 * who we are, how far agents are trusted, what powers them, how they are
 * reached, and where their work lands. Sections that belong together share one
 * page and split across subtabs rather than stacking lists on top of each other.
 */
const NAV: SettingsNavGroup[] = [
  {
    label: 'Operations',
    items: [{ key: 'health', label: 'Health', icon: <Activity /> }],
  },
  {
    label: 'Company',
    items: [
      { key: 'identity', label: 'Identity', icon: <Building2 /> },
      { key: 'documents', label: 'Documents', icon: <FileText /> },
      { key: 'avatar-parts', label: 'Avatars', icon: <Boxes /> },
      { key: 'departments', label: 'Departments', icon: <DoorOpen /> },
    ],
  },
  {
    label: 'Trust',
    items: [
      { key: 'autonomy', label: 'Autonomy', icon: <Shield /> },
      { key: 'access', label: 'Access', icon: <UserRoundCog /> },
    ],
  },
  {
    label: 'Intelligence',
    items: [
      { key: 'ai', label: 'Models', icon: <Brain /> },
      { key: 'images', label: 'Image generation', icon: <ImageIcon /> },
      { key: 'research', label: 'Research', icon: <Globe /> },
    ],
  },
  {
    label: 'Channels',
    items: [
      { key: 'mail', label: 'Mail', icon: <Mail /> },
      { key: 'voice', label: 'Voice & phone', icon: <Phone /> },
      { key: 'sms', label: 'Text messaging', icon: <MessageSquare /> },
      { key: 'chat', label: 'Chat bridge', icon: <MessagesSquare /> },
    ],
  },
  {
    label: 'Systems',
    items: [{ key: 'workspace', label: 'Workspace', icon: <FolderCog /> }],
  },
]

const SECTION_KEYS = new Set(NAV.flatMap((group) => group.items.map((item) => item.key)))

/**
 * Sections that used to have their own sidebar entry now live as a subtab of
 * the page they belong to. Old `?section=` links keep working and land on the
 * right tab — a deep link an operator bookmarked never dead-ends.
 */
const SECTION_ALIASES: Record<string, { section: string; tab: string }> = {
  pricing: { section: 'ai', tab: 'pricing' },
  mailboxes: { section: 'mail', tab: 'mailboxes' },
  templates: { section: 'documents', tab: 'templates' },
  filing: { section: 'documents', tab: 'filing' },
  callcosts: { section: 'voice', tab: 'costs' },
}

function resolveSection(requested: string): { section: string; tab: string | null } {
  const alias = SECTION_ALIASES[requested]
  if (alias) return { section: alias.section, tab: alias.tab }
  if (SECTION_KEYS.has(requested)) return { section: requested, tab: null }
  return { section: 'identity', tab: null }
}

const MAILBOX_COLUMNS: PagedColumn<MailRow>[] = [
  {
    key: 'personName',
    header: 'Agent',
    cell: (row) => (
      <span className="min-w-0">
        <span className="block truncate font-medium text-primary">{row.personName}</span>
        {row.title ? <span className="block truncate text-xs text-fg-muted">{row.title}</span> : null}
      </span>
    ),
    search: (row) => row.personName,
    sortValue: (row) => row.personName,
  },
  {
    key: 'address',
    header: 'Address',
    cell: (row) => (row.connected ? row.address : <span className="text-fg-muted">—</span>),
    search: (row) => row.address,
    sortValue: (row) => row.address,
  },
  {
    key: 'status',
    header: 'Status',
    cell: (row) => (
      <Badge variant={row.status === 'active' ? 'default' : row.status === 'error' ? 'destructive' : 'outline'}>
        {row.status}
      </Badge>
    ),
    search: (row) => row.status,
    sortValue: (row) => row.status,
  },
  {
    key: 'lastSyncAt',
    header: 'Last sync',
    cell: (row) => (row.connected ? row.lastSyncAt || 'never' : '—'),
    sortValue: (row) => row.lastSyncAt ?? '',
  },
  {
    key: 'lastError',
    header: 'Last error',
    cell: (row) => (row.lastError ? <span className="text-danger">{row.lastError}</span> : '—'),
    search: (row) => row.lastError ?? '',
  },
]

export function SettingsView({
  health,
  providers,
  providerAssignments,
  kinds,
  prices,
  unpricedModels,
  billing,
  mailboxes,
  agentsWithoutMailbox,
  mailOauthApps,
  mailOauthRedirectUri,
  mailSignature,
  imageSetting,
  imageFallbackModels,
  voiceProviders,
  research,
  documents,
  companyIdentity,
  departments,
  deskless,
  wander,
  sceneKinds,
  workspace,
  chat,
  callCosts,
  templates,
  filing,
  sms,
  phoneSystem,
  agentDials,
  initialSection,
  avatarParts,
  avatarPartCategories,
  avatarPartLibrary,
  accessScopes,
}: {
  providers: ProviderSummary[]
  /** Which agent works on which provider, so removing one shows its cost. */
  providerAssignments: ProviderAssignment[]
  kinds: ProviderKindOption[]
  prices: PriceRow[]
  /** Models agents can spend on that no price row covers. */
  unpricedModels: string[]
  /** What the providers say they charged, against what the ledger counted. */
  billing: BillingView
  mailboxes: MailboxRow[]
  agentsWithoutMailbox: AgentWithoutMailbox[]
  /** The company's Google Workspace / Microsoft 365 applications, secrets withheld. */
  mailOauthApps: MailOauthAppView[]
  /** The one address both providers call back to; operators copy it into their console. */
  mailOauthRedirectUri: string
  /** The company signature appended to every agent's outbound mail. */
  mailSignature: MailSignatureView
  imageSetting: { providerSlug: string; model: string } | null
  /** Static catalog offered only when the live provider model list fails. */
  imageFallbackModels: { id: string; name: string; provider: string }[]
  voiceProviders: VoiceProviderState
  research: { provider: string | null }
  documents: DocumentBrandingView
  /** Who the company is — the profile every agent works from. */
  companyIdentity: CompanyIdentityView
  /** What is broken right now, worst first. */
  health: HealthCheck[]
  /** The company's places, and who has a desk in them. */
  departments: DepartmentRow[]
  deskless: number
  wander: boolean
  sceneKinds: { value: string; label: string }[]
  workspace: WorkspacePolicyView
  callCosts: VoiceCostSettingsView
  templates: TemplateRowView[]
  filing: { settings: FilingSettingsView; activity: FilingActivityRow[] }
  chat: {
    connections: ChatConnectionsView
    routes: ChatChannelRouteRowView[]
    agents: ChatAgentOption[]
    webhookUrls: { slack: string; teams: string }
  }
  sms: SmsSettingsView
  phoneSystem: {
    trunks: SipTrunkSummary[]
    extensions: AgentExtensionRow[]
    numbers: PhoneNumberRowView[]
    agents: AgentOption[]
    ingress: { host: string; port: number } | null
  }
  agentDials: AgentDial[]
  /** Which section to open on arrival — links elsewhere in the app deep-link here. */
  initialSection: string
  avatarParts: AvatarPartRowView[]
  avatarPartCategories: AvatarPartCategory[]
  /** The same parts shaped for the composer and the previews. */
  avatarPartLibrary: AvatarPart[]
  accessScopes: ScopeOptions
}) {
  const arrival = React.useMemo(() => resolveSection(initialSection), [initialSection])
  const [active, setActive] = React.useState(arrival.section)
  const [documentTab, setDocumentTab] = React.useState(arrival.tab ?? 'letterhead')
  const [mailTab, setMailTab] = React.useState(arrival.tab ?? 'mailboxes')
  const [voiceTab, setVoiceTab] = React.useState(arrival.tab ?? 'pipeline')
  const [busy, startBusy] = React.useTransition()
  const [mailboxDrawer, setMailboxDrawer] = React.useState<MailRow | null>(null)
  const [voiceDrawer, setVoiceDrawer] = React.useState<'deepgram' | 'elevenlabs' | null>(null)
  const [imageDrawer, setImageDrawer] = React.useState(false)
  const [voiceKey, setVoiceKey] = React.useState('')
  const [voiceError, setVoiceError] = React.useState<string | null>(null)
  const imageCapable = providers.filter((p) => ['openai', 'google'].includes(p.provider))
  const identityProviders: IdentityProviderOption[] = providers.map((provider) => ({
    slug: provider.slug,
    label: `${provider.label} · ${provider.slug}`,
  }))
  const mailRows: MailRow[] = [
    ...mailboxes.map((box) => ({ ...box, connected: true })),
    ...agentsWithoutMailbox.map((agent) => ({
      id: `unconnected:${agent.id}`,
      personId: agent.id,
      personName: agent.name,
      title: agent.title,
      address: '',
      status: 'not connected',
      connected: false,
    })),
  ]

  return (
    <SettingsShell
      title="Settings"
      description="Company-level configuration: who your agents work for, how far they are trusted, and what powers them."
      nav={NAV}
      activeKey={active}
      onSelect={setActive}
      linkRender={nextLink}
    >
      {active === 'health' ? <HealthSettings checks={health} /> : null}

      {active === 'identity' ? (
        <CompanyIdentitySettings identity={companyIdentity} providers={identityProviders} />
      ) : null}

      {active === 'autonomy' ? (
        <SettingsSection
          title="Autonomy"
          description="How far each agent can go on its own, per action category. Onboarding sets the day-one dial from the role; this is where you raise or lower trust as an agent earns it. Changes apply to new work only."
        >
          <AutonomySettings agents={agentDials} linkRender={nextLink} />
        </SettingsSection>
      ) : null}

      {active === 'access' ? <AccessSettings scopeOptions={accessScopes} /> : null}

      {active === 'ai' ? (
        <ModelSettings
          providers={providers}
          kinds={kinds}
          prices={prices}
          unpricedModels={unpricedModels}
          billing={billing}
          assignments={providerAssignments}
          initialTab={arrival.tab ?? 'providers'}
        />
      ) : null}

      {active === 'mail' ? (
        <div className="space-y-4">
          <SubtabNav
            ariaLabel="Mail"
            active={mailTab}
            onSelect={setMailTab}
            tabs={[
              { key: 'mailboxes', label: 'Mailboxes', count: mailboxes.length },
              { key: 'signature', label: 'Signature' },
              { key: 'applications', label: 'Sign-in applications' },
            ]}
          />

          {mailTab === 'mailboxes' ? (
            <SettingsSection
              title="Mailboxes"
              description="Every agent's mail standing: the address it works from, sync health, and errors. An agent with no address cannot receive work — open its row to connect one."
            >
              <SettingsRow
                title="Agent mail"
                description={
                  agentsWithoutMailbox.length > 0
                    ? `${agentsWithoutMailbox.length} agent${agentsWithoutMailbox.length === 1 ? '' : 's'} still without an address.`
                    : 'Every agent on the roster has an address connected.'
                }
                control={
                  <Badge variant={agentsWithoutMailbox.length > 0 ? 'outline' : 'default'}>
                    {mailboxes.length} connected
                  </Badge>
                }
              />
              <div className="px-5 py-4">
                <PagedTable
                  columns={MAILBOX_COLUMNS}
                  rows={mailRows}
                  rowKey={(row) => row.id}
                  pageSize={15}
                  searchable
                  defaultSort={{ key: 'personName', dir: 'asc' }}
                  onRowClick={(row) => setMailboxDrawer(row)}
                  labels={{ searchPlaceholder: 'Search mailboxes…', searchLabel: 'Search mailboxes' }}
                  empty={
                    <EmptyState
                      title="No agents on the roster"
                      description="Onboard an agent, then connect its address from the profile to bring it online."
                    />
                  }
                />
              </div>
            </SettingsSection>
          ) : null}

          {mailTab === 'signature' ? <MailSignatureSettings signature={mailSignature} /> : null}

          {mailTab === 'applications' ? (
            <SettingsSection
              title="Sign-in applications"
              description="Your own Google Workspace and Microsoft 365 applications — the identity agents sign into their mailboxes with."
            >
              <MailOauthApps apps={mailOauthApps} redirectUri={mailOauthRedirectUri} />
            </SettingsSection>
          ) : null}
        </div>
      ) : null}

      {active === 'voice' ? (
        <div className="space-y-4">
          <SubtabNav
            ariaLabel="Voice and phone"
            active={voiceTab}
            onSelect={setVoiceTab}
            tabs={[
              { key: 'pipeline', label: 'Call pipeline' },
              { key: 'phone', label: 'Phone system', count: phoneSystem.trunks.length + phoneSystem.numbers.length },
              { key: 'costs', label: 'Costs & recordings' },
            ]}
          />

          {voiceTab === 'pipeline' ? (
            <SettingsSection title="Call pipeline" description="What powers a phone or browser call with an agent.">
              <SettingsRow title="How a call is put together" stacked>
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  {SPEECH_PROVIDERS.map(({ provider, label, stage }, index) => (
                    <React.Fragment key={provider}>
                      {index > 0 ? (
                        <>
                          <span className="rounded-md border border-border px-3 py-2">
                            <span className="text-fg-muted">Thinking</span>{' '}
                            <span className="font-medium">the agent&apos;s own model</span>{' '}
                            <Badge variant={providers.length > 0 ? 'default' : 'destructive'}>
                              {providers.length > 0 ? `${providers.length} configured` : 'none'}
                            </Badge>
                          </span>
                          <span className="text-fg-subtle">→</span>
                        </>
                      ) : null}
                      <span className="rounded-md border border-border px-3 py-2">
                        <span className="text-fg-muted">{stage}</span> <span className="font-medium">{label}</span>{' '}
                        <Badge variant={voiceProviders[provider] ? 'default' : 'outline'}>
                          {voiceProviders[provider] ? 'connected' : 'not connected'}
                        </Badge>
                      </span>
                      {index === 0 ? <span className="text-fg-subtle">→</span> : null}
                    </React.Fragment>
                  ))}
                </div>
                <p className="mt-2 text-xs text-fg-muted">
                  Realtime speech-to-speech skips this pipeline and talks through your{' '}
                  {imageCapable.length > 0 ? (
                    <>OpenAI/Google model provider keys — available now.</>
                  ) : (
                    <>OpenAI or Google model provider key — add one under Models to enable it.</>
                  )}{' '}
                  Each agent picks its mode and voice on its profile&apos;s Voice tab.
                </p>
              </SettingsRow>
              {SPEECH_PROVIDERS.map(({ provider, label, line }) => (
                <SettingsRow
                  key={provider}
                  title={label}
                  description={line}
                  control={
                    <span className="flex items-center gap-2">
                      {voiceProviders[provider] ? <Badge variant="secondary">key sealed</Badge> : null}
                      <Button
                        variant={voiceProviders[provider] ? 'outline' : 'default'}
                        size="sm"
                        onClick={() => {
                          setVoiceKey('')
                          setVoiceError(null)
                          setVoiceDrawer(provider)
                        }}
                      >
                        {voiceProviders[provider] ? 'Manage' : 'Connect'}
                      </Button>
                    </span>
                  }
                />
              ))}
            </SettingsSection>
          ) : null}

          {voiceTab === 'phone' ? (
            <SettingsSection
              title="Phone system"
              description="How a call reaches an agent: buy real numbers on a connected Twilio account, or point your own PBX or carrier trunk at this deployment."
            >
              <PhoneSystemRow
                trunks={phoneSystem.trunks}
                extensions={phoneSystem.extensions}
                numbers={phoneSystem.numbers}
                agents={phoneSystem.agents}
                ingress={phoneSystem.ingress}
              />
            </SettingsSection>
          ) : null}

          {voiceTab === 'costs' ? <VoiceCostSettings settings={callCosts} /> : null}
        </div>
      ) : null}

      {active === 'documents' ? (
        <div className="space-y-4">
          <SubtabNav
            ariaLabel="Documents"
            active={documentTab}
            onSelect={setDocumentTab}
            tabs={[
              { key: 'letterhead', label: 'Letterhead' },
              { key: 'templates', label: 'Templates', count: templates.length },
              { key: 'filing', label: 'Filing' },
            ]}
          />
          {documentTab === 'letterhead' ? (
            <DocumentsSection branding={documents} identityName={companyIdentity.name} />
          ) : null}
          {documentTab === 'templates' ? <DocumentTemplatesView rows={templates} /> : null}
          {documentTab === 'filing' ? (
            <FilingSection settings={filing.settings} activity={filing.activity} />
          ) : null}
        </div>
      ) : null}

      {active === 'sms' ? <SmsSection settings={sms} /> : null}
      {active === 'research' ? <ResearchSection provider={research.provider} /> : null}
      {active === 'workspace' ? <WorkspaceSection policy={workspace} /> : null}
      {active === 'chat' ? (
        <ChatSettingsSection
          connections={chat.connections}
          routes={chat.routes}
          agents={chat.agents}
          webhookUrls={chat.webhookUrls}
        />
      ) : null}

      {active === 'images' ? (
        <SettingsSection
          title="Image generation"
          description="Powers the avatar studio. Reuses your model providers — same keys, same connection layer — with an image-capable model (OpenAI or Google)."
        >
          {imageCapable.length === 0 ? (
            <div className="px-5 py-4">
              <EmptyState
                title="No image-capable providers"
                description="Add an OpenAI or Google provider under Models first — image generation shares those keys."
              />
            </div>
          ) : imageSetting ? (
            <SettingsRow
              title="Configured"
              description={`${imageSetting.providerSlug} · ${imageSetting.model}`}
              control={
                <span className="flex items-center gap-2">
                  <Badge variant="secondary">uses provider key</Badge>
                  <Button variant="outline" size="sm" onClick={() => setImageDrawer(true)}>
                    Change
                  </Button>
                </span>
              }
            />
          ) : (
            <SettingsRow
              title="Not configured"
              description="Avatar generation is unavailable until a provider is chosen."
              control={
                <Button size="sm" onClick={() => setImageDrawer(true)}>
                  Choose provider &amp; model
                </Button>
              }
            />
          )}
        </SettingsSection>
      ) : null}

      {active === 'departments' ? (
        <SettingsSection
          title="Departments"
          description="The places your company has. Everyone works somewhere, the floor on the home screen shows who is where, and each department can have a backdrop drawn for it."
        >
          <DepartmentsSettings
            departments={departments}
            deskless={deskless}
            wander={wander}
            sceneKinds={sceneKinds}
          />
        </SettingsSection>
      ) : null}

      {active === 'avatar-parts' ? (
        <SettingsSection
          title="Avatars"
          description="The library everyone's likeness is built from — bodies, outfits, faces, hair. Parts are company assets: generate a set once and every person is assembled from it in their own avatar composer."
        >
          <AvatarPartsView
            parts={avatarParts}
            categories={avatarPartCategories}
            library={avatarPartLibrary}
            imageProviderConfigured={imageSetting !== null}
          />
        </SettingsSection>
      ) : null}

      <Drawer
        open={voiceDrawer !== null}
        onClose={() => setVoiceDrawer(null)}
        title={voiceDrawer ? SPEECH_PROVIDERS.find((p) => p.provider === voiceDrawer)!.label : ''}
        description={voiceDrawer ? SPEECH_PROVIDERS.find((p) => p.provider === voiceDrawer)!.line : undefined}
        size="md"
      >
        {voiceDrawer ? (
          <div className="space-y-4">
            {voiceProviders[voiceDrawer] ? (
              <div className="flex items-center justify-between rounded-md border border-border px-3 py-2 text-sm">
                <span className="flex items-center gap-2">
                  <Badge>connected</Badge>
                  <span className="text-fg-muted">Key sealed at rest.</span>
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    startBusy(async () => {
                      const form = new FormData()
                      form.set('provider', voiceDrawer)
                      await removeSpeechProviderAction(form)
                      setVoiceDrawer(null)
                    })
                  }
                >
                  Remove
                </Button>
              </div>
            ) : null}
            <div className="space-y-2">
              <Label htmlFor="voice-key">{voiceProviders[voiceDrawer] ? 'Replace API key' : 'API key'}</Label>
              <Input
                id="voice-key"
                type="password"
                value={voiceKey}
                onChange={(e) => setVoiceKey(e.target.value)}
                placeholder="Paste the key"
              />
              <p className="text-xs text-fg-muted">
                From{' '}
                <a
                  href={SPEECH_PROVIDERS.find((p) => p.provider === voiceDrawer)!.consoleUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-primary underline underline-offset-2"
                >
                  {SPEECH_PROVIDERS.find((p) => p.provider === voiceDrawer)!.consoleLabel}
                </a>
                . Verified against the live API before it is sealed.
              </p>
            </div>
            <Button
              disabled={busy || !voiceKey.trim()}
              onClick={() =>
                startBusy(async () => {
                  setVoiceError(null)
                  const result = await setSpeechProviderKeyAction({ provider: voiceDrawer, apiKey: voiceKey })
                  if (!result.ok) {
                    setVoiceError(result.message)
                    return
                  }
                  setVoiceDrawer(null)
                })
              }
            >
              {busy ? 'Verifying…' : 'Verify & connect'}
            </Button>
            {voiceError ? <p className="text-sm text-danger">{voiceError}</p> : null}
          </div>
        ) : null}
      </Drawer>

      <Drawer
        open={imageDrawer}
        onClose={() => setImageDrawer(false)}
        title={imageSetting ? 'Image generation' : 'Choose provider & model'}
        description="Avatar generation runs on one of your model providers — the same key, an image-capable model."
        size="md"
      >
        {imageDrawer ? (
          <ImageProviderForm
            providers={imageCapable}
            current={imageSetting}
            fallbackModels={imageFallbackModels}
            onSaved={() => setImageDrawer(false)}
          />
        ) : null}
      </Drawer>

      <Drawer
        open={mailboxDrawer !== null}
        onClose={() => setMailboxDrawer(null)}
        title={mailboxDrawer ? (mailboxDrawer.connected ? `Mailbox — ${mailboxDrawer.address}` : mailboxDrawer.personName) : ''}
        description={
          mailboxDrawer
            ? mailboxDrawer.connected
              ? `Connected to ${mailboxDrawer.personName}`
              : 'No address connected — this agent cannot receive work yet.'
            : undefined
        }
        size="md"
      >
        {mailboxDrawer ? (
          <div className="space-y-4 text-sm">
            <div className="space-y-2">
              <div className="flex items-center justify-between rounded-md border border-border px-3 py-2">
                <span className="text-fg-muted">Status</span>
                <Badge variant={mailboxDrawer.status === 'active' ? 'default' : mailboxDrawer.status === 'error' ? 'destructive' : 'outline'}>
                  {mailboxDrawer.status}
                </Badge>
              </div>
              {mailboxDrawer.connected ? (
                <div className="flex items-center justify-between rounded-md border border-border px-3 py-2">
                  <span className="text-fg-muted">Last sync</span>
                  <span>{mailboxDrawer.lastSyncAt || 'never'}</span>
                </div>
              ) : null}
              {mailboxDrawer.lastError ? (
                <div className="rounded-md border border-danger/40 bg-danger-subtle px-3 py-2">
                  <p className="text-xs text-fg-muted">Last error</p>
                  <p>{mailboxDrawer.lastError}</p>
                </div>
              ) : null}
            </div>
            {mailboxDrawer.connected ? null : (
              <p className="text-fg-muted">
                Mailboxes are connected from the agent&apos;s own profile, where the sign-in happens — either through
                your Google Workspace or Microsoft 365 application, or with IMAP details for self-hosted mail.
              </p>
            )}
            <Button asChild variant={mailboxDrawer.connected ? 'outline' : 'default'} size="sm">
              <Link href={`/organization?person=${mailboxDrawer.personId}`}>
                {mailboxDrawer.connected ? 'Open agent profile' : 'Connect an address'}
              </Link>
            </Button>
          </div>
        ) : null}
      </Drawer>
    </SettingsShell>
  )
}
