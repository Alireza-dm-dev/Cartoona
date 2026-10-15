import { describe, it, expect, vi, afterEach } from "vitest"
import { withTransaction } from "@/lib/db/transaction"
import { DbError, DbConfigError, normalizePgError, isBusinessError, describeDbError } from "@/lib/db/errors"
import { closePool, getPool } from "@/lib/db/pool"
import { pingDatabase } from "@/lib/db/health"
import { runQuery } from "@/lib/db/query"

/**
 * Transaction helper and error normalisation (fake clients), plus a REAL pg
 * pool aimed at a closed loopback port to prove a connection failure never
 * surfaces the password. No database is needed.
 */

function fakePool(behaviour: { failOn?: string; rollbackFails?: boolean } = {}) {
  const statements: string[] = []
  const releases: unknown[] = []
  const client = {
    async query(text: string) {
      statements.push(text)
      if (text === "ROLLBACK" && behaviour.rollbackFails) throw new Error("connection lost during rollback")
      if (behaviour.failOn && text === behaviour.failOn) throw Object.assign(new Error("boom"), { code: "23505" })
      return { rows: [{ ok: 1 }], rowCount: 1 }
    },
    release(error?: unknown) {
      releases.push(error ?? null)
    },
  }
  const pool = { connect: vi.fn(async () => client) }
  return { pool: pool as never, statements, releases }
}

describe("withTransaction", () => {
  it("BEGIN, work, COMMIT, then releases the client once", async () => {
    const { pool, statements, releases } = fakePool()
    const result = await withTransaction(async (tx) => {
      await tx.query("SELECT $1::int", [1])
      return "done"
    }, pool)
    expect(result).toBe("done")
    expect(statements).toEqual(["BEGIN", "SELECT $1::int", "COMMIT"])
    expect(releases).toEqual([null])
  })

  it("rolls back on error, rethrows the ORIGINAL error, and releases", async () => {
    const { pool, statements, releases } = fakePool()
    const original = new Error("business rule failed")
    await expect(
      withTransaction(async (tx) => {
        await tx.query("INSERT 1")
        throw original
      }, pool),
    ).rejects.toBe(original)
    expect(statements).toEqual(["BEGIN", "INSERT 1", "ROLLBACK"])
    expect(releases).toEqual([null])
  })

  it("a failing COMMIT rolls back and surfaces the commit error", async () => {
    const { pool, statements, releases } = fakePool({ failOn: "COMMIT" })
    await expect(withTransaction(async () => "x", pool)).rejects.toMatchObject({ code: "23505" })
    expect(statements).toEqual(["BEGIN", "COMMIT", "ROLLBACK"])
    expect(releases).toEqual([null])
  })

  it("a failing ROLLBACK destroys the connection but still throws the original error", async () => {
    const { pool, releases } = fakePool({ rollbackFails: true })
    const original = new Error("work failed")
    await expect(withTransaction(async () => { throw original }, pool)).rejects.toBe(original)
    expect(releases).toHaveLength(1)
    expect(releases[0]).toBeInstanceOf(Error) // release(err) => pg discards the client
  })
})

