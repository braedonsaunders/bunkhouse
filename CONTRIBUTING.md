# Contributing

Bunkhouse welcomes complete, auditable contributions. Start with an issue for substantial product or schema changes. Preserve the product doctrine in [AGENTS.md](AGENTS.md), especially email-first operation, the HR metaphor, governed procedures, runtime-enforced autonomy, provider neutrality, tenant RLS, and append-only evidence.

## Development

1. Install Node 22 or newer and pnpm 10.
2. Copy `.env.example` to `.env.local` and use disposable local services.
3. Run `pnpm install` and `pnpm --filter web db:migrate`.
4. Start the media/mail development services with `docker compose -f docker-compose.dev.yml up -d`.
5. Run `pnpm dev`; run the worker separately with `pnpm --filter web worker`.

Before submitting, run:

```bash
pnpm audit --prod --audit-level high
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

Changes to tenant data need an additive migration, RLS coverage, server-side permission enforcement, lifecycle validation, actor-attributed before/after audit evidence, and tests proportional to the risk. Never modify an applied migration or weaken a gate to make a change pass.

