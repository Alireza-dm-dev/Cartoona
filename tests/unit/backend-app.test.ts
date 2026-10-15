import { describe, it, expect, afterEach, vi } from "vitest"
import type { FastifyInstance } from "fastify"
import { buildBackendApp } from "@/backend/src/app"
import { loadBackendConfig, BackendConfigError } from "@/backend/src/config"
import { PRICING_UNAVAILABLE_BODY } from "@/backend/src/routes/creation-pricing"
import type { Queryable } from "@/lib/db/types"
import { setLogSink, type LogRecord } from "@/lib/observability/logger"

/**
 * The Fastify backend in-process (`app.inject`, no port bound) with a fake
 * database and a captured log sink. Real PostgreSQL is covered by the opt-in
 * backend-db.test.ts.
 */

const SECRET = "Backend-Secret-Pw-4471"
const RAW_DB_TEXT = `connection to postgresql://cartoona:${SECRET}@db/cartoona failed: duplicate key (id)=(secret-row)`

type Responder = (text: string, values: readonly unknown[]) => unknown[] | Error

function fakeDb(respond: Responder) {
  const calls: Array<{ text: string; values: readonly unknown[] }> = []
  const db: Queryable = {
    async query(text: string, values: readonly unknown[] = []) {
      calls.push({ text, values })
      const out = respond(text, values)
      if (out instanceof Error) throw out
      return { rows: out, rowCount: out.length, command: "SELECT", oid: 0, fields: [] } as never
    },
  }
  return { db, calls }
}

const pgError = (code: string) => Object.assign(new Error(RAW_DB_TEXT), { code })

const SAFE_ROLE = { rolsuper: false, privileged: false, app_member: true, owns_objects: false }
const PRICES = [
  { pricing_key: "image.default", candy_cost: 12 },
  { pricing_key: "video.short", candy_cost: 40 },
]

/** A healthy database: SELECT 1, a restricted session role, the price catalog. */
const healthy: Responder = (text) => {
  if (text === "SELECT 1") return [{ "?column?": 1 }]
  if (text.includes("pg_has_role")) return [SAFE_ROLE]
  if (text.includes("creation_pricing")) return PRICES
  return new Error(`unexpected SQL: ${text}`)
}

let app: FastifyInstance | null = null
let logs: LogRecord[] = []
let restoreSink: (() => void) | null = null

function build(respond: Responder = healthy) {
  const { db, calls } = fakeDb(respond)
  const closeDb = vi.fn(async () => {})
  logs = []
  restoreSink = setLogSink((record) => logs.push(record))
  app = buildBackendApp({ db: () => db, closeDb })
  return { app, calls, closeDb }
}

afterEach(async () => {
  await app?.close()
  app = null
  restoreSink?.()
  restoreSink = null
  vi.unstubAllEnvs()
})

describe("app construction", () => {
  it("builds and serves without binding a port, and opens no database for /health", async () => {
    const getDb = vi.fn()
    restoreSink = setLogSink(() => {})
    app = buildBackendApp({ db: getDb, closeDb: async () => {} })
    await app.ready()
    expect(app.server.listening).toBe(false)
    const res = await app.inject({ method: "GET", url: "/health" })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: "ok" })
    expect(getDb).not.toHaveBeenCalled()
  })

  it("closing the app closes the database pool", async () => {
    const { app: a, closeDb } = build()
    await a.close()
    app = null
    expect(closeDb).toHaveBeenCalledTimes(1)
  })

  it("enables no CORS: no Access-Control-* headers, even for a cross-origin request", async () => {
    const { app: a } = build()
    const res = await a.inject({ method: "GET", url: "/v1/creation-pricing", headers: { origin: "https://evil.example" } })
    expect(Object.keys(res.headers).filter((h) => h.startsWith("access-control-"))).toEqual([])
    const preflight = await a.inject({ method: "OPTIONS", url: "/v1/creation-pricing", headers: { origin: "https://evil.example", "access-control-request-method": "GET" } })
    expect(preflight.statusCode).toBe(404)
  })
})

describe("GET /health (liveness)", () => {
  it("returns 200 { status: ok } even when the database is down", async () => {
    const { app: a, calls } = build(() => pgError("08006"))
    const res = await a.inject({ method: "GET", url: "/health" })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: "ok" })
    expect(res.headers["cache-control"]).toBe("no-store")
    expect(calls).toHaveLength(0)
  })
})

