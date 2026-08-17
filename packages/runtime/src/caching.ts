import type { AiConfig } from '@braedonsaunders/appkit-ai'
import type { ModelMessage } from 'ai'
import { reportsItsOwnCost } from './cost'

/**
 * Not paying twice for the same prefix.
 *
 * Every provider's prompt cache is a *prefix* cache: it matches the longest
 * identical head of the request — tools, then system, then messages, in that
 * order — and bills it at a fraction of the input price. A tool-using run is
 * the ideal shape for it, because each step appends to the tail and leaves the
 * head alone. A measured run re-bought the same 300,000-token head twenty-six
 * times.
 *
 * Three things have to be true before a cache actually hits, and only one of
 * them is a flag:
 *
 * 1. **The head must not move.** This is the one that is easy to break and
 *    invisible when broken — see the stride in compaction.ts, which exists
 *    entirely so that trimming history does not rewrite the prefix every step.
 * 2. **The request must reach the same upstream.** A gateway that load-balances
 *    across providers will route step two somewhere that has never seen step
 *    one, and the cache is cold every time through no fault of the prompt.
 * 3. **Some providers need to be told where the reusable part ends.** Anthropic
 *    and Gemini want an explicit breakpoint; Moonshot, DeepSeek, Z.AI, OpenAI,
 *    Groq and Grok cache automatically and need nothing at all.
 */

/** Sticky routing so a run's steps keep landing on the same upstream. */
type SessionPinning = { session_id: string }

/**
 * Ask the gateway to pin this run to one upstream.
 *
 * OpenRouter may serve one model id from several providers, each with its own
 * cache. Without a session key the steps of a single run scatter across them
 * and every step pays full price for a prefix that some other provider is
 * holding. The run id is exactly the right key: stable for the life of the
 * work, different for the next piece of it.
 */
export function sessionPinningOptions(
  ai: AiConfig,
  runId: string | null | undefined,
): Record<string, SessionPinning> | undefined {
  if (!runId || !reportsItsOwnCost(ai)) return undefined
  // OpenRouter caps the key at 256 characters; a run id is a uuid.
  const pin = { session_id: runId.slice(0, 256) }
  return ai.provider === 'openrouter' ? { openrouter: pin } : { openrouter: pin, custom: pin }
}

/**
 * Providers that must be shown where the cacheable prefix ends.
 *
 * Only the ones reached directly are listed. Through a gateway the request is
 * an OpenAI-shaped body and part-level cache directives do not survive the
 * translation, so there is nothing useful to attach — which is fine, because
 * every model this deployment routes through the gateway caches on its own.
 */
function needsExplicitBreakpoint(ai: AiConfig): boolean {
  return ai.provider === 'anthropic'
}

/**
 * The system prompt as a message, marked as the end of the reusable prefix.
 *
 * It is the right and only breakpoint worth spending here: an agent's identity,
 * its company, its directory, its procedures and its recalled logbook are
 * assembled once and are then byte-identical for every step of the run, while
 * everything after them changes constantly. Anthropic allows four breakpoints;
 * one at the end of the largest stable block collects almost all of the saving,
 * and spending the others on a moving tail would only churn the cache.
 *
 * Returns null when the provider caches by itself, so the caller keeps passing
 * an ordinary system string and nothing is disturbed.
 */
export function cachedSystemMessage(ai: AiConfig, system: string): ModelMessage | null {
  if (!needsExplicitBreakpoint(ai) || !system) return null
  return {
    role: 'system',
    content: system,
    providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
  }
}

/** Cache reads reported by the provider, where it reports them. */
export function cachedInputTokens(usage: { cachedInputTokens?: number } | undefined): number {
  const cached = usage?.cachedInputTokens
  return typeof cached === 'number' && Number.isFinite(cached) && cached > 0 ? cached : 0
}
