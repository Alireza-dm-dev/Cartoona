import { describe, it, expect } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { runDataCopy } from "@/scripts/db/data-copy/copy"
import {
  ALL_TABLES,
  COPIED_TABLES,
  EXCLUDED,
  EXPECTED_TARGET_MIGRATIONS,
  IDENTITY_PROVIDER,
  PHASES,
  REFERENCE_SEED_COUNTS,
} from "@/scripts/db/data-copy/mapping"
import { DataCopyError, FORBIDDEN_PROJECT_REFS, parseDbUrl, redact, validateTargets } from "@/scripts/db/data-copy/safety"

/**
 * Static guarantees for the V0.1.44 data-copy tool. No database needed.
 */

const root = process.cwd()
const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8")
/** Source without comments, so prose about what is NOT done cannot trip a check. */
const code = (rel: string) => read(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*(\/\/|--).*$/gm, "")
const TOOL = fs.readdirSync(path.join(root, "scripts/db/data-copy")).filter((f) => f.endsWith(".ts")).map((f) => `scripts/db/data-copy/${f}`)
const PW = "s3cret-Pass_word-123"
const local = (db: string, host = "127.0.0.1") => `postgresql://owner:${PW}@${host}:5433/${db}`

function refusal(fn: () => unknown): DataCopyError {
  try {
    fn()
  } catch (e) {
    expect(e).toBeInstanceOf(DataCopyError)
    return e as DataCopyError
  }
  throw new Error("expected a refusal")
}