describe("GET /ready (readiness)", () => {
  it("200 { status: ready } with a reachable database and a restricted role", async () => {
    const { app: a, calls } = build()
    const res = await a.inject({ method: "GET", url: "/ready" })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: "ready" })
    expect(calls.map((c) => c.text)).toContain("SELECT 1")
  })

  it("the role check runs once; the ping runs on every call", async () => {
    const { app: a, calls } = build()
    for (let i = 0; i < 3; i++) expect((await a.inject({ method: "GET", url: "/ready" })).statusCode).toBe(200)
    expect(calls.filter((c) => c.text === "SELECT 1")).toHaveLength(3)
    expect(calls.filter((c) => c.text.includes("pg_has_role"))).toHaveLength(1)
  })

  it.each([
    ["connection failure", "08006"],
    ["server shutting down", "57P01"],
    ["statement timeout", "57014"],
  ])("503 { status: unavailable } on %s, with no raw detail", async (_label, code) => {
    const { app: a } = build(() => pgError(code))
    const res = await a.inject({ method: "GET", url: "/ready" })
    expect(res.statusCode).toBe(503)
    expect(res.json()).toEqual({ status: "unavailable" })
    expect(res.body).not.toMatch(/secret|postgresql|duplicate/)
  })

  it.each([
    ["the owner / a superuser", { ...SAFE_ROLE, rolsuper: true }],
    ["a role with CREATEROLE/CREATEDB/BYPASSRLS", { ...SAFE_ROLE, privileged: true }],
    ["a role that owns tables", { ...SAFE_ROLE, owns_objects: true }],
    ["a role outside cartoona_app", { ...SAFE_ROLE, app_member: false }],
  ])("503 when DATABASE_URL names %s", async (_label, role) => {
    const { app: a } = build((text) => (text.includes("pg_has_role") ? [role] : healthy(text, [])))
    const res = await a.inject({ method: "GET", url: "/ready" })
    expect(res.statusCode).toBe(503)
    expect(res.json()).toEqual({ status: "unavailable" })
    expect(logs.some((l) => l.event === "READINESS_FAILED" && /^db_role_/.test(l.reason ?? ""))).toBe(true)
  })
})

describe("GET /v1/creation-pricing", () => {
  it("serves the PostgreSQL repository's catalog with the Next route's contract", async () => {
    const { app: a, calls } = build()
    const res = await a.inject({ method: "GET", url: "/v1/creation-pricing" })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ prices: { "image.default": 12, "video.short": 40 } })
    expect(res.headers["cache-control"]).toBe("public, s-maxage=60, stale-while-revalidate=300")
    expect(res.headers["x-content-type-options"]).toBe("nosniff")
    expect(res.headers["content-type"]).toMatch(/^application\/json/)
    // Through getActiveCreationPrices: its constant SQL, no parameters.
    expect(calls).toHaveLength(1)
    expect(calls[0].text).toMatch(/FROM public\.creation_pricing cp\s+WHERE cp\.is_active/)
    expect(calls[0].values).toEqual([])
  })

  it.each([
    ["empty catalog", () => []],
    ["invalid row", () => [{ pricing_key: "image.default", candy_cost: 0 }]],
  ])("%s -> 503 with the route's unavailable body", async (_label, rows) => {
    const { app: a } = build((text) => (text.includes("creation_pricing") ? rows() : healthy(text, [])))
    const res = await a.inject({ method: "GET", url: "/v1/creation-pricing" })
    expect(res.statusCode).toBe(503)
    expect(res.json()).toEqual(PRICING_UNAVAILABLE_BODY)
    expect(res.headers["cache-control"]).toBe("no-store")
  })

  it.each(["08006", "57014", "23505", "XX000"])("database error %s -> the same safe 503, no raw message", async (code) => {
    const { app: a } = build(() => pgError(code))
    const res = await a.inject({ method: "GET", url: "/v1/creation-pricing" })
    expect(res.statusCode).toBe(503)
    expect(res.json()).toEqual({ error: "قیمت‌ها در حال حاضر در دسترس نیستند.", code: "CREATION_PRICING_UNAVAILABLE" })
    expect(res.body).not.toMatch(/secret|postgresql|duplicate|XX000|23505/)
    expect(JSON.stringify(logs)).not.toContain(SECRET)
  })

  it("the body is byte-for-byte the Next route's (same keys, same Persian message)", async () => {
    const fs = await import("node:fs")
    const nextRoute = fs.readFileSync("app/api/creation-pricing/route.ts", "utf8")
    expect(nextRoute).toContain(`"${PRICING_UNAVAILABLE_BODY.error}"`)
    expect(nextRoute).toContain(`code: "${PRICING_UNAVAILABLE_BODY.code}"`)
    expect(nextRoute).toContain('"public, s-maxage=60, stale-while-revalidate=300"')
  })
})

