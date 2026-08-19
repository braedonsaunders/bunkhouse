export type ChatExportThread = {
  id: string
  title: string
  personId: string
  personName: string
  status: 'open' | 'closed'
  originThreadId: string | null
  originMessageSeq: number | null
}

export type ChatExportMessage = {
  id: string
  seq: number
  role: 'user' | 'agent' | 'system'
  body: string
  at: string
  runId: string | null
  dispatchId: string | null
  attachments?: Array<{ fileId: string; filename: string; contentType: string; sizeBytes: number }>
}

export type ChatExportRecord = {
  version: 1
  exportedAt: string
  thread: ChatExportThread
  messages: ChatExportMessage[]
}

export function chatExportRecord(
  thread: ChatExportThread,
  messages: ChatExportMessage[],
  exportedAt = new Date().toISOString(),
): ChatExportRecord {
  return { version: 1, exportedAt, thread, messages }
}

function markdownValue(value: string): string {
  return value.replaceAll('\r\n', '\n').replaceAll('\r', '\n').trim()
}

/** A portable, human-readable transcript with the run joins kept as evidence. */
export function chatExportMarkdown(record: ChatExportRecord): string {
  const lines = [
    `# ${markdownValue(record.thread.title)}`,
    '',
    `- Agent: ${record.thread.personName}`,
    `- Status: ${record.thread.status === 'closed' ? 'Archived' : 'Open'}`,
    `- Conversation ID: ${record.thread.id}`,
    `- Exported: ${record.exportedAt}`,
  ]
  if (record.thread.originThreadId && record.thread.originMessageSeq !== null) {
    lines.push(
      `- Continued from: ${record.thread.originThreadId} through message ${record.thread.originMessageSeq}`,
    )
  }
  lines.push('')

  for (const message of record.messages) {
    const speaker = message.role === 'user'
      ? 'You'
      : message.role === 'agent'
        ? record.thread.personName
        : 'System note'
    lines.push(`## ${speaker} · ${message.at}`, '', markdownValue(message.body), '')
    if (message.attachments?.length) {
      lines.push(
        ...message.attachments.map((file) =>
          `- Attached: ${markdownValue(file.filename)} (${file.contentType}, file ${file.fileId})`,
        ),
        '',
      )
    }
    const evidence = [
      `Message ${message.seq}`,
      ...(message.runId ? [`Run ${message.runId}`] : []),
      ...(message.dispatchId ? [`Dispatch ${message.dispatchId}`] : []),
    ]
    lines.push(`_${evidence.join(' · ')}_`, '')
  }
  return `${lines.join('\n').trimEnd()}\n`
}

export function chatExportJson(record: ChatExportRecord): string {
  return `${JSON.stringify(record, null, 2)}\n`
}

export function chatExportFilename(title: string, extension: 'md' | 'json'): string {
  const base = title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '')
    .toLocaleLowerCase()
  return `${base || 'conversation'}.${extension}`
}