describe("normalizePgError", () => {
  const pgError = (code: string, extra: Record<string, unknown> = {}) =>
    Object.assign(new Error(`raw server text with detail (id)=(secret-row) for ${code}`), { code, ...extra })

  it.each([
    ["23505", "unique_violation", false],
    ["23503", "foreign_key_violation", false],
    ["23514", "check_violation", false],
    ["23502", "not_null_violation", false],
    ["22P02", "invalid_input", false],
    ["40001", "serialization_failure", true],
    ["40P01", "deadlock", true],
    ["57014", "query_timeout", false],
    ["57P01", "unavailable", true],
    ["08006", "unavailable", true],
    ["42501", "unknown", false],
  ])("SQLSTATE %s -> %s (retryable %s)", (code, kind, retryable) => {
    const e = normalizePgError(pgError(code, { constraint: "orders_pkey" })) as DbError
    expect(e).toBeInstanceOf(DbError)
    expect(e.kind).toBe(kind)
    expect(e.sqlState).toBe(code)
    expect(e.retryable).toBe(retryable)
    expect(e.message).toBe(`database error: ${kind}`)
    expect(e.message).not.toContain("secret-row")
  })

  it("keeps the constraint name for integrity errors (server-side only)", () => {
    const e = normalizePgError(pgError("23505", { constraint: "orders_parent_submission_key_key" })) as DbError
    expect(e.constraint).toBe("orders_parent_submission_key_key")
  })

  it("recognises business tokens raised by the SQL functions", () => {
    for (const token of ["request_not_found", "coupon_expired", "ERR_REFERRAL_CODE_EXHAUSTED", "orders_append_only", "CREATION_PRICING_UNAVAILABLE"]) {
      const raised = Object.assign(new Error(token), { code: "P0001" })
      const e = normalizePgError(raised) as DbError
      expect(e.kind).toBe("business")
      expect(e.businessCode).toBe(token)
      expect(isBusinessError(raised, token)).toBe(true)
    }
  })

  it("a raised sentence is not a business code and is never exposed", () => {
    const e = normalizePgError(Object.assign(new Error("p_limit must be between 1 and 50"), { code: "P0001" })) as DbError
    expect(e.kind).toBe("unknown")
    expect(e.businessCode).toBeNull()
    expect(e.message).not.toContain("p_limit")
  })

  it("maps client-side connection failures to unavailable", () => {
    expect((normalizePgError(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" })) as DbError).kind).toBe("unavailable")
    expect((normalizePgError(new Error("timeout exceeded when trying to connect")) as DbError).kind).toBe("unavailable")
    expect((normalizePgError(new Error("Connection terminated unexpectedly")) as DbError).kind).toBe("unavailable")
  })

  it("is idempotent and passes config errors through", () => {
    const once = normalizePgError(pgError("23503"))
    expect(normalizePgError(once)).toBe(once)
    const config = new DbConfigError("DATABASE_URL is not set.")
    expect(normalizePgError(config)).toBe(config)
    expect((normalizePgError("weird") as DbError).kind).toBe("unknown")
  })

  it("describeDbError emits only safe fields", () => {
    const described = describeDbError(pgError("23514", { constraint: "c", detail: "Failing row contains (secret)" }))
    expect(described).toEqual({ kind: "check_violation", sqlState: "23514", constraint: "c", businessCode: null, retryable: false })
    expect(JSON.stringify(described)).not.toContain("secret")
  })
})

describe("real pg pool, unreachable target: no password in errors or logs", () => {
  const SECRET = "Unreachable-Secret-Pw-7731"

  afterEach(async () => {
    await closePool()
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it("ping, query and transaction all fail as 'unavailable' without leaking the password", async () => {
    // Port 1 on loopback: refused immediately, nothing is contacted.
    vi.stubEnv("DATABASE_URL", `postgresql://cartoona_app_login:${SECRET}@127.0.0.1:1/cartoona`)
    vi.stubEnv("DB_CONNECTION_TIMEOUT_MS", "2000")
    const logs = [vi.spyOn(console, "error"), vi.spyOn(console, "warn"), vi.spyOn(console, "log")]

    expect(await pingDatabase()).toEqual({ ok: false, kind: "unavailable" })

    const queryError = await runQuery(getPool(), "SELECT $1::int", [1]).catch((e: unknown) => e)
    expect(queryError).toBeInstanceOf(DbError)
    expect((queryError as DbError).kind).toBe("unavailable")

    const txError = await withTransaction(async () => 1).catch((e: unknown) => e)
    const everything = [
      String(queryError),
      (queryError as Error).message,
      String((queryError as Error).cause),
      String(txError),
      JSON.stringify(describeDbError(txError)),
      JSON.stringify(logs.map((spy) => spy.mock.calls)),
    ].join("\n")
    expect(everything).not.toContain(SECRET)
  })

  it("a missing DATABASE_URL makes the ping report config, not throw", async () => {
    vi.stubEnv("DATABASE_URL", "")
    expect(await pingDatabase()).toEqual({ ok: false, kind: "config" })
  })
})
