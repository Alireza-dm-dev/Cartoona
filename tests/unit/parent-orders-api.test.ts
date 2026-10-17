import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { AuthRetryableFetchError } from "@supabase/supabase-js"
import { setLogSink, type LogRecord } from "@/lib/observability/logger"
import { REQUEST_ID_HEADER } from "@/lib/observability/request-id"
import { encodeOrdersCursor } from "@/lib/parent/orders/pagination"
import { createFakeSupabase, uuid, ts } from "../helpers/fake-supabase"
import type { SessionKind } from "../helpers/supabase-jwt"

const m = vi.hoisted(() => ({ client: null as unknown }))
vi.mock("@/lib/supabase/server", () => ({ createServerSupabaseClient: async () => m.client }))

const ME = "profile-me"
let records: LogRecord[]
let restore: () => void
beforeEach(() => { records = []; restore = setLogSink((r) => records.push(r)) })
afterEach(() => restore())

function world(over: { role?: string; session?: SessionKind; profile?: boolean; auth?: object; count?: number } = {}) {
  const rows = Array.from({ length: over.count ?? 45 }, (_, i) => ({
    id: uuid(i + 1), parent_id: ME, type: "image", status: "pending_review", title: `SECRET-TITLE-${i}`, candy_cost: 1, created_at: ts(i + 1),
  }))
  rows.push({ id: uuid(900), parent_id: "profile-other", type: "image", status: "pending_review", title: "THEIRS", candy_cost: 1, created_at: ts(900) })
  const f = createFakeSupabase({
    ...(over.auth ?? { user: { id: "user-1" } }),
    tables: {
      users: [{ id: "user-1", role: over.role ?? "parent" }],
      parent_profiles: over.profile === false ? [] : [{ id: ME, user_id: "user-1" }],
      orders: rows,
    },
    session: over.session,
    rpc: {
      get_parent_orders_delivered_at: () => [],
    },
  })
  m.client = f.client
  return f
}
const GET = async (qs = "") => (await import("@/app/api/parent/orders/route")).GET(new Request(`http://x/api/parent/orders${qs}`))

