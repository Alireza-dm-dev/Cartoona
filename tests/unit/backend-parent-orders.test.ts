import { describe, it, expect, afterEach } from "vitest"
import type { FastifyInstance } from "fastify"
import { buildBackendApp } from "@/backend/src/app"
import { signAssertion } from "@/lib/identity/assertion"
import { toVerifiedIdentity } from "@/lib/identity/types"
import type { Queryable } from "@/lib/db/types"
import { encodeOrdersCursor } from "@/lib/parent/orders/pagination"
import { setLogSink, type LogRecord } from "@/lib/observability/logger"

/**
 * GET /v1/parent/orders (V0.1.45) in-process with a fake database: who the
 * caller is (assertion only), parent-only, profile resolved server-side, query
 * validation, error mapping and cache headers. Real PostgreSQL and the full
 * Next -> Fastify chain: parent-orders-cutover-db.test.ts (opt-in).
 */

const SECRET = Buffer.from("44".repeat(32), "hex")
const SUBJECT = "6f1c2e7a-3b4d-4c5e-8f9a-0b1c2d3e4f50"
const USER = "11111111-2222-4333-8444-555555555555"
const PROFILE = "22222222-3333-4444-8555-666666666666"
const OTHER_PROFILE = "33333333-4444-4555-8666-777777777777"
const DAY = 86_400_000
const PATH = "/v1/parent/orders"

interface Call { text: string; values: readonly unknown[] }
interface World { role?: string; deleted?: boolean; profile?: boolean; ordersDown?: boolean; rows?: number }

function fakeDb(w: World = {}) {
  const calls: Call[] = []
  const db: Queryable = {
    async query(text: string, values: readonly unknown[] = []) {
      calls.push({ text, values })
      let rows: unknown[] = []
      if (text.includes("user_identities")) {
        rows = values[1] === SUBJECT ? [{ user_id: USER, role: w.role ?? "parent", deleted: w.deleted ?? false, sessions_not_before_ms: null }] : []
      } else if (text.includes("FROM public.parent_profiles")) {
        rows = w.profile === false || values[0] !== USER ? [] : [{ id: PROFILE }]
      } else if (text.includes("FROM public.orders")) {
        if (w.ordersDown) throw Object.assign(new Error("terminating connection: password=hunter2"), { code: "57P01" })
        const limit = Number(values[4])
        rows = Array.from({ length: Math.min(w.rows ?? 3, limit) }, (_, i) => ({
          id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
          type: "image", status: i === 0 ? "delivered" : "pending_review", title: `Order ${i}`, candy_cost: 12,
          created_at: `2026-09-0${9 - (i % 9)}T10:00:00.000001+00:00`,
          delivered_at: i === 0 ? "2026-09-10T10:00:00.345678+00:00" : null,
        }))
      }
      return { rows, rowCount: rows.length, command: "SELECT", oid: 0, fields: [] } as never
    },
  }
  return { db, calls }
}

let app: FastifyInstance | null = null
let logs: LogRecord[] = []
let restore: (() => void) | null = null

function build(w: World = {}) {
  const fake = fakeDb(w)
  logs = []
  restore = setLogSink((r) => logs.push(r))
  app = buildBackendApp({ db: () => fake.db, closeDb: async () => {}, authSecret: () => SECRET })
  return fake
}

afterEach(async () => {
  await app?.close()
  app = null
  restore?.()
})

const sign = (over: { subject?: string; path?: string; secret?: Buffer; authenticatedAt?: number } = {}) =>
  signAssertion({
    identity: toVerifiedIdentity({ provider: "supabase", subject: over.subject ?? SUBJECT }),
    authenticatedAt: over.authenticatedAt ?? Date.now() - DAY,
    requestId: "req-orders-000001",
    method: "GET",
    path: over.path ?? PATH,
    secret: over.secret ?? SECRET,
  })

const get = (qs = "", headers: Record<string, string> = { "x-cartoona-internal-auth": sign() }) =>
  app!.inject({ method: "GET", url: `${PATH}${qs}`, headers: { "x-request-id": "req-orders-000001", ...headers } })

const ordersQuery = (calls: Call[]) => calls.find((c) => c.text.includes("FROM public.orders"))

