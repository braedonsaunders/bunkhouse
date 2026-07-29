# AGENTS.md — bunkhouse

You are working in **bunkhouse**: open-source AI employees — **agents** — for main-street
businesses. Each agent has a real mailbox on the company's own domain, a job title, a
personality, human-readable memory, duties, procedures it provably follows, and a salary
(its monthly model-token budget). Companies manage agents like HR manages people, on a mixed
org chart that includes the real human employees.

(This file is also the coding-agent brief. "Agent" in *product* copy means an AI employee
record; "you"/"the coding agent" means whoever is editing this repo. Do not conflate them.)

## Product doctrine (do not drift)

1. **Email is the primary surface.** Agents are reached by emailing them. Humans in the
   company need zero new software. Every agent action anchors to a real mail thread or a
   recorded session — email is the audit log. Secondary channels (in-app chat, Slack/Teams
   bridge, SMS) come after mail works.
2. **The HR metaphor is the UX, fully committed.** Hire (role packs are candidates),
   onboard, review, promote autonomy, offboard with memory handover. The record is an
   employee, not a configuration: never surface temperature, system prompts, or "agent
   settings" where personality, duties, salary, and the autonomy dial belong.
3. **Procedures are governed objects.** Versioned, assignable, cited in output. An agent that
   can't show which procedure it followed is a bug. Skill/role packs may ship procedures.
4. **Autonomy is a dial, per agent × action category** (external email, money-adjacent,
   record changes, computer use, shell). Enforcement lives in the runtime, not in prompts.
5. **Salary = token budget.** Per-agent monthly budget against the company's own provider
   keys; metering is first-class; overage is "overtime" and visible. No bunkhouse-side
   markup, ever.
6. **Model-agnostic per agent.** Any provider, any model, per agent. The runtime owns the
   loop; providers are adapters. Never hardcode a provider.
7. **Real files, real storage.** Output is genuine docx/xlsx/pdf filed to the company's
   connected storage. No proprietary doc format.
8. **Memory is human-readable and editable** from the agent's profile. Company knowledge is
   a separate governed layer. Nothing opaque.
9. **Gated abilities are recorded.** Computer use and remote shell always produce
   replayable session records surfaced in the observatory.
10. **OpenBooks gets no special treatment.** It connects via its own MCP like any other
    integration. No OpenBooks-specific code in this repo.

## Engineering standards (ported from the openbooks production standard, generalized)

Prefer explicit controls, auditability, deterministic behavior, and long-term operability
over implementation convenience. At minimum, designs and implementations must preserve:

- strict tenant isolation (RLS-enforced, never query-discipline-only);
- deterministic, idempotent behavior for anything that can run twice (mail sync, duty
  scheduling, run resumption, approval replay);
- immutable history — run events, mail ledgers, shell/computer-use session records, and
  decided approvals are append-only; corrections are new records, not edits;
- complete audit evidence for material changes: actor, timestamp, before/after state;
  an agent's actions must always be attributable to the agent, its run, and its trigger;
- explicit lifecycle states and transition rules (person status, run status, approval
  status, mailbox status) enforced at the domain/service and API boundaries, not only by
  hiding UI;
- effective-dated or version-pinned configuration where changing a rule could reinterpret
  history (procedures are version-pinned per run; autonomy changes never retro-apply);
- precise decimal handling for money (token spend uses the shared `money` type — no
  floating-point arithmetic on costs);
- backward-compatible migrations that preserve tenant data, and reversible rollouts;
- a single source of truth for every policy and configuration value — no silent fallbacks,
  ambiguous overlapping configuration, UI-only enforcement, destructive feature toggles,
  or parallel sources of truth.

**Feature gates:** every org-level feature gate lives on one authoritative Company
Settings → Features switchboard. Module pages may display effective status and link there,
but never expose a second switch or persist a parallel gate. Dependent capabilities
(computer use, shell, SMS, Slack/Teams bridge…) must not be independently available when
their parent gate is off — enforce the dependency in UI, navigation, APIs, services/jobs,
and configuration writes. Turning a feature off preserves its data and audit history.

**Configurable by default:** every setting a reasonable operator would expect to control
(autonomy defaults, budget policies, mail signatures, schedules, escalation targets,
retention) must be UI-configurable from the app — never hardcoded, never env-only, unless
it is genuinely deployment infrastructure.

## Definition of done — UI or it doesn't exist

**NOTHING IS DONE UNLESS ITS UI IS BUILT AND PROPERLY TENANT-CONFIGURABLE.** An engine,
schema, or service without its management surface is an unfinished slice — do not report
it done, do not move on. Every capability ships with, in the same slice:

1. the screen where an operator configures it (on the appkit admin/settings templates —
   SettingsShell, SettingsSection/SettingsRow, RecordList — never bespoke layouts);
2. every knob a reasonable operator expects, tenant-scoped in the database (never env,
   never code constants);
