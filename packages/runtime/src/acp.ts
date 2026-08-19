import type { AcpClient } from '@bunkhouse/acp'
import type { RunAgentProgress } from './loop'

/**
 * Adapts the runtime's provider-neutral progress stream to ACP. This is the
 * only direction live presentation data travels: the runtime never imports a
 * client renderer or its stream format.
 */
export function createAcpRunProgress(args: { client: AcpClient; sessionId: string }): RunAgentProgress {
  return {
    onTextDelta: (text) =>
      args.client.sessionUpdate({
        sessionId: args.sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
      }),
    onToolCall: ({ toolCallId, toolName, input }) =>
      args.client.sessionUpdate({
        sessionId: args.sessionId,
        update: {
          sessionUpdate: 'tool_call',
          toolCallId,
          title: toolName,
          status: 'in_progress',
          rawInput: input,
        },
      }),
    onToolResult: ({ toolCallId, output }) =>
      args.client.sessionUpdate({
        sessionId: args.sessionId,
        update: { sessionUpdate: 'tool_call_update', toolCallId, status: 'completed', rawOutput: output },
      }),
  }
}
