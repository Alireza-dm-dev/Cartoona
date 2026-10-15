# syntax=docker/dockerfile:1

# ──────────────────────────────────────────────────────────────────────────────
# Cartoona — backend container (V0.1.40)
#
# The Fastify API, side by side with the Next.js frontend. Build context is the
# repository root (it reuses lib/db, lib/repositories and lib/observability);
# backend/Dockerfile.dockerignore admits only what the build needs.
#
# The runtime stage ships exactly one bundled file (server.cjs, which contains
# fastify, pg and the shared lib code) plus the healthcheck — no node_modules,
# no TypeScript, no tests, no .git, no env files.
# ──────────────────────────────────────────────────────────────────────────────

ARG NODE_VERSION=24

# ── Stage 1: build — install from the lockfile and bundle ────────────────────
FROM node:${NODE_VERSION}-bookworm-slim AS build
WORKDIR /src

COPY package.json package-lock.json ./
# The npm download cache is a BuildKit cache mount: it speeds up rebuilds and
# never becomes part of an image layer.
RUN --mount=type=cache,target=/root/.npm \
    npm ci --ignore-scripts --no-audit --no-fund

COPY tsconfig.json ./
COPY types ./types
COPY lib ./lib
COPY backend/build.mjs ./backend/build.mjs
COPY backend/src ./backend/src
RUN node backend/build.mjs

# ── Stage 2: runtime — the only stage that ships ─────────────────────────────
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    BACKEND_PORT=4000 \
    BACKEND_HOST=0.0.0.0

# Dedicated unprivileged account; the backend never runs as root.
RUN groupadd --system --gid 1001 backend \
 && useradd --system --uid 1001 --gid backend --no-create-home backend

COPY --from=build --chown=backend:backend /src/backend/dist/server.cjs ./server.cjs
COPY --chown=backend:backend backend/healthcheck.mjs ./healthcheck.mjs

USER backend

EXPOSE 4000

# Liveness only (/health never touches the database).
HEALTHCHECK --interval=15s --timeout=5s --retries=3 --start-period=10s \
    CMD ["node", "healthcheck.mjs"]

# Node directly as PID 1 (no shell, no npm): SIGTERM from `docker stop` reaches
# the server, which closes HTTP and the database pool, then exits.
CMD ["node", "server.cjs"]
