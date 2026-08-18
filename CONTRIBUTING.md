# Contributing

Bunkhouse welcomes complete, auditable contributions. Start with an issue for substantial product or schema changes. Preserve the product doctrine in [AGENTS.md](AGENTS.md), especially email-first operation, the HR metaphor, governed procedures, runtime-enforced autonomy, provider neutrality, tenant RLS, and append-only evidence.

## Development

1. Install Node 22 or newer and pnpm 10.
2. Copy `.env.example` to `.env.local` and use disposable local services.
3. Run `pnpm install` and `pnpm --filter web db:migrate`.
4. Start the media/mail development services with `docker compose -f docker-compose.dev.yml up -d`.
5. Run `pnpm dev`; run the worker separately with `pnpm --filter web worker`.

To exercise the Docker image built from the current checkout instead of the published
quickstart image:

```bash
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build --wait
```

Before submitting, run:

```bash
pnpm audit --prod --audit-level high
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

Database-boundary claims (forced RLS, append-only ledgers, procedure pinning) have their own suite that runs only against a disposable, migrated database — never your development one:

```bash
docker run -d --name bunkhouse-test-pg -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=bunkhouse_test -p 55437:5432 postgres:16
psql postgresql://postgres:postgres@localhost:55437/bunkhouse_test \
  -c "create role bunkhouse_super login bypassrls"
BUNKHOUSE_DB_URL=postgresql://postgres:postgres@localhost:55437/bunkhouse_test \
  pnpm --filter web db:migrate
BUNKHOUSE_TEST_DB_URL=postgresql://postgres:postgres@localhost:55437/bunkhouse_test \
  pnpm --filter web test:db
```

CI runs it on every push and on every release tag.

Changes to tenant data need an additive migration, RLS coverage, server-side permission enforcement, lifecycle validation, actor-attributed before/after audit evidence, and tests proportional to the risk. Never modify an applied migration or weaken a gate to make a change pass.
