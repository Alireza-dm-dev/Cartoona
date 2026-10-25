import { describe, it, expect } from "vitest"
import fs from "node:fs"
import path from "node:path"

/**
 * V0.1.53 RUNTIME ZERO-DATABASE GUARD. After this release Supabase is Auth and
 * Storage bytes only; every business row is in PostgreSQL behind the backend.
 * This scans the whole RUNTIME tree (app, components, lib, backend/src,
 * middleware.ts) and fails on any Supabase DATABASE use:
 *
 *   - `.rpc(` of any kind
 *   - `.from("<a public table>")`, where the table names are READ FROM the schema
 *     migrations (not a hand list), so a new table is covered automatically
 *   - PostgREST endpoints (`/rest/v1`)
 *   - a Supabase client that exposes `.from()` / `.rpc()` in its TYPE
 *
 * Allowed: Auth methods, Storage (`.storage.from("<bucket>")`, bytes and signed
 * URLs). Historical migrations, tests and fixtures are not runtime. Exemptions
 * are explicit and minimal (EXEMPT below; currently none).
 */

const root = process.cwd()
const read = (f: string) => fs.readFileSync(path.join(root, f), "utf8")
const code = (f: string) => read(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1")

function walk(dir: string, out: string[] = []): string[] {
  const full = path.join(root, dir)
  if (!fs.existsSync(full)) return out
  for (const e of fs.readdirSync(full, { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`
    if (e.isDirectory()) walk(rel, out)
    else if (/\.(ts|tsx|mjs|js)$/.test(e.name)) out.push(rel)
  }
  return out
}

const RUNTIME = [...walk("app"), ...walk("components"), ...walk("lib"), ...walk("backend/src"), "middleware.ts"]
/** Explicit, minimal exemptions: file -> reason. None today. */
const EXEMPT: Record<string, string> = {}

const SCHEMA_TABLES = new Set<string>(
  ["database/migrations/0002_tables.sql", "database/migrations/0003_identity.sql"].flatMap((f) =>
    [...read(f).matchAll(/CREATE TABLE public\.([a-z_]+)/g)].map((m) => m[1]),
  ),
)

describe("the schema table list is real", () => {
  it("covers the business tables the old Supabase reads used", () => {
    for (const t of ["users", "parent_profiles", "orders", "media_assets", "examples", "homepage_content", "referral_relationships", "candy_wallets", "audit_logs"]) {
      expect(SCHEMA_TABLES.has(t), t).toBe(true)
    }
    expect(SCHEMA_TABLES.size).toBeGreaterThan(30)
  })
})

describe("runtime code makes no Supabase database call", () => {
  const files = RUNTIME.filter((f) => !(f in EXEMPT))

  it("scans a real tree", () => {
    expect(files.length).toBeGreaterThan(300)
  })

  it("no `.rpc(` anywhere", () => {
    const hits = files.filter((f) => /\.rpc\s*\(/.test(code(f)))
    expect(hits).toEqual([])
  })

  it("no `.from(<table>)` of any schema table (Storage `.storage.from(<bucket>)` is the only `.from(` allowed)", () => {
    const offenders: string[] = []
    for (const f of files) {
      const src = code(f).replace(/\.storage\s*\.from\(/g, ".storage.STORAGE(")
      for (const m of src.matchAll(/\.from\(\s*(["'`])([^"'`]+)\1/g)) {
        if (SCHEMA_TABLES.has(m[2])) offenders.push(`${f}: .from("${m[2]}")`)
      }
    }
    expect(offenders).toEqual([])
  })

  it("no `.from(` on a Supabase client at all outside Storage (Array/Buffer/Object.from excepted)", () => {
    const offenders: string[] = []
    for (const f of files) {
      const src = code(f).replace(/\.storage\s*\.from\(/g, ".storage.STORAGE(")
      for (const m of src.matchAll(/([A-Za-z_$][\w$]*)\s*\.from\(/g)) {
        if (!["Array", "Buffer", "Object", "Uint8Array"].includes(m[1])) offenders.push(`${f}: ${m[1]}.from(`)
      }
      // multi-line chains: `supabase\n  .from("x")`
      if (/\)\s*\n\s*\.from\(\s*["'`]/.test(src)) offenders.push(`${f}: chained .from(`)
    }
    expect(offenders).toEqual([])
  })

  it("no PostgREST endpoint", () => {
    const hits = files.filter((f) => /\/rest\/v1\b|postgrest/i.test(code(f)))
    expect(hits).toEqual([])
  })

  it("the Supabase helpers' return types expose no `.from()` / `.rpc()`", () => {
    const types = code("lib/supabase/types.ts")
    expect(types).toMatch(/Pick<SupabaseClient, "auth" \| "storage">/)
    expect(types).toMatch(/Pick<SupabaseClient, "storage">/)
    expect(code("lib/supabase/server.ts")).toMatch(/Promise<SupabaseSessionClient>/)
    expect(code("lib/supabase/client.ts")).toMatch(/: SupabaseSessionClient/)
    expect(code("lib/supabase/admin.ts")).toMatch(/: SupabaseStorageServiceClient/)
  })
})

describe("the service credential is Storage-only", () => {
  it("SUPABASE_SECRET_KEY is read in exactly two modules: the Storage client and the dev-only Auth Admin helper", () => {
    const readers = RUNTIME.filter((f) => /SUPABASE_SECRET_KEY/.test(code(f))).sort()
    expect(readers).toEqual(["lib/auth/dev-auth-admin.ts", "lib/supabase/admin.ts"])
    // The Auth Admin helper only ever talks to /auth/v1 (user list/create/delete/link), is imported by the dev route alone,
    // and that route answers 404 unless dev auth is explicitly enabled.
    const helper = code("lib/auth/dev-auth-admin.ts")
    expect([...helper.matchAll(/\$\{getSupabaseUrl\(\)\}(\/[a-z0-9_/]+)/g)].map((m) => m[1])).toEqual(["/auth/v1"])
    expect(helper).not.toMatch(/\/rest\/|\/storage\/|\.rpc\(|\.from\(/)
    const importers = RUNTIME.filter((f) => /dev-auth-admin/.test(code(f)) && f !== "lib/auth/dev-auth-admin.ts")
    expect(importers).toEqual(["app/api/dev/parent-auth/route.ts"])
  })

  it("createAdminSupabaseClient is imported only by the three Storage modules", () => {
    const users = RUNTIME.filter((f) => /createAdminSupabaseClient/.test(code(f)) && f !== "lib/supabase/admin.ts").sort()
    expect(users).toEqual(["lib/storage/example-media.ts", "lib/storage/final-deliverables.ts", "lib/storage/homepage-media.ts"])
    for (const f of users) {
      expect(code(f), f).not.toMatch(/\.rpc\(|\.auth\b|admin\.from\(/)
      expect(code(f), f).toMatch(/storage/)
    }
  })

  it("no backend code holds a Supabase client or credential", () => {
    for (const f of walk("backend/src")) expect(code(f), f).not.toMatch(/@supabase|SUPABASE_|createClient\(/)
  })
})

describe("the Edge middleware reads no role and no table", () => {
  it("authentication-only routing", () => {
    const mw = code("middleware.ts")
    expect(mw).not.toMatch(/\.from\(|\.rpc\(|role|isAdminRole|isParentRole|checkParentSessionLifetime|disablePostgrest/i)
    expect(mw).toMatch(/supabase\.auth\.getUser\(\)/)
  })
})

describe("role truth is PostgreSQL's: no runtime code reads a role from Supabase", () => {
  it("only lib/auth/backend-role.ts (GET /v1/auth/me) turns a verified identity into a role", () => {
    for (const f of RUNTIME.filter((x) => x.startsWith("app/") || x.startsWith("lib/") || x.startsWith("components/"))) {
      expect(code(f), f).not.toMatch(/select\(\s*["']role["']\s*\)|user_metadata\??\.role|app_metadata\??\.role|roleRow/)
    }
    expect(code("lib/auth/backend-role.ts")).toMatch(/\/v1\/auth\/me/)
  })

  it("the privileged layouts and pages use the page gates, not a lookup", () => {
    expect(code("app/admin/layout.tsx")).toMatch(/gateAdminPage\(/)
    expect(code("app/(dashboard)/layout.tsx")).toMatch(/gateParentPage\(/)
    expect(code("app/(auth)/complete-request/page.tsx")).toMatch(/gateParentPage\(/)
    expect(code("app/(auth)/parent-consent/page.tsx")).toMatch(/gateParentPage\(/)
  })

  it("the old role helpers and Supabase profile creators are gone", () => {
    for (const f of [
      "lib/auth/require-admin.ts", "lib/examples/example-auth.ts", "lib/parent/ensure-parent-profile.ts",
      "app/api/parent/complete-signup/route.ts", "app/api/dev/supabase-check/route.ts", "lib/supabase/postgrest-retry.ts",
      "lib/auth/admin-role.ts", "lib/auth/parent-access.ts", "lib/requests/resolve-character.ts",
    ]) expect(fs.existsSync(path.join(root, f)), f).toBe(false)
  })
})

describe("signup creates no Supabase business state", () => {
  it("neither signup nor the dev route inserts a profile, wallet or credits", () => {
    for (const f of ["app/(auth)/signup/page.tsx", "app/api/dev/parent-auth/route.ts", "app/(auth)/login/page.tsx"]) {
      expect(code(f), f).not.toMatch(/parent_profiles|candy_wallets|parent_welcome_credits|\.insert\(/)
    }
    expect(code("app/(auth)/signup/page.tsx")).toMatch(/ensureParentAccountSetup\(\)/)
  })

  it("the dev route cannot weaken production auth: it is 404 unless explicitly enabled, and issues no session without the backend's role answer", () => {
    const dev = code("app/api/dev/parent-auth/route.ts")
    expect(dev).toMatch(/if \(!isDevAuthEnabled\(\)\)/)
    expect(dev).toMatch(/sessionIsParentCapable\(supabase\)/)
    expect(dev).not.toMatch(/createAdminSupabaseClient|SUPABASE_SECRET_KEY/)
    const gate = code("lib/auth/dev-parent-auth.ts")
    expect(gate).toMatch(/NODE_ENV/)
  })

  it("the password route is Supabase Auth only: no table, no backend write of a credential", () => {
    const pw = code("app/api/parent/password/route.ts")
    expect(pw).toMatch(/supabase\.auth\.updateUser\(/)
    expect(pw).not.toMatch(/callWrite|backendWriteJson|\.from\(|\.rpc\(/)
  })
})
