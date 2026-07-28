# bunkhouse

**Open-source AI employees for main-street business.** Hire agents that live in your inbox.

A bunkhouse is where the hired agents live. This one is where your AI agents live: each one
has a real mailbox on your own domain, a job title, a personality, a memory, and a salary —
and you manage them the way you manage people, not the way you configure software.

## What makes an agent different from a chatbot

- **A real email address on your domain.** `dana@yourshop.com` via Google Workspace,
  Microsoft 365, or plain IMAP/SMTP. Your staff, customers, and vendors just email her.
  Nobody installs anything. Email threads are the audit log.
- **A job, not a prompt.** Agents are hired from role packs — office administrator,
  AR/collections clerk, customer service rep — with duties they perform proactively on
  schedule, procedures they provably follow, and an autonomy dial you turn up as trust grows
  (draft-for-review → send-with-CC → fully trusted, per action category).
- **Your company's doctrine, enforced.** Upload the employee handbook, price sheets,
  warranty policy, and SOPs. Procedures become versioned, governed objects every agent cites
  and follows — not vibes in a context window.
- **Real work product.** Genuine `.docx` / `.xlsx` / `.pdf` files, attached to threads and
  filed to your actual shared storage (Google Drive, OneDrive, a NAS or Windows file share).
- **A mixed org chart.** The directory holds your human employees too. Agents route work to
  the right person by title, ask humans questions over email, delegate to each other, and
  escalate to their manager.
- **A desk you can look over.** The observatory shows each agent at work — the browser
  they're driving, the document they're drafting, the shell session they're running — with
  every gated ability (computer use, terminal/PowerShell on company machines) recorded and
  replayable.
- **A salary, not a meter.** Each agent's salary is its monthly model-token budget, paid to
  your own API keys — bring any provider, run different models per agent. Overage is overtime.
  Bunkhouse takes nothing.
- **Memory you can read.** Per-agent memory is human-readable notes you can open, correct,
  and delete from the agent's HR profile, plus a governed company-knowledge layer.

## Status

Early. The foundation is being laid in the open: schema, the model-agnostic employee
runtime, the mail engine, and the HR app. Watch the repo.

## Architecture

pnpm monorepo on the [AppKit](https://github.com/braedonsaunders/appkit) foundation
(design system, multi-tenant Postgres/RLS, auth/IAM, jobs, storage, documents, sandboxed
scripting).

- `apps/web` — the HR app: directory, agent profiles, org chart, hiring, observatory.
- `packages/runtime` — the model-agnostic employee loop: provider seam (any LLM per agent),
  MCP client, tool framework, context assembly, autonomy enforcement, budget metering.
- `packages/roles` — role packs: declarative bundles of duties, procedures, prompts,
  templates, and required abilities. Community-installable from git.
- `vendor/appkit` — pinned AppKit package tarballs.

## License

AGPL-3.0 for the core (see [LICENSE](LICENSE)). Role packs and skill packs are MIT so the
ecosystem stays frictionless.
