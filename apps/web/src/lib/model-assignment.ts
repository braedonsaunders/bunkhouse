import type { AgentModelConfig } from '../db/schema'

/**
 * How an agent's two brains read on screen. An agent works with one model and
 * answers on a call with another; the roster and the record must say the same
 * thing about them, so both read it from here.
 *
 * The call model is optional on the record. Left unset, the agent answers with
 * the provider's own quick model, and failing that with the model it works
 * with — the same chain `resolveAgentAiConfig` applies at run time. These
 * summaries name whichever one is actually in force, so nothing on screen
 * claims a model the agent will not use.
 */

/** Roster cell: the working model, plus the call model whenever it differs. */
export function rosterModelCell(config: AgentModelConfig | null): string {
  if (!config) return 'Not assigned'
  const assigned = `${config.provider} / ${config.model}`
  return config.modelFast && config.modelFast !== config.model
    ? `${assigned} · ${config.modelFast} on calls`
    : assigned
}

/** The record card's description: one sentence covering both choices. */
export function assignedModelsSummary(
  config: AgentModelConfig | null,
  /** The provider's own quick model, used when the agent names none. */
  providerFast?: string | undefined,
): string {
  if (!config) return 'Not assigned yet — this agent cannot work without a brain.'
  const lead = `${config.provider} — ${config.model} for their work`
  if (config.modelFast) return `${lead}, ${config.modelFast} on a call.`
  if (providerFast) return `${lead}; on a call they answer with ${providerFast}, this provider's quick model.`
  return `${lead}, and the same model on a call.`
}
