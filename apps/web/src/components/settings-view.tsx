'use client'

import * as React from 'react'
import Link from 'next/link'
import { Boxes, Brain, Building2, FileText, FolderCog, Globe, ImageIcon, Mail, MessageSquare,
  MessagesSquare, Phone, Plug, Shield } from 'lucide-react'
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
import {
  refreshPricesAction,
  removeProviderAction,
  removeSpeechProviderAction,
  setManualPriceAction,
  setSpeechProviderKeyAction,
} from '../app/admin/settings/actions'
import type { AvatarPart, AvatarPartCategory } from '@appkit/avatars/composition'
import { AvatarPartsView, type AvatarPartRowView } from './avatar-parts-view'
import { AddProviderForm, type ProviderKindOption } from './add-provider-form'
import { ImageProviderForm } from './image-provider-form'
import { AutonomySettings, type AgentDial } from './autonomy-settings'
import { CompanyIdentitySettings, type CompanyIdentityView, type IdentityProviderOption } from './company-identity-settings'
import { PhoneSystemRow, type AgentExtensionRow, type AgentOption, type PhoneNumberRowView, type SipTrunkSummary } from './phone-system'
import { MailOauthApps, type MailOauthAppView } from './mail-oauth-apps'
import { DocumentsSection, IntegrationsSection, ResearchSection, SmsSection, WorkspaceSection, type DocumentBrandingView, type IntegrationRowView, type SmsSettingsView, type WorkspacePolicyView } from './capability-settings'
import { VoiceCostSettings, type VoiceCostSettingsView } from './voice-cost-settings'
import { DocumentTemplatesView, type TemplateRowView } from './document-templates-view'
import { FilingSection, type FilingActivityRow, type FilingSettingsView } from './filing-settings'
import { ChatSettingsSection, type ChatAgentOption, type ChatChannelRouteRowView, type ChatConnectionsView } from './chat-settings'

const nextLink: LinkRender = ({ href, children, className, title }) => (
  <Link href={href} className={className} title={title}>
    {children}
  </Link>
)

export type ProviderSummary = {
  slug: string
  label: string
  provider: string
  modelSmart?: string
  modelFast?: string
  baseUrl?: string
}

