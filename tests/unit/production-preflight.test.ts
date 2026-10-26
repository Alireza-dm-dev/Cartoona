import { describe, expect, it } from "vitest"
import { runPreflight } from "../../scripts/ops/production-preflight-core.mjs"

const SECRET = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90"
const DB_PASSWORD = "9f8e7d6c5b4a39281706f5e4d3c2b1a0"
const STORAGE_KEY = "sb_secret_TESTONLYVALUE0123456789"

const frontend = {
  NODE_ENV: "production",
  NEXT_PUBLIC_SITE_URL: "https://cartoona.example",
  CARTOONA_APP_ORIGIN: "https://cartoona.example",
  NEXT_PUBLIC_SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "sb_publishable_TESTONLY",
  SUPABASE_SECRET_KEY: STORAGE_KEY,
  BACKEND_INTERNAL_URL: "http://backend.internal:4000",
  CARTOONA_INTERNAL_AUTH_SECRET: SECRET,
  RATE_LIMIT_HASH_SECRET: "0123456789abcdef0123456789abcdef0123",
  RATE_LIMIT_TRUSTED_IP_HEADER: "x-forwarded-for",
}
const backend = {
  NODE_ENV: "production",
  CARTOONA_INTERNAL_AUTH_SECRET: SECRET,
  DATABASE_URL: `postgresql://cartoona_app_prod:${DB_PASSWORD}@db.internal:5432/cartoona`,
  DB_SSL_MODE: "verify-full",
}

const failing = (r: ReturnType<typeof runPreflight>) => r.checks.filter((c) => c.status === "fail").map((c) => c.id)

