import 'server-only'

import { and, eq, inArray, sql } from 'drizzle-orm'
import { authAccounts, auditLog, memberships, users } from '@braedonsaunders/appkit-db'
import { db } from '../db/client'
import { people } from '../db/schema'
import type { SessionUser } from './auth'

const LEGACY_OWNER_EMAIL = 'owner@bunkhouse.local'

export type PersonAccountOption = {
  userId: string
  name: string
  email: string
  isActive: boolean
  membershipStatus: 'active' | 'invited' | 'suspended' | null
  linkedPersonId: string | null
  linkedPersonName: string | null
}

export type PersonAccountAccess = {
  current: {
    userId: string
    name: string
    email: string
    isActive: boolean
    membershipStatus: 'active' | 'invited' | 'suspended' | null
  } | null
  options: PersonAccountOption[]
}

function normalEmail(value: string): string {
  return value.trim().toLowerCase()
}

function defaultTitle(name: string): string {
  return name.trim().toLowerCase() === 'owner' ? 'Owner' : 'Team member'
}

/**
 * Make one workspace membership visible in the mixed company directory.
 *
 * This is deliberately a Bunkhouse domain service rather than an AppKit
 * identity hook: a login can represent a customer, vendor, or staff record in
 * another product, while here every workspace member is a human colleague.
 * The transaction takes a stable advisory lock so boot reconciliation and an
 * administrator adding the same member cannot create two people.
 */
