'use client'

import * as React from 'react'
import Link from 'next/link'
import { Brain } from 'lucide-react'
import {
  Badge,
  Button,
  EmptyState,
  SettingsRow,
  SettingsSection,
  SettingsShell,
  type LinkRender,
  type SettingsNavGroup,
} from '@appkit/ui'
import { removeProviderAction } from '../app/admin/settings/actions'
import { AddProviderForm, type ProviderKindOption } from './add-provider-form'

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

const NAV: SettingsNavGroup[] = [
  {
    label: 'Company',
    items: [{ key: 'ai', label: 'Model providers', icon: <Brain /> }],
  },
]

export function SettingsView({
  providers,
  kinds,
}: {
  providers: ProviderSummary[]
  kinds: ProviderKindOption[]
}) {
  const [active, setActive] = React.useState('ai')
  const [removing, startRemoving] = React.useTransition()

  return (
    <SettingsShell
      title="Settings"
      description="Company-level configuration. Everything lives here, nothing in env."
      back={{ href: '/admin', label: 'Admin' }}
      nav={NAV}
      activeKey={active}
      onSelect={setActive}
      linkRender={nextLink}
    >
      {active === 'ai' ? (
        <SettingsSection
          title="Model providers"
          description="Your own API keys, sealed at rest and live-verified before saving. Each hand is assigned a provider and model on its profile."
        >
          {providers.length === 0 ? (
            <EmptyState title="No providers yet" description="Add one API key and your hands can start thinking." />
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
                      disabled={removing}
                      onClick={() =>
                        startRemoving(async () => {
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
    </SettingsShell>
  )
}
