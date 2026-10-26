import { describe, it, expect, vi, afterEach, beforeEach } from "vitest"

/**
 * lib/db/pool.ts with `pg` replaced by a recording fake: proves the pool is
 * lazy, single per process, configured from env, and fails closed - without a
 * database. Real connections are covered in db-foundation.test.ts and the
 * opt-in postgres-repositories-db.test.ts.
 */

const pg = vi.hoisted(() => {
  const constructed: Array<Record<string, unknown>> = []
  class Pool {
    readonly config: Record<string, unknown>
    readonly handlers: Record<string, (error: unknown) => void> = {}
    ended = false
    constructor(config: Record<string, unknown>) {
      this.config = config
      constructed.push(config)
    }
    on(event: string, handler: (error: unknown) => void) {
      this.handlers[event] = handler
      return this
    }
    async end() {
      this.ended = true
    }
  }
  return { constructed, Pool }
})

vi.mock("pg", () => ({ Pool: pg.Pool, default: { Pool: pg.Pool } }))

import { getPool, closePool, readPoolConfig, POOL_DEFAULTS } from "@/lib/db/pool"
import { DbConfigError } from "@/lib/db/errors"

const SECRET = "Sup3r-Secret-Passw0rd-Value"
const LOCAL_URL = `postgresql://cartoona_app_login:${SECRET}@localhost:5433/cartoona`

beforeEach(() => {
  pg.constructed.length = 0
  vi.stubEnv("DATABASE_URL", "")
})

