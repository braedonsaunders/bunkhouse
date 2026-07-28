# AGENTS.md — bunkhouse

You are working in **bunkhouse**: open-source AI employees ("hands") for main-street
businesses. Each hand has a real mailbox on the company's own domain, a job title, a
personality, human-readable memory, duties, procedures it provably follows, and a salary
(its monthly model-token budget). Companies manage hands like HR manages people, on a mixed
org chart that includes the real human employees.

## Product doctrine (do not drift)

1. **Email is the primary surface.** Hands are reached by emailing them. Humans in the
   company need zero new software. Every hand action anchors to a real mail thread or a
   recorded session — email is the audit log. Secondary channels (in-app chat, Slack/Teams
   bridge, SMS) come after mail works.
2. **The HR metaphor is the UX, fully committed.** Hire (role packs are candidates),
   onboard, review, promote autonomy, offboard with memory handover. Never expose "agent
   config" where an HR concept exists.
3. **Procedures are governed objects.** Versioned, assignable, cited in output. A hand that
   can't show which procedure it followed is a bug. Skill/role packs may ship procedures.
4. **Autonomy is a dial, per hand × action category** (external email, money-adjacent,
   record changes, computer use, shell). Enforcement lives in the runtime, not in prompts.
5. **Salary = token budget.** Per-hand monthly budget against the company's own provider
   keys; metering is first-class; overage is "overtime" and visible. No bunkhouse-side
   markup, ever.
6. **Model-agnostic per hand.** Any provider, any model, per hand. The runtime owns the
   loop; providers are adapters. Never hardcode a provider.
7. **Real files, real storage.** Output is genuine docx/xlsx/pdf filed to the company's
   connected storage. No proprietary doc format.
8. **Memory is human-readable and editable** from the hand's profile. Company knowledge is
   a separate governed layer. Nothing opaque.
9. **Gated abilities are recorded.** Computer use and remote shell always produce
   replayable session records surfaced in the observatory.
10. **OpenBooks gets no special treatment.** It connects via its own MCP like any other
    integration. No OpenBooks-specific code in this repo.

## Foundation rules

Built on AppKit (repo: `../appkit`, vendored tarballs in `vendor/appkit`, wired via `file:`
deps + root pnpm overrides). Adopt AppKit's
[`building-applications.md`](../appkit/docs/for-agents/building-applications.md) rules
verbatim: fully tokenized styling (no raw colors), one motion system with
visible-by-default entrances, Server-Component-safe primitives, clean cutover (no legacy
shims), complete production-grade code (no stubs/TODO paths), search before building,
no dead code, docs updated in the same change.

**Extend AppKit where appropriate:** when a capability is generalizable beyond bunkhouse
(mailbox receive engine, employee runtime, MCP client, memory store, procedures, avatar
generation, observatory streaming, remote-shell daemon, office-doc authoring), build it as
an AppKit-shaped package — clean contract, adapters injectable, no bunkhouse coupling — and
plan its home in the appkit repo. Re-pack vendored tarballs from `../appkit` with
`pnpm pack --pack-destination <here>/vendor/appkit` after changing AppKit
(`pnpm build:packages` there first), then update the root overrides.

## Repo map

- `apps/web` — the HR app (Next 16 on the AppKit shell).
- `packages/runtime` — the employee loop: providers, MCP, tools, context assembly,
  autonomy enforcement, budget metering. Publishable; keep it free of web coupling.
- `packages/roles` — role-pack format + first-party packs (MIT).
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
