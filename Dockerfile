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

ARG BUNKHOUSE_VERSION=development
ARG BUNKHOUSE_REVISION=unknown
ARG BUNKHOUSE_BUILD_DATE=unknown
LABEL org.opencontainers.image.title="Bunkhouse" \
      org.opencontainers.image.version="$BUNKHOUSE_VERSION" \
      org.opencontainers.image.revision="$BUNKHOUSE_REVISION" \
      org.opencontainers.image.created="$BUNKHOUSE_BUILD_DATE" \
      org.opencontainers.image.source="https://github.com/braedonsaunders/bunkhouse"
ENV BUNKHOUSE_VERSION="$BUNKHOUSE_VERSION" \
    BUNKHOUSE_REVISION="$BUNKHOUSE_REVISION" \
    BUNKHOUSE_BUILD_DATE="$BUNKHOUSE_BUILD_DATE"

# Native tools the SERVER's own work depends on — and only those. Everything
# the agents use with their hands (chromium, libreoffice, git, tesseract,
# bubblewrap) lives in the desk guest base image now, not here: agent
# execution happens inside a per-agent microVM (docs/desk-host.md), so shipping
# agent tools in the app image would only
# grow the surface of the containers that hold the keys.
# - ca-certificates: the system trust store. Node carries its own CA bundle, so
#   its absence is invisible until a native dependency needs TLS: LiveKit's
#   media client (@livekit/rtc-node) is Rust and reads the OS store, so without
#   this the voice agent registers happily and then fails every call it is
#   handed with "no native root CA certificates found".
# - poppler-utils: pdfunite concatenates PDFs in the server-side document
#   pipeline (@braedonsaunders/appkit-office, used by documents.ts and the template merge);
#   pdftoppm is file-reading.ts's OCR raster step, which probes for a
#   tesseract binary and fails closed where none exists.
# - libreoffice-writer + libreoffice-calc + fonts-liberation: the tier-0
#   document and spreadsheet pipeline. create_document, create_spreadsheet,
#   template merge, and authenticated file previews render through
#   @braedonsaunders/appkit-office's soffice call ON THE SERVER — that ability
#   is deliberately better than an agent driving LibreOffice by hand in the
#   guest (docs/desk-host.md), so the binaries stay here even though the guest
#   image also carries them for GUI work. Server-side rendering without fonts
#   produces tofu.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    poppler-utils \
    libreoffice-writer \
    libreoffice-calc \
    fonts-liberation \
    openssh-client \
    sshpass \
    freerdp2-x11 \
    tigervnc-viewer \
    tigervnc-tools \
    xvfb \
    xdotool \
    imagemagick \
    python3-winrm \
    telnet \
    expect \
  && rm -rf /var/lib/apt/lists/*

# --- deps: workspace-aware install ------------------------------------------
# Dev dependencies stay in (tsx, typescript run at runtime); NODE_ENV becomes
# production only when the processes start.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/
COPY packages/acp/package.json packages/acp/
COPY packages/roles/package.json packages/roles/
COPY packages/runtime/package.json packages/runtime/
RUN pnpm install --frozen-lockfile

# --- build -------------------------------------------------------------------
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter web exec next build

ENV NODE_ENV=production \
    HOSTNAME=0.0.0.0 \
    PORT=3000
EXPOSE 3000 8090 8091

# Migrations are tracked and idempotent (scripts/migrate.mts); the server must
# not take traffic before they have run.
# pnpm keeps bins package-local, so run through the web package's own .bin.
CMD ["sh", "-c", "apps/web/node_modules/.bin/tsx apps/web/scripts/migrate.mts && cd apps/web && exec node_modules/.bin/next start -p 3000 -H 0.0.0.0"]