describe("request ids", () => {
  it("every response carries X-Request-Id (success, error, 404)", async () => {
    const { app: a } = build()
    for (const url of ["/health", "/ready", "/v1/creation-pricing", "/nope"]) {
      const res = await a.inject({ method: "GET", url })
      expect(res.headers["x-request-id"]).toMatch(/^[A-Za-z0-9._-]{8,64}$/)
    }
  })

  it("a safe incoming id is preserved and logged", async () => {
    const { app: a } = build()
    const res = await a.inject({ method: "GET", url: "/health", headers: { "x-request-id": "edge-1234.abcd_EF" } })
    expect(res.headers["x-request-id"]).toBe("edge-1234.abcd_EF")
    expect(logs.find((l) => l.event === "REQUEST_COMPLETED")?.requestId).toBe("edge-1234.abcd_EF")
  })

  it.each([
    "short",
    "x".repeat(65),
    "bad id with spaces",
    "<script>alert(1)</script>",
    "id\r\nSet-Cookie: x=1",
    "../../etc/passwd",
  ])("an unsafe incoming id %j is replaced with a fresh UUID", async (incoming) => {
    const { app: a } = build()
    const res = await a.inject({ method: "GET", url: "/health", headers: { "x-request-id": incoming } })
    expect(res.headers["x-request-id"]).not.toBe(incoming)
    expect(res.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/)
  })
})

describe("logging", () => {
  it("one REQUEST_COMPLETED per request with requestId, method, route template, status, durationMs", async () => {
    const { app: a } = build()
    const res = await a.inject({ method: "GET", url: "/v1/creation-pricing?utm=abc&email=a@b.c" })
    const done = logs.filter((l) => l.event === "REQUEST_COMPLETED")
    expect(done).toHaveLength(1)
    expect(done[0]).toMatchObject({
      level: "info",
      requestId: res.headers["x-request-id"],
      method: "GET",
      route: "GET /v1/creation-pricing",
      status: 200,
      subsystem: "request",
    })
    expect(done[0].durationMs).toBeGreaterThanOrEqual(0)
  })

  it("503s log as warn, with the database error kind but never its text", async () => {
    const { app: a } = build(() => pgError("08006"))
    await a.inject({ method: "GET", url: "/v1/creation-pricing" })
    const done = logs.find((l) => l.event === "REQUEST_COMPLETED")
    expect(done).toMatchObject({ level: "warn", status: 503 })
    expect(logs.find((l) => l.event === "PRICING_UNAVAILABLE")).toMatchObject({ reason: "unavailable", errorCode: "DATABASE_UNAVAILABLE" })
  })

  it("no URL, query string, cookie, token, credential or raw DB text reaches the logs", async () => {
    const { app: a } = build(() => pgError("08006"))
    await a.inject({
      method: "GET",
      url: `/v1/creation-pricing?token=${SECRET}&email=parent@example.com`,
      headers: {
        cookie: `sb-access-token=${SECRET}`,
        authorization: `Bearer ${SECRET}`,
        "x-forwarded-for": "203.0.113.9",
      },
    })
    await a.inject({ method: "GET", url: "/ready" })
    await a.inject({ method: "GET", url: `/nope/${SECRET}` })
    const text = JSON.stringify(logs)
    expect(logs.length).toBeGreaterThan(0)
    for (const forbidden of [SECRET, "parent@example.com", "203.0.113.9", "postgresql://", "duplicate key", "token=", "/nope"]) {
      expect(text).not.toContain(forbidden)
    }
  })
})

