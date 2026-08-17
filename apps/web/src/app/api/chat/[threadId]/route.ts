import 'server-only'
import { createUIMessageStream, createUIMessageStreamResponse, type UIMessageChunk } from 'ai'
import { requireTenantPermission } from '../../../../lib/tenant'
import { sendMessage } from '../../../../lib/chat-threads'

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
 * `tool_result` completes it. The answer itself arrives as one text part when
 * the run finishes — deliberately not fake token-by-token. The governed loop is
 * multi-step and tool-using; its steps are the honest unit of progress here,
 * and dribbling a finished sentence out a character at a time would be theatre.
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
  if (typeof prompt !== 'string') return badRequest('A message is required.')
  if (prompt.length > MAX_PROMPT_CHARS) return badRequest('That message is too long to send.')
  const body = prompt.trim()
  if (!body) return badRequest('Write a message first.')

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
      const textId = 'answer'
      try {
        const { messages } = await sendMessage({
          tenantId: access.tenantId,
          threadId,
          userId: access.user.id,
          body,
          progress: {
            onToolCall: ({ toolCallId, toolName, input }) => {
              emit({ type: 'tool-input-available', toolCallId, toolName, input })
            },
            onToolResult: ({ toolCallId, output }) => {
              emit({ type: 'tool-output-available', toolCallId, output })
            },
          },
        })
        const answer = messages.filter((message) => message.role === 'agent').at(-1)
        emit({ type: 'text-start', id: textId })
        if (answer?.body) emit({ type: 'text-delta', id: textId, delta: answer.body })
        emit({ type: 'text-end', id: textId })
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