afterEach(async () => {
  await closePool()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe("pool lifecycle", () => {
  it("importing the DB modules opens nothing and needs no DATABASE_URL", async () => {
    await import("@/lib/db/transaction")
    await import("@/lib/db/health")
    await import("@/lib/repositories/parent-orders")
    await import("@/lib/repositories/creation-pricing")
    await import("@/lib/repositories/welcome-credits")
    expect(pg.constructed).toHaveLength(0)
  })

  it("a missing DATABASE_URL fails only when the database is used", () => {
    expect(() => getPool()).toThrow(DbConfigError)
    expect(() => getPool()).toThrow(/DATABASE_URL is not set/)
    expect(pg.constructed).toHaveLength(0)
  })

  it("creates one pool per process and reuses it", () => {
    vi.stubEnv("DATABASE_URL", LOCAL_URL)
    const a = getPool()
    const b = getPool()
    expect(a).toBe(b)
    expect(pg.constructed).toHaveLength(1)
  })

  it("closePool ends the pool; the next use creates a fresh one", async () => {
    vi.stubEnv("DATABASE_URL", LOCAL_URL)
    const first = getPool() as unknown as { ended: boolean }
    await closePool()
    expect(first.ended).toBe(true)
    await closePool() // idempotent
    expect(getPool()).not.toBe(first)
    expect(pg.constructed).toHaveLength(2)
  })

  it("registers an idle-client error handler that logs safe fields only", () => {
    vi.stubEnv("DATABASE_URL", LOCAL_URL)
    const log = vi.spyOn(console, "error").mockImplementation(() => {})
    const pool = getPool() as unknown as { handlers: Record<string, (e: unknown) => void> }
    expect(pool.handlers.error).toBeTypeOf("function")
    pool.handlers.error(Object.assign(new Error(`terminating connection for ${LOCAL_URL}`), { code: "57P01" }))
    const logged = JSON.stringify(log.mock.calls)
    expect(logged).toContain("unavailable")
    expect(logged).not.toContain(SECRET)
    expect(logged).not.toContain("terminating connection")
  })
})

describe("pool configuration", () => {
  it("uses conservative defaults", () => {
    const config = readPoolConfig({ DATABASE_URL: LOCAL_URL })
    expect(config).toMatchObject({
      connectionString: LOCAL_URL,
      max: POOL_DEFAULTS.max,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 15_000,
      application_name: "cartoona",
    })
    expect(POOL_DEFAULTS.max).toBe(5)
  })

  it("accepts in-range env overrides", () => {
    const config = readPoolConfig({
      DATABASE_URL: "postgresql://app:pw@postgres:5432/cartoona",
      DB_POOL_MAX: "10",
      DB_IDLE_TIMEOUT_MS: "10000",
      DB_CONNECTION_TIMEOUT_MS: "2000",
    })
    expect(config).toMatchObject({ max: 10, idleTimeoutMillis: 10_000, connectionTimeoutMillis: 2_000 })
  })

  it("has no TLS by default and verifies the full chain when asked", () => {
    expect(readPoolConfig({ DATABASE_URL: LOCAL_URL })).not.toHaveProperty("ssl")
    expect(readPoolConfig({ DATABASE_URL: LOCAL_URL, DB_SSL_MODE: "disable" })).not.toHaveProperty("ssl")
    expect(readPoolConfig({ DATABASE_URL: LOCAL_URL, DB_SSL_MODE: "verify-full" }).ssl).toEqual({ rejectUnauthorized: true })
    const pem = "-----BEGIN CERTIFICATE-----\\nAAAA\\n-----END CERTIFICATE-----"
    const ca = readPoolConfig({ DATABASE_URL: LOCAL_URL, DB_SSL_MODE: "verify-full", DB_SSL_CA: pem }).ssl as { ca: string }
    expect(ca.ca).toContain("\nAAAA\n")
  })

  it.each([
    [{ DB_SSL_MODE: "require" }],
    [{ DB_SSL_MODE: "no-verify" }],
    [{ DB_SSL_MODE: "verify-full", DB_SSL_CA: "not a certificate" }],
    [{ DB_SSL_CA: "-----BEGIN CERTIFICATE-----" }],
  ])("rejects an unsafe or inconsistent TLS setting %j", (extra) => {
    expect(() => readPoolConfig({ DATABASE_URL: LOCAL_URL, ...extra })).toThrow(/DB_SSL/)
  })

  it.each([
    ["DB_POOL_MAX", "0"],
    ["DB_POOL_MAX", "500"],
    ["DB_POOL_MAX", "five"],
    ["DB_POOL_MAX", "-1"],
    ["DB_IDLE_TIMEOUT_MS", "5"],
    ["DB_CONNECTION_TIMEOUT_MS", "1e9"],
  ])("rejects %s=%s", (name, value) => {
    expect(() => readPoolConfig({ DATABASE_URL: LOCAL_URL, [name]: value })).toThrow(new RegExp(name))
  })

  it.each([
    ["hosted Supabase", `postgresql://postgres:${SECRET}@db.abcdefghijklmnopqrst.supabase.co:5432/postgres`, /hosted Supabase/],
    ["Supabase pooler", `postgresql://postgres.x:${SECRET}@aws-0-eu-west-1.pooler.supabase.com:6543/postgres`, /hosted Supabase/],
    ["production project ref", `postgresql://oucyhmrnzahlhqjfqcge:${SECRET}@localhost:5433/cartoona`, /hosted Supabase/],
    ["query-string override", `postgresql://u:${SECRET}@localhost:5433/cartoona?host=evil.example.com`, /query parameters/],
    ["non-postgres scheme", `mysql://u:${SECRET}@localhost:3306/app`, /postgresql:\/\//],
    ["no database", `postgresql://u:${SECRET}@localhost:5433`, /host and a database/],
    ["not a URL", `${SECRET}`, /valid postgresql/],
  ])("fails closed on %s, without echoing the password", (_label, url, expected) => {
    let message = ""
    try {
      readPoolConfig({ DATABASE_URL: url })
    } catch (error) {
      expect(error).toBeInstanceOf(DbConfigError)
      message = String((error as Error).message)
    }
    expect(message).toMatch(expected)
    expect(message).not.toContain(SECRET)
    expect(message).not.toContain(url)
  })
})
