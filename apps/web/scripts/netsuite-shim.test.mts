/**
 * The NetSuite MCP shim, against a fake of Oracle's hosted server.
 *
 * The behaviours under test were all measured on a live account first (run
 * e8feac83, 2026-08-05): the opaque SuiteQL error for alias-qualified unknown
 * columns, the Balance Sheet demanding the only subsidiary the account has,
 * and failures shipped with isError false.
 */
import assert from 'node:assert/strict'
import type { ToolSet } from 'ai'
import { isNetsuiteMcp, shimNetsuiteTools } from '@bunkhouse/runtime'

const text = (value: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(value) }], isError: false })
const textOf = (result: unknown) =>
  ((result as { content: { text: string }[] }).content ?? []).map((part) => part.text).join(' ')
const opts = { toolCallId: 't', messages: [] } as never

// --- recognising the server -------------------------------------------------
assert.equal(
  isNetsuiteMcp('https://8638714.suitetalk.api.netsuite.com/services/mcp/v1/suiteapp/com.netsuite.mcpstandardtools'),
  true,
)
assert.equal(isNetsuiteMcp('https://mcp.example.com/netsuite'), false, 'a lookalike path is not the vendor host')
assert.equal(isNetsuiteMcp('not a url'), false)

// --- the opaque SuiteQL error gains the verified hint ------------------------
{
  const tools = {
    ns_runCustomSuiteQL: {
      execute: async () => text({ error: 'Error executing SuiteQL query: An unexpected SuiteScript error has occurred' }),
    },
  } as unknown as ToolSet
  const shimmed = shimNetsuiteTools(tools)
  const result = (await shimmed.ns_runCustomSuiteQL!.execute!({ sqlQuery: 'SELECT a.accounttype FROM account a' } as never, opts)) as {
    isError?: boolean
  }
  assert.equal(result.isError, true, 'an error-shaped answer is marked as one')
  assert.ok(textOf(result).includes('accttype'), 'the hint names the verified example')
  assert.ok(textOf(result).includes('without table aliases'), 'the hint says how to get the real identifier error')
}

// --- a clean result passes through untouched ---------------------------------
{
  const clean = text({ data: [{ id: 1 }] })
  const tools = { ns_runCustomSuiteQL: { execute: async () => clean } } as unknown as ToolSet
  const result = await shimNetsuiteTools(tools).ns_runCustomSuiteQL!.execute!({} as never, opts)
  assert.deepEqual(result, clean, 'data is not rewrapped')
}

// --- the lone subsidiary is supplied on retry --------------------------------
{
  const calls: unknown[] = []
  const tools = {
    ns_runReport: {
      execute: async (input: { subsidiaryId?: number }) => {
        calls.push(input)
        return input.subsidiaryId === undefined
          ? text({ error: 'Unable to run report -202 Balance Sheet. Invalid subsidiaryId: Value is required.' })
          : text({ reportData: { rows: 3 } })
      },
    },
    ns_getSubsidiaries: { execute: async () => text([{ id: '1', name: 'Rassaun Services Inc.' }]) },
  } as unknown as ToolSet
  const shimmed = shimNetsuiteTools(tools)
  const result = (await shimmed.ns_runReport!.execute!({ reportId: -202 } as never, opts)) as { isError?: boolean }
  assert.notEqual(result.isError, true, 'the retry with the only subsidiary succeeds')
  assert.ok(textOf(result).includes('reportData'), 'the report itself comes back')
  assert.deepEqual(calls, [{ reportId: -202 }, { reportId: -202, subsidiaryId: 1 }], 'exactly one informed retry')
}

// --- more than one subsidiary is the model's choice, not the shim's ----------
{
  const tools = {
    ns_runReport: {
      execute: async () => text({ error: 'Invalid subsidiaryId: Value is required.' }),
    },
    ns_getSubsidiaries: {
      execute: async () => text([{ id: '1' }, { id: '2' }]),
    },
  } as unknown as ToolSet
  const result = (await shimNetsuiteTools(tools).ns_runReport!.execute!({ reportId: -202 } as never, opts)) as {
    isError?: boolean
  }
  assert.equal(result.isError, true, 'the original error stands, marked')
  assert.ok(textOf(result).includes('Value is required'), 'and keeps its own words')
}

// --- an explicit subsidiaryId that fails is not second-guessed ----------------
{
  let listed = 0
  const tools = {
    ns_runReport: { execute: async () => text({ error: 'Invalid subsidiaryId: Value is required.' }) },
    ns_getSubsidiaries: {
      execute: async () => {
        listed += 1
        return text([{ id: '1' }])
      },
    },
  } as unknown as ToolSet
  await shimNetsuiteTools(tools).ns_runReport!.execute!({ reportId: -202, subsidiaryId: 9 } as never, opts)
  assert.equal(listed, 0, 'the caller chose a subsidiary; the shim stays out of it')
}

console.log('netsuite shim: opaque errors explained, the lone subsidiary supplied, failures marked as failures')
