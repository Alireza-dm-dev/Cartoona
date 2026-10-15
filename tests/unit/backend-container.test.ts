import { describe, it, expect } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { composeService, withoutYamlComments } from "../helpers/compose-text"

/**
 * Static guards for the V0.1.40 backend container and its boundaries: the
 * image, the compose service, what the frontend may (not) know about it, and
 * which modules may import what.
 */

const root = path.resolve(__dirname, "../..")
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8")
const code = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")

function walk(dir: string, pattern = /\.(ts|tsx|mjs|js)$/): string[] {
  if (!fs.existsSync(path.join(root, dir))) return []
  const out: string[] = []
  for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`
    if (entry.isDirectory()) out.push(...walk(rel, pattern))
    else if (pattern.test(entry.name)) out.push(rel)
  }
  return out
}

const dockerfile = withoutYamlComments(read("backend/Dockerfile"))
const runtimeStage = dockerfile.slice(dockerfile.indexOf("AS runtime"))
const ignore = read("backend/Dockerfile.dockerignore").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"))
const compose = withoutYamlComments(read("compose.yml"))
const backend = composeService(compose, "backend")
const frontend = composeService(compose, "frontend")

const ports = (block: string) => {
  const lines = block.split("\n")
  const start = lines.findIndex((l) => /^\s+ports:\s*$/.test(l))
  const out: string[] = []
  for (const line of start === -1 ? [] : lines.slice(start + 1)) {
    const m = /^\s+-\s*"?([^"]+)"?\s*$/.exec(line)
    if (!m) break
    out.push(m[1])
  }
  return out
}

describe("backend/Dockerfile", () => {
  it("builds on node:24-bookworm-slim in both stages", () => {
    expect(dockerfile).toMatch(/^ARG NODE_VERSION=24$/m)
    expect([...dockerfile.matchAll(/^FROM (\S+)/gm)].map((m) => m[1])).toEqual([
      "node:${NODE_VERSION}-bookworm-slim",
      "node:${NODE_VERSION}-bookworm-slim",
    ])
  })

  it("runs as a dedicated non-root user", () => {
    expect(runtimeStage).toMatch(/useradd --system --uid 1001/)
    expect(runtimeStage).toMatch(/^USER backend$/m)
    expect(runtimeStage).not.toMatch(/^USER root$/m)
    // USER comes before CMD, so the process never starts as root.
    expect(runtimeStage.indexOf("USER backend")).toBeLessThan(runtimeStage.indexOf("CMD"))
  })

  it("listens on 0.0.0.0:4000 inside the container", () => {
    expect(runtimeStage).toMatch(/BACKEND_PORT=4000/)
    expect(runtimeStage).toMatch(/BACKEND_HOST=0\.0\.0\.0/)
    expect(runtimeStage).toMatch(/^EXPOSE 4000$/m)
  })

  it("runs Node directly as PID 1 (exec form, no shell or npm)", () => {
    expect(runtimeStage).toMatch(/^CMD \["node", "server\.cjs"\]$/m)
    expect(runtimeStage).not.toMatch(/npm (start|run)/)
  })

  it("ships only the bundle and the healthcheck - no source, tests, node_modules or env", () => {
    const copies = [...runtimeStage.matchAll(/^COPY .+$/gm)].map((m) => m[0])
    expect(copies).toHaveLength(2)
    expect(copies[0]).toMatch(/--from=build .*\/backend\/dist\/server\.cjs \.\/server\.cjs$/)
    expect(copies[1]).toMatch(/backend\/healthcheck\.mjs \.\/healthcheck\.mjs$/)
    expect(runtimeStage).not.toMatch(/node_modules|\.env|tests|\.git/)
  })

  it("has a liveness HEALTHCHECK on /health", () => {
    expect(runtimeStage).toMatch(/HEALTHCHECK .*\n?\s*CMD \["node", "healthcheck\.mjs"\]/)
    expect(read("backend/healthcheck.mjs")).toMatch(/127\.0\.0\.1:\$\{port\}\/health/)
  })

  it("passes no secret as a build arg", () => {
    expect([...dockerfile.matchAll(/^ARG (\w+)/gm)].map((m) => m[1])).toEqual(["NODE_VERSION"])
  })
})

describe("backend/Dockerfile.dockerignore", () => {
  it("denies by default and admits only build inputs", () => {
    expect(ignore[0]).toBe("*")
    const admitted = ignore.filter((r) => r.startsWith("!"))
    expect(admitted).toEqual([
      "!package.json", "!package-lock.json", "!tsconfig.json", "!types/**", "!lib/**",
      "!backend/build.mjs", "!backend/healthcheck.mjs", "!backend/src/**",
    ])
  })

  it("re-excludes env files, keys and node_modules anywhere", () => {
    expect(ignore).toEqual(expect.arrayContaining(["**/.env", "**/.env.*", "**/*.pem", "**/node_modules", "backend/dist"]))
  })

  it("the frontend image context excludes the backend", () => {
    expect(read(".dockerignore").split("\n").map((l) => l.trim())).toContain("backend")
  })
})

describe("compose.yml - backend service", () => {
  it("is built from backend/Dockerfile with the repository as context", () => {
    expect(backend).toMatch(/context: \.\s*$/m)
    expect(backend).toMatch(/dockerfile: backend\/Dockerfile/)
    expect(backend).toMatch(/image: cartoona-backend:local/)
  })

  it("is published on loopback only", () => {
    expect(ports(backend)).toEqual(["127.0.0.1:4000:4000"])
  })

  it("binds 0.0.0.0 inside the container", () => {
    expect(backend).toMatch(/BACKEND_HOST: 0\.0\.0\.0/)
    expect(backend).toMatch(/BACKEND_PORT: "4000"/)
  })

  it("gets the RESTRICTED role URL, never .env.docker or the owner password", () => {
    expect(backend).toMatch(/DATABASE_URL: \$\{BACKEND_DATABASE_URL:-\}/)
    expect(backend).not.toMatch(/env_file/)
    expect(backend).not.toMatch(/POSTGRES_PASSWORD|PGPASSWORD|POSTGRES_USER|SUPABASE/)
  })

  it("waits for a healthy postgres, health-checks itself, and runs no init (Node is PID 1)", () => {
    expect(backend).toMatch(/depends_on:\s*\n\s+postgres:\s*\n\s+condition: service_healthy/)
    expect(backend).toMatch(/test: \["CMD", "node", "healthcheck\.mjs"\]/)
    expect(backend).not.toMatch(/init: true/)
  })
})

describe("frontend stays independent of the backend", () => {
  it("compose: no depends_on and no reference to the backend", () => {
    expect(frontend).not.toBe("")
    expect(frontend).not.toMatch(/depends_on|backend|4000/)
  })

  it("no frontend code calls or imports the backend", () => {
    const files = [...walk("app"), ...walk("components"), ...walk("lib"), "middleware.ts", "next.config.ts"].filter((f) => fs.existsSync(path.join(root, f)))
    expect(files.length).toBeGreaterThan(50)
    const offenders = files.filter((f) => /@\/backend\/|localhost:4000|backend:4000|BACKEND_(PORT|HOST|URL|DATABASE_URL)/.test(read(f)))
    expect(offenders).toEqual([])
  })

  it(".env.docker.example points the backend at the app login role, not the owner", () => {
    const template = read(".env.docker.example")
    expect(/^BACKEND_DATABASE_URL=(.*)$/m.exec(template)?.[1]).toBe(
      "postgresql://cartoona_app_login:your-app-db-password@postgres:5432/cartoona",
    )
    expect(/^CARTOONA_APP_DB_PASSWORD=(.*)$/m.exec(template)?.[1]).toBe("your-app-db-password")
  })
})

describe("module boundaries", () => {
  const backendSrc = walk("backend/src")
  const shared = [...walk("lib/db"), ...walk("lib/repositories")]

  it.each(backendSrc)("%s imports no Next.js, React, Supabase or server-only", (file) => {
    for (const [, spec] of code(file).matchAll(/from\s+"([^"]+)"/g)) {
      expect(spec).not.toMatch(/^(next(\/|$)|react|@supabase\/|server-only$)/)
      expect(spec).not.toMatch(/lib\/(supabase|auth)\b|request-context|auth-events/)
    }
  })

  it.each(shared)("%s does not import Fastify", (file) => {
    expect(read(file)).not.toMatch(/from\s+"fastify/)
  })

  it("no CORS package and no Access-Control headers in the backend", () => {
    const pkg = JSON.parse(read("package.json"))
    const deps = { ...pkg.dependencies, ...pkg.devDependencies }
    expect(Object.keys(deps).filter((d) => /cors/.test(d))).toEqual([])
    for (const file of backendSrc) expect(code(file)).not.toMatch(/Access-Control-Allow/i)
  })

  it("only the expected runtime packages were added (no Express, Nest, GraphQL, ORM, Redis, queue)", () => {
    const pkg = JSON.parse(read("package.json"))
    const deps = { ...pkg.dependencies, ...pkg.devDependencies }
    for (const name of ["express", "@nestjs/core", "graphql", "mercurius", "prisma", "@prisma/client", "drizzle-orm", "ioredis", "redis", "bullmq", "bull"]) {
      expect(deps[name], name).toBeUndefined()
    }
    expect(pkg.dependencies.fastify).toBeDefined()
  })

  it("the backend runs no migrations", () => {
    for (const file of backendSrc) expect(code(file)).not.toMatch(/migrate|schema_migrations|database\/migrations/i)
  })

  it("server.ts handles SIGTERM and closes the app; app.ts closes the pool on close", () => {
    const server = code("backend/src/server.ts")
    expect(server).toMatch(/process\.on\("SIGTERM"/)
    expect(server).toMatch(/app\.close\(\)/)
    expect(code("backend/src/app.ts")).toMatch(/addHook\("onClose"/)
  })
})

describe("package scripts", () => {
  const scripts = JSON.parse(read("package.json")).scripts

  it("adds backend scripts without changing the frontend ones", () => {
    expect(scripts).toMatchObject({
      dev: "next dev",
      build: "next build",
      start: "next start",
      "backend:dev": "node backend/build.mjs --dev",
      "backend:build": "node backend/build.mjs",
      "backend:start": "node backend/dist/server.cjs",
      "backend:typecheck": "tsc --noEmit -p backend/tsconfig.json",
    })
  })

  it("the bundle is gitignored", () => {
    expect(read(".gitignore")).toMatch(/^\/backend\/dist\/$/m)
  })
})
