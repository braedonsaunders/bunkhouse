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

console.log('system credentials: raw and encoded secret material is removed before durable errors')
