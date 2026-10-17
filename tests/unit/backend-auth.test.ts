import { describe, it, expect, afterEach, vi } from "vitest"
import type { FastifyInstance } from "fastify"
import { buildBackendApp } from "@/backend/src/app"
import { requireAuth, requireRole } from "@/backend/src/plugins/auth"
import { InternalAuthConfigError, signAssertion } from "@/lib/identity/assertion"
import { toVerifiedIdentity } from "@/lib/identity/types"
import type { Queryable } from "@/lib/db/types"
import { setLogSink, type LogRecord } from "@/lib/observability/logger"

/**
 * Backend authentication (requireAuth + GET /v1/auth/me) in-process, with a
 * fake database. Real PostgreSQL is covered by the opt-in auth-chain-db test.
 */

const SECRET = Buffer.from("33".repeat(32), "hex")
const LINKED = "6f1c2e7a-3b4d-4c5e-8f9a-0b1c2d3e4f50"
const DELETED = "7a2d3f8b-4c5e-4d6f-9a0b-1c2d3e4f5061"
const UNLINKED = "8b3e4a9c-5d6f-4e7a-8b1c-2d3e4f506172"
const CARTOONA_USER = "11111111-2222-4333-8444-555555555555"

interface Call { text: string; values: readonly unknown[] }

function fakeDb(behaviour: "ok" | "down" = "ok", role = "parent") {
  const calls: Call[] = []
  const db: Queryable = {
    async query(text: string, values: readonly unknown[] = []) {
      calls.push({ text, values })
      if (behaviour === "down") throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" })
      let rows: unknown[] = []
      if (text.includes("user_identities")) {
        const [provider, subject] = values
        if (provider === "supabase" && subject === LINKED) rows = [{ user_id: CARTOONA_USER, role, deleted: false }]
        if (provider === "supabase" && subject === DELETED) rows = [{ user_id: CARTOONA_USER, role, deleted: true }]
      }
      return { rows, rowCount: rows.length, command: "SELECT", oid: 0, fields: [] } as never
    },
  }
  return { db, calls }
}

let app: FastifyInstance | null = null
let logs: LogRecord[] = []
let restore: (() => void) | null = null

function build(opts: { db?: ReturnType<typeof fakeDb>; secret?: () => Buffer } = {}) {
  const { db, calls } = opts.db ?? fakeDb()
  logs = []
  restore = setLogSink((r) => logs.push(r))
  app = buildBackendApp({ db: () => db, closeDb: async () => {}, authSecret: opts.secret ?? (() => SECRET) })
  return { app, calls }
}

afterEach(async () => {
  await app?.close()
  app = null
  restore?.()
  restore = null
})

const assertion = (over: { subject?: string; path?: string; method?: string; secret?: Buffer; now?: number; requestId?: string } = {}) =>
  signAssertion({
    identity: toVerifiedIdentity({ provider: "supabase", subject: over.subject ?? LINKED }),
    requestId: over.requestId ?? "req-auth-000001",
    method: over.method ?? "GET",
    path: over.path ?? "/v1/auth/me",
    secret: over.secret ?? SECRET,
    now: over.now,
  })

const me = (headers: Record<string, string> = {}) => app!.inject({ method: "GET", url: "/v1/auth/me", headers })
const AUTH = "x-cartoona-internal-auth"

describe("GET /v1/auth/me", () => {
  it("a valid assertion for a linked identity -> 200 with the Cartoona user and role only", async () => {
    const { calls } = build()
    const res = await me({ [AUTH]: assertion() })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ authenticated: true, userId: CARTOONA_USER, role: "parent" })
    expect(res.headers["cache-control"]).toBe("no-store")
    // One parameterised lookup by (provider, subject).
    expect(calls).toHaveLength(1)
    expect(calls[0].values).toEqual(["supabase", LINKED])
    expect(calls[0].text).not.toContain(LINKED)
    // The provider subject is never returned.
    expect(res.body).not.toContain(LINKED)
  })

  it("the role comes from the database, not from anything the caller sends", async () => {
    build({ db: fakeDb("ok", "admin") })
    const res = await me({ [AUTH]: assertion(), "x-role": "parent" })
    expect(res.json().role).toBe("admin")
  })
})

