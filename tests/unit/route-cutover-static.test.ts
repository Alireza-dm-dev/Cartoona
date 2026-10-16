import { describe, it, expect } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { composeService, withoutYamlComments } from "../helpers/compose-text"

/**
 * Static guards for the V0.1.41 cutover of GET /api/creation-pricing to the
 * Fastify backend: scope (only this route), no Supabase fallback, no direct
 * database access from the frontend, and an address/credential boundary that
 * the browser and the frontend container cannot cross.
 */

const root = path.resolve(__dirname, "../..")
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8")
const code = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")

function walk(dir: string, pattern = /\.(ts|tsx|js|jsx|mjs)$/): string[] {
  if (!fs.existsSync(path.join(root, dir))) return []
  const out: string[] = []
  for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`
    if (entry.isDirectory()) out.push(...walk(rel, pattern))
    else if (pattern.test(entry.name)) out.push(rel)
  }
  return out
}

const frontendFiles = [...walk("app"), ...walk("components"), ...walk("lib"), "middleware.ts"].filter((f) => fs.existsSync(path.join(root, f)))
const compose = withoutYamlComments(read("compose.yml"))
const frontend = composeService(compose, "frontend")
const backend = composeService(compose, "backend")

describe("scope: creation pricing is the only migrated route", () => {
  it("only app/api/creation-pricing/route.ts uses the backend client", () => {
    const users = frontendFiles
      .filter((f) => !f.startsWith("lib/backend/"))
      .filter((f) => /@\/lib\/backend\//.test(read(f)))
    expect(users).toEqual(["app/api/creation-pricing/route.ts"])
  })

  it("the other pricing/billing/order/auth/storage routes still read Supabase and never the backend", () => {
    const routes = walk("app/api").filter((f) => f !== "app/api/creation-pricing/route.ts" && f !== "app/api/health/route.ts")
    expect(routes.length).toBeGreaterThan(10)
    for (const route of routes) expect(read(route)).not.toMatch(/@\/lib\/backend|BACKEND_INTERNAL_URL/)
  })
})

describe("the pricing route has no Supabase path", () => {
  const route = code("app/api/creation-pricing/route.ts")

  it("imports no Supabase, no pg, no repositories, no lib/db", () => {
    expect(route).not.toMatch(/supabase|createServerSupabaseClient|from "pg"|@\/lib\/(db|repositories)|\.from\(|\.rpc\(|cookies\(/i)
  })

  it("the backend client module is Supabase-free and database-free", () => {
    for (const file of walk("lib/backend")) {
      const src = code(file)
      expect(src).not.toMatch(/supabase|from "pg"|@\/lib\/(db|repositories|supabase)|fastify/i)
      expect(src).not.toMatch(/localhost|127\.0\.0\.1/)
    }
  })

  it("the validator the route uses is pure", () => {
    expect(code("lib/pricing/creation-prices.ts")).not.toMatch(/^import /m)
  })
})

describe("no frontend code reaches the database", () => {
  it("nothing under app/, components/ or middleware imports pg, lib/db or lib/repositories", () => {
    const files = [...walk("app"), ...walk("components"), "middleware.ts"].filter((f) => fs.existsSync(path.join(root, f)))
    const offenders = files.filter((f) => /from\s+"(pg|@\/lib\/db\/[^"]*|@\/lib\/repositories\/[^"]*)"/.test(read(f)))
    expect(offenders).toEqual([])
  })
})

describe("BACKEND_INTERNAL_URL never reaches a browser", () => {
  it("is never NEXT_PUBLIC_*, anywhere", () => {
    const files = [...frontendFiles, "compose.yml", "Dockerfile", ".env.example", ".env.local.example", ".env.docker.example", "next.config.ts"]
    for (const file of files) {
      expect(read(file), file).not.toMatch(/NEXT_PUBLIC_BACKEND|NEXT_PUBLIC_[A-Z_]*INTERNAL/)
    }
  })

  it("is not a build arg of the frontend image", () => {
    expect(read("Dockerfile")).not.toMatch(/BACKEND/)
    expect(frontend.split("args:")[1]?.split("image:")[0] ?? "").not.toMatch(/BACKEND/)
  })

  it("only server-only modules read it", () => {
    const readers = frontendFiles.filter((f) => /BACKEND_INTERNAL_URL/.test(code(f)))
    expect(readers).toEqual(["lib/backend/config.ts"])
    expect(read("lib/backend/client.ts")).toMatch(/^import "server-only"/m)
  })

  it("no Client Component imports the backend client", () => {
    const clients = frontendFiles.filter((f) => /^["']use client["']/m.test(read(f)))
    expect(clients.length).toBeGreaterThan(10)
    for (const file of clients) expect(read(file), file).not.toMatch(/@\/lib\/backend\//)
  })

  it("the browser-side hook still calls only /api/creation-pricing", () => {
    const hook = read("lib/pricing/use-creation-pricing.ts")
    expect(hook).toMatch(/fetch\(`\/api\/creation-pricing\?_=/)
    expect(hook).not.toMatch(/backend|4000|\/v1\//i)
  })
})