describe("GET /v1/parent/orders", () => {
  it("200 { orders, nextCursor } for the asserted parent; the profile is resolved from the principal", async () => {
    const { calls } = build({ rows: 3 })
    const res = await get()
    expect(res.statusCode).toBe(200)
    expect(res.headers["cache-control"]).toBe("no-store")
    expect(res.headers["x-request-id"]).toBe("req-orders-000001")
    const body = res.json()
    expect(Object.keys(body).sort()).toEqual(["nextCursor", "orders"])
    expect(body.orders).toHaveLength(3)
    expect(Object.keys(body.orders[0]).sort()).toEqual(["candyCost", "completedAt", "createdAt", "displayTitle", "id", "requestType", "status"])
    expect(body.orders[0]).toMatchObject({ status: "ready", completedAt: "2026-09-10T10:00:00.345678+00:00", candyCost: 12 })
    expect(body.nextCursor).toBeNull()
    // identity -> profile (by the principal's user id) -> orders (by that profile), 3 queries, no N+1
    expect(calls.map((c) => (c.text.includes("user_identities") ? "identity" : c.text.includes("parent_profiles") ? "profile" : "orders"))).toEqual(["identity", "profile", "orders"])
    expect(calls[1].values).toEqual([USER])
    expect(ordersQuery(calls)!.values[0]).toBe(PROFILE)
    expect(ordersQuery(calls)!.values[4]).toBe(21) // default 20 + 1
    expect(JSON.stringify(body)).not.toMatch(new RegExp(`${PROFILE}|${USER}|${SUBJECT}`))
  })

  it("pagination inputs: limit 1..50 and an opaque cursor travel as bind values", async () => {
    const { calls } = build({ rows: 10 })
    const cursor = encodeOrdersCursor({ createdAt: "2026-09-05T10:00:00.000001+00:00", id: "00000000-0000-4000-8000-000000000005" })
    const res = await get(`?limit=5&cursor=${encodeURIComponent(cursor)}`)
    expect(res.statusCode).toBe(200)
    expect(res.json().orders).toHaveLength(5)
    expect(typeof res.json().nextCursor).toBe("string")
    const q = ordersQuery(calls)!
    expect(q.values.slice(2)).toEqual(["2026-09-05T10:00:00.000001+00:00", "00000000-0000-4000-8000-000000000005", 6])
  })

  it("bad cursor / limit / unknown or repeated parameters -> 400 before any orders query", async () => {
    for (const qs of ["?cursor=garbage", "?limit=0", "?limit=51", "?limit=abc", "?parentProfileId=" + OTHER_PROFILE, "?limit=5&limit=6", "?sort=created_at", "?userId=" + USER]) {
      const { calls } = build()
      const res = await get(qs)
      expect(res.statusCode, qs).toBe(400)
      expect(res.json()).toEqual({ error: "invalid_request" })
      expect(res.headers["cache-control"]).toBe("no-store")
      expect(ordersQuery(calls), qs).toBeUndefined()
      await app!.close()
      app = null
    }
  })

  it("identity headers, cookies and bearer tokens are never read", async () => {
    const { calls } = build()
    const res = await get("", {
      "x-cartoona-internal-auth": sign(),
      "x-user-id": "99999999-9999-4999-8999-999999999999",
      "x-role": "parent",
      "x-parent-profile-id": OTHER_PROFILE,
      authorization: "Bearer forged",
      cookie: "sb-x-auth-token=forged",
    })
    expect(res.statusCode).toBe(200)
    expect(ordersQuery(calls)!.values[0]).toBe(PROFILE)
    expect(calls.flatMap((c) => c.values)).not.toContain(OTHER_PROFILE)
  })

  it("parent only: admin and super_admin -> 403 forbidden, no profile or orders query", async () => {
    for (const role of ["admin", "super_admin"]) {
      const { calls } = build({ role })
      const res = await get()
      expect(res.statusCode).toBe(403)
      expect(res.json()).toEqual({ error: "forbidden" })
      expect(calls).toHaveLength(1)
      await app!.close()
      app = null
    }
  })

  it("deleted account -> 403 forbidden; unlinked subject -> 403 identity_not_linked", async () => {
    build({ deleted: true })
    expect((await get()).json()).toEqual({ error: "forbidden" })
    await app!.close()
    build()
    const res = await get("", { "x-cartoona-internal-auth": sign({ subject: "8b3e4a9c-5d6f-4e7a-8b1c-2d3e4f506172" }) })
    expect([res.statusCode, res.json()]).toEqual([403, { error: "identity_not_linked" }])
  })

  it("assertion failures -> 401: missing, forged, minted for another path, v1, expired session", async () => {
    build()
    const cases: Record<string, string | undefined>[] = [
      {},
      { "x-cartoona-internal-auth": sign({ secret: Buffer.from("55".repeat(32), "hex") }) },
      { "x-cartoona-internal-auth": sign({ path: "/v1/auth/me" }) },
      { "x-cartoona-internal-auth": "v1." + sign().split(".").slice(1).join(".") },
    ]
    for (const headers of cases) {
      const res = await get("", headers as Record<string, string>)
      expect(res.statusCode).toBe(401)
      expect(res.json()).toEqual({ error: "unauthenticated" })
    }
    const expired = await get("", { "x-cartoona-internal-auth": sign({ authenticatedAt: Date.now() - 31 * DAY }) })
    expect([expired.statusCode, expired.json()]).toEqual([401, { error: "session_expired" }])
  })

  it("a parent with no profile -> 404 parent_profile_not_found (no orders query)", async () => {
    const { calls } = build({ profile: false })
    const res = await get()
    expect([res.statusCode, res.json()]).toEqual([404, { error: "parent_profile_not_found" }])
    expect(ordersQuery(calls)).toBeUndefined()
  })

  it("database failure -> 503 service_unavailable; no raw error text in the body or logs", async () => {
    build({ ordersDown: true })
    const res = await get()
    expect([res.statusCode, res.json()]).toEqual([503, { error: "service_unavailable" }])
    expect(res.headers["cache-control"]).toBe("no-store")
    expect(JSON.stringify(logs)).not.toMatch(/hunter2|terminating/)
    expect(logs.find((l) => l.event === "ORDERS_PAGE_FAILED")).toMatchObject({ errorCode: "DATABASE_UNAVAILABLE", requestId: "req-orders-000001" })
  })

  it("logs never carry the assertion, subject, user or profile id", async () => {
    build()
    const assertion = sign()
    await get("", { "x-cartoona-internal-auth": assertion })
    const out = JSON.stringify(logs)
    for (const secret of [assertion, SUBJECT, USER, PROFILE]) expect(out).not.toContain(secret)
  })

  it("only GET exists", async () => {
    build()
    const res = await app!.inject({ method: "POST", url: PATH, headers: { "x-cartoona-internal-auth": sign() } })
    expect(res.statusCode).toBe(404)
  })
})
