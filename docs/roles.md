# Roles link resources

A role is the job an agent holds. It carries what belongs to the job itself —
title, pitch, personality seed, standing duties, day-one autonomy, suggested
salary, inbound policy — and it carries **no copies of company resources.**

The procedures a role follows, the skills it draws on, the company knowledge it
is given and the systems it works in are all **links**. Each one is recorded
once, on the resource, as its `assignment`:

```ts
type ResourceAssignment = {
  roles?: string[]      // role slugs — builtin packs and roles built here alike
  personIds?: string[]  // named agents
  everyone?: boolean    // the whole company
}
```

One field, one source of truth, two places to edit it:

- **Company resources → Procedures / Skills / Notes / Systems → Applies to** —
  "who follows this?"
- **Roles → the role → Procedures / Skills / Knowledge / Systems** — "what does
  this job work from?"

Both write the same `assignment`. Neither is a mirror of the other, so a
procedure cannot be assigned on one screen and missing on the other.

## Why not keep the text on the role

It was kept on the role, in a `role_defs.procedures` JSON column and in each
pack's `procedures` array, and every custom role meant retyping doctrine that
already existed in the procedure library. Worse, the copy was ungoverned: not
versioned, not citable, not visible under Company resources, and it drifted
from the governed record the moment either side was edited. Two stores of the
same rule is the parallel-source-of-truth failure the engineering standard
names outright. Migration `0049_role_resource_links.sql` converts every inline
role procedure into a real versioned procedure assigned to its role and drops
the column.

## Duties are the exception

A duty stays on the role. It is not a shared object to point at: it is this
job's standing work, and each agent onboarded into the role gets its own copy
with its own schedule, time zone and next-due clock. There is no company duty
library to link to, and a duty two agents "shared" would still have to fire
twice.

## Starter procedures

A role pack in `packages/roles` is distributable MIT data with no company
behind it, so it cannot link to anything — it ships procedure text. That text
is a **seed**: `installRoleProcedures` writes it into the company's library as
version 1, assigned to the role, on first adoption (explicitly from the role's
Procedures tab, or automatically at the first hire). It is idempotent by slug
and never overwrites what the company has since revised. After installation the
governed record is the doctrine and the seed is history.

Roles built in the app ship no seeds — they link from the start.

## Resolution at runtime

`lib/assignment.ts` holds the single matcher:

```ts
bindsToAgent(assignment, { personId, roleSlug })
```

Every resource resolves through it, so "applies to" cannot mean one thing on
screen and another in the prompt:

| Resource         | Where it resolves                               |
| ---------------- | ----------------------------------------------- |
| Procedures       | `boundProcedures` (`lib/agent-runs.ts`)          |
| Skills           | `skillsForAgent` (`lib/skills.ts`)               |
| Company knowledge| `reachableBy` (`lib/memory.ts`, in SQL)          |
| Systems (MCP)    | `connectIntegrationAbilities` (`lib/agent-abilities.ts`) |

Company knowledge and systems reached every agent before `0049`; the migration
marks everything that existed then as `everyone`, so nothing narrows under an
operator who has not asked for it. A system an agent is not assigned is not
connected for that agent at all — it is never dialled, so a narrowed toolbox
costs a run nothing.

## Deliberate asymmetry

Linking from a role never widens or narrows a resource assigned to **everyone**.
The role screen shows it as `Everyone` and offers no toggle: unlinking it there
would quietly change what the whole company sees from a screen about one job.
That decision belongs on the resource, where the consequence is in view.
