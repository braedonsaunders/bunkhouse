'use client'

import * as React from 'react'
import Link from 'next/link'
import { ArrowLeft, MessageSquare } from 'lucide-react'
import {
  Badge,
  Button,
  DetailPageLayout,
  DocumentTitle,
  SubtabNav,
} from '@braedonsaunders/appkit-ui'

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
    <div className="space-y-3">
      <SubtabNav
        tabs={sections.map(({ key, label }) => ({ key, label }))}
        active={current?.key ?? ''}
        onSelect={setActive}
        ariaLabel={ariaLabel}
        className="pb-0"
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
  status,
  avatar,
  contactAction,
  sections,
  initialSection,
}: {
  agentId: string
  name: string
  status: string
  avatar: React.ReactNode
  contactAction?: React.ReactNode
  sections: AgentPageSection[]
  initialSection?: string
}) {
  const [active, setActive] = React.useState(() => validSection(sections, initialSection))
  const current = sections.find((section) => section.key === active) ?? sections[0]
  const hasChat = sections.some((section) => section.key === 'chat')
  const fillsPage = current?.key === 'overview' || current?.key === 'chat' || current?.key === 'mail'

  const select = (key: string): void => {
    setActive(key)
    window.history.replaceState(null, '', `/organization/${encodeURIComponent(agentId)}?section=${key}`)
  }

  return (
    <DetailPageLayout
      header={
        <div className="-mt-3">
          <DocumentTitle title={name} />
          <div className="flex h-5 items-center">
            <Button asChild size="sm" variant="ghost" className="-ml-2 h-5 px-2 text-xs">
              <Link href="/organization">
                <ArrowLeft aria-hidden className="size-3.5" />
                All agents
              </Link>
            </Button>
          </div>
          <div className="mt-1 flex min-w-0 items-center gap-2.5">
            <button
              type="button"
              className="shrink-0 rounded-full transition-opacity hover:opacity-80"
              title={`Open ${name}'s profile`}
              onClick={() => select('profile')}
            >
              {avatar}
            </button>
            <div className="flex min-w-0 flex-1 items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-2">
                <h1 className="truncate text-lg font-semibold leading-5 text-fg">{name}</h1>
                <span className="flex shrink-0 items-center gap-1.5">
                  <Badge>Agent</Badge>
                  <Badge variant={status === 'active' ? 'default' : 'outline'}>{status}</Badge>
                </span>
              </div>
              <div className="ml-auto flex shrink-0 items-center justify-end gap-2">
                {hasChat ? (
                  <React.Fragment key="message">
                    <Button type="button" size="sm" onClick={() => select('chat')}>
                      <MessageSquare aria-hidden className="size-4" />
                      Message
                    </Button>
                  </React.Fragment>
                ) : null}
                {contactAction ? <React.Fragment key="contact">{contactAction}</React.Fragment> : null}
              </div>
            </div>
          </div>
        </div>
      }
      subtabs={
        <SubtabNav
          tabs={sections.map(({ key, label }) => ({ key, label }))}
          active={current?.key ?? ''}
          onSelect={select}
          ariaLabel={`${name}'s employee record`}
          className="-mt-4 pb-0"
        />
      }
      className={fillsPage ? 'h-full min-h-0 p-0' : 'p-3 sm:p-4'}
    >
      <div key={current?.key} className={fillsPage ? 'h-full min-h-0' : undefined}>
        {current?.content}
      </div>
    </DetailPageLayout>
  )
}
