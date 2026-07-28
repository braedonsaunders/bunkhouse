'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { MailboxInbox, type MailFolderKey, type MailThreadListItem } from '@appkit/mailbox/react'
import { formatAttachmentSize } from '@appkit/storage'
import {
  composeMailAction,
  loadMailConversationAction,
  loadMailFolderAction,
  replyToThreadAction,
  type MailConversation,
  type MailThreadRow,
} from '../app/mail/actions'

export type AgentMailboxOption = {
  id: string
  personId: string
  ownerName: string
  address: string
}

/**
 * The agent's inbox on its own flyout tab: @appkit/mailbox's inbox surface,
 * fed by server actions. Switching mailbox switches the flyout to that
 * colleague — the inbox is never separate from the person it belongs to.
 */
export function AgentMailInbox({
  basePath,
  mailboxes,
  activeMailboxId,
  replyLabel,
  initialFolder,
  initialCounts,
  initialThreads,
  initialThreadId,
  initialConversation,
}: {
  basePath: string
  mailboxes: AgentMailboxOption[]
  activeMailboxId: string
  replyLabel: string
  initialFolder: MailFolderKey
  initialCounts: Record<MailFolderKey, number>
  initialThreads: MailThreadRow[]
  initialThreadId: string | null
  initialConversation: MailConversation | null
}) {
  const router = useRouter()
  const [folder, setFolder] = React.useState<MailFolderKey>(initialFolder)
  const [counts, setCounts] = React.useState(initialCounts)
  const [threads, setThreads] = React.useState<MailThreadRow[]>(initialThreads)
  const [activeThreadId, setActiveThreadId] = React.useState<string | null>(initialThreadId)
  const [conversation, setConversation] = React.useState<MailConversation | null>(initialConversation)

  const refreshFolder = React.useCallback(
    async (nextFolder: MailFolderKey) => {
      const result = await loadMailFolderAction({ mailboxId: activeMailboxId, folder: nextFolder })
      setThreads(result.threads)
      setCounts(result.counts)
    },
    [activeMailboxId],
  )

  const listItems: MailThreadListItem[] = threads.map((thread) => ({
    id: thread.id,
    counterparty: thread.counterparty,
    subject: thread.subject,
    at: thread.at,
    open: thread.open,
  }))

  return (
    <MailboxInbox
      className="h-full"
      mailboxes={mailboxes.map((m) => ({ id: m.id, ownerName: m.ownerName, address: m.address }))}
      activeMailboxId={activeMailboxId}
      onSwitchMailbox={(id) => {
        const target = mailboxes.find((m) => m.id === id)
        if (target) router.push(`${basePath}?person=${target.personId}&tab=mailbox`, { scroll: false })
      }}
      folder={folder}
      folderCounts={counts}
      onSwitchFolder={(key) => {
        setFolder(key)
        setActiveThreadId(null)
        setConversation(null)
        void refreshFolder(key)
      }}
      threads={listItems}
      activeThreadId={activeThreadId}
      onSelectThread={(id) => {
        setActiveThreadId(id)
        setConversation(null)
        if (id) {
          void loadMailConversationAction({ threadId: id }).then((loaded) => setConversation(loaded))
        }
      }}
      conversation={
        conversation
          ? {
              subject: conversation.subject,
              messages: conversation.messages.map((message) => ({
                id: message.id,
                direction: message.direction,
                fromLabel: message.fromLabel,
                toLabel: message.toLabel,
                at: message.at,
                bodyText: message.bodyText,
                attachments: message.attachments.map((attachment) => ({
                  filename: attachment.filename,
                  sizeLabel: formatAttachmentSize(attachment.size),
                  href: attachment.href,
                })),
              })),
            }
          : null
      }
      onReply={async (text) => {
        if (!activeThreadId) return
        await replyToThreadAction({ threadId: activeThreadId, text })
        setConversation(await loadMailConversationAction({ threadId: activeThreadId }))
      }}
      onCompose={async (draft) => {
        await composeMailAction({ mailboxId: activeMailboxId, ...draft })
        await refreshFolder(folder)
      }}
      onRefresh={() => {
        void refreshFolder(folder)
        if (activeThreadId) {
          void loadMailConversationAction({ threadId: activeThreadId }).then((loaded) => setConversation(loaded))
        }
      }}
      replyLabel={replyLabel}
    />
  )
}