function walk(dir: string): string[] {
  if (!fs.existsSync(path.join(root, dir))) return []
  const out: string[] = []
  for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`
    if (entry.isDirectory()) out.push(...walk(rel))
    else if (/\.(ts|tsx|js|mjs|cjs)$/.test(entry.name)) out.push(rel)
  }
  return out
}

describe("data-copy mapping covers the plain schema exactly", () => {
  const planTables = [...read("database/migrations/0002_tables.sql").matchAll(/^CREATE TABLE public\.(\w+)/gm), ...read("database/migrations/0003_identity.sql").matchAll(/^CREATE TABLE public\.(\w+)/gm)].map((m) => m[1])

  it("classifies every application table exactly once", () => {
    expect(ALL_TABLES.map((t) => t.table).sort()).toEqual([...planTables].sort())
    expect(new Set(ALL_TABLES.map((t) => t.table)).size).toBe(ALL_TABLES.length)
    expect(ALL_TABLES.filter((t) => t.strategy === "derived").map((t) => t.table)).toEqual(["user_identities"])
    expect(ALL_TABLES.filter((t) => t.strategy === "reference_replace").map((t) => t.table).sort()).toEqual(Object.keys(REFERENCE_SEED_COUNTS).sort())
    expect(EXCLUDED.map((e) => e.object).join(" ")).toMatch(/auth schema[\s\S]*storage schema/)
  })

  it("the reference seed counts are the 0008 seed rows", () => {
    const seed = read("database/migrations/0008_reference_data.sql")
    for (const [table, n] of Object.entries(REFERENCE_SEED_COUNTS)) {
      expect(seed.match(new RegExp(`^INSERT INTO public\\.${table} `, "gm"))?.length, table).toBe(n)
    }
  })

  it("copy order respects every foreign key (one declared cycle handled by a second pass)", () => {
    const order = PHASES.flatMap((p, pi) => p.tables.map((t, ti) => ({ table: t.table, rank: pi * 100 + ti })))
    const rank = (t: string) => order.find((o) => o.table === t)!.rank
    const fks = [
      ...read("database/migrations/0002_tables.sql").matchAll(/ALTER TABLE ONLY public\.(\w+)\s+ADD CONSTRAINT \w+ FOREIGN KEY \((\w+)\) REFERENCES public\.(\w+)/g),
      ["", "user_identities", "user_id", "users"],
    ]
    expect(fks.length).toBeGreaterThan(35)
    for (const [, child, column, parent] of fks) {
      const spec = ALL_TABLES.find((t) => t.table === child)!
      if (spec.secondPass?.column === column) {
        expect(rank(spec.secondPass.after)).toBeGreaterThan(rank(child))
        continue
      }
      expect(rank(parent), `${child}.${column} -> ${parent}`).toBeLessThan(rank(child))
    }
  })

  it("is pinned to exactly the audited migrations 0001-0013", () => {
    const files = fs.readdirSync(path.join(root, "database/migrations")).filter((f) => f.endsWith(".sql")).map((f) => f.replace(/\.sql$/, "")).sort()
    expect(EXPECTED_TARGET_MIGRATIONS).toEqual(files)
    expect(files).toHaveLength(13)
  })
})

describe("data-copy target safety", () => {
  it.each(FORBIDDEN_PROJECT_REFS)("refuses the Cartoona Supabase project %s anywhere in either URL", (ref) => {
    for (const [s, t] of [
      [`postgresql://postgres:${PW}@db.${ref}.supabase.co:5432/postgres`, local("t")],
      [local("s"), `postgresql://postgres.${ref}:${PW}@127.0.0.1:5433/t`],
      [local(`s_${ref}`), local("t")],
    ]) {
      const e = refusal(() => validateTargets({ sourceUrl: s, targetUrl: t }))
      expect(e.code).toBe("unsafe_url")
      expect(e.message).not.toContain(PW)
    }
  })

  it("refuses hosted Supabase hosts, the linked CLI project, and any non-local host", () => {
    for (const host of ["db.abcdefghijklmnopqrst.supabase.co", "aws-0-eu-west-1.pooler.supabase.com", "example.supabase.net"]) {
      expect(refusal(() => validateTargets({ sourceUrl: `postgresql://u:${PW}@${host}:5432/x`, targetUrl: local("t") })).code).toBe("unsafe_url")
    }
    expect(refusal(() => validateTargets({ sourceUrl: local("linkedrefxyz"), targetUrl: local("t"), linkedProjectRef: "linkedrefxyz" })).code).toBe("unsafe_url")
    for (const host of ["10.0.0.5", "db.internal", "prod-db.example.com"]) {
      expect(refusal(() => validateTargets({ sourceUrl: local("s"), targetUrl: `postgresql://u:${PW}@${host}:5432/t` })).message).toMatch(/not local/)
      expect(refusal(() => validateTargets({ sourceUrl: `postgresql://u:${PW}@${host}:5432/s`, targetUrl: local("t") })).message).toMatch(/not local/)
    }
  })

  it("names both databases explicitly: nothing is defaulted or inferred", () => {
    expect(refusal(() => validateTargets({ sourceUrl: undefined, targetUrl: local("t") })).code).toBe("missing_url")
    expect(refusal(() => validateTargets({ sourceUrl: local("s"), targetUrl: "" })).code).toBe("missing_url")
    for (const name of ["PGHOST", "PGHOSTADDR", "PGPORT", "PGDATABASE", "PGSERVICE"]) {
      expect(refusal(() => validateTargets({ sourceUrl: local("s"), targetUrl: local("t"), env: { [name]: "x" } })).code).toBe("ambient_pg_env")
    }
    for (const bad of [`${local("t")}?host=evil`, `postgresql://u:${PW}@127.0.0.1,10.0.0.1:5432/t`, `mysql://u:${PW}@127.0.0.1/t`, local("postgres"), local("template1")]) {
      expect(refusal(() => validateTargets({ sourceUrl: local("s"), targetUrl: bad })).message).not.toContain(PW)
    }
  })

  it("source and target cannot be the same database (any loopback spelling)", () => {
    expect(refusal(() => validateTargets({ sourceUrl: local("same"), targetUrl: local("same") })).code).toBe("same_database")
    expect(refusal(() => validateTargets({ sourceUrl: local("same", "localhost"), targetUrl: local("same", "127.0.0.1") })).code).toBe("same_database")
    expect(validateTargets({ sourceUrl: local("a"), targetUrl: local("b") }).target.label).toBe("owner@127.0.0.1:5433/b")
  })

  it("the production source mode is designed but disabled", () => {
    for (const mode of ["production", "production-export", "remote"]) {
      const e = refusal(() => validateTargets({ sourceUrl: local("s"), targetUrl: local("t"), sourceMode: mode }))
      expect(e.code).toBe("production_mode_disabled")
    }
  })

  it("credentials never appear in labels, refusals, redacted text or connection errors", async () => {
    expect(parseDbUrl(local("db"), "X").label).toBe("owner@127.0.0.1:5433/db")
    expect(redact(`failed for ${local("db")} and pw ${PW}`, [PW])).toBe("failed for postgresql://<redacted> and pw <redacted>")
    // A real connection attempt to a closed local port: the error must not echo the URL or password.
    const err = await runDataCopy({
      sourceUrl: `postgresql://owner:${PW}@127.0.0.1:1/s`,
      targetUrl: `postgresql://owner:${PW}@127.0.0.1:1/t`,
      migrationsDir: path.join(root, "database/migrations"),
      log: (l) => expect(l).not.toContain(PW),
    }).catch((e) => e)
    expect(err).toBeInstanceOf(DataCopyError)
    expect(err.code).toBe("connect_failed")
    expect(`${err.message} ${err.details.join(" ")}`).not.toContain(PW)
  })
})

