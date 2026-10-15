import { describe, it, expect } from "vitest"
import fs from "node:fs"
import path from "node:path"

/**
 * Source-level guarantees for the V0.1.39 data-access layer:
 *  - framework-free (reusable by the future Fastify backend);
 *  - no Supabase auth/RLS concepts and no string-built SQL in repositories;
 *  - the application has NOT been switched: no route, page or component
 *    imports the new layer yet;
 *  - the application role migration carries no secret.
 */

const root = process.cwd()
const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8")
/** Source without comments, so prose about what is NOT used cannot trip a check. */
const code = (rel: string) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*(\/\/|--).*$/gm, "")
const filesIn = (dir: string) =>
  fs.readdirSync(path.join(root, dir)).filter((f) => f.endsWith(".ts")).map((f) => `${dir}/${f}`)

const LAYER = [...filesIn("lib/db"), ...filesIn("lib/repositories")]
const REPOSITORIES = filesIn("lib/repositories")

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`
    if (entry.isDirectory()) out.push(...walk(rel))
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(rel)
  }
  return out
}

describe("data-access layer boundaries", () => {
  it("has the expected modules", () => {
    expect(LAYER).toEqual(expect.arrayContaining([
      "lib/db/pool.ts", "lib/db/types.ts", "lib/db/transaction.ts", "lib/db/errors.ts", "lib/db/query.ts", "lib/db/health.ts",
      "lib/repositories/parent-orders.ts", "lib/repositories/welcome-credits.ts", "lib/repositories/creation-pricing.ts",
    ]))
  })

  it.each(LAYER)("%s imports nothing from Next.js, React, Supabase or server-only", (file) => {
    const src = read(file)
    const imports = [...src.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1])
    for (const spec of imports) {
      expect(spec).not.toMatch(/^(next(\/|$)|react|@supabase\/|server-only$)/)
      expect(spec).not.toMatch(/lib\/supabase|lib\/auth/)
    }
    expect(src).not.toMatch(/cookies\(|headers\(|NextResponse/)
  })

  it.each(LAYER)("%s relies on no Supabase auth, RLS or storage schema", (file) => {
    expect(code(file)).not.toMatch(/auth\.uid|auth\.jwt|auth\.users|storage\.(objects|buckets)|service_role|set_config\('request\.jwt/)
  })

  it.each(REPOSITORIES)("%s builds no SQL from runtime values", (file) => {
    const src = code(file)
    expect(src).not.toContain("${")
    expect(src).not.toMatch(/\.query\(\s*[^"`'\s]/) // only runQuery(db, CONSTANT, values)
    expect(src).not.toMatch(/\+\s*["'`]\s*(AND|OR|WHERE|ORDER|LIMIT)/i)
  })

  it("the parent read model the repository shares is framework-free", () => {
    for (const file of ["lib/parent/orders/summary.ts", "lib/parent/orders/pagination.ts", "lib/parent/orders/status-mapping.ts", "lib/credits/welcome-image-credits.ts"]) {
      expect(read(file)).not.toMatch(/from "(server-only|next\/|@supabase\/)/)
    }
  })
})

describe("the application is not switched to PostgreSQL yet", () => {
  const appFiles = [...walk("app"), ...walk("components"), "middleware.ts"].filter((f) => fs.existsSync(path.join(root, f)))

  it.each(appFiles)("%s does not import lib/db or lib/repositories", (file) => {
    expect(read(file)).not.toMatch(/@\/lib\/(db|repositories)\//)
  })

  it("/api/health stays process liveness, with no database dependency", () => {
    const health = read("app/api/health/route.ts")
    expect(health).not.toMatch(/lib\/db|pingDatabase|\bpg\b/)
  })
})

describe("application role migration", () => {
  const sql = code("database/migrations/0009_application_role.sql")

  it("creates a NOLOGIN, non-privileged group role and holds no secret", () => {
    expect(sql).toMatch(/CREATE ROLE cartoona_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS/)
    expect(sql).not.toMatch(/PASSWORD/i)
    expect(sql).not.toMatch(/GRANT\s+(ALL|CREATE)\b/i)
    expect(sql).not.toMatch(/GRANT[^;]*(INSERT|UPDATE|DELETE|TRUNCATE|EXECUTE)/i)
    expect(sql).not.toMatch(/OWNER TO cartoona_app/i)
  })

  it("the login-role script takes the password from env, via stdin, and never prints it", () => {
    const script = read("scripts/db/app-login-role.sh")
    expect(script).toMatch(/CARTOONA_APP_DB_PASSWORD/)
    expect(script).toMatch(/migrate-local\.sh" --check/)
    expect(script).toMatch(/\$\{err\/\/"\$pw"\/\*\*\*\}/)
    expect(script).not.toMatch(/echo[^\n]*\$pw\b(?!")/)
    expect(script).not.toMatch(/-c\s+"[^"]*PASSWORD/)
  })
})
