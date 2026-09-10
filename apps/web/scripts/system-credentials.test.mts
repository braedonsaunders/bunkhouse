import assert from 'node:assert/strict'
import { redactCredentialText } from '../src/lib/credential-redaction'

const credential = 'x key+/=with?symbols'
const percentEncoded = encodeURIComponent(credential)
const formEncoded = new URLSearchParams({ value: credential }).toString().slice('value='.length)
const message = `raw=${credential}; percent=${percentEncoded}; form=${formEncoded}`
const redacted = redactCredentialText(message, credential)

assert.equal(redacted.includes(credential), false, 'raw credential is removed')
assert.equal(redacted.includes(percentEncoded), false, 'URL-encoded credential is removed')
assert.equal(redacted.includes(formEncoded), false, 'form-encoded credential is removed')
assert.equal(redacted, 'raw=[redacted]; percent=[redacted]; form=[redacted]')
assert.equal(redactCredentialText('ordinary failure', undefined), 'ordinary failure')

// --- declining a handoff ends the work parked behind it ----------------------
//
// Only `stored` resumes a parked run: the continuation is reached from
// `pendingStoredCredentialContinuationIds`, which asks for `status = 'stored'`
// and nothing else. Cancelling settled the request and left the run it belonged
// to sitting in `waiting_credential` with nothing in the system able to move it
// again — observed on the live tenant, a run still claiming to wait on a request
// that had been answered five minutes after it was asked. The abandoned-work
// sweep cannot reach it either, because that sweep only looks at runs still
// claiming to be `running`.
{
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../src/lib/system-credential-requests.ts', import.meta.url), 'utf8')
  const cancel = src.slice(src.indexOf('export async function cancelSystemCredentialRequest'))

  assert.match(cancel, /update\(runs\)/, 'cancelling closes the run it parked')
  assert.match(cancel, /status: 'cancelled'/, 'and nothing failed — a person answered')
  assert.match(
    cancel,
    /eq\(runs\.status, 'waiting_credential'\)/,
    'scoped to a run that is still parked, so a run that moved on is untouched',
  )
  assert.match(cancel, /eq\(runs\.id, request\.runId\)/, 'and only to the run this request belongs to')
  assert.match(cancel, /appendRunEventInTransaction/, 'the conversation is told why the work stopped')
  // One transaction: a settled request with an open run is the state this fixes.
  assert.ok(
    cancel.indexOf('update(runs)') < cancel.indexOf('}))'),
    'the run is closed inside the transaction that settles the request',
  )
}

console.log('system credentials: raw and encoded secret material is removed before durable errors')