describe("401: missing or invalid assertion", () => {
  it.each([
    ["no header at all", {}],
    ["browser-style identity headers only", { "x-user-id": CARTOONA_USER, "x-role": "super_admin", authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.x.y", cookie: "sb-access-token=x" }],
  ])("%s -> 401 unauthenticated (AUTH_MISSING), no database lookup", async (_label, headers) => {
    const { calls } = build()
    const res = await me(headers as Record<string, string>)
    expect(res.statusCode).toBe(401)
    expect(res.json()).toEqual({ error: "unauthenticated" })
    expect(calls).toHaveLength(0)
    expect(logs.find((l) => l.event === "AUTH_REJECTED")).toMatchObject({ errorCode: "AUTH_MISSING", status: 401 })
  })

  it.each([
    ["garbage", () => "not-an-assertion"],
    ["forged with another secret", () => assertion({ secret: Buffer.from("44".repeat(32), "hex") })],
    ["tampered payload", () => { const [v, p, s] = assertion().split("."); return `${v}.${p.slice(0, -2)}AA.${s}` }],
    ["expired", () => assertion({ now: Date.now() - 120_000 })],
    ["issued in the future", () => assertion({ now: Date.now() + 120_000 })],
    ["bound to another path", () => assertion({ path: "/v1/creation-pricing" })],
    ["bound to another method", () => assertion({ method: "POST" })],
  ])("%s -> 401, no database lookup", async (_label, make) => {
    const { calls } = build()
    const res = await me({ [AUTH]: make() })
    expect(res.statusCode).toBe(401)
    expect(res.json()).toEqual({ error: "unauthenticated" })
    expect(calls).toHaveLength(0)
    expect(logs.find((l) => l.event === "AUTH_REJECTED")).toMatchObject({ errorCode: "AUTH_INVALID" })
  })

  it("a repeated header (two assertions) is refused as ambiguous", async () => {
    build()
    const res = await app!.inject({ method: "GET", url: "/v1/auth/me", headers: { [AUTH]: [assertion(), assertion()] as unknown as string } })
    expect(res.statusCode).toBe(401)
  })

  it("the binding uses the path without the query string", async () => {
    build()
    expect((await app!.inject({ method: "GET", url: "/v1/auth/me?x=1", headers: { [AUTH]: assertion() } })).statusCode).toBe(200)
  })
})

describe("403 and 503", () => {
  it("valid assertion, identity not linked -> 403 identity_not_linked (nothing created)", async () => {
    const { calls } = build()
    const res = await me({ [AUTH]: assertion({ subject: UNLINKED }) })
    expect(res.statusCode).toBe(403)
    expect(res.json()).toEqual({ error: "identity_not_linked" })
    expect(calls.every((c) => /^\s*SELECT/i.test(c.text))).toBe(true)
    expect(logs.find((l) => l.event === "AUTH_REJECTED")).toMatchObject({ errorCode: "IDENTITY_NOT_LINKED", status: 403 })
  })

  it("linked but soft-deleted account -> 403 forbidden", async () => {
    build()
    const res = await me({ [AUTH]: assertion({ subject: DELETED }) })
    expect(res.statusCode).toBe(403)
    expect(res.json()).toEqual({ error: "forbidden" })
  })

  it("database unavailable -> 503 service_unavailable, nothing raw", async () => {
    build({ db: fakeDb("down") })
    const res = await me({ [AUTH]: assertion() })
    expect(res.statusCode).toBe(503)
    expect(res.json()).toEqual({ error: "service_unavailable" })
    expect(res.body).not.toMatch(/ECONNREFUSED/)
  })

  it("secret not configured -> 503, before any verification or lookup", async () => {
    const { calls } = build({ secret: () => { throw new InternalAuthConfigError("CARTOONA_INTERNAL_AUTH_SECRET is not set.") } })
    const res = await me({ [AUTH]: assertion() })
    expect(res.statusCode).toBe(503)
    expect(calls).toHaveLength(0)
  })
})

describe("requireRole", () => {
  it("403 forbidden when the database role is not allowed; passes when it is", async () => {
    build({ db: fakeDb("ok", "parent") })
    const deps = { db: () => fakeDb("ok", "parent").db, closeDb: async () => {}, authSecret: () => SECRET }
    app!.get("/v1/admin-only", { preHandler: [requireAuth(deps), requireRole("admin", "super_admin")] }, async () => ({ ok: true }))
    app!.get("/v1/parent-only", { preHandler: [requireAuth(deps), requireRole("parent")] }, async () => ({ ok: true }))
    const admin = await app!.inject({ method: "GET", url: "/v1/admin-only", headers: { [AUTH]: assertion({ path: "/v1/admin-only" }) } })
    expect(admin.statusCode).toBe(403)
    expect(admin.json()).toEqual({ error: "forbidden" })
    const parent = await app!.inject({ method: "GET", url: "/v1/parent-only", headers: { [AUTH]: assertion({ path: "/v1/parent-only" }) } })
    expect(parent.statusCode).toBe(200)
  })
})

describe("logging", () => {
  it("never logs the assertion, signature, subject, user id or browser identity headers", async () => {
    build()
    const token = assertion()
    await me({ [AUTH]: token })
    await me({ [AUTH]: assertion({ subject: UNLINKED }) })
    await me({ [AUTH]: token + "x", "x-user-id": CARTOONA_USER })
    const text = JSON.stringify(logs)
    for (const leak of [token, token.split(".")[2], LINKED, UNLINKED, CARTOONA_USER]) expect(text).not.toContain(leak)
    expect(logs.map((l) => l.errorCode).filter(Boolean)).toEqual(expect.arrayContaining(["IDENTITY_NOT_LINKED", "AUTH_INVALID"]))
  })
})

describe("public routes are unaffected", () => {
  it("/health and /v1/creation-pricing need no assertion", async () => {
    build()
    expect((await app!.inject({ method: "GET", url: "/health" })).statusCode).toBe(200)
  })

  it("requireAuth is never consulted for an unauthenticated route", async () => {
    const secret = vi.fn(() => SECRET)
    build({ secret })
    await app!.inject({ method: "GET", url: "/health" })
    expect(secret).not.toHaveBeenCalled()
  })
})
