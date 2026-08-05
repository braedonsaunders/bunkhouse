// Next.js instrumentation hook — runs once per server boot. First-boot auth
// bootstrap lives here (not in the migrate script) because provisioning the
// owner credential needs Better Auth's own password hasher, which needs the
// full app runtime. Failure is logged, never fatal: a reachable app with a
// clear log beats a crash-looping deployment.

export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return
  try {
    const { ensureOwnerAccount } = await import('./lib/auth')
    await ensureOwnerAccount()
  } catch (error) {
    console.error('[auth] owner bootstrap failed:', error)
  }
  // Membership backfill: any active user without a membership row (the owner
  // account predates memberships) joins the bootstrap tenant. Idempotent.
  try {
    const { ensureMembershipBackfill } = await import('./lib/tenant')
    await ensureMembershipBackfill()
  } catch (error) {
    console.error('[tenant] membership backfill failed:', error)
  }
  // A workspace member is also a human in Bunkhouse's mixed directory. Keep
  // the two records linked after membership backfill so caller identity,
  // reporting lines, and approval routing all resolve to the same colleague.
  try {
    const { ensureMembershipPeopleBackfill } = await import('./lib/person-accounts')
    await ensureMembershipPeopleBackfill()
  } catch (error) {
    console.error('[people] membership reconciliation failed:', error)
  }
}
