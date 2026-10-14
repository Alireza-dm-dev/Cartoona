import { describe, it, expect } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { composeService, composeServiceNames } from "../helpers/compose-text"

/**
 * Static guards for the V0.1.35 container setup.
 *
 * These assert the properties that make the image safe and reproducible — no
 * secrets in the build context, non-root runtime, standalone server, a health
 * endpoint that cannot depend on a backend — rather than the exact text of the
 * files, so ordinary edits to comments or layer order do not break them.
 */

const root = path.resolve(__dirname, "../..")
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8")
/** Non-comment lines only: a rule must be real, not described in a comment. */
const directives = (source: string) =>
  source
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))

/** Everything from the last FROM onwards: the only stage that ships. */
const runnerStage = (dockerfile: string) => dockerfile.slice(dockerfile.lastIndexOf("FROM node:"))

/** Source with comments stripped, so prose cannot satisfy or break a check. */
const code = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")

describe("Dockerfile", () => {
  const dockerfile = read("Dockerfile")
  const lines = directives(dockerfile)

  it("exists and is a multi-stage build with deps/builder/runner", () => {
    const stages = lines
      .filter((l) => /^FROM /i.test(l))
      .map((l) => l.split(/\s+AS\s+/i)[1])
    expect(stages).toEqual(["deps", "builder", "runner"])
  })

  it("pins the Node major version on an official image", () => {
    expect(dockerfile).toMatch(/ARG NODE_VERSION=\d+/)
    for (const from of lines.filter((l) => /^FROM /i.test(l))) {
      expect(from).toMatch(/^FROM node:\$\{NODE_VERSION\}-/)
    }
  })

  it("installs dependencies deterministically from the lockfile", () => {
    expect(lines.some((l) => /^RUN npm ci\b/.test(l))).toBe(true)
    expect(dockerfile).not.toMatch(/RUN\s+npm\s+install/)
  })

  it("ships only the standalone artifacts, not the source tree or node_modules", () => {
    const runner = runnerStage(dockerfile)
    expect(runner).toContain("/app/.next/standalone")
    expect(runner).toContain("/app/.next/static")
    expect(runner).toContain("/app/public")
    expect(runner).not.toMatch(/COPY --from=builder[^\n]*node_modules/)
    expect(runner).not.toMatch(/COPY --from=deps/)
  })

  it("runs as an unprivileged user that owns the copied files", () => {
    const userLines = lines.filter((l) => /^USER /i.test(l))
    expect(userLines.length).toBeGreaterThan(0)
    // The last USER wins; it must not be root.
    const finalUser = userLines[userLines.length - 1]
    expect(finalUser).toMatch(/^USER\s+(?!root\b|0\b)\S+/i)
    // Only the shipping stage matters: the builder's files never leave it.
    for (const copy of directives(runnerStage(dockerfile)).filter((l) => /^COPY /i.test(l))) {
      expect(copy).toMatch(/--chown=nextjs:nodejs/)
    }
    expect(dockerfile).not.toMatch(/chmod\s+777/)
  })

  it("serves the standalone server in production, never a dev server", () => {
    expect(lines).toContain('CMD ["node", "server.js"]')
    expect(lines.join("\n")).not.toMatch(/npm run dev|next dev|npm start/)
    expect(dockerfile).toMatch(/ENV NODE_ENV=production/)
  })

  it("exposes 3000 and binds all interfaces", () => {
    expect(lines).toContain("EXPOSE 3000")
    expect(dockerfile).toMatch(/HOSTNAME=0\.0\.0\.0/)
  })

  it("declares a Node-based healthcheck and needs no curl/wget", () => {
    expect(dockerfile).toMatch(/HEALTHCHECK[\s\S]*CMD \["node", "healthcheck\.mjs"\]/)
    expect(dockerfile).not.toMatch(/apt-get install[^\n]*(curl|wget)/)
  })

  it("accepts no secret as a build argument", () => {
    const args = lines
      .filter((l) => /^ARG /i.test(l))
      .map((l) => l.replace(/^ARG\s+/i, "").split("=")[0].trim())
    for (const name of args) {
      if (name === "NODE_VERSION") continue
      expect(name).toMatch(/^NEXT_PUBLIC_/)
    }
    // Prose may name a secret to explain why it is absent; a directive may not.
    expect(lines.join("\n")).not.toMatch(/SUPABASE_SECRET_KEY|RATE_LIMIT_HASH_SECRET|SERVICE_ROLE/)
  })

  it("hard-codes no credential-shaped value and copies no env file", () => {
    expect(dockerfile).not.toMatch(/[a-z0-9-]+\.supabase\.co/)
    expect(dockerfile).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/) // a JWT-shaped key
    expect(lines.join("\n")).not.toMatch(/COPY[^\n]*\.env(\s|$|\.)/)
  })
})