describe("compose: the frontend holds no database credential", () => {
  const template = read(".env.docker.example")
  const templateVars = [...template.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1])
  const databaseVars = templateVars.filter((n) => /^(POSTGRES_|.*DATABASE_URL$|.*DB_PASSWORD$)/.test(n))

  it("the template's database variables are all blanked for the frontend", () => {
    expect(databaseVars).toEqual(expect.arrayContaining(["POSTGRES_DB", "POSTGRES_USER", "POSTGRES_PASSWORD", "DATABASE_URL", "LOCAL_DATABASE_URL", "CARTOONA_APP_DB_PASSWORD", "BACKEND_DATABASE_URL"]))
    for (const name of databaseVars) {
      expect(frontend, name).toMatch(new RegExp(`^\\s+${name}:\\s*""\\s*$`, "m"))
    }
  })

  it("no frontend environment entry carries a database value or a backend secret", () => {
    const entries = [...frontend.matchAll(/^\s{6}([A-Z][A-Z0-9_]*):\s*(.*)$/gm)].map((m) => [m[1], m[2].trim()] as const)
    for (const [name, value] of entries) {
      if (/^(POSTGRES_|.*DATABASE_URL$|.*DB_PASSWORD$)/.test(name)) expect(value, name).toBe('""')
      expect(value, name).not.toMatch(/postgres(ql)?:\/\/|cartoona_app_login/)
    }
  })

  it("has the internal URL and a bounded timeout, and no startup dependency on the backend", () => {
    expect(frontend).toMatch(/^\s+BACKEND_INTERNAL_URL: http:\/\/backend:4000\s*$/m)
    expect(frontend).toMatch(/BACKEND_REQUEST_TIMEOUT_MS: \$\{BACKEND_REQUEST_TIMEOUT_MS:-3000\}/)
    expect(frontend).not.toMatch(/depends_on/)
  })

  it("the backend still gets only the restricted URL and no env_file", () => {
    expect(backend).toMatch(/DATABASE_URL: \$\{BACKEND_DATABASE_URL:-\}/)
    expect(backend).not.toMatch(/env_file|POSTGRES_PASSWORD|PGPASSWORD|BACKEND_INTERNAL_URL/)
  })
})

describe("env templates carry placeholders only", () => {
  it("BACKEND_INTERNAL_URL appears with local examples, never a credential or NEXT_PUBLIC_", () => {
    for (const file of [".env.example", ".env.local.example"]) {
      const line = read(file).match(/^BACKEND_INTERNAL_URL=(.*)$/m)
      expect(line, file).not.toBeNull()
      expect(line![1]).toMatch(/^(|http:\/\/127\.0\.0\.1:4000)$/)
    }
    expect(read(".env.docker.example")).not.toMatch(/^BACKEND_INTERNAL_URL=/m)
  })
})
