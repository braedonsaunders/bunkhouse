import { createHmac, timingSafeEqual } from 'node:crypto'

export type DeskHandoverScope = 'view' | 'control'

function digest(secret: string, value: string): string {
  return createHmac('sha256', secret).update(value).digest('base64url')
}

function equal(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** Bind every authenticated runner call to the desk named by its route. */
export function deskIdentity(secret: string, deskId: string): string {
  return digest(secret, `desk-v1\nidentity\n${deskId}`)
}

export function deskIdentityMatches(secret: string, deskId: string, offered: string): boolean {
  return equal(deskIdentity(secret, deskId), offered)
}

export type DeskHandoverCapability = {
  deskId: string
  scope: DeskHandoverScope
  expiresAt: number
  nonce: string
}

function capabilityPayload(value: DeskHandoverCapability): string {
  return `desk-v1\nhandover\n${value.deskId}\n${value.scope}\n${value.expiresAt}\n${value.nonce}`
}

/** A least-privilege browser credential: one desk, one scope, one deadline. */
export function signDeskHandoverCapability(secret: string, value: DeskHandoverCapability): string {
  return digest(secret, capabilityPayload(value))
}

export function verifyDeskHandoverCapability(
  secret: string,
  value: DeskHandoverCapability,
  offered: string,
  now = Date.now(),
): boolean {
  if (!Number.isSafeInteger(value.expiresAt) || value.expiresAt <= now || value.nonce.length < 16) return false
  return equal(signDeskHandoverCapability(secret, value), offered)
}
