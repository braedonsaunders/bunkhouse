import { and, asc, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import { PageContainer, PageHeader } from '@braedonsaunders/appkit-ui'
import { memories, memoryProposals, people, procedureRevisions, procedures } from '../../db/schema'
import { db } from '../../db/client'
import { resolveTenantId } from '../../lib/tenant'
import { describeAssignment } from '../../lib/assignment'
import { roleOptions as listRoleOptions } from '../../lib/roles'
import { listMcpIntegrations, readMcpHealth } from '../../lib/mcp-integrations'
import { mcpOauthRedirectUri } from '../../lib/mcp-oauth'
import { listCurrentRevisions, listSkillFiles, listSkills } from '../../lib/skills'
import { deskSupported } from '../../lib/desk'
import { ResourcesView } from '../../components/resources-view'
import type { ProcedureRow } from '../../components/procedures-view'
import type { SkillRowView } from '../../components/skills-view'
import { listRemoteComputers } from '../../lib/remote-computers'
import { resolveDeskFeatures } from '../../lib/desk-policy'

export const dynamic = 'force-dynamic'

const stamp = (d: Date) => d.toISOString().slice(0, 16).replace('T', ' ')

export default async function ResourcesPage({
  searchParams,
}: {
  searchParams: Promise<{
    tab?: string
    mcpOauthConnected?: string
    mcpOauthTools?: string
    mcpOauthError?: string
  }>
}) {
  const { tab, mcpOauthConnected, mcpOauthTools, mcpOauthError } = await searchParams
  // What the MCP OAuth callback left behind, if the operator just came back
  // from a provider. The Systems tab clears it from the address bar once shown.
  const mcpOauthOutcome = mcpOauthConnected
    ? {
        ok: true,
        message: (() => {
          const tools = Number(mcpOauthTools ?? '0')
          return `${mcpOauthConnected} is connected — ${tools} tool${tools === 1 ? '' : 's'} available to your agents.`
        })(),
      }
    : mcpOauthError
      ? { ok: false, message: mcpOauthError }
      : null
  const tenantId = await resolveTenantId('resources.read')
  const app = db()
  const data = await app.withTenantContext(tenantId, async () => {
    const notes = await app.db
      .select()
      .from(memories)
      .where(and(eq(memories.scope, 'company'), isNull(memories.validUntil), eq(memories.status, 'active')))
      .orderBy(desc(memories.pinned), asc(memories.title))
    // Open proposals await a decision; a gardener finding that was safe
    // enough to auto-apply still shows up (read-only) for the audit trail —
    // its silent "nothing needed doing" marker rows do not (empty noteIds).
    const proposals = await app.db
      .select({
        proposal: memoryProposals,
        proposerName: sql<string | null>`(select name from people p where p.id = ${memoryProposals.proposedByPersonId})`,
      })
      .from(memoryProposals)
      .where(
        or(
          eq(memoryProposals.status, 'open'),
          and(
            eq(memoryProposals.status, 'auto_applied'),
            sql`${memoryProposals.payload} ->> 'origin' = 'gardener'`,
            sql`jsonb_array_length(coalesce(${memoryProposals.payload} -> 'noteIds', '[]'::jsonb)) > 0`,
          ),
        ),
      )
      .orderBy(sql`case when ${memoryProposals.status} = 'open' then 0 else 1 end`, desc(memoryProposals.createdAt))
      .limit(200)

    // The notes each proposal references (payload.noteIds) — fetched once so
    // the drawer can render a real before/after diff instead of just the
    // proposed text on its own.
    const refIds = new Set<string>()
    for (const { proposal } of proposals) {
      for (const refId of proposal.payload.noteIds ?? []) refIds.add(refId)
    }
    const refNotes =
      refIds.size > 0
        ? await app.db
            .select({ id: memories.id, slug: memories.slug, title: memories.title, body: memories.body })
            .from(memories)
            .where(inArray(memories.id, [...refIds]))
        : []
    const refNoteById = new Map(refNotes.map((n) => [n.id, n]))

    const procedureHeads = await app.db.select().from(procedures).orderBy(asc(procedures.title))
    const revisions = await app.db.select().from(procedureRevisions).orderBy(desc(procedureRevisions.version))
    const agents = await app.db
      .select({ id: people.id, name: people.name })
      .from(people)
      .where(eq(people.kind, 'agent'))
      .orderBy(asc(people.name))
    const systems = await listMcpIntegrations(tenantId)
    const systemHealth = await readMcpHealth(tenantId)
    const skillHeads = await listSkills(tenantId)
    const skillRevisions = await listCurrentRevisions(tenantId)
    const skillFileRows = await listSkillFiles(tenantId)
    return {
      notes,
      proposals,
      refNoteById,
      procedureHeads,
      revisions,
      agents,
      systems,
      systemHealth,
      skillHeads,
      skillRevisions,
      skillFileRows,
    }
  })
  const [computerRows, deskFeatures] = await Promise.all([
    listRemoteComputers(tenantId),
    resolveDeskFeatures(tenantId),
  ])

  const agentNames = new Map(data.agents.map((h) => [h.id, h.name]))
  // Every role an assignment can name — the builtin packs and the roles this
  // company built. A custom role that could not be picked here was a role
  // nothing could ever be assigned to.
  const roleOptions = await listRoleOptions(tenantId)
  const names = { roles: new Map(roleOptions.map((r) => [r.value, r.label])), agents: agentNames }
  /** "Applies to" reads the same for every governed resource. */
  const appliesTo = (assignment: Parameters<typeof describeAssignment>[0]) => describeAssignment(assignment, names)

  const skillRows: SkillRowView[] = data.skillHeads.map((head) => {
    const revision = data.skillRevisions.find((r) => r.skillId === head.id && r.version === head.currentVersion)
    const files = data.skillFileRows.filter((f) => f.skillId === head.id && f.version === head.currentVersion)
    return {
      id: head.id,
      slug: head.slug,
      title: head.title,
      description: head.description,
      status: head.status,
      version: head.currentVersion,
      appliesTo: appliesTo(head.assignment),
      origin: head.source.path ? `${head.source.repo}/${head.source.path}` : head.source.repo,
      pinned: `${head.source.ref} · ${head.source.commitSha.slice(0, 7)}`,
      licence: head.license ?? 'Not stated by the author',
      hasScripts: head.hasScripts,
      updatedAt: stamp(head.updatedAt),
      body: revision?.body ?? '',
      files: files.map((f) => ({ path: f.path, sizeBytes: f.sizeBytes, isScript: f.isScript })),
      assignment: head.assignment,
    }
  })
  const procedureRows: ProcedureRow[] = data.procedureHeads.map((head) => {
    const revs = data.revisions.filter((r) => r.procedureId === head.id)
    const current = revs.find((r) => r.version === head.currentVersion)
    return {
      id: head.id,
      slug: head.slug,
      title: head.title,
      status: head.status,
      version: head.currentVersion,
      appliesTo: appliesTo(head.assignment),
      updatedAt: stamp(head.updatedAt),
      body: current?.body ?? '',
      content: current?.content ?? null,
      steps: current?.content?.steps.length ?? 0,
      revisions: revs.map((r) => ({
        version: r.version,
        body: r.body,
        content: r.content ?? null,
        changeNote: r.changeNote ?? '',
        createdAt: stamp(r.createdAt),
      })),
      assignment: head.assignment,
    }
  })

  return (
    <PageContainer className="space-y-6">
      <PageHeader
        title="Company resources"
        description="Everything your agents bring to the job: the notes they read, the procedures they follow, the systems they work in, and the changes they nominate. Agents can only nominate — humans decide what crosses this boundary."
      />

      <ResourcesView
        notes={data.notes.map((note) => ({
          id: note.id,
          slug: note.slug,
          kind: note.kind,
          title: note.title,
          body: note.body,
          importance: note.importance,
          pinned: note.pinned,
          author: note.author,
          updatedAt: stamp(note.updatedAt),
          appliesTo: appliesTo(note.assignment),
          assignment: note.assignment,
        }))}
        proposals={data.proposals.map(({ proposal, proposerName }) => {
          const housekeeping = proposal.payload.origin === 'gardener'
          return {
            id: proposal.id,
            kind: proposal.kind,
            title: proposal.payload.title ?? '(untitled)',
            body: proposal.payload.body ?? '',
            rationale: proposal.rationale,
            from: proposerName ?? (housekeeping ? 'Housekeeping' : 'consolidator'),
            createdAt: stamp(proposal.createdAt),
            status: proposal.status as 'open' | 'auto_applied',
            decidedAt: proposal.decidedAt ? stamp(proposal.decidedAt) : null,
            housekeeping,
            refs: (proposal.payload.noteIds ?? [])
              .map((refId) => data.refNoteById.get(refId))
              .filter((ref): ref is { id: string; slug: string; title: string; body: string } => Boolean(ref)),
          }
        })}
        procedures={procedureRows}
        skills={skillRows}
        shellAvailable={deskSupported()}
        systems={data.systems.map((entry) => ({
          slug: entry.slug,
          label: entry.label,
          url: entry.url,
          category: entry.category,
          hasHeaders: Boolean(entry.sealedHeaders),
          isOauth: Boolean(entry.oauth),
          isM2m: Boolean(entry.m2m),
          // Never the key itself — only what the operator has to recognise the
          // connection by, so reconnecting does not mean re-entering all of it.
          ...(entry.m2m?.clientId ?? entry.oauth?.clientId
            ? { clientId: entry.m2m?.clientId ?? entry.oauth!.clientId }
            : {}),
          ...(entry.m2m?.keyId ? { keyId: entry.m2m.keyId } : {}),
          ...(entry.m2m?.algorithm ? { algorithm: entry.m2m.algorithm } : {}),
          ...(entry.m2m?.scope ? { scope: entry.m2m.scope } : {}),
          ...(data.systemHealth[entry.slug] ? { health: data.systemHealth[entry.slug]! } : {}),
          appliesTo: appliesTo(entry.assignment),
          assignment: entry.assignment,
        }))}
        computers={computerRows.map((row) => ({
          id: row.id,
          name: row.name,
          host: row.host,
          port: row.port,
          protocol: row.protocol,
          username: row.username ?? '',
          domain: row.domain ?? '',
          credentialKind: row.credentialKind,
          status: row.status,
          lastConnectedAt: row.lastConnectedAt ? stamp(row.lastConnectedAt) : 'Never',
          lastError: row.lastError ?? '',
        }))}
        remoteComputersEnabled={deskFeatures.remoteComputers}
        mcpOauthOutcome={mcpOauthOutcome}
        mcpOauthRedirectUri={await mcpOauthRedirectUri()}
        roleOptions={roleOptions}
        agentOptions={data.agents.map((h) => ({ value: h.id, label: h.name }))}
        {...(tab ? { initialTab: tab } : {})}
      />
    </PageContainer>
  )
}
