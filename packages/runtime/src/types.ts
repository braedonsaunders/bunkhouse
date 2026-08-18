import type { AiConfig } from '@braedonsaunders/appkit-ai'
import type { ModelMessage } from 'ai'

/** The governed action categories. Must stay in sync with the app's
 *  `action_category` enum — the dial is enforced here, not in prompts.
 *  The pg enum still carries the retired 'shell' and 'computer_use' values
 *  (postgres cannot drop them); they are deliberately absent here so no
 *  ability can be defined against a retired dial. */
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

export type AgentPersonality = {
  bio: string
  tone: string[]
  signoff: string
}

/** Everything the loop needs to know about the agent it is running. */
export type AgentProfile = {
  id: string
  name: string
  title: string
  email: string
  personality: AgentPersonality
  /** Provider + model for THIS agent; different agents run different models. */
  ai: AiConfig
  temperature?: number
  responsibilities?: string
  /** This agent's manager on the org chart — its escalation path. */
  reportsToId?: string
  proactivity: 'reactive' | 'duties' | 'autonomous'
  /** IANA zone this agent works in; the clock its working day is read against. */
  timezone?: string | null
  /**
   * The company signature is appended mechanically on the send path, so the
   * agent must not type a sign-off of its own or the message ends twice.
   */
  signatureAppended?: boolean
}

/** A directory entry — human or agent — the agent may route work to. */
export type DirectoryEntry = {
  id: string
  kind: 'human' | 'agent'
  name: string
  title: string
  email: string
  responsibilities?: string
  reportsToId?: string
}

/**
 * The company an agent works for, as the operator maintains it. Everything
 * here is stated by the business about itself — an agent may repeat it to a
 * customer, so nothing may be inferred or embellished downstream.
 */
export type CompanyIdentity = {
  legalName?: string
  tagline?: string
  industry?: string
  websiteUrl?: string
  /** Services or products offered. */
  services?: string[]
  serviceArea?: string
  /** Who the company serves. */
  customers?: string[]
  differentiators?: string[]
  values?: string[]
  /** How the company writes and speaks; sits under the agent's own tone. */
  brandVoice?: string
  hours?: string
  contact?: { phone?: string; email?: string; address?: string }
  /** Anything else every agent should know, in markdown. */
  notes?: string
}

export type CompanyProfile = {
  name: string
  description?: string
  identity?: CompanyIdentity
  directory: DirectoryEntry[]
}

/** An active procedure revision bound to this agent, loaded verbatim. */
export type BoundProcedure = {
  id: string
  slug: string
  title: string
  version: number
  body: string
}

/** A human-readable memory note (agent or company scope). */
export type MemoryNote = {
  scope: 'agent' | 'company'
  slug: string
  title: string
  body: string
}

/** An image the agent should actually look at, inlined into the run's opening turn. */
export type RunInputImage = { filename: string; mediaType: string; dataBase64: string }

/** What triggered this run, rendered into the opening instruction. */
export type RunInput =
  | {
      type: 'email'
      threadSubject: string
      conversation: string
      instruction?: string
      /** Image attachments from the thread, shown to multimodal models. */
      images?: RunInputImage[]
    }
  | { type: 'duty'; dutyTitle: string; instruction: string }
  | { type: 'chat'; message: string }
  | { type: 'delegation'; fromName: string; instruction: string }
  | { type: 'manual'; instruction: string }
  | {
      /** A committed deliverable: produce the work product and deliver it. */
      type: 'assignment'
      title: string
      spec: string
      deliverTo: { name?: string; address: string }
      formats?: string[]
      dueAt?: string
      /** Where the commitment was made, for the agent's own context. */
      source?: string
    }
  | {
      /** Continuation of a run that asked someone and waited: the answer (or silence). */
      type: 'reply_received'
      question: string
      askedOf: string
      /** Null when the wait timed out with no answer after a nudge. */
      reply: { fromName?: string; fromAddress: string; text: string } | null
      daysWaited?: number
    }
  | {
      /** Continuation of a suspended run after a human decided its approval. */
      type: 'approval_decision'
      decision: 'approved' | 'declined'
      description: string
      /** Present when the approved action was executed on the agent's behalf. */
      result?: unknown
      note?: string
    }

export type RunEvent =
  | { kind: 'message'; text: string }
  | { kind: 'tool_call'; toolName: string; category: ActionCategory | null; input: unknown }
  | { kind: 'tool_result'; toolName: string; output: unknown }
  | { kind: 'procedure_citation'; slug: string; version: number }
  /** An installed skill's instructions were disclosed to the agent mid-run. */
  | { kind: 'skill_loaded'; slug: string; version: number }
  | { kind: 'approval_request'; approvalId: string; category: ActionCategory; description: string }
  | { kind: 'error'; message: string }

export type TokenUsage = {
  inputTokens: number
  outputTokens: number
  /**
   * Input tokens the provider served from its prompt cache rather than reading
   * afresh. They are already counted inside inputTokens — this is the portion
   * of them that was cheap — so it is banked beside the total rather than
   * subtracted from it, and a run's cache hit rate stops being invisible.
   */
  cachedInputTokens?: number
}

/**
 * What one model call actually cost, as the provider itself reported it —
 * present only when the provider returns money rather than tokens. Gateways
 * route the same model id to different upstreams at different prices and apply
 * cache discounts, so tokens × a price table can never reconstruct this number.
 * When it is present the sink must bank it verbatim instead of estimating.
 */
export type ReportedCost = { costUsd: number }

/** Injected persistence — the runtime never touches a database directly. */
export type RunSink = {
  event: (event: RunEvent) => Promise<void>
  spend: (usage: TokenUsage & { provider: string; model: string } & Partial<ReportedCost>) => Promise<void>
}

/**
 * The application-owned durable boundary around a tool that can change the
 * outside world. The runtime identifies the exact model tool call; the app
 * persists the intent and its outcome before/after invoking the adapter.
 */
export type ExternalEffectGate = {
  execute: <T>(input: {
    toolName: string
    category: ActionCategory
    idempotencyKey: string
    /** Whether the key names this model invocation or the destination action. */
    idempotencyScope: 'invocation' | 'domain'
    request: unknown
    signal: AbortSignal
    operation: (signal: AbortSignal) => Promise<T>
  }) => Promise<T>
}

/** Resolves the dial for this agent. Missing categories default to 'approval' —
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
  | { status: 'completed'; summary: string; usage: TokenUsage; messages: ModelMessage[] }
  | { status: 'waiting_approval'; approvalId: string; usage: TokenUsage; messages: ModelMessage[] }
  | {
      status: 'waiting_reply'
      wait: { threadId: string; to: string; question: string; nudgeAfterDays: number }
      usage: TokenUsage
      messages: ModelMessage[]
    }
  | { status: 'budget_paused'; usage: TokenUsage; messages: ModelMessage[] }
  /** An operator stopped this run; the work done up to that point is kept. */
  | { status: 'cancelled'; usage: TokenUsage; messages: ModelMessage[] }
  | { status: 'failed'; error: string; usage: TokenUsage; messages: ModelMessage[] }
