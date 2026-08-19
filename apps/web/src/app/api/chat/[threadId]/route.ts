import 'server-only'
import { randomUUID } from 'node:crypto'
import { createUIMessageStream, createUIMessageStreamResponse, type UIMessageChunk } from 'ai'
import type { AcpClient, ChatRequester } from '@bunkhouse/acp'
import { createAcpRunProgress } from '@bunkhouse/runtime'
import { requireTenantPermission } from '../../../../lib/tenant'
import { dispatchChatMessage } from '../../../../lib/chat-dispatch'
import { shouldAppendPersistedAnswer } from '../../../../lib/chat-reply'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
/** A governed run is a piece of work, not a completion — it can legitimately
 *  spend minutes on a document or a portal. */
export const maxDuration = 300

const MAX_PROMPT_CHARS = 32_000

/**
 * One turn of the chat page's conversation, streamed.
 *
 * This is the SAME turn `sendMessageAction` takes — `lib/chat-threads.ts`
 * `sendMessage` is the only implementation, so the run, the trigger, the dial,
 * the approvals, the budget meter and the append-only transcript are identical
 * whichever door the message came through. Doctrine #1 holds: a web chat
 * message is a governed run, never a second loop.
 *
 * What this adds is the reporting. The response is a Vercel-AI-SDK UI message
 * stream (`AgentPanel` decodes it with `readUIMessageStream`), and what goes
 * onto it comes from the run's OWN ledger as the work happens: each `tool_call`
 * becomes a tool part so the panel can render what the agent is doing, and each
 * `tool_result` completes it. Provider text is forwarded as it is generated;
 * completed steps alone are recorded durably, so an interrupted fragment can
 * never masquerade as an audited answer.
 *
 * Abort (the panel's Stop button) DETACHES the stream; it does not cancel the
 * run. A governed run is real work — by the time Stop is pressed it may already
 * have sent an email or written a file — so tearing it down mid-step would
 * leave the record describing something that did not finish the way it says.
 * The turn completes, the agent's message is persisted with its `run_id`, and a
 * reload shows it. Genuinely stopping an agent is a different, deliberate act
 * with its own audit trail: Stop on the run record, which sets the run
 * cancelled and the loop checks that every step.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ threadId: string }> },
): Promise<Response> {
  const { threadId } = await params
  const access = await requireTenantPermission('work.manage')
  const requester: ChatRequester = {
    name: access.user.name.trim() || access.user.email,
    email: access.user.email,
    relationship: 'operator',
  }

  let payload: unknown
  try {
    payload = await request.json()
  } catch {
    return badRequest('That request could not be read.')
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return badRequest('That request could not be read.')
  }
  const prompt = (payload as { prompt?: unknown }).prompt
  const suppliedRequestId = (payload as { requestId?: unknown }).requestId
  const suppliedAttachmentIds = (payload as { attachmentIds?: unknown }).attachmentIds
  if (typeof prompt !== 'string') return badRequest('A message is required.')
  if (prompt.length > MAX_PROMPT_CHARS) return badRequest('That message is too long to send.')
  const body = prompt.trim()
  if (!body) return badRequest('Write a message first.')
  if (suppliedRequestId !== undefined && (typeof suppliedRequestId !== 'string' || suppliedRequestId.length > 128)) {
    return badRequest('That message request identity is not valid.')
  }
  if (suppliedAttachmentIds !== undefined && (
    !Array.isArray(suppliedAttachmentIds)
    || suppliedAttachmentIds.length > 8
    || suppliedAttachmentIds.some((id) => typeof id !== 'string')
  )) return badRequest('The attached file list is not valid.')
  const attachmentIds = (suppliedAttachmentIds as string[] | undefined) ?? []
  // Older clients remain compatible, but current clients send their own stable
  // identity so a retried HTTP request returns the first dispatch.
  const requestId = typeof suppliedRequestId === 'string' && suppliedRequestId.trim()
    ? suppliedRequestId.trim()
    : randomUUID()

  const stream = createUIMessageStream({
    execute: async ({ writer }) => {
      // A detached client leaves the run running (see above) but there is
      // nothing left to write to, so writes stop rather than throw.
      const emit = (chunk: UIMessageChunk): void => {
        if (request.signal.aborted) return
        try {
          writer.write(chunk)
        } catch {
          // The reader is gone. The turn carries on regardless.
        }
      }

      emit({ type: 'start' })
      let textIndex = 0
      let textId = `answer-${textIndex}`
      let textStarted = false
      let anyText = false
      let streamedText = ''
      const finishText = (): void => {
        if (!textStarted) return
        emit({ type: 'text-end', id: textId })
        textStarted = false
        textIndex += 1
        textId = `answer-${textIndex}`
      }
      const emitText = (delta: string): void => {
        if (!delta) return
        if (!textStarted) {
          textStarted = true
          emit({ type: 'text-start', id: textId })
        }
        anyText = true
        streamedText += delta
        emit({ type: 'text-delta', id: textId, delta })
      }
      // This route is a client adapter, not part of the employee loop. ACP is
      // the stable seam; the current web UI stream can change independently.
      const client: AcpClient = {
        sessionUpdate: ({ sessionId, update }) => {
          if (sessionId !== threadId) return
          switch (update.sessionUpdate) {
            case 'agent_message_chunk':
              emitText(update.content.text)
              break
            case 'tool_call':
              finishText()
              emit({
                type: 'tool-input-available',
                toolCallId: update.toolCallId,
                toolName: update.title,
                input: update.rawInput,
              })
              break
            case 'tool_call_update':
              emit({ type: 'tool-output-available', toolCallId: update.toolCallId, output: update.rawOutput })
              break
          }
        },
      }
      try {
        const { messages } = await dispatchChatMessage({
          tenantId: access.tenantId,
          threadId,
          userId: access.user.id,
          body,
          idempotencyKey: requestId,
          attachmentIds,
          requester,
          progress: createAcpRunProgress({ client, sessionId: threadId }),
        })
        const answer = messages?.filter((message) => message.role === 'agent').at(-1)
        if (messages === null) emitText('Added to the conversation queue.')
        // A model may finish with a gated tool after streaming only a progress
        // preamble. The persisted outcome is authoritative: append it whenever
        // it says something the stream did not, so the turn cannot visually
        // end on a tool call. Containment avoids duplicating an answer that was
        // already streamed with different whitespace.
        if (answer?.body && shouldAppendPersistedAnswer(streamedText, answer.body)) {
          if (anyText) finishText()
          emitText(answer.body)
        }
        finishText()
        emit({ type: 'finish' })
      } catch (error) {
        // Everyday refusals — a closed conversation, somebody else's thread, an
        // empty message — belong on screen in the operator's own language.
        emit({ type: 'error', errorText: error instanceof Error ? error.message : String(error) })
        emit({ type: 'finish' })
      }
    },
    onError: (error) => (error instanceof Error ? error.message : 'Something went wrong sending that message.'),
  })

  return createUIMessageStreamResponse({ stream, headers: { 'x-thread-id': threadId } })
}

function badRequest(message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status: 400,
    headers: { 'content-type': 'application/json' },
  })
}