describe("errors", () => {
  it("unknown route -> safe 404 { error: not_found }", async () => {
    const { app: a } = build()
    const res = await a.inject({ method: "GET", url: "/v1/admin/secrets" })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: "not_found" })
    expect(res.headers["x-request-id"]).toBeTruthy()
    expect(logs.find((l) => l.event === "REQUEST_COMPLETED")).toMatchObject({ status: 404, reason: "route_not_found" })
  })

  it("unknown method on a known path is a 404, not a 405 leak of the route table", async () => {
    const { app: a } = build()
    const res = await a.inject({ method: "DELETE", url: "/v1/creation-pricing" })
    expect(res.statusCode).toBe(404)
  })

  it("an unexpected error -> 500 { error: internal_error }, no stack or message, X-Request-Id set", async () => {
    const { app: a } = build()
    a.get("/boom", async () => {
      throw new Error(`kaboom ${SECRET} at /srv/app/secret.ts:12`)
    })
    const res = await a.inject({ method: "GET", url: "/boom" })
    expect(res.statusCode).toBe(500)
    expect(res.json()).toEqual({ error: "internal_error" })
    expect(res.body).not.toMatch(/kaboom|stack|secret\.ts/)
    expect(res.headers["x-request-id"]).toBeTruthy()
    expect(res.headers["cache-control"]).toBe("no-store")
    expect(logs.find((l) => l.event === "REQUEST_FAILED")).toMatchObject({ status: 500, errorCode: "INTERNAL_ERROR" })
    expect(JSON.stringify(logs)).not.toContain(SECRET)
  })

  it("a DbError escaping a route -> 503 service_unavailable for transient kinds, 500 otherwise", async () => {
    const { app: a } = build(() => pgError("08006"))
    const { runQuery } = await import("@/lib/db/query")
    a.get("/db-down", async () => runQuery({ query: async () => { throw pgError("08006") } } as Queryable, "SELECT 1"))
    a.get("/db-bug", async () => runQuery({ query: async () => { throw pgError("42703") } } as Queryable, "SELECT 1"))
    const down = await a.inject({ method: "GET", url: "/db-down" })
    expect(down.statusCode).toBe(503)
    expect(down.json()).toEqual({ error: "service_unavailable" })
    const bug = await a.inject({ method: "GET", url: "/db-bug" })
    expect(bug.statusCode).toBe(500)
    expect(bug.json()).toEqual({ error: "internal_error" })
    expect(down.body + bug.body).not.toMatch(/secret|42703|08006/)
  })

  it("validation errors -> 400 { error: invalid_request }", async () => {
    const { app: a } = build()
    a.get("/validated", { schema: { querystring: { type: "object", required: ["n"], properties: { n: { type: "integer" } } } } }, async () => ({ ok: true }))
    const res = await a.inject({ method: "GET", url: "/validated?n=abc" })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: "invalid_request" })
  })

  it("a malformed / oversized body is a safe 4xx", async () => {
    const { app: a } = build()
    a.post("/echo", async () => ({ ok: true }))
    const bad = await a.inject({ method: "POST", url: "/echo", headers: { "content-type": "application/json" }, payload: "{not json" })
    expect(bad.statusCode).toBe(400)
    expect(bad.json()).toEqual({ error: "invalid_request" })
    const big = await a.inject({ method: "POST", url: "/echo", headers: { "content-type": "application/json" }, payload: JSON.stringify({ x: "a".repeat(20_000) }) })
    expect(big.statusCode).toBe(413)
    expect(big.json()).toEqual({ error: "invalid_request" })
  })
})

describe("config", () => {
  const URL_OK = `postgresql://cartoona_app_login:${SECRET}@postgres:5432/cartoona`

  it("defaults to 0.0.0.0:4000", () => {
    expect(loadBackendConfig({ DATABASE_URL: URL_OK })).toEqual({ port: 4000, host: "0.0.0.0" })
  })

  it("accepts BACKEND_PORT / BACKEND_HOST overrides", () => {
    expect(loadBackendConfig({ DATABASE_URL: URL_OK, BACKEND_PORT: "4100", BACKEND_HOST: "127.0.0.1" })).toEqual({ port: 4100, host: "127.0.0.1" })
  })

  it.each([
    [{ BACKEND_PORT: "0" }, /BACKEND_PORT/],
    [{ BACKEND_PORT: "70000" }, /BACKEND_PORT/],
    [{ BACKEND_PORT: "40a" }, /BACKEND_PORT/],
    [{ BACKEND_HOST: "example.com" }, /BACKEND_HOST/],
    [{ DATABASE_URL: "" }, /DATABASE_URL is not set/],
    [{ DATABASE_URL: `postgresql://postgres:${SECRET}@db.abcdefghijklmnopqrst.supabase.co:5432/postgres` }, /hosted Supabase/],
    [{ DATABASE_URL: `postgresql://u:${SECRET}@postgres:5432/cartoona?host=evil` }, /query parameters/],
  ])("fails clearly on %j without echoing values", (override, expected) => {
    let message = ""
    try {
      loadBackendConfig({ DATABASE_URL: URL_OK, ...override })
    } catch (error) {
      expect(error).toBeInstanceOf(BackendConfigError)
      message = (error as Error).message
    }
    expect(message).toMatch(expected)
    expect(message).not.toContain(SECRET)
    expect(message).not.toContain("example.com")
  })
})
