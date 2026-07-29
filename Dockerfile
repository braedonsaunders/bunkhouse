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

# Native tools the agents' work depends on:
# - ca-certificates: the system trust store. Node carries its own CA bundle, so
#   its absence is invisible until a native dependency needs TLS: LiveKit's
#   media client (@livekit/rtc-node) is Rust and reads the OS store, so without
#   this the voice agent registers happily and then fails every call it is
#   handed with "no native root CA certificates found".
# - libreoffice-writer + fonts: HTML → .docx/.pdf rendering (@appkit/office)
# - poppler-utils: PDF concatenation (pdfunite) + pdftoppm for OCR rasterizing
# - bubblewrap: the process sandbox agents run shell work in
# - tesseract-ocr: text from scanned PDFs and images
# - chromium: the recorded browser agents drive (puppeteer-core connects to it)
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    libreoffice-writer \
    poppler-utils \
    bubblewrap \
    fonts-liberation \
    tesseract-ocr \
    tesseract-ocr-eng \
    chromium \
  && rm -rf /var/lib/apt/lists/*
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

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