describe("GET /api/parent/orders", () => {
  it("returns { orders, nextCursor } bounded to the default page, own orders only, with X-Request-Id", async () => {
    world()
    const res = await GET()
    expect(res.status).toBe(200)
    expect(res.headers.get("Cache-Control")).toBe("no-store")
    expect(res.headers.get(REQUEST_ID_HEADER)).toBeTruthy()
    const body = await res.json()
    expect(Object.keys(body).sort()).toEqual(["nextCursor", "orders"])
    expect(body.orders).toHaveLength(20)
    expect(typeof body.nextCursor).toBe("string")
    expect(JSON.stringify(body)).not.toMatch(/THEIRS|profile-me|parent_id|parent_profile/)
    // Read model only: no internal columns.
    expect(Object.keys(body.orders[0]).sort()).toEqual(["candyCost", "completedAt", "createdAt", "displayTitle", "id", "requestType", "status"])
  })

  it("walks to the end: second and last pages, nextCursor null at the end", async () => {
    world()
    const p1 = await (await GET("?limit=20")).json()
    const p2 = await (await GET(`?limit=20&cursor=${encodeURIComponent(p1.nextCursor)}`)).json()
    const p3 = await (await GET(`?limit=20&cursor=${encodeURIComponent(p2.nextCursor)}`)).json()
    expect([p1.orders.length, p2.orders.length, p3.orders.length]).toEqual([20, 20, 5])
    expect(p3.nextCursor).toBeNull()
    const ids = [...p1.orders, ...p2.orders, ...p3.orders].map((o: { id: string }) => o.id)
    expect(new Set(ids).size).toBe(45)
  })

  it("limit is bounded server-side (max 50)", async () => {
    world({ count: 120 })
    expect((await (await GET("?limit=100000")).json()).orders).toHaveLength(50)
  })

  it("invalid cursor -> safe 400 before any backend call", async () => {
    const f = world()
    const res = await GET("?cursor=garbage")
    expect(res.status).toBe(400)
    expect(res.headers.get("Cache-Control")).toBe("no-store")
    expect(JSON.stringify(await res.json())).not.toMatch(/cursor|supabase|postgres/i)
    expect(f.calls.total()).toBe(0)
    expect(res.headers.get(REQUEST_ID_HEADER)).toBeTruthy()
  })

  it("full context is resolved once for the whole request", async () => {
    const f = world()
    await GET()
    expect(f.calls.getUser).toBe(1)
    expect(f.calls.from.users).toBe(1)
    expect(f.calls.from.parent_profiles).toBe(1)
    // V0.1.43: the lifetime is evaluated from the verified session, locally.
    expect(f.calls.rpc.filter((c) => c.fn !== "get_parent_orders_delivered_at")).toHaveLength(0)
    expect(f.calls.getSession).toBe(1)
  })

  it("401 when unauthenticated; no data", async () => {
    world({ auth: { user: null } })
    const res = await GET()
    expect(res.status).toBe(401)
    expect(JSON.stringify(await res.json())).not.toContain("SECRET")
  })

  it("transient auth failure is a retryable 503, not a 401", async () => {
    world({ auth: { user: null, authError: new AuthRetryableFetchError("Request timed out after 10000ms", 0) } })
    const res = await GET()
    expect(res.status).toBe(503)
    expect((await res.json()).code).toBe("SESSION_CHECK_UNAVAILABLE")
  })

  it("lifetime lookup_failed -> 503 with NO signOut; definite expiry -> existing 401 + local signOut", async () => {
    const a = world({ session: "transient" })
    const signOutA = vi.spyOn((a.client as unknown as { auth: { signOut: () => Promise<unknown> } }).auth, "signOut")
    const res = await GET()
    expect(res.status).toBe(503)
    expect(signOutA).not.toHaveBeenCalled()

    const b = world({ session: "expired" })
    const signOutB = vi.spyOn((b.client as unknown as { auth: { signOut: () => Promise<unknown> } }).auth, "signOut")
    const res2 = await GET()
    expect(res2.status).toBe(401)
    expect((await res2.json()).code).toBe("PARENT_SESSION_EXPIRED")
    expect(signOutB).toHaveBeenCalledWith({ scope: "local" })
  })

  it("non-parent roles are denied 403 with no data", async () => {
    for (const role of ["admin", "super_admin"]) {
      world({ role })
      const res = await GET()
      expect(res.status).toBe(403)
      expect(JSON.stringify(await res.json())).not.toContain("SECRET")
    }
  })

  it("a parent with no profile gets an empty page, not an error", async () => {
    world({ profile: false })
    expect(await (await GET()).json()).toEqual({ orders: [], nextCursor: null })
  })

  it("another parent's cursor/ids cannot expose their orders", async () => {
    world()
    const forged = encodeOrdersCursor({ createdAt: ts(999), id: uuid(900) })
    const body = await (await GET(`?cursor=${encodeURIComponent(forged)}`)).json()
    expect(JSON.stringify(body)).not.toContain("THEIRS")
  })

  it("is observability-wrapped: REQUEST_COMPLETED with route/status/duration; no titles, ids or cursors logged", async () => {
    world()
    const p1 = await (await GET()).json()
    await GET(`?cursor=${encodeURIComponent(p1.nextCursor)}`)
    const done = records.filter((r) => r.event === "REQUEST_COMPLETED")
    expect(done).toHaveLength(2)
    expect(done[0]).toMatchObject({ route: "GET /api/parent/orders", method: "GET", status: 200 })
    expect(typeof done[0].durationMs).toBe("number")
    expect(done[0].requestId).toBeTruthy()
    const out = JSON.stringify(records)
    expect(out).not.toMatch(/SECRET|THEIRS|profile-me|user-1|00000000-0000-4000|cursor=|garbage/)
  })

  it("a database failure is one generic 500 with a safe error event", async () => {
    const f = createFakeSupabase({ user: { id: "user-1" }, tables: { users: [{ id: "user-1", role: "parent" }], parent_profiles: [{ id: ME, user_id: "user-1" }], orders: [] }, tableErrors: { orders: { message: "relation orders: password=hunter2" } } })
    m.client = f.client
    const res = await GET()
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toMatch(/hunter2|relation/)
    expect(records.find((r) => r.event === "ORDERS_PAGE_FAILED")).toMatchObject({ level: "error", errorCode: "DATABASE_UNAVAILABLE" })
    expect(JSON.stringify(records)).not.toMatch(/hunter2/)
  })
})
