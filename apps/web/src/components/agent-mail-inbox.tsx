'use client'

import * as React from 'react'
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
  ownerName: string
  address: string
}

/**
 * The agent's inbox on its own flyout tab: @appkit/mailbox's inbox surface,
 * fed by server actions.
 *
 * One mailbox, and only theirs. The drawer is already open on a person, so a
 * picker offering everyone else's mail asked you to leave the record you had
 * just opened — you get to a colleague's inbox by opening the colleague.
 * @appkit/mailbox draws no switcher when there is nowhere to switch to.
 */
export function AgentMailInbox({
  mailbox,
  replyLabel,
  initialFolder,
  initialCounts,
  initialThreads,
  initialThreadId,
  initialConversation,
}: {
  mailbox: AgentMailboxOption
  replyLabel: string
  initialFolder: MailFolderKey
  initialCounts: Record<MailFolderKey, number>
  initialThreads: MailThreadRow[]
  initialThreadId: string | null
  initialConversation: MailConversation | null
}) {
  const activeMailboxId = mailbox.id
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

  // "Sync now" lives outside this component: it pulls from the provider and
  // revalidates, and the fresh thread list arrives as new initial props on a
  // component that is already mounted. State seeded once at mount never sees
  // them — an operator pressed Sync, the mail landed in the database, and the
  // drawer kept showing the list from before, which reads as sync being
  // broken. So a new server render is treated as the refresh it is — via a
  // refetch of whichever folder is actually open, since the initial props
  // describe only the initial one.
  const seededWith = React.useRef(initialThreads)
  React.useEffect(() => {
    if (seededWith.current === initialThreads) return
    seededWith.current = initialThreads
    void refreshFolder(folder)
  }, [initialThreads, folder, refreshFolder])

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
      mailboxes={[{ id: mailbox.id, ownerName: mailbox.ownerName, address: mailbox.address }]}
      activeMailboxId={activeMailboxId}
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