describe("production preflight (V0.1.55)", () => {
  it("passes a correct frontend and backend environment (payments closed is a warning)", () => {
    const f = runPreflight(frontend, { service: "frontend" })
    expect(failing(f)).toEqual([])
    expect(f.checks.find((c) => c.id === "payment_provider")?.status).toBe("warn")
    expect(runPreflight(backend, { service: "backend" }).ok).toBe(true)
  })

  it("fails when payments are required but no real provider exists", () => {
    expect(failing(runPreflight(frontend, { service: "frontend", payments: true }))).toEqual(["payment_provider"])
  })

  it("refuses the stub provider, test variables and every stub setting in production", () => {
    const r = runPreflight({ ...frontend, CARTOONA_PAYMENT_PROVIDER: "stub", CARTOONA_PAYMENT_STUB_URL: "x", CARTOONA_TEST_DATABASE_URL: "x", RATE_LIMIT_DISABLED: "1", DEV_PARENT_AUTH_ENABLED: "1" }, { service: "frontend" })
    expect(failing(r)).toEqual(expect.arrayContaining(["payment_stub", "forbidden_CARTOONA_PAYMENT_STUB_URL", "forbidden_CARTOONA_TEST_DATABASE_URL", "forbidden_RATE_LIMIT_DISABLED", "forbidden_DEV_PARENT_AUTH_ENABLED"]))
  })

  it("rejects a weak, short, non-hex, placeholder or low-variety internal secret", () => {
    for (const bad of ["", "abc", "z".repeat(64), "your-internal-auth-secret-64-hex-chars", "ab".repeat(32), "a".repeat(32)]) {
      expect(failing(runPreflight({ ...frontend, CARTOONA_INTERNAL_AUTH_SECRET: bad }, { service: "frontend" })), JSON.stringify(bad)).toContain("internal_auth_secret")
    }
  })

  it.each([
    [{ CARTOONA_APP_ORIGIN: "http://cartoona.example" }, "app_origin"],
    [{ CARTOONA_APP_ORIGIN: "https://cartoona.example/" }, "app_origin"],
    [{ CARTOONA_APP_ORIGIN: "https://localhost" }, "app_origin"],
    [{ CARTOONA_APP_ORIGIN: "" }, "app_origin"],
    [{ NEXT_PUBLIC_SITE_URL: "http://cartoona.example" }, "site_url"],
    [{ BACKEND_INTERNAL_URL: "https://cartoona.example" }, "backend_url"],
    [{ BACKEND_INTERNAL_URL: "http://backend.internal:4000/v1" }, "backend_url"],
    [{ BACKEND_INTERNAL_URL: "" }, "backend_url"],
    [{ NEXT_PUBLIC_SUPABASE_URL: "https://example.com" }, "supabase_url"],
    [{ SUPABASE_SECRET_KEY: "" }, "supabase_storage_key"],
    [{ SUPABASE_SECRET_KEY: "sb_publishable_TESTONLY" }, "supabase_storage_key"],
    [{ RATE_LIMIT_HASH_SECRET: "short" }, "rate_limit_secret"],
    [{ NEXT_PUBLIC_DATABASE_URL: "x" }, "public_NEXT_PUBLIC_DATABASE_URL"],
    [{ NEXT_PUBLIC_BACKEND_URL: "x" }, "public_NEXT_PUBLIC_BACKEND_URL"],
    [{ DATABASE_URL: "postgresql://x" }, "frontend_forbidden_DATABASE_URL"],
    [{ POSTGRES_PASSWORD: "x" }, "frontend_forbidden_POSTGRES_PASSWORD"],
    [{ NODE_ENV: "development" }, "node_env"],
    [{ CARTOONA_PAYMENT_PROVIDER: "somepsp" }, "payment_provider"],
  ])("frontend: %j fails %s", (override, id) => {
    expect(failing(runPreflight({ ...frontend, ...override }, { service: "frontend" }))).toContain(id)
  })

  it.each([
    [{ DATABASE_URL: `postgresql://cartoona:${DB_PASSWORD}@db.internal:5432/cartoona` }, "database_url"],
    [{ DATABASE_URL: `postgresql://postgres:${DB_PASSWORD}@db.internal:5432/cartoona` }, "database_url"],
    [{ DATABASE_URL: `postgresql://cartoona_app_x:${DB_PASSWORD}@db.internal:5432/cartoona?sslmode=require` }, "database_url"],
    [{ DATABASE_URL: `postgresql://cartoona_app_x:${DB_PASSWORD}@db.abcdefghijklmnopqrst.supabase.co:5432/postgres` }, "database_url"],
    [{ DATABASE_URL: "postgresql://cartoona_app_x:short@db.internal:5432/cartoona" }, "database_url"],
    [{ DATABASE_URL: `postgresql://cartoona_app_x@db.internal:5432/cartoona` }, "database_url"],
    [{ DATABASE_URL: "" }, "database_url"],
    [{ DB_SSL_MODE: "disable" }, "database_tls"],
    [{ DB_SSL_MODE: "require" }, "database_tls"],
    [{ SUPABASE_SECRET_KEY: "x" }, "backend_forbidden_SUPABASE_SECRET_KEY"],
    [{ CARTOONA_PAYMENT_WEBHOOK_SECRET: "x" }, "backend_forbidden_CARTOONA_PAYMENT_WEBHOOK_SECRET"],
    [{ DB_POOL_MAX: "500" }, "backend_DB_POOL_MAX"],
    [{ BACKEND_PORT: "abc" }, "backend_BACKEND_PORT"],
  ])("backend: %j fails %s", (override, id) => {
    expect(failing(runPreflight({ ...backend, ...override }, { service: "backend" }))).toContain(id)
  })

  it("plaintext PostgreSQL needs an explicit private-network acknowledgement and then only warns", () => {
    const env = { ...backend, DB_SSL_MODE: "disable" }
    expect(runPreflight(env, { service: "backend", allowPlaintextPrivateDb: true }).ok).toBe(true)
    expect(runPreflight({ ...env, DATABASE_URL: `postgresql://cartoona_app_x:${DB_PASSWORD}@localhost:5433/cartoona` }, { service: "backend" }).checks.find((c) => c.id === "database_tls")?.status).toBe("warn")
  })

  it("reports the write freeze and fails a value that freezes nothing", () => {
    const detail = (env: object, opts = {}) => runPreflight({ ...frontend, ...env }, { service: "frontend", ...opts }).checks.find((c) => c.id === "write_freeze")!
    expect(detail({}).detail).toBe("write freeze is OFF")
    expect(detail({ CARTOONA_WRITE_FREEZE: "1" }).detail).toBe("write freeze is ON")
    expect(detail({ CARTOONA_WRITE_FREEZE: "true" }).status).toBe("fail")
    expect(detail({}, { expectFreeze: "on" }).status).toBe("fail")
    expect(detail({ CARTOONA_WRITE_FREEZE: "1" }, { expectFreeze: "off" }).status).toBe("fail")
    expect(detail({ CARTOONA_WRITE_FREEZE: "1" }, { expectFreeze: "on" }).status).toBe("pass")
  })

  it("never puts a configured value in the report, even when every check fails", () => {
    const bad = { ...frontend, ...backend, CARTOONA_APP_ORIGIN: "http://leak-me.example", BACKEND_INTERNAL_URL: "http://u:leak-pass@host/leak-path", RATE_LIMIT_HASH_SECRET: "leak-hash" }
    for (const service of ["frontend", "backend"] as const) {
      const text = JSON.stringify(runPreflight(bad, { service }))
      for (const secret of [SECRET, DB_PASSWORD, STORAGE_KEY, "leak-me", "leak-pass", "leak-path", "leak-hash", "db.internal"]) expect(text).not.toContain(secret)
    }
  })

  it("is a read-only script: no network, database, file-write or child-process imports", async () => {
    const fs = await import("node:fs")
    for (const f of ["production-preflight.mjs", "production-preflight-core.mjs"]) {
      const src = fs.readFileSync(`scripts/ops/${f}`, "utf8")
      expect(src).not.toMatch(/from "(pg|node:net|node:http|node:https|node:child_process|node:fs)"|fetch\(|writeFile|appendFile/)
    }
  })
})