describe("data-copy behaviour guarantees (source level)", () => {
  it("user ids are preserved: users/identities are never given generated ids", () => {
    const users = ALL_TABLES.find((t) => t.table === "users")!
    expect(users.pk).toEqual(["id"])
    expect(COPIED_TABLES.every((t) => t.pk.length > 0)).toBe(true)
    for (const file of TOOL) expect(code(file), file).not.toMatch(/gen_random_uuid|uuid_generate/)
    // Every copied row keeps the source primary key: inserts list the source columns, ids included.
    expect(code("scripts/db/data-copy/copy.ts")).toMatch(/INSERT INTO public\.\$\{ident\(spec\.table\)\} \(\$\{cols\}\) SELECT \$\{insertCols\} FROM json_populate_recordset/)
  })

  it("identity backfill is ('supabase', users.id::text) for users.id, with no overwrite path", () => {
    expect(IDENTITY_PROVIDER).toBe("supabase")
    const src = code("scripts/db/data-copy/identity.ts")
    expect(src).toMatch(/INSERT INTO public\.user_identities \(id, user_id, provider, provider_subject, created_at\)\s+SELECT md5\('cartoona-identity:' \|\| \$1 \|\| ':' \|\| u\.id::text\)::uuid, u\.id, \$1, u\.id::text, u\.created_at/)
    expect(src).not.toMatch(/ON CONFLICT|UPDATE public\.user_identities|DELETE FROM public\.user_identities/)
    expect(src).toMatch(/backfillSupabaseIdentities[\s\S]*IDENTITY_PROVIDER/)
  })

  it("sessions_not_before is target-only and never written (NULL for copied users)", () => {
    const users = ALL_TABLES.find((t) => t.table === "users")!
    expect(users.targetOnlyColumns).toEqual(["sessions_not_before"])
    expect(read("database/migrations/0011_users_sessions_not_before.sql")).toMatch(/ADD COLUMN sessions_not_before timestamp with time zone;/)
    // mapping.ts only declares it (plus prose notes); the SQL-bearing modules may only check it.
    for (const file of TOOL.filter((f) => !f.endsWith("/mapping.ts"))) {
      for (const line of code(file).split("\n").filter((l) => l.includes("sessions_not_before"))) {
        expect(line, file).toMatch(/targetOnlyColumns|sessions_not_before_set|WHERE sessions_not_before IS NOT NULL/)
      }
    }
    expect(code("scripts/db/data-copy/copy.ts")).not.toMatch(/auth\.sessions|\bamr\b/)
  })

  it("storage bytes and Supabase storage/auth tables are never read or written", () => {
    for (const file of TOOL) {
      const src = code(file)
      expect(src, file).not.toMatch(/\b(from|join|into|update|table)\s+(storage|auth)\./i)
      expect(src, file).not.toMatch(/@supabase\//)
    }
  })

  it("triggers are bypassed by name inside the phase transaction only, never globally", () => {
    const src = code("scripts/db/data-copy/copy.ts")
    expect(src).not.toMatch(/session_replication_role|DISABLE TRIGGER ALL|DISABLE TRIGGER USER/i)
    expect(src).toMatch(/ALTER TABLE public\.\$\{ident\(table\)\} \$\{enable \? "ENABLE" : "DISABLE"\} TRIGGER \$\{ident\(t\.name\)\}/)
    const bypassed = ALL_TABLES.flatMap((t) => [...(t.bypassTriggers ?? []), ...(t.secondPass?.bypassTriggers ?? [])].map((b) => b.name)).sort()
    expect(bypassed).toEqual(["assign_parent_referral_code", "candy_purchases_set_updated_at", "ensure_parent_candy_wallet", "grant_parent_welcome_image_credits"])
    // Append-only guards block UPDATE/DELETE/TRUNCATE only, so history inserts need no bypass.
    expect(read("database/migrations/0006_append_only_guards.sql")).not.toMatch(/BEFORE INSERT/)
  })

  it("the tool reads no ambient configuration: no process.env, DATABASE_URL or .env file", () => {
    for (const file of TOOL) {
      const src = code(file)
      expect(src, file).not.toMatch(/process\.env|env\.DATABASE_URL|dotenv|\.env\.local|\.env\.docker/)
    }
  })

  it("no application runtime imports or bundles the copy tool", () => {
    const runtime = [...walk("app"), ...walk("lib"), ...walk("components"), ...walk("backend/src"), "middleware.ts", "backend/build.mjs"]
    for (const file of runtime) expect(read(file), file).not.toMatch(/data-copy|copy-supabase-to-plain|cartoona_data_copy/)
    for (const file of TOOL) {
      for (const spec of [...read(file).matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1])) {
        expect(spec, file).toMatch(/^(\.\/|node:|pg$)/)
      }
    }
    const bundle = path.join(root, "backend/dist/server.cjs")
    if (fs.existsSync(bundle)) expect(fs.readFileSync(bundle, "utf8")).not.toMatch(/cartoona_data_copy|backfillSupabaseIdentities/)
    expect(JSON.parse(read("package.json")).scripts["db:copy"]).toBe("node scripts/db/copy-supabase-to-plain.mjs")
  })

  it("keeps the V0.1.43 AMR blocker visible: copying is allowed, cutover is not", () => {
    const doc = read("docs/DATA_MIGRATION.md")
    expect(doc).toMatch(/AMR/)
    expect(doc).toMatch(/Production cutover[\s>]+is NOT allowed/)
    expect(read("docs/AUTH_ARCHITECTURE.md")).toMatch(/amr/i)
  })
})
