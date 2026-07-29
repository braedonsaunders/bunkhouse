import type { AiConfig } from '@appkit/ai'

/**
 * Money the provider itself reports, rather than money we work out.
 *
 * A price table can only ever produce an estimate: a gateway routes one model
 * id to whichever upstream is cheapest or up right now, prices each of them
 * differently, and discounts cache reads — none of which is visible in a token
 * count. Where a provider will simply tell us what the call cost, that number
 * is the truth and the table is the fallback.
 *
 * OpenRouter is the provider that does. Asking costs nothing but a flag on the
 * request; the answer rides back on the response body next to the token counts.
 */

/** OpenRouter's own host, and the flag that turns cost reporting on. */
const OPENROUTER_HOST = 'openrouter.ai'

/**
 * Whether this configuration talks to OpenRouter — either as the named
 * provider, or as a `custom` endpoint an operator has pointed at the gateway
 * themselves. Both bill the same way, so both should be asked the same question.
 */
export function reportsItsOwnCost(ai: AiConfig): boolean {
  if (ai.provider === 'openrouter') return true
  const baseUrl = ai.baseUrl?.trim()
  if (!baseUrl) return false
  try {
    return new URL(baseUrl).hostname.endsWith(OPENROUTER_HOST)
  } catch {
    return false
  }
}

/** The flag itself, shaped as the request body wants it. */
type UsageAccounting = { usage: { include: boolean } }

/**
 * Provider options that ask for usage accounting. The AI SDK passes unknown
 * keys under a provider's own namespace straight through to the request body,
 * which is exactly where OpenRouter looks for this flag.
 */
export function usageAccountingOptions(ai: AiConfig): Record<string, UsageAccounting> | undefined {
  if (!reportsItsOwnCost(ai)) return undefined
  // The namespace is the provider name the model was built with; a `custom`
  // endpoint aimed at the gateway is still constructed under its own name, so
  // both are offered and the one that does not match is ignored.
  const flag = { usage: { include: true } }
  return ai.provider === 'openrouter' ? { openrouter: flag } : { openrouter: flag, custom: flag }
}

type UsageWithCost = { cost?: unknown; cost_details?: { upstream_inference_cost?: unknown } }

/**
 * The USD this step actually cost, read off the raw response body, or null when
 * the provider said nothing. Null is a real answer — it means fall back to the
 * price table — so a malformed or absent figure must never become 0.
 */
export function reportedCostUsd(body: unknown): number | null {
  if (typeof body !== 'object' || body === null) return null
  const usage = (body as { usage?: UsageWithCost }).usage
  if (typeof usage !== 'object' || usage === null) return null
  const cost = Number(usage.cost)
  if (!Number.isFinite(cost) || cost < 0) return null
  return cost
}