3. visible state: status, last activity, last error, and the audit trail where one exists;
4. discoverability — reachable from Settings or from the natural record page, not only by
   knowing the URL. Settings is the sidebar settings area itself (`/admin/settings`); there
   is no hub page in front of it.

If a slice is intentionally engine-first, its task stays open until the UI lands.

**Rich text everywhere prose is edited.** Multi-line prose fields (notes, procedures, instructions, knowledge) use @appkit/editor's RichTextEditor — lists, headings, links, tables — never a bare Textarea. When storage is markdown, round-trip at the edge (md→HTML in, HTML→GFM out); the stored format stays human-readable.

**UI copy is professional SaaS language.** Never surface engineering-internal phrasing to operators: no "documented follow-up", "not wired up yet", "TODO", roadmap talk, or references to plugins/workers/branches. If a capability is unavailable, say what the operator can use instead in product terms ("Realtime calls are available with OpenAI voices; Google voices are coming soon") — and prefer not offering unavailable options at all over explaining why they fail.

**Complex drawers get subtabs.** When a record drawer/flyout holds more than one section of data (a builder with duties + procedures + settings, a person with mailbox + memory + payroll), organize it with SubtabNav — never one long scroll of stacked sections.

**No stacked tables.** Never stack multiple tables/lists vertically on one page — split them into SubtabNav sections (or SettingsShell nav). One list per view.

**Schedules are human-readable.** Operators see "At 8:00 AM, Monday through Friday" and edit with the structured schedule builder — never raw cron. Cron is the internal storage format only; raw entry lives behind the builder's Advanced toggle.

**Lists are tables; adding happens above them, in a flyout.** Any collection an operator manages is an `@appkit/ui` `PagedTable`/`RecordList` — never a stack of `SettingsRow`s standing in for rows. The create action is a button in the section's header row (and in the empty state), and it opens a Drawer. Never place an add/connect form — or a disclosure holding one — below a table or list; the same goes for singleton connections (a provider key, a storage destination): a status row with a Connect/Manage button, and the form in the drawer.

**Row interactions open Drawers.** Clicking a list/table row opens an `@appkit/ui` Drawer with the record's detail and actions — never an inline form below the table, never a bare navigation when a drawer fits. Full-page records are for deep surfaces (profiles, run timelines); everything else drawers.

## Foundation rules

Built on AppKit (repo: `../appkit`, vendored tarballs in `vendor/appkit`, wired via `file:`
deps + root pnpm overrides). Adopt AppKit's
[`building-applications.md`](../appkit/docs/for-agents/building-applications.md) rules
verbatim: fully tokenized styling (no raw colors), one motion system with
visible-by-default entrances, Server-Component-safe primitives, clean cutover (no legacy
shims), complete production-grade code (no stubs/TODO paths), search before building,
no dead code, docs updated in the same change.

**AppKit first, both directions — non-negotiable:**

1. **Before building ANYTHING fresh, check AppKit.** Search `../appkit/packages/*` (and
   `docs/for-agents/orientation.md`) for an existing primitive, package, or pattern before
   writing a component, utility, schema helper, queue, or service. Building a local
   version of something AppKit already ships is a bug (e.g. lists are `RecordList`/
   `PagedTable`, secrets are `@appkit/crypto` sealers, queues are `@appkit/jobs` profiles).
2. **Backfill the other direction.** When something built here is generalizable beyond
   bunkhouse (mailbox receive engine, employee runtime, MCP client, memory store,
   procedures, avatar generation, observatory streaming, remote-shell daemon, office-doc
   authoring), build it AppKit-shaped — clean contract, adapters injectable, no bunkhouse
   coupling — and **update the appkit repo directly with the new package** (follow appkit's
   own AGENTS.md gates, commit there), then consume it back here via the vendored tarball.
   Fix appkit bugs found along the way in appkit itself, autonomously.

After changing AppKit: `pnpm build:packages` there, re-pack with
`pnpm pack --pack-destination <here>/vendor/appkit`, update the root overrides, reinstall.

## Repo map

- `apps/web` — the HR app (Next 16 on the AppKit shell).
- `packages/runtime` — the employee loop: providers, MCP, tools, context assembly,
  autonomy enforcement, budget metering. Publishable; keep it free of web coupling.
- `packages/roles` — role-pack format + first-party packs (MIT).
- `docs/organization.md` — the roster, the reporting hierarchy, and the tree invariant.
- `vendor/appkit` — pinned AppKit tarballs (36 packages).

## Validation gates (green before "done")

```bash
pnpm install
pnpm typecheck   # tsc --noEmit across every workspace
pnpm lint
pnpm build
```

Never commit on red. Never `ts-ignore` / `eslint-disable` around a gate.

## Git

Commit atomically to local `main`; stage only files you intentionally touched. End commit
messages with the Claude co-author trailer. The repo is private during buildout
(github.com/braedonsaunders/bunkhouse); it is written to be public — no secrets, ever.

## Licensing

Core is AGPL-3.0. `packages/roles` and future skill packs are MIT (note the per-package
`license` field). Keep the split intact when adding packages.