describe(".dockerignore", () => {
  const rules = directives(read(".dockerignore"))

  it("keeps real env files, git history, logs and local data out of the context", () => {
    for (const rule of [".env", ".env.*", ".git", "node_modules", ".next", "*.log"]) {
      expect(rules).toContain(rule)
    }
    expect(rules.some((r) => /^(coverage)$/.test(r))).toBe(true)
    expect(rules.some((r) => /^test-results$/.test(r))).toBe(true)
    expect(rules.some((r) => /^scratchpad$/.test(r))).toBe(true)
    expect(rules.some((r) => /sqlite|pgdata|postgres-data/.test(r))).toBe(true)
    expect(rules).toContain(".DS_Store")
  })

  it("never re-includes a real env file, only the placeholder templates", () => {
    for (const negation of rules.filter((r) => r.startsWith("!"))) {
      expect(negation).toMatch(/\.example$/)
    }
  })

  it("keeps what the build genuinely needs", () => {
    for (const needed of ["package.json", "package-lock.json", "next.config.ts", "public", "assets", "app", "lib", "components", "docker"]) {
      expect(rules).not.toContain(needed)
    }
  })
})

describe("compose.yml — app service", () => {
  const compose = read("compose.yml")
  // Scoped to the app block: the postgres service (V0.1.37) has its own
  // healthcheck/restart/ports and must not satisfy these by accident.
  const app = composeService(compose, "app")

  it("uses the modern format with no obsolete version key", () => {
    expect(compose).toMatch(/^services:/m)
    expect(compose).not.toMatch(/^version:/m)
  })

  it("defines one app service built from the project Dockerfile", () => {
    expect(app).not.toBe("")
    expect(app).toMatch(/dockerfile: Dockerfile/)
    expect(app).toMatch(/image: cartoona-app:local/)
  })

  it("publishes port 3000 and binds the container to all interfaces", () => {
    expect(app).toMatch(/-\s*"3000:3000"/)
    expect(app).toMatch(/HOSTNAME: 0\.0\.0\.0/)
  })

  it("has a restart policy and a healthcheck with sane timings", () => {
    expect(app).toMatch(/restart: unless-stopped/)
    expect(app).toMatch(/test: \["CMD", "node", "healthcheck\.mjs"\]/)
    expect(app).toMatch(/interval: 30s/)
    expect(app).toMatch(/timeout: 5s/)
    expect(app).toMatch(/retries: 3/)
    expect(app).toMatch(/start_period: \d+s/)
  })

  it("supplies runtime configuration from an operator-provided env file", () => {
    expect(app).toMatch(/env_file:/)
    expect(app).toMatch(/\.env\.docker\b/)
    expect(compose).not.toMatch(/\.env\.local/)
  })

  it("embeds no credentials — build args are NEXT_PUBLIC_* interpolations only", () => {
    const argValues = [...compose.matchAll(/^\s+(NEXT_PUBLIC_\w+):\s*(.+)$/gm)]
    expect(argValues.length).toBeGreaterThan(0)
    for (const [, , value] of argValues) {
      expect(value.trim()).toMatch(/^\$\{[A-Z_]+:-[^}]*\}$/)
    }
    expect(compose).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/)
    expect(compose).not.toMatch(/SUPABASE_SECRET_KEY\s*:\s*\S/)
    expect(compose).not.toMatch(/[a-z0-9-]+\.supabase\.co/)
  })

  it("runs no backend emulator — the only services are app and postgres", () => {
    // V0.1.37 deliberately adds a plain PostgreSQL (see
    // docker-postgres-foundation.test.ts); Supabase emulators stay out.
    const services = composeServiceNames(compose)
    expect(services).toEqual(["app", "postgres"])
    expect(compose).not.toMatch(/supabase\/|pgbouncer|gotrue|postgrest\/postgrest/)
  })
})

