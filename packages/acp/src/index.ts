/**
 * Bunkhouse's public client/runtime seam follows Agent Client Protocol v1.
 *
 * The package intentionally has no UI, provider, model, database, or transport
 * dependency. A desktop client, web host, or test harness can implement the
 * client side without being allowed into the employee runtime.
 */
export const ACP_PROTOCOL_VERSION = 1 as const

export type AcpTextContent = { type: 'text'; text: string }

export type AcpToolCallStatus = 'pending' | 'in_progress' | 'completed' | 'failed'

export type AcpSessionUpdate =
  | { sessionUpdate: 'agent_message_chunk'; content: AcpTextContent }
  | {
      sessionUpdate: 'tool_call'
      toolCallId: string
      title: string
      status: Extract<AcpToolCallStatus, 'pending' | 'in_progress'>
      rawInput: unknown
    }
  | {
      sessionUpdate: 'tool_call_update'
      toolCallId: string
      status: Extract<AcpToolCallStatus, 'completed' | 'failed'>
      rawOutput?: unknown
    }

export type AcpSessionNotification = {
  sessionId: string
  update: AcpSessionUpdate
}

/** The experience-side callback surface defined by ACP. */
export interface AcpClient {
  sessionUpdate(notification: AcpSessionNotification): void | Promise<void>
}

export type AcpInitializeRequest = {
  protocolVersion: number
  clientCapabilities?: Record<string, unknown>
}

export type AcpInitializeResponse = {
  protocolVersion: typeof ACP_PROTOCOL_VERSION
  agentCapabilities: {
    loadSession: boolean
    promptCapabilities: { image: boolean; audio: boolean; embeddedContext: boolean }
  }
}

export type AcpPromptRequest = {
  sessionId: string
  prompt: AcpTextContent[]
  _meta?: Record<string, unknown>
}

export type AcpPromptResponse = {
  stopReason: 'end_turn' | 'cancelled' | 'refusal'
  _meta?: Record<string, unknown>
}

/** The runtime-side contract. Hosts provide identity, tenancy, and transport. */
export interface AcpAgent {
  initialize(request: AcpInitializeRequest): Promise<AcpInitializeResponse>
  prompt(request: AcpPromptRequest): Promise<AcpPromptResponse>
  cancel(request: { sessionId: string }): Promise<void>
}

export const BUNKHOUSE_ACP_CAPABILITIES = {
  protocolVersion: ACP_PROTOCOL_VERSION,
  sessionUpdates: true,
  toolCalls: true,
  cancellation: true,
  governedExtensions: true,
} as const

/**
 * Product policy extension carried across the ACP boundary. The retired
 * database values `shell` and `computer_use` remain deliberately absent.
 */
export type ActionCategory =
  | 'external_email'
  | 'internal_email'
  | 'record_write'
  | 'money_adjacent'
  | 'file_write'
  | 'phone_call'
  | 'sandbox'
  | 'desktop'
  | 'shared_folder'
  | 'background_job'

export type AutonomyLevel = 'forbidden' | 'approval' | 'notify' | 'trusted'

/** Authenticated human context supplied by the host, never by prompt text. */
export type ChatRequester = {
  name: string
  title?: string
  email?: string
  relationship: 'manager' | 'colleague' | 'operator'
}