export type PriceRow = {
  id: string
  model: string
  inputUsdPerMtok: string
  outputUsdPerMtok: string
  /** Raw dollars behind the formatted columns, so sorting is numeric. */
  inputUsd: number
  outputUsd: number
  source: string
  sourceRef?: string
  effectiveAt: string
}

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
    label: 'Company',
    items: [
      { key: 'identity', label: 'Identity', icon: <Building2 /> },
      { key: 'documents', label: 'Documents', icon: <FileText /> },
      { key: 'avatar-parts', label: 'Avatars', icon: <Boxes /> },
    ],
  },
  {
    label: 'Trust',
    items: [{ key: 'autonomy', label: 'Autonomy', icon: <Shield /> }],
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
    items: [
      { key: 'workspace', label: 'Workspace', icon: <FolderCog /> },
      { key: 'integrations', label: 'Integrations', icon: <Plug /> },
    ],
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

const PRICE_COLUMNS: PagedColumn<PriceRow>[] = [
  { key: 'model', header: 'Model', cell: (row) => row.model, search: (row) => row.model, sortValue: (row) => row.model },
  {
    key: 'input',
    header: 'Input $/Mtok',
    align: 'right',
    cell: (row) => row.inputUsdPerMtok,
    sortValue: (row) => row.inputUsd,
  },
  {
    key: 'output',
    header: 'Output $/Mtok',
    align: 'right',
    cell: (row) => row.outputUsdPerMtok,
    sortValue: (row) => row.outputUsd,
  },
  {
    key: 'source',
    header: 'Source',
    cell: (row) => <Badge variant={row.source === 'openrouter' ? 'secondary' : 'outline'}>{row.source}</Badge>,
    search: (row) => row.source,
    sortValue: (row) => row.source,
  },
  {
    key: 'effectiveAt',
    header: 'Effective',
    cell: (row) => row.effectiveAt,
    sortValue: (row) => row.effectiveAt,
  },
]

const MAILBOX_COLUMNS: PagedColumn<MailboxRow>[] = [
  {
    key: 'personName',
    header: 'Agent',
    cell: (row) => <span className="font-medium text-primary">{row.personName}</span>,
    search: (row) => row.personName,
    sortValue: (row) => row.personName,
  },
  { key: 'address', header: 'Address', cell: (row) => row.address, search: (row) => row.address, sortValue: (row) => row.address },
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
  { key: 'lastSyncAt', header: 'Last sync', cell: (row) => row.lastSyncAt || 'never', sortValue: (row) => row.lastSyncAt ?? '' },
  {
    key: 'lastError',
    header: 'Last error',
    cell: (row) => (row.lastError ? <span className="text-danger">{row.lastError}</span> : '—'),
    search: (row) => row.lastError ?? '',
  },
]

export function SettingsView({
  providers,
  kinds,
  prices,
  mailboxes,
  agentsWithoutMailbox,
  mailOauthApps,
  mailOauthRedirectUri,
  imageSetting,
  imageFallbackModels,
  voiceProviders,
  research,
  documents,
  companyIdentity,
  workspace,
  chat,
  callCosts,
  templates,
  filing,
  sms,
  integrations,
  phoneSystem,
  agentDials,
  initialSection,
  avatarParts,
  avatarPartCategories,
  avatarPartLibrary,
}: {
  providers: ProviderSummary[]
  kinds: ProviderKindOption[]
  prices: PriceRow[]
  mailboxes: MailboxRow[]
  agentsWithoutMailbox: AgentWithoutMailbox[]
  /** The company's Google Workspace / Microsoft 365 applications, secrets withheld. */
  mailOauthApps: MailOauthAppView[]
  /** The one address both providers call back to; operators copy it into their console. */
  mailOauthRedirectUri: string
  imageSetting: { providerSlug: string; model: string } | null
  /** Static catalog offered only when the live provider model list fails. */
  imageFallbackModels: { id: string; name: string; provider: string }[]
  voiceProviders: VoiceProviderState
  research: { provider: string | null }
  documents: DocumentBrandingView
  /** Who the company is — the profile every agent works from. */
  companyIdentity: CompanyIdentityView
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
  integrations: IntegrationRowView[]
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
}) {
  const arrival = React.useMemo(() => resolveSection(initialSection), [initialSection])
  const [active, setActive] = React.useState(arrival.section)
  const [modelTab, setModelTab] = React.useState(arrival.tab ?? 'providers')
  const [documentTab, setDocumentTab] = React.useState(arrival.tab ?? 'letterhead')
  const [mailTab, setMailTab] = React.useState(arrival.tab ?? 'mailboxes')
  const [voiceTab, setVoiceTab] = React.useState(arrival.tab ?? 'pipeline')
  const [busy, startBusy] = React.useTransition()
  const [notice, setNotice] = React.useState<string | null>(null)
  const [priceDrawer, setPriceDrawer] = React.useState<string | null>(null)
  const [mailboxDrawer, setMailboxDrawer] = React.useState<MailboxRow | null>(null)
  const [voiceDrawer, setVoiceDrawer] = React.useState<'deepgram' | 'elevenlabs' | null>(null)
  const [voiceKey, setVoiceKey] = React.useState('')
  const [voiceError, setVoiceError] = React.useState<string | null>(null)
  const imageCapable = providers.filter((p) => ['openai', 'google'].includes(p.provider))
  const priceHistory = priceDrawer && priceDrawer !== '*new*' ? prices.filter((row) => row.model === priceDrawer) : []
  const identityProviders: IdentityProviderOption[] = providers.map((provider) => ({
    slug: provider.slug,
    label: `${provider.label} · ${provider.slug}`,
  }))

  return (
    <SettingsShell
      title="Settings"
      description="Company-level configuration: who your agents work for, how far they are trusted, and what powers them."
      nav={NAV}
      activeKey={active}
      onSelect={(key) => {
        setActive(key)
        setNotice(null)
      }}
      linkRender={nextLink}
    >
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

      {active === 'ai' ? (
        <div className="space-y-4">
          <SubtabNav
            ariaLabel="Models"
            active={modelTab}
            onSelect={setModelTab}
            tabs={[
              { key: 'providers', label: 'Providers', count: providers.length },
              { key: 'pricing', label: 'Pricing', count: prices.length },
            ]}
          />

          {modelTab === 'providers' ? (
            <SettingsSection
              title="Model providers"
              description="Your own API keys, sealed at rest and live-verified before saving. Each agent is assigned a provider and model on its profile."
            >
              {providers.length === 0 ? (
                <EmptyState title="No providers yet" description="Add one API key and your agents can start thinking." />
              ) : (
                providers.map((entry) => (
                  <SettingsRow
                    key={entry.slug}
                    title={`${entry.label} · ${entry.slug}`}
                    description={`${entry.provider}${entry.modelSmart ? ` · default ${entry.modelSmart}` : ''}${entry.modelFast ? ` · fast ${entry.modelFast}` : ''}${entry.baseUrl ? ` · ${entry.baseUrl}` : ''}`}
                    control={
                      <span className="flex items-center gap-2">
                        <Badge variant="secondary">key sealed</Badge>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busy}
                          onClick={() =>
                            startBusy(async () => {
                              const form = new FormData()
                              form.set('slug', entry.slug)
                              await removeProviderAction(form)
                            })
                          }
                        >
                          Remove
                        </Button>
                      </span>
                    }
                  />
                ))
              )}
              <SettingsRow title="Add a provider" description="Verify the key, pick defaults from its live model list." stacked>
                <AddProviderForm kinds={kinds} />
              </SettingsRow>
            </SettingsSection>
          ) : null}

          {modelTab === 'pricing' ? (
            <SettingsSection
              title="Model pricing"
              description="Effective-dated, append-only price rows — every spend record stamps the exact price it used, so costs are auditable forever. Refresh pulls live prices from the OpenRouter catalog for models your agents use; '*' is the company default."
            >
              <SettingsRow
                title="Keeping prices current"
                description="Refreshing appends a new effective row only where the price actually changed."
                control={
                  <span className="flex items-center gap-2">
                    <Button variant="outline" size="sm" onClick={() => setPriceDrawer('*new*')}>
                      Add manual price
                    </Button>
                    <Button
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        startBusy(async () => {
                          setNotice(null)
                          try {
                            await refreshPricesAction()
                            setNotice('Prices refreshed.')
                          } catch (err) {
                            setNotice(err instanceof Error ? err.message : String(err))
                          }
                        })
                      }
                    >
                      {busy ? 'Refreshing…' : 'Refresh from OpenRouter'}
                    </Button>
                  </span>
                }
              />
              {notice ? <p className="px-5 py-3 text-sm text-fg-muted">{notice}</p> : null}
              <div className="px-5 py-4">
                <PagedTable
                  columns={PRICE_COLUMNS}
                  rows={prices}
                  rowKey={(row) => row.id}
                  pageSize={15}
                  searchable
                  defaultSort={{ key: 'effectiveAt', dir: 'desc' }}
                  onRowClick={(row) => setPriceDrawer(row.model)}
                  labels={{ searchPlaceholder: 'Search prices…', searchLabel: 'Search prices' }}
                  empty={
                    <EmptyState
                      title="No prices yet"
                      description="Refresh from OpenRouter or add a manual price. Unpriced spend records cost $0 and are flagged."
                    />
                  }
                />
              </div>
            </SettingsSection>
          ) : null}
        </div>
      ) : null}

      {active === 'mail' ? (
        <div className="space-y-4">
          <SubtabNav
            ariaLabel="Mail"
            active={mailTab}
            onSelect={setMailTab}
            tabs={[
              { key: 'mailboxes', label: 'Mailboxes', count: mailboxes.length },
              { key: 'applications', label: 'Sign-in applications' },
            ]}
          />

          {mailTab === 'mailboxes' ? (
            <SettingsSection
              title="Mailboxes"
              description="Every agent's connected email account: status, sync health, and errors. Connect a mailbox from the agent's profile."
            >
              <div className="px-5 py-4">
                <PagedTable
                  columns={MAILBOX_COLUMNS}
                  rows={mailboxes}
                  rowKey={(row) => row.id}
                  pageSize={15}
                  searchable
                  defaultSort={{ key: 'personName', dir: 'asc' }}
                  onRowClick={(row) => setMailboxDrawer(row)}
                  labels={{ searchPlaceholder: 'Search mailboxes…', searchLabel: 'Search mailboxes' }}
                  empty={
                    <EmptyState
                      title="No mailboxes connected"
                      description="Open an agent’s profile and connect their address to bring them online."
                    />
                  }
                />
              </div>
              {agentsWithoutMailbox.length > 0 ? (
                <SettingsRow
                  title="Agents without a mailbox"
                  description="These agents cannot receive work until an address is connected."
                  stacked
                >
                  <div className="flex flex-wrap gap-2">
                    {agentsWithoutMailbox.map((agent) => (
                      <Link
                        key={agent.id}
                        href={`/organization/agents?person=${agent.id}`}
                        className="rounded-md border border-border px-3 py-1.5 text-sm text-fg-muted transition-colors hover:border-primary/50 hover:text-fg"
                      >
                        {agent.name} · {agent.title}
                      </Link>
                    ))}
                  </div>
                </SettingsRow>
              ) : null}
            </SettingsSection>
          ) : null}

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

      {active === 'integrations' ? <IntegrationsSection integrations={integrations} /> : null}

      {active === 'images' ? (
        <SettingsSection
          title="Image generation"
          description="Powers the avatar studio. Reuses your model providers — same keys, same connection layer — with an image-capable model (OpenAI or Google)."
        >
          {imageSetting ? (
            <SettingsRow
              title="Configured"
              description={`${imageSetting.providerSlug} · ${imageSetting.model}`}
              control={<Badge variant="secondary">uses provider key</Badge>}
            />
          ) : (
            <SettingsRow title="Not configured" description="Avatar generation is unavailable until a provider is chosen." />
          )}
          {imageCapable.length === 0 ? (
            <EmptyState
              title="No image-capable providers"
              description="Add an OpenAI or Google provider under Models first — image generation shares those keys."
            />
          ) : (
            <SettingsRow title={imageSetting ? 'Change' : 'Choose provider & model'} stacked>
              <ImageProviderForm
                providers={imageCapable}
                current={imageSetting}
                fallbackModels={imageFallbackModels}
              />
            </SettingsRow>
          )}
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
        open={priceDrawer !== null}
        onClose={() => setPriceDrawer(null)}
        title={priceDrawer === '*new*' ? 'Add manual price' : `Pricing — ${priceDrawer ?? ''}`}
        description={
          priceDrawer === '*new*'
            ? "Model id, or * for the company default. Appends an effective-dated row."
            : 'Full effective-dated history; the newest row is in force. Changes append, never edit.'
        }
        size="md"
      >
        <div className="space-y-6">
          {priceDrawer && priceDrawer !== '*new*' ? (
            <div className="space-y-1">
              {priceHistory.map((row) => (
                <div key={row.id} className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-sm">
                  <span className="tabular-nums">
                    {row.inputUsdPerMtok} in · {row.outputUsdPerMtok} out
                  </span>
                  <span className="flex items-center gap-2 text-xs text-fg-muted">
                    <Badge variant={row.source === 'openrouter' ? 'secondary' : 'outline'}>{row.source}</Badge>
                    {row.effectiveAt}
                  </span>
                </div>
              ))}
            </div>
          ) : null}
          <form
            action={async (form: FormData) => {
              setNotice(null)
              await setManualPriceAction(form)
              setPriceDrawer(null)
            }}
            className="space-y-3"
          >
            <div className="space-y-1">
              <Label htmlFor="price-model">Model</Label>
              <Input
                id="price-model"
                name="model"
                defaultValue={priceDrawer === '*new*' ? '' : (priceDrawer ?? '')}
                placeholder="claude-sonnet-5 or *"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="price-in">Input $/Mtok</Label>
                <Input id="price-in" name="inputUsdPerMtok" type="number" step="0.0001" min="0" required />
              </div>
              <div className="space-y-1">
                <Label htmlFor="price-out">Output $/Mtok</Label>
                <Input id="price-out" name="outputUsdPerMtok" type="number" step="0.0001" min="0" required />
              </div>
            </div>
            <Button type="submit" size="sm">
              Append price row
            </Button>
          </form>
        </div>
      </Drawer>

      <Drawer
        open={mailboxDrawer !== null}
        onClose={() => setMailboxDrawer(null)}
        title={mailboxDrawer ? `Mailbox — ${mailboxDrawer.address}` : ''}
        description={mailboxDrawer ? `Connected to ${mailboxDrawer.personName}` : undefined}
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
              <div className="flex items-center justify-between rounded-md border border-border px-3 py-2">
                <span className="text-fg-muted">Last sync</span>
                <span>{mailboxDrawer.lastSyncAt || 'never'}</span>
              </div>
              {mailboxDrawer.lastError ? (
                <div className="rounded-md border border-danger/40 bg-danger-subtle px-3 py-2">
                  <p className="text-xs text-fg-muted">Last error</p>
                  <p>{mailboxDrawer.lastError}</p>
                </div>
              ) : null}
            </div>
            <Button asChild variant="outline" size="sm">
              <Link href={`/organization/agents?person=${mailboxDrawer.personId}`}>Open agent profile</Link>
            </Button>
          </div>
        ) : null}
      </Drawer>
    </SettingsShell>
  )
}
