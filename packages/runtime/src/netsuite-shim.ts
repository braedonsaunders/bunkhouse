import type { ToolSet } from 'ai'

/**
 * Client-side ergonomics for NetSuite's hosted MCP (the standard-tools
 * SuiteApp on suitetalk.api.netsuite.com). Oracle's server; we cannot fix it,
 * only stand between it and the model. Three measured failures on one live
 * call cost the caller two and a half minutes, and each has a shim here:
 *
 * 1. `ns_runCustomSuiteQL` answers "An unexpected SuiteScript error has
 *    occurred" — nothing else — whenever an unknown column is qualified with a
 *    table alias. Verified against the live account: `SELECT accounttype FROM
 *    account` names the unknown identifier in its error; `SELECT a.accounttype
 *    FROM account a` returns only the generic line. (Whitespace was the first
 *    suspect and is innocent: the same queries with embedded newlines and tabs
 *    all ran clean.) The model that wrote the query cannot tell a bad column
 *    from a broken server, so it retries blind. The shim appends what was
 *    actually learned: check the column names, or drop the aliases so the
 *    server names the unknown identifier.
 *
 * 2. `ns_runReport` demands `subsidiaryId` even when the account has exactly
 *    one subsidiary — the only possible value costs the model a discovery
 *    round trip every time. The shim answers the error itself: fetch the
 *    subsidiaries, and when there is exactly one, retry with it.
 *
 * 3. Failures come back as ordinary results — `{"error": ...}` in the text
 *    with `isError: false` — so nothing downstream can tell them apart from
 *    data without parsing the payload. The shim marks them.
 */

/** The hosted MCP this shim understands, recognised by its home. */
export function isNetsuiteMcp(url: string): boolean {
  try {
    return new URL(url).hostname.endsWith('.suitetalk.api.netsuite.com')
  } catch {
    return false
  }
}

type McpContent = { type: string; text?: string }
type McpResult = { content?: McpContent[]; isError?: boolean }

/** The joined text of an MCP result, or null when there is none. */
function textOf(result: unknown): string | null {
  const content = (result as McpResult | null)?.content
  if (!Array.isArray(content)) return null
  const text = content
    .map((part) => (typeof part?.text === 'string' ? part.text : ''))
    .join(' ')
    .trim()
  return text || null
}

/** The `error` string inside a NetSuite tool's JSON answer, or null. */
function errorOf(result: unknown): string | null {
  const text = textOf(result)
  if (!text) return null
  try {
    const parsed = JSON.parse(text) as { error?: unknown }
    return typeof parsed.error === 'string' && parsed.error.trim() ? parsed.error.trim() : null
  } catch {
    return null
  }
}

/** Replace the result's text wholesale, keeping the MCP shape. */
function withText(result: unknown, text: string, isError: boolean): McpResult {
  const base = (result ?? {}) as McpResult
  return { ...base, content: [{ type: 'text', text }], isError }
}

const OPAQUE_SUITEQL_ERROR = 'An unexpected SuiteScript error has occurred'

const SUITEQL_HINT =
  'This generic NetSuite failure most often means a column name that does not exist on the table: with a table alias (a.accounttype) NetSuite hides its real "Unknown identifier" message behind this line. Check every column against the SuiteQL schema (for example the account table’s type column is accttype, not accounttype), or rerun the query without table aliases — the error will then name the unknown identifier.'

const SUBSIDIARY_REQUIRED = /invalid subsidiaryid.*value is required/i

type Execute = (input: never, options: never) => PromiseLike<unknown> | unknown

/**
 * Wrap one server's tools. `tools` is keyed by the server's own names
 * (ns_runCustomSuiteQL, ...) — namespacing happens after this.
 */
export function shimNetsuiteTools(tools: ToolSet): ToolSet {
  const subsidiaries = tools['ns_getSubsidiaries']
  const shimmed: ToolSet = {}
  for (const [name, tool] of Object.entries(tools)) {
    if (!tool.execute) {
      shimmed[name] = tool
      continue
    }
    const execute = tool.execute.bind(tool) as Execute
    const wrapped = async (input: never, options: never): Promise<unknown> => {
      let result = await execute(input, options)
      let error = errorOf(result)
      if (error === null) return result

      if (name === 'ns_runCustomSuiteQL' && error.includes(OPAQUE_SUITEQL_ERROR)) {
        return withText(result, JSON.stringify({ error, hint: SUITEQL_HINT }), true)
      }

      if (
        name === 'ns_runReport' &&
        SUBSIDIARY_REQUIRED.test(error) &&
        (input as { subsidiaryId?: unknown } | null)?.subsidiaryId === undefined &&
        subsidiaries?.execute
      ) {
        // The report wants the one value the account can possibly have. Ask
        // for the list; with exactly one entry the retry is not a guess, and
        // with any other count the original error stands — choosing among
        // subsidiaries is the model's call, not this shim's.
        try {
          const listed = await (subsidiaries.execute.bind(subsidiaries) as Execute)({} as never, options)
          const text = textOf(listed)
          const entries = text ? (JSON.parse(text) as { id?: unknown }[]) : []
          const only = Array.isArray(entries) && entries.length === 1 ? entries[0] : null
          const id = only ? Number(only.id) : Number.NaN
          if (Number.isFinite(id)) {
            result = await execute({ ...(input as object), subsidiaryId: id } as never, options)
            error = errorOf(result)
            if (error === null) return result
          }
        } catch {
          // The listing failed; the original error is still the true story.
        }
      }

      // Any error-shaped answer is marked as one, so the ledger and anything
      // else downstream can tell a failure from data without parsing it.
      const base = (result ?? {}) as McpResult
      return base.isError ? result : { ...base, isError: true }
    }
    shimmed[name] = { ...tool, execute: wrapped as typeof tool.execute }
  }
  return shimmed
}
