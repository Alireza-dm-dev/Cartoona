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

// The only frontend code that calls the backend: the migrated public read
// (V0.1.41), the auth-chain proof (V0.1.42) and the parent orders LIST loader
// (V0.1.45), which serves exactly two surfaces: GET /api/parent/orders and the
// /dashboard/orders first page.
const BACKEND_CLIENT_USERS = ["app/api/auth/backend-me/route.ts", "app/api/creation-pricing/route.ts", "lib/parent/orders/backend-orders.ts"]
const ORDERS_LIST_SURFACES = ["app/(dashboard)/dashboard/orders/page.tsx", "app/api/parent/orders/route.ts"]
const BACKEND_ROUTES = ["app/api/auth/backend-me/route.ts", "app/api/creation-pricing/route.ts", "app/api/parent/orders/route.ts"]

describe("scope: creation pricing and the parent orders LIST are the only migrated business reads", () => {
  it("only the pricing route, the auth proof route and the orders-list loader use the backend client", () => {
    const users = frontendFiles
      .filter((f) => !f.startsWith("lib/backend/"))
      .filter((f) => /@\/lib\/backend\//.test(read(f)))
    expect(users.sort()).toEqual(BACKEND_CLIENT_USERS)
  })

  it("the orders-list loader is used by the list route and the list page only", () => {
    const users = frontendFiles.filter((f) => /@\/lib\/parent\/orders\/backend-orders/.test(read(f)))
    expect(users.sort()).toEqual(ORDERS_LIST_SURFACES)
  })

  it("every other route (order detail, final media, gallery, billing, writes...) never reaches the backend", () => {
    const routes = walk("app/api").filter((f) => !BACKEND_ROUTES.includes(f) && f !== "app/api/health/route.ts")
    expect(routes.length).toBeGreaterThan(10)
    expect(routes).toContain("app/api/parent/orders/[orderId]/final-media/route.ts")
    for (const route of routes) expect(read(route)).not.toMatch(/@\/lib\/backend|BACKEND_INTERNAL_URL|backend-orders/)
    for (const page of walk("app").filter((f) => f.endsWith("page.tsx") && !ORDERS_LIST_SURFACES.includes(f))) {
      expect(read(page), page).not.toMatch(/@\/lib\/backend|backend-orders/)
    }
  })

  it("the backend exposes exactly the migrated routes, and only GETs", () => {
    const routes = walk("backend/src/routes").map((f) => read(f)).join("\n")
    const registered = [...routes.matchAll(/app\.(get|post|put|patch|delete|route)\(\s*"([^"]+)"/g)].map((m) => `${m[1].toUpperCase()} ${m[2]}`)
    expect(registered.sort()).toEqual(["GET /health", "GET /ready", "GET /v1/auth/me", "GET /v1/creation-pricing", "GET /v1/parent/orders"])
  })
})

describe("the parent orders LIST reads no Supabase data", () => {
  const surfaces = [...ORDERS_LIST_SURFACES, "lib/parent/orders/backend-orders.ts"]

  it("no Supabase table/RPC query, no pg, lib/db or repositories in the route, page or loader", () => {
    for (const file of surfaces) {
      const src = code(file)
      expect(src, file).not.toMatch(/\.from\(|\.rpc\(|from "pg"|@\/lib\/(db|repositories)\/|resolveParentRequestContext|get_parent_orders_delivered_at/)
    }
    // Supabase stays only as the identity provider: session verification and the local sign-out.
    expect(code("app/api/parent/orders/route.ts")).not.toMatch(/createServerSupabaseClient\(\)/)
    expect(code("lib/parent/orders/backend-orders.ts")).toMatch(/verifySupabaseIdentity\(\)/)
  })

  it("the old Supabase list query is gone, and nothing else used it", () => {
    expect(fs.existsSync(path.join(root, "lib/parent/orders/queries.ts"))).toBe(false)
    for (const file of frontendFiles) expect(read(file), file).not.toMatch(/@\/lib\/parent\/orders\/queries"/)
  })

  it("the browser still calls only Next for orders, never the backend", () => {
    const loadMore = read("components/dashboard/orders/orders-load-more.tsx")
    expect(loadMore).toMatch(/fetch\(`\/api\/parent\/orders\?cursor=/)
    expect(loadMore).not.toMatch(/backend|4000|\/v1\//i)
  })

  it("the backend route takes the caller from requireAuth only, is parent-only, and resolves the profile itself", () => {
    const route = code("backend/src/routes/parent-orders.ts")
    expect(route).toMatch(/preHandler: \[requireAuth\(deps\), requireRole\("parent"\)\]/)
    expect(route).toMatch(/request\.authPrincipal!\.userId/)
    expect(route).toMatch(/findParentProfileIdByUserId\(deps\.db\(\), \{ userId \}\)/)
    expect(route).toMatch(/rejectUnknown: true/)
    expect(route).not.toMatch(/request\.(headers|body|cookies)|x-user-id|x-role|authorization|parentProfileId:\s*request/i)
    expect(route).toMatch(/Cache-Control", "no-store"/)
  })

  it("the Next route forwards no browser identity and is dynamic and uncached", () => {
    const route = code("app/api/parent/orders/route.ts")
    expect(route).toMatch(/export const dynamic = "force-dynamic"/)
    expect(route).toMatch(/"Cache-Control": "no-store"/)
    expect(route).not.toMatch(/request\.headers|x-user-id|x-role|parentProfileId|cookies\(/i)
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
