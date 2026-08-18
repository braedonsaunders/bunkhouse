# The Organization — people, agents, and the reporting hierarchy

The organization module is the roster and the org chart: every human employee and
every AI agent in one company, joined by one formal reporting line. It replaces
what was called the Directory.

## Why one table, two record experiences

People and agents are the same record — `people`, discriminated by
`person_kind` (`human` | `agent`). They must share a table because the reporting
hierarchy crosses the boundary in both directions: an agent escalates to a human
manager, a human can have agents reporting to them, and routing ("this thread is
the bookkeeper's") does not care which kind the owner is. One table means one
reporting line, one drawer, one set of lifecycle states.

They do **not** share a page. A mixed roster forces every column to be the union
of two different records — a phone number that is blank for half the rows, a
model that is blank for the other half — and no honest heading covers both. So:

| Surface | Route | Shows |
| --- | --- | --- |
| Agents | `/organization` | AI employees: role, mailbox, model, extension, manager, status |
| Agent record | `/organization/<agent-id>` | One AI employee's overview, inbox, chat, work, and profile |
| People | `/organization/people` | Humans: job title, email, phone, manager, status |
| Org chart | `/organization/chart` | Both, drawn as the reporting hierarchy |

The primary navigation keeps five destinations: Home, Team, Work, Library, and
Settings. Team groups Agents, People, Org chart, and Roles; Work groups Activity
and Approvals. Chat and mail are not detached company-wide destinations: they
belong to the AI employee who owns the conversations.

`/organization/<id>` is the canonical deep link for any caller that holds an
employee id — the lobby, roster, org chart, mail, approvals, runs, and PBX. An
agent id opens a full record page. A human id resolves to the People roster and
opens the compact record drawer, because humans do not have an AI work surface.

The agent page uses a stable employee header and five primary sections:

- **Overview** — current state, current focus, next duty, approvals, salary use,
  and recent activity;
- **Inbox** — the agent's real company mailbox and mail audit trail;
- **Chat** — operator conversations scoped to this one agent;
- **Work** — duties, governed assignments, and run activity;
- **Profile** — identity, role and resources, avatar, model, voice, autonomy,
  memory, and compensation.

An agent can own any number of chat threads. The conversation list is always
filtered by `person_id`; opening Chat selects the newest active thread by
default, while operators can start another or reveal archived conversations.
The list's **New** menu starts either a text chat or a call. A call creates its
own conversation and replaces only the center transcript with the animated call
stage and media controls; it does not navigate to a separate call page. Desktop,
Browser, Terminal, Files, and History stay independently selectable in the work
rail throughout the call, and the call transcript joins the conversation when
the room closes. The five shared tabs remain visible even before the first tool
or file appears, so operators always know where each kind of work will land.
Legacy `/chat` and `/mail` links resolve their thread owner and redirect to the
corresponding section on the canonical agent page.

## The reporting hierarchy

`people.reports_to_id` is a self-referencing nullable FK. Null means top level.
That single pointer is the whole structure — there is no separate hierarchy
table, so the chart can never disagree with the record.

**The tree invariant is enforced on every write path**, not by hiding UI. A
reporting line may not point at itself, at somebody outside the tenant, or at
anyone already below the person in the chain. `lib/org.ts` owns the rule
(`assertValidManager`), and all three writers call it:

- the record form (`updatePerson`),
- the org chart's drag gesture (`setReportsTo`),
- onboarding (`hireAgent`, `addPerson` — new records validate their manager).

The chart also guards client-side with `@braedonsaunders/appkit-ui`'s `canReparent`, but that
runs against a snapshot the browser may have held while somebody else
reorganized, so it is a fast path and never the rule. A rejected drag reverts on
screen and surfaces the server's message.

## Adding people

Agents are hired into a role (Roles → onboard), which brings their duties and
day-one autonomy dial with them, and — because the role links rather than copies
— everything that role has been given: its procedures, skills, company knowledge
and systems. See [roles.md](roles.md). Humans are added directly from
People → **Add a person**: name, title, work email, phone, manager, time zone,
start date, and what they own.

"What they own" (`responsibilities`) is not decoration — it is rendered into
every agent's system prompt as the company directory, which is how an agent
decides that a thread belongs to somebody else and routes it there.

## Login accounts and human records

A workspace membership is access to Bunkhouse; a human `people` row is the
employee record agents know. They are distinct records with one explicit link:
`people.user_id`. Each membership is reconciled into People automatically, and
the human record's **Access** tab shows or changes the linked account. A global
account may belong to several workspaces, but it can link to only one human per
tenant. Agents can never carry a user link.

The two email addresses have different jobs and are intentionally not kept in
lockstep. The account email is the sign-in identity. The person email is their
work address in the company directory. When an authenticated operator starts a
call, the linked person supplies the verified name and work email; the login is
the proof of who is calling. This keeps call delivery and escalation aligned
with the roster without pretending an SSO address must also be a mailbox.

Membership creation, reactivation, and boot reconciliation are idempotent. A
matching unlinked human is adopted before a new row is created, and the database
enforces one `(tenant_id, user_id)` link. Suspending or removing workspace access
does not delete or unlink the employee record: reporting lines and audit history
remain intact, while the Access tab shows the effective account state.

## What the hierarchy does at runtime

`packages/runtime` reads the reporting line, so the chart is operational rather
than cosmetic. Each agent's system prompt carries:

- the company directory, with each entry's manager named inline;
- **"You report to \<name\>, \<title\> \<email\>"** — the escalation target,
  stated outright rather than left as "escalate to your manager" for the model
  to resolve;
- the agent's own direct reports, for delegation.

Change a reporting line and the next run picks it up. Autonomy, budgets, and
procedures are unaffected — the hierarchy governs routing and escalation only.

## The chart itself

`OrgChart` is a generic `@braedonsaunders/appkit-ui` primitive, not a bunkhouse component: it
takes flat records with a `parentId` and resolves the forest itself. It is
deliberately tolerant of dirty data — a dangling manager or an edit-race cycle
surfaces as an extra top-level card rather than a dropped record or a hang.
Branches collapse, the canvas zooms, and dragging a card onto another commits
the new manager.

Offboarded records are hidden by default (`?show=all` includes them). When a
filter hides somebody's manager, their reports are re-rooted at the top level
rather than stranded off-chart.

Drag-and-drop has no touch equivalent, which is why "Reports to" also lives as a
plain select on the record — the hierarchy is always editable without a mouse.