describe(".env.docker.example", () => {
  const template = read(".env.docker.example")

  it("is a placeholder-only template", () => {
    expect(template).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/)
    // Non-secret identifiers with a fixed recommended value (V0.1.37).
    const fixedNames: Record<string, string> = { POSTGRES_DB: "cartoona", POSTGRES_USER: "cartoona" }
    for (const [, name, value] of template.matchAll(/^([A-Z_]+)=(.*)$/gm)) {
      expect(name).toMatch(/^[A-Z_]+$/)
      if (value.trim() === "") continue
      if (name in fixedNames) {
        expect(value).toBe(fixedNames[name])
        continue
      }
      expect(value).toMatch(/your-|localhost/)
    }
  })

  it("documents the build-time vs runtime split", () => {
    expect(template).toMatch(/BUILD-TIME/)
    expect(template).toMatch(/RUNTIME ONLY/)
  })

  it("is the committed file — .env.docker itself is gitignored", () => {
    expect(fs.existsSync(path.join(root, ".env.docker.example"))).toBe(true)
    const gitignore = read(".gitignore")
    expect(directives(gitignore)).toContain(".env*")
    expect(directives(gitignore)).toContain("!.env.docker.example")
    expect(directives(gitignore)).not.toContain("!.env.docker")
  })
})

describe("next.config.ts", () => {
  const config = read("next.config.ts")

  it("configures standalone output", () => {
    expect(config).toMatch(/output:\s*["']standalone["']/)
  })
})

describe("health endpoint", () => {
  const source = read("app/api/health/route.ts")

  it("depends on no backend, directly or by import", () => {
    expect(code(source)).not.toMatch(/supabase/i)
    expect(code(source)).not.toMatch(/process\.env/)
    expect(code(source)).not.toMatch(/\bfetch\(/)
    const imports = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1])
    expect(imports).toEqual(["next/server"])
  })

  it("answers 200 with a fixed, non-revealing body", async () => {
    const { GET } = await import("@/app/api/health/route")
    const response = await GET()
    expect(response.status).toBe(200)
    expect(response.headers.get("Cache-Control")).toBe("no-store")
    const body = await response.json()
    expect(body).toEqual({ status: "ok" })
  })

  it("is outside the auth middleware matcher, so it needs no session", async () => {
    const { config } = await import("@/middleware")
    for (const pattern of config.matcher) {
      expect(pattern).not.toMatch(/^\/api/)
    }
    expect(config.matcher).not.toContain("/:path*")
  })
})

describe("existing app behaviour is untouched", () => {
  it("keeps the dev workflow on next dev and start on next start", () => {
    const pkg = JSON.parse(read("package.json"))
    expect(pkg.scripts.dev).toBe("next dev")
    expect(pkg.scripts.build).toBe("next build")
    expect(pkg.scripts.start).toBe("next start")
  })

  it("still serves the non-homepage background as a hashed static import", () => {
    const source = read("components/ui/app-background.tsx")
    expect(source).toMatch(/import appBackground from "@\/assets\/non-homepage\/app-background\.webp"/)
    expect(fs.existsSync(path.join(root, "assets/non-homepage/app-background.webp"))).toBe(true)
  })

  it("prerenders nothing that queries the backend, so the build needs no Supabase", () => {
    // Any page or layout that builds a server Supabase client throws on a
    // missing configuration, so prerendering it would tie `docker build` to a
    // live backend. `public-header-account` is deliberately absent: it swallows
    // a configuration failure and degrades to the anonymous header.
    const routeFiles: string[] = []
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
        const next = `${dir}/${entry.name}`
        if (entry.isDirectory()) walk(next)
        else if (entry.name === "page.tsx" || entry.name === "layout.tsx") routeFiles.push(next)
      }
    }
    walk("app")

    const backendBacked = routeFiles.filter((file) => {
      const source = read(file)
      return (
        source.includes("@/lib/supabase/server") ||
        source.includes("@/lib/homepage/resolver")
      )
    })

    expect(backendBacked.length).toBeGreaterThan(0)
    for (const file of backendBacked) {
      expect(read(file), `${file} must be force-dynamic`).toMatch(
        /export const dynamic = ["']force-dynamic["']/,
      )
    }
  })
})
