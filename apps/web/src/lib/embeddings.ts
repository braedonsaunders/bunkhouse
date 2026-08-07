import 'server-only'
import { unsealSecret } from '@appkit/crypto'
import { listAiProviders } from './ai'

/**
 * Turning text into a vector, for semantic recall in the Logbook.
 *
 * Deliberately small and deliberately optional. Retrieval worked before this
 * existed and must keep working when it fails: a company with no suitable
 * provider, a key that has lapsed, an embedding endpoint having a bad
 * afternoon. Every function here answers null rather than throwing, and the
 * caller falls back to the lexical leg — a slightly worse search is a fine
 * outcome, an agent that cannot save a note is not.
 */

/**
 * The model, and the number that has to match the column. `vector(1536)` is
 * declared in the migration, so a model of any other width cannot be swapped in
 * without one — which is the point of naming the dimension here beside it.
 */
const EMBEDDING_MODEL = 'text-embedding-3-small'
export const EMBEDDING_DIMENSIONS = 1536

/** How many notes may be embedded in one request to the provider. */
const BATCH = 64

/**
 * A provider that speaks the OpenAI embeddings protocol. OpenAI itself, or
 * anything OpenAI-compatible with a base URL — which covers the way this
 * company already configures its models. Gemini's embeddings API is a
 * different shape and is not attempted rather than half-supported.
 */
async function embeddingProvider(
  tenantId: string,
): Promise<{ apiKey: string; baseUrl: string } | null> {
  const providers = await listAiProviders(tenantId)
  // Prefer OpenAI proper: it is the one whose default base URL is known to
  // serve this model. An OpenAI-compatible aggregator is taken only when it
  // carries its own base URL, since guessing one would be a wrong request to
  // somebody's endpoint rather than a clean "no embeddings here".
  const candidates = providers.filter(
    (entry) => entry.provider === 'openai' || (entry.provider === 'openai-compatible' && entry.baseUrl),
  )
  const preferred = candidates.find((entry) => entry.provider === 'openai') ?? candidates[0]
  if (!preferred) return null
  const apiKey = unsealSecret(preferred.sealedApiKey)
  if (apiKey === null) return null
  return { apiKey, baseUrl: preferred.baseUrl ?? 'https://api.openai.com/v1' }
}

/** One batch, one request. Null on any failure — never throws at a caller. */
async function embedBatch(
  provider: { apiKey: string; baseUrl: string },
  inputs: string[],
): Promise<number[][] | null> {
  try {
    const response = await fetch(`${provider.baseUrl.replace(/\/$/, '')}/embeddings`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${provider.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: EMBEDDING_MODEL, input: inputs }),
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok) {
      console.error(`[memory] embeddings refused: HTTP ${response.status} ${(await response.text()).slice(0, 200)}`)
      return null
    }
    const body = (await response.json()) as { data?: { index: number; embedding: number[] }[] }
    if (!body.data || body.data.length !== inputs.length) return null
    // The API is documented to return them in order, but the index is there to
    // be used and a silently transposed pair of note vectors would be a
    // horrible thing to debug.
    const ordered: number[][] = new Array(inputs.length)
    for (const item of body.data) ordered[item.index] = item.embedding
    return ordered.every((vector) => Array.isArray(vector) && vector.length === EMBEDDING_DIMENSIONS)
      ? ordered
      : null
  } catch (error) {
    console.error(`[memory] embeddings unavailable: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}

/**
 * Embed many texts, in order. Returns null when embeddings are unavailable at
 * all; individual batches that fail come back as nulls in place.
 */
export async function embedTexts(tenantId: string, texts: string[]): Promise<(number[] | null)[] | null> {
  if (texts.length === 0) return []
  const provider = await embeddingProvider(tenantId)
  if (!provider) return null
  const out: (number[] | null)[] = []
  for (let start = 0; start < texts.length; start += BATCH) {
    const slice = texts.slice(start, start + BATCH).map((text) => text.slice(0, 8_000))
    const vectors = await embedBatch(provider, slice)
    for (let index = 0; index < slice.length; index += 1) out.push(vectors?.[index] ?? null)
  }
  return out
}

/** Embed one text. Null when it could not be done, for any reason. */
export async function embedText(tenantId: string, text: string): Promise<number[] | null> {
  const [vector] = (await embedTexts(tenantId, [text])) ?? []
  return vector ?? null
}

/** How a note is rendered for embedding: the title carries most of the signal. */
export function embeddableText(title: string, body: string): string {
  return `${title}\n\n${body}`.trim()
}

/** pgvector's literal form. Postgres takes it as text and casts. */
export function toVectorLiteral(vector: number[]): string {
  return `[${vector.join(',')}]`
}
