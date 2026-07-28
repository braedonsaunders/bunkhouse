# bunkhouse — dev deployment image.
#
# One image, three runnables (compose picks per service):
#   web         (default)  migrate → next start
#   worker      node_modules/.bin/tsx apps/web/scripts/worker.mts
#   voice-agent node_modules/.bin/tsx apps/web/scripts/voice-agent.mts start
#
# Deliberately a full-workspace image rather than Next standalone: the worker
# and the voice agent run TypeScript through tsx under the react-server
# condition, and the voice agent carries native LiveKit bindings — both need
# the real node_modules tree. Fat and honest beats slim and broken for a dev
# deployment; a standalone split is a production-hardening step.

FROM node:24-bookworm-slim AS base
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.30.0 --activate

# --- deps: workspace-aware install ------------------------------------------
# Dev dependencies stay in (tsx, typescript run at runtime); NODE_ENV becomes
# production only when the processes start.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/
COPY packages/roles/package.json packages/roles/
COPY packages/runtime/package.json packages/runtime/
COPY vendor/appkit/ vendor/appkit/
RUN pnpm install --frozen-lockfile

# --- build -------------------------------------------------------------------
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter web exec next build

ENV NODE_ENV=production \
    HOSTNAME=0.0.0.0 \
    PORT=3000
EXPOSE 3000

# Migrations are tracked and idempotent (scripts/migrate.mts); the server must
# not take traffic before they have run.
# pnpm keeps bins package-local, so run through the web package's own .bin.
CMD ["sh", "-c", "apps/web/node_modules/.bin/tsx apps/web/scripts/migrate.mts && cd apps/web && exec node_modules/.bin/next start -p 3000 -H 0.0.0.0"]
