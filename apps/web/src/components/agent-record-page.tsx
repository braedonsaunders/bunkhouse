'use client'

import * as React from 'react'
import { Mail, MessageSquare } from 'lucide-react'
import { Badge, Button, DetailHeader, DetailPageLayout, SubtabNav } from '@appkit/ui'

export type AgentPageSection = {
  key: string
  label: string
  content: React.ReactNode
}

function validSection(sections: AgentPageSection[], requested: string | undefined): string {
  return requested && sections.some((section) => section.key === requested)
    ? requested
    : (sections[0]?.key ?? 'overview')
}

/** Local navigation inside one employee record, used by Work and Profile. */
export function AgentRecordSubsections({
  sections,
  initialSection,
  ariaLabel,
}: {
  sections: AgentPageSection[]
  initialSection?: string
  ariaLabel: string
}) {
  const [active, setActive] = React.useState(() => validSection(sections, initialSection))
  const current = sections.find((section) => section.key === active) ?? sections[0]

  return (
    <div className="space-y-5">
      <SubtabNav
        tabs={sections.map(({ key, label }) => ({ key, label }))}
        active={current?.key ?? ''}
        onSelect={setActive}
        ariaLabel={ariaLabel}
      />
      <div key={current?.key}>{current?.content}</div>
    </div>
  )
}

/**
 * One agent's complete workplace: communication, current work and employee
 * record share a canonical full page rather than competing drawers and chat
 * destinations.
 */
export function AgentRecordPage({
  agentId,
  name,
  subtitle,
  status,
  avatar,
  contactAction,
  sections,
  initialSection,
}: {
  agentId: string
  name: string
  subtitle: string
  status: string
  avatar: React.ReactNode
  contactAction?: React.ReactNode
  sections: AgentPageSection[]
  initialSection?: string
}) {
  const [active, setActive] = React.useState(() => validSection(sections, initialSection))
  const current = sections.find((section) => section.key === active) ?? sections[0]
  const hasInbox = sections.some((section) => section.key === 'inbox')
  const hasChat = sections.some((section) => section.key === 'chat')

  const select = (key: string): void => {
    setActive(key)
    window.history.replaceState(null, '', `/organization/${encodeURIComponent(agentId)}?section=${key}`)
  }

  return (
    <DetailPageLayout
      header={
        <div className="flex items-center gap-4 pb-4">
          <button
            type="button"
            className="shrink-0 rounded-full transition-opacity hover:opacity-80"
            title={`Open ${name}'s profile`}
            onClick={() => select('profile')}
          >
            {avatar}
          </button>
          <div className="min-w-0 flex-1">
            <DetailHeader
              back={{ href: '/organization', label: 'All agents' }}
              title={name}
              subtitle={subtitle}
              badge={
                <span className="flex items-center gap-2">
                  <Badge>Agent</Badge>
                  <Badge variant={status === 'active' ? 'default' : 'outline'}>{status}</Badge>
                </span>
              }
              actions={
                <>
                  {hasChat ? (
                    <Button type="button" size="sm" onClick={() => select('chat')}>
                      <MessageSquare aria-hidden className="size-4" />
                      Message
                    </Button>
                  ) : null}
                  {contactAction}
                  {hasInbox ? (
                    <Button type="button" size="sm" variant="outline" onClick={() => select('inbox')}>
                      <Mail aria-hidden className="size-4" />
                      Inbox
                    </Button>
                  ) : null}
                </>
              }
            />
          </div>
        </div>
      }
      subtabs={
        <SubtabNav
          tabs={sections.map(({ key, label }) => ({ key, label }))}
          active={current?.key ?? ''}
          onSelect={select}
          ariaLabel={`${name}'s employee record`}
        />
      }
      className={current?.key === 'chat' || current?.key === 'inbox' ? '' : 'space-y-6'}
    >
      <div key={current?.key}>{current?.content}</div>
    </DetailPageLayout>
  )
}
