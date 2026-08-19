import { redactSecrets } from '@bunkhouse/runtime'

/**
 * Network stacks may print query credentials either raw, percent-encoded, or
 * application/x-www-form-urlencoded. Durable health and request errors must
 * remove every representation before they are stored.
 */
export function redactCredentialText(message: string, credential: string | undefined): string {
  if (!credential) return message
  const formEncoded = new URLSearchParams({ value: credential }).toString().slice('value='.length)
  return redactSecrets(message, [credential, encodeURIComponent(credential), formEncoded])
}
