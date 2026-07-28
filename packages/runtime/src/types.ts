import type { AiConfig } from '@appkit/ai'

/** The governed action categories. Must stay in sync with the app's
 *  `action_category` enum — the dial is enforced here, not in prompts. */
export type ActionCategory =
  | 'external_email'
  | 'internal_email'
  | 'record_write'
  | 'money_adjacent'
  | 'file_write'
  | 'computer_use'
  | 'shell'
  | 'phone_call'

export type AutonomyLevel = 'forbidden' | 'approval' | 'notify' | 'trusted'

export type HandPersonality = {
  bio: string
  tone: string[]
  signoff: string
}

/** Everything the loop needs to know about the hand it is running. */
export type HandProfile = {
  id: string
  name: string
  title: string
  email: string
  personality: HandPersonality
  /** Provider + model for THIS hand; different hands run different models. */
  ai: AiConfig
  temperature?: number
  responsibilities?: string
  proactivity: 'reactive' | 'duties' | 'autonomous'
}

/** A directory entry — human or hand — the hand may route work to. */
export type DirectoryEntry = {
  id: string
  kind: 'human' | 'hand'
  name: string
  title: string
  email: string
  responsibilities?: string
  reportsToId?: string
}

export type CompanyProfile = {
  name: string
  description?: string
  directory: DirectoryEntry[]
}

/** An active procedure revision bound to this hand, loaded verbatim. */
export type BoundProcedure = {
  id: string
  slug: string
  title: string
  version: number
  body: string
}

/** A human-readable memory note (hand or company scope). */
export type MemoryNote = {
  scope: 'hand' | 'company'
  slug: string
  title: string
  body: string
}

/** What triggered this run, rendered into the opening instruction. */
export type RunInput =
  | { type: 'email'; threadSubject: string; conversation: string; instruction?: string }
  | { type: 'duty'; dutyTitle: string; instruction: string }
  | { type: 'chat'; message: string }
  | { type: 'delegation'; fromName: string; instruction: string }
  | { type: 'manual'; instruction: string }

export type RunEvent =
  | { kind: 'message'; text: string }
  | { kind: 'tool_call'; toolName: string; category: ActionCategory | null; input: unknown }
  | { kind: 'tool_result'; toolName: string; output: unknown }
  | { kind: 'procedure_citation'; slug: string; version: number }
  | { kind: 'approval_request'; approvalId: string; category: ActionCategory; description: string }
  | { kind: 'error'; message: string }

export type TokenUsage = { inputTokens: number; outputTokens: number }

/** Injected persistence — the runtime never touches a database directly. */
export type RunSink = {
  event: (event: RunEvent) => Promise<void>
  spend: (usage: TokenUsage & { provider: string; model: string }) => Promise<void>
}

/** Resolves the dial for this hand. Missing categories default to 'approval' —
 *  the safe posture for anything nobody configured. */
export type AutonomyResolver = (category: ActionCategory) => AutonomyLevel

/** Files an approval request and returns its id; the run suspends on it. */
export type ApprovalGate = {
  request: (input: {
    category: ActionCategory
    description: string
    action: Record<string, unknown>
  }) => Promise<{ approvalId: string }>
}

/** Salary meter. `remainingUsd` < 0 means over budget (overtime territory). */
export type BudgetMeter = {
  remainingUsd: () => Promise<number>
  overagePolicy: 'pause' | 'overtime' | 'ask'
}

export type RunOutcome =
  | { status: 'completed'; summary: string; usage: TokenUsage }
  | { status: 'waiting_approval'; approvalId: string; usage: TokenUsage }
  | { status: 'budget_paused'; usage: TokenUsage }
  | { status: 'failed'; error: string; usage: TokenUsage }
