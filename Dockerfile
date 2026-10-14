# syntax=docker/dockerfile:1

# ──────────────────────────────────────────────────────────────────────────────
# Cartoona — production container (V0.1.35)
#
# Runs ONLY the Next.js web app. Supabase (or whichever backend replaces it)
# stays external: there is no database, auth or storage service in this image or
# in compose.yml, and nothing here is provider-specific beyond the names of a
# few environment variables.
#
# No secret is baked in. The runtime image carries no .env file (see
# .dockerignore), and every credential arrives at `docker run` time.
# ──────────────────────────────────────────────────────────────────────────────

# Node 24 LTS on Debian slim. glibc rather than Alpine/musl on purpose: `sharp`
# (pulled in by Next for image handling) ships prebuilt glibc binaries, and the
# ~30 MB saved by musl is not worth debugging a native build. Pinned by major so
# patch updates are picked up by a rebuild, never a surprise major jump.
ARG NODE_VERSION=24

# ── Stage 1: deps — install from the lockfile, nothing else ──────────────────
FROM node:${NODE_VERSION}-bookworm-slim AS deps
WORKDIR /app

# Only the manifests, so this layer is reused on every build that does not
# change dependencies.
COPY package.json package-lock.json ./

# `npm ci` (not `npm install`): installs exactly the lockfile, fails if
# package.json and the lockfile disagree, and never rewrites the lockfile.
RUN npm ci

# ── Stage 2: builder — compile the app ───────────────────────────────────────
FROM node:${NODE_VERSION}-bookworm-slim AS builder
WORKDIR /app

ENV NEXT_TELEMETRY_DISABLED=1

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# NEXT_PUBLIC_* values are inlined into the browser bundle by `next build`, so
# they are the only variables that must be present at BUILD time; everything
# else (SUPABASE_SECRET_KEY, rate-limit secrets, …) is read at runtime and must
# NOT be passed here. These args carry no values of their own — compose fills
# them from the operator's environment. An empty value builds fine; the
# browser-side Supabase client then reports its own missing-configuration error
# instead of silently talking to the wrong project.
#
# Build args are visible in image history, so never pass a secret as one.
ARG NEXT_PUBLIC_SUPABASE_URL=""
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY=""
ARG NEXT_PUBLIC_SITE_URL=""
ENV NEXT_PUBLIC_SUPABASE_URL=${NEXT_PUBLIC_SUPABASE_URL} \
    NEXT_PUBLIC_SUPABASE_ANON_KEY=${NEXT_PUBLIC_SUPABASE_ANON_KEY} \
    NEXT_PUBLIC_SITE_URL=${NEXT_PUBLIC_SITE_URL}

# The build contacts no backend: every authenticated page is force-dynamic, so
# nothing is prerendered against Supabase. If that ever regresses the build
# fails here rather than reaching out to production.
RUN npm run build

# ── Stage 3: runner — the only stage that ships ──────────────────────────────
FROM node:${NODE_VERSION}-bookworm-slim AS runner
WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000

# Bind all interfaces: on the loopback default the published port would not
# reach the app from the host.
ENV HOSTNAME=0.0.0.0

# Dedicated unprivileged account; the app never runs as root.
RUN groupadd --system --gid 1001 nodejs \
 && useradd --system --uid 1001 --gid nodejs nextjs

# Exactly three artifacts, all owned by the app user — no source tree, no dev
# dependencies, no tests, no builder node_modules. `standalone` already contains
# the traced production dependencies and server.js.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --chown=nextjs:nodejs docker/healthcheck.mjs ./healthcheck.mjs

USER nextjs

EXPOSE 3000

# Node-based probe — no curl/wget in the image. start-period covers Next's cold
# start; after that a stuck process is marked unhealthy within ~90s.
HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=30s \
    CMD ["node", "healthcheck.mjs"]

# The standalone server, directly as PID 1 (no shell wrapper), so SIGTERM and
# SIGINT from `docker stop` / `docker compose down` reach Node itself and Next
# shuts down gracefully. Never `npm run dev` and never `npm start` here.
CMD ["node", "server.js"]