export async function ensurePersonForMembership(args: {
  tenantId: string
  userId: string
  actorUserId?: string | null
  /** The configured bootstrap owner may adopt the old seeded manager record. */
  adoptLegacyOwner?: boolean
}): Promise<{ personId: string; created: boolean }> {
  const app = db()
  return app.superDb.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`person-account:${args.tenantId}:${args.userId}`}, 0))`,
    )

    const [member] = await tx
      .select({
        membershipId: memberships.id,
        membershipStatus: memberships.status,
        displayName: memberships.displayName,
        userId: users.id,
        name: users.name,
        email: users.email,
        isActive: users.isActive,
      })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(and(eq(memberships.tenantId, args.tenantId), eq(memberships.userId, args.userId)))
      .limit(1)
    if (!member) throw new Error('That account is not a member of this workspace.')
    if (!['active', 'invited'].includes(member.membershipStatus)) {
      throw new Error('Suspended workspace memberships are not added to the People directory.')
    }

    const [linked] = await tx
      .select({ id: people.id })
      .from(people)
      .where(and(eq(people.tenantId, args.tenantId), eq(people.userId, member.userId)))
      .limit(1)
    if (linked) return { personId: linked.id, created: false }

    const email = normalEmail(member.email)
    const [emailMatch] = await tx
      .select({ id: people.id, kind: people.kind, userId: people.userId })
      .from(people)
      .where(and(eq(people.tenantId, args.tenantId), sql`lower(${people.email}) = ${email}`))
      .limit(1)
    if (emailMatch) {
      if (emailMatch.kind !== 'human') {
        throw new Error(`The sign-in email ${email} is already assigned to an agent.`)
      }
      if (emailMatch.userId && emailMatch.userId !== member.userId) {
        throw new Error(`The sign-in email ${email} is already linked to another person.`)
      }
      await tx
        .update(people)
        .set({ userId: member.userId, updatedAt: new Date() })
        .where(and(eq(people.tenantId, args.tenantId), eq(people.id, emailMatch.id)))
      await tx.insert(auditLog).values({
        tenantId: args.tenantId,
        actorUserId: args.actorUserId ?? null,
        entityType: 'person',
        entityId: emailMatch.id,
        action: 'account_linked',
        summary: `${member.name} linked to ${email}`,
        before: { userId: null },
        after: { userId: member.userId, signInEmail: email },
        metadata: { source: 'membership_reconciliation' },
      })
      return { personId: emailMatch.id, created: false }
    }

    // Early Bunkhouse installations seeded a credentialless Demo Owner as the
    // manager of every agent. The real ADMIN_EMAIL account was later added as
    // a second member. Adopt that exact legacy record for the configured owner
    // so reporting lines and approval recipients remain attached to the owner
    // instead of creating a duplicate person.
    if (args.adoptLegacyOwner) {
      const [legacy] = await tx
        .select({ id: people.id, name: people.name, email: people.email })
        .from(people)
        .where(
          and(
            eq(people.tenantId, args.tenantId),
            eq(people.kind, 'human'),
            sql`lower(${people.email}) = ${LEGACY_OWNER_EMAIL}`,
            sql`${people.userId} is null`,
          ),
        )
        .limit(1)
      if (legacy) {
        const [legacyMembership] = await tx
          .select({ id: memberships.id, userId: memberships.userId })
          .from(memberships)
          .innerJoin(users, eq(users.id, memberships.userId))
          .where(
            and(
              eq(memberships.tenantId, args.tenantId),
              sql`lower(${users.email}) = ${LEGACY_OWNER_EMAIL}`,
              sql`not exists (select 1 from ${authAccounts} a where a.user_id = ${users.id})`,
            ),
          )
          .limit(1)
        if (legacyMembership) {
          await tx
            .update(memberships)
            .set({ status: 'suspended', updatedAt: new Date() })
            .where(and(eq(memberships.tenantId, args.tenantId), eq(memberships.id, legacyMembership.id)))
        }
        await tx
          .update(people)
          .set({
            name: member.name || member.displayName,
            email,
            userId: member.userId,
            updatedAt: new Date(),
          })
          .where(and(eq(people.tenantId, args.tenantId), eq(people.id, legacy.id)))
        await tx.insert(auditLog).values({
          tenantId: args.tenantId,
          actorUserId: args.actorUserId ?? null,
          entityType: 'person',
          entityId: legacy.id,
          action: 'legacy_owner_reconciled',
          summary: `${legacy.name} became ${member.name} <${email}>`,
          before: { name: legacy.name, email: legacy.email, userId: null },
          after: { name: member.name, email, userId: member.userId },
          metadata: {
            source: 'membership_reconciliation',
            ...(legacyMembership ? { suspendedLegacyMembershipId: legacyMembership.id } : {}),
          },
        })
        return { personId: legacy.id, created: false }
      }
    }

    const [created] = await tx
      .insert(people)
      .values({
        tenantId: args.tenantId,
        kind: 'human',
        status: member.membershipStatus === 'active' ? 'active' : 'onboarding',
        name: member.name || member.displayName,
        title: defaultTitle(member.name || member.displayName),
        email,
        userId: member.userId,
        startedOn: member.membershipStatus === 'active' ? new Date().toISOString().slice(0, 10) : null,
      })
      .returning({ id: people.id })
    if (!created) throw new Error('Could not create a People record for this workspace member.')
    await tx.insert(auditLog).values({
      tenantId: args.tenantId,
      actorUserId: args.actorUserId ?? null,
      entityType: 'person',
      entityId: created.id,
      action: 'person_provisioned',
      summary: `${member.name} added to People from workspace membership`,
      before: null,
      after: { name: member.name, email, userId: member.userId },
      metadata: { source: 'membership_reconciliation' },
    })
    return { personId: created.id, created: true }
  })
}

/** Reconcile every current workspace member at boot; safe to run repeatedly. */
export async function ensureMembershipPeopleBackfill(): Promise<void> {
  const app = db()
  const configuredOwnerEmail = normalEmail(process.env.ADMIN_EMAIL ?? '')

  const ownerCandidates = await app.withSuperAdmin((superDb) =>
    superDb
      .select({
        tenantId: memberships.tenantId,
        userId: users.id,
        email: users.email,
        isSuperAdmin: users.isSuperAdmin,
        hasCredential: sql<boolean>`exists (
          select 1 from ${authAccounts} a
          where a.user_id = ${users.id} and a.provider_id = 'credential'
        )`,
      })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(inArray(memberships.status, ['active', 'invited'])),
  )
  const candidatesByTenant = new Map<string, typeof ownerCandidates>()
  for (const candidate of ownerCandidates) {
    const list = candidatesByTenant.get(candidate.tenantId) ?? []
    list.push(candidate)
    candidatesByTenant.set(candidate.tenantId, list)
  }
  for (const [tenantId, candidates] of candidatesByTenant) {
    const configured = configuredOwnerEmail
      ? candidates.find((candidate) => normalEmail(candidate.email) === configuredOwnerEmail)
      : undefined
    const credentialedAdmins = candidates.filter((candidate) => candidate.isSuperAdmin && candidate.hasCredential)
    // ADMIN_EMAIL is authoritative when present. On older deployments where
    // it was removed after bootstrap, one unambiguous credentialed platform
    // administrator is the safe equivalent; two is ambiguous, so adopt none.
    const owner = configured ?? (credentialedAdmins.length === 1 ? credentialedAdmins[0] : undefined)
    if (owner) {
      await ensurePersonForMembership({ tenantId, userId: owner.userId, adoptLegacyOwner: true })
    }
  }

  const current = await app.withSuperAdmin((superDb) =>
    superDb
      .select({ tenantId: memberships.tenantId, userId: memberships.userId })
      .from(memberships)
      .where(inArray(memberships.status, ['active', 'invited'])),
  )
  let reconciled = 0
  for (const member of current) {
    try {
      const result = await ensurePersonForMembership(member)
      if (result.created) reconciled += 1
    } catch (error) {
      console.error(
        `[people] could not reconcile membership ${member.userId} in tenant ${member.tenantId}:`,
        error instanceof Error ? error.message : String(error),
      )
    }
  }
  if (reconciled > 0) console.log(`[people] provisioned ${reconciled} People record(s) from workspace membership.`)
}

/** The account-linking state rendered in a human's Access tab. */
export async function personAccountAccess(tenantId: string, personId: string): Promise<PersonAccountAccess> {
  const app = db()
  return app.withSuperAdmin(async (superDb) => {
    const [person] = await superDb
      .select({ userId: people.userId })
      .from(people)
      .where(and(eq(people.tenantId, tenantId), eq(people.id, personId), eq(people.kind, 'human')))
      .limit(1)
    if (!person) return { current: null, options: [] }

    const memberRows = await superDb
      .select({
        userId: users.id,
        name: users.name,
        email: users.email,
        isActive: users.isActive,
        membershipStatus: memberships.status,
      })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(eq(memberships.tenantId, tenantId))
    const links = await superDb
      .select({ userId: people.userId, personId: people.id, personName: people.name })
      .from(people)
      .where(and(eq(people.tenantId, tenantId), sql`${people.userId} is not null`))
    const linkByUser = new Map(links.map((link) => [link.userId!, link]))
    const options: PersonAccountOption[] = memberRows.map((member) => {
      const link = linkByUser.get(member.userId)
      return {
        ...member,
        linkedPersonId: link?.personId ?? null,
        linkedPersonName: link?.personName ?? null,
      }
    })

    if (!person.userId) return { current: null, options }
    const [account] = await superDb
      .select({ userId: users.id, name: users.name, email: users.email, isActive: users.isActive })
      .from(users)
      .where(eq(users.id, person.userId))
      .limit(1)
    if (!account) return { current: null, options }
    const membership = memberRows.find((row) => row.userId === person.userId)
    if (!membership && !options.some((option) => option.userId === account.userId)) {
      options.push({
        ...account,
        membershipStatus: null,
        linkedPersonId: personId,
        linkedPersonName: null,
      })
    }
    return {
      current: { ...account, membershipStatus: membership?.membershipStatus ?? null },
      options,
    }
  })
}

/** Explicit operator-controlled account link/unlink from a human record. */
export async function setPersonAccount(args: {
  tenantId: string
  personId: string
  userId: string | null
  actorUserId: string
}): Promise<void> {
  const app = db()
  await app.withTenant(args.tenantId, async () => {
    const [person] = await app.db.select().from(people).where(eq(people.id, args.personId)).limit(1)
    if (!person) throw new Error('Person not found.')
    if (person.kind !== 'human') throw new Error('Only human records can be linked to sign-in accounts.')
    if (person.userId === args.userId) return

    let account: { id: string; name: string; email: string } | undefined
    if (args.userId) {
      const [member] = await app.db
        .select({ id: users.id, name: users.name, email: users.email })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(and(eq(memberships.tenantId, args.tenantId), eq(memberships.userId, args.userId)))
        .limit(1)
      if (!member) throw new Error('That account is not a member of this workspace.')
      const [other] = await app.db
        .select({ id: people.id, name: people.name })
        .from(people)
        .where(eq(people.userId, args.userId))
        .limit(1)
      if (other && other.id !== person.id) throw new Error(`That account is already linked to ${other.name}.`)
      account = member
    }

    await app.db.update(people).set({ userId: args.userId, updatedAt: new Date() }).where(eq(people.id, person.id))
    await app.db.insert(auditLog).values({
      tenantId: args.tenantId,
      actorUserId: args.actorUserId,
      entityType: 'person',
      entityId: person.id,
      action: args.userId ? 'account_linked' : 'account_unlinked',
      summary: args.userId
        ? `${person.name} linked to ${account!.email}`
        : `${person.name} disconnected from their sign-in account`,
      before: { userId: person.userId },
      after: { userId: args.userId, ...(account ? { signInEmail: account.email } : {}) },
      metadata: { source: 'people_ui' },
    })
  })
}

/** Verified business identity for an authenticated caller inside one tenant. */
export async function authenticatedPerson(
  tenantId: string,
  user: SessionUser,
): Promise<{ personId: string | null; name: string; email: string }> {
  const app = db()
  const [person] = await app.withTenantContext(tenantId, () =>
    app.db
      .select({ id: people.id, name: people.name, email: people.email })
      .from(people)
      .where(and(eq(people.userId, user.id), eq(people.kind, 'human')))
      .limit(1),
  )
  return person
    ? { personId: person.id, name: person.name, email: person.email }
    : { personId: null, name: user.name || user.email, email: user.email }
}
