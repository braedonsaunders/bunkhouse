/**
 * The company's own email domains, as pure functions.
 *
 * Deliberately free of any server import so the settings form can normalize a
 * typed-in domain exactly the way the action that stores it will — a chip that
 * says "@Rassaun.COM" while the database holds "rassaun.com" is the operator
 * and the system disagreeing about what was just saved.
 *
 * Domains are matched whole, on a dot boundary: `rassaun.com` covers
 * `bsaunders@rassaun.com` and `x@mail.rassaun.com`, and never
 * `x@notrassaun.com`.
 */

/**
 * The domain part of an address, lowercased — or null when there isn't one.
 * Tolerates a bare domain being passed in, which is what the settings hold.
 */
function domainOf(address: string): string | null {
  const at = address.lastIndexOf('@')
  const domain = (at >= 0 ? address.slice(at + 1) : address).trim().toLowerCase()
  return domain || null
}

/**
 * A typed-in domain, reduced to the bare thing that can be compared: accepts
 * "@rassaun.com", "https://rassaun.com/careers", "Bob@Rassaun.com" and
 * "rassaun.com" alike. Returns null for anything that is not a domain.
 */
export function normalizeDomain(raw: string): string | null {
  let value = raw.trim().toLowerCase()
  if (!value) return null
  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
  value = value.split('/')[0] ?? ''
  const domain = domainOf(value)
  if (!domain) return null
  // A domain has at least one dot and no whitespace or address punctuation;
  // anything else is a typo the operator should see rather than a silent drop.
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain)) return null
  return domain
}

/** Is this address at one of the company's own domains? */
export function matchesInternalDomain(address: string, domains: readonly string[]): boolean {
  const domain = domainOf(address)
  if (!domain) return false
  return domains.some((candidate) => domain === candidate || domain.endsWith(`.${candidate}`))
}
