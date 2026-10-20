import { describe, it, expect, beforeAll, afterAll, vi } from "vitest"
import http from "node:http"
import { randomBytes } from "node:crypto"
import type net from "node:net"
import path from "node:path"
import { Pool } from "pg"

const cookies = vi.hoisted(() => ({ jar: null as null | { getAll(): Array<{ name: string; value: string }>; setAll(c: Array<{ name: string; value: string }>): void } }))
vi.mock("next/headers", () => ({
  cookies: async () => ({
    getAll: () => cookies.jar?.getAll() ?? [],
    set: (name: string, value: string) => cookies.jar?.setAll([{ name, value }]),
  }),
}))

import type { FastifyInstance } from "fastify"
import { buildBackendApp } from "@/backend/src/app"
import { GET as ordersRoute } from "@/app/api/parent/orders/route"
import { fetchParentOrdersPage, verifyParentOrdersCaller } from "@/lib/parent/orders/backend-orders"
import { closePool, getPool } from "@/lib/db/pool"
import type { Queryable } from "@/lib/db/types"
import { signAssertion } from "@/lib/identity/assertion"
import { toVerifiedIdentity } from "@/lib/identity/types"
import { decodeOrdersCursor } from "@/lib/parent/orders/pagination"
import { runDataCopy } from "@/scripts/db/data-copy/copy"
import { buildSupabaseSource, dropDbs, migrateTarget, ownerUrl, pgEnv, psql, root, script, type PgEnv } from "../helpers/data-copy-db"
import { cookieJar, startStubAuth, type StubAuth } from "../helpers/stub-supabase-auth"
import { DAY_MS } from "../helpers/supabase-jwt"

/**
 * V0.1.45 parent orders LIST cutover, end to end on REAL local services
 * (opt-in: CARTOONA_PLAIN_PG=docker):
 *
 *   Supabase-shaped source (real migration chain + fixtures, orders created by
 *   the real request function) -> V0.1.44 copy -> plain PostgreSQL 17
 *   stub Supabase Auth (real @supabase/ssr) -> Next GET /api/parent/orders
 *   -> signed v2 assertion -> Fastify (listening, restricted login role)
 *   -> requireAuth -> parent profile -> getParentOrdersPage
 *
 * Expectations are read from the copied database, never hardcoded order lists.
 * Nothing contacts Supabase or any hosted service.
 */

const enabled = process.env.CARTOONA_PLAIN_PG === "docker"
const id = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`
const SRC = `pos_${id}`
const TGT = `pot_${id}`
const ROLE = `cartoona_app_po${id}`
const DB_PASSWORD = randomBytes(24).toString("hex")
const AUTH_SECRET = randomBytes(32).toString("hex")

const U = { a: "a1000000-0000-4000-8000-000000000001", b: "a1000000-0000-4000-8000-000000000002", admin: "a1000000-0000-4000-8000-000000000003", deleted: "a1000000-0000-4000-8000-000000000004", superAdmin: "a1000000-0000-4000-8000-000000000005" }
const P = { a: "b1000000-0000-4000-8000-000000000001", b: "b1000000-0000-4000-8000-000000000002" }
const NO_PROFILE_USER = "a1000000-0000-4000-8000-0000000000bb"

let env: PgEnv
let backend: FastifyInstance | null = null
let backendUrl = ""
let stub: StubAuth | null = null
let queries = 0

interface Order { id: string; requestType: string; createdAt: string; displayTitle: string; status: string; candyCost: number; completedAt: string | null }

/** The parent's visible orders straight from the copied database, in list order. */
async function expectedOrders(profile: string) {
  const out = await psql(env, TGT, `select o.id || '|' || to_char(o.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"+00:00"') || '|' ||
      coalesce(to_char((select min(h.created_at) from public.order_status_history h where h.order_id = o.id and h.new_status = 'delivered') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"+00:00"'), '-') || '|' || o.status || '|' || o.type || '|' || o.candy_cost
    from public.orders o where o.parent_id = '${profile}' and o.status not in ('draft', 'pending_payment') order by o.created_at desc, o.id desc`)
  return out.split("\n").map((l) => {
    const [oid, createdAt, delivered, status, type, cost] = l.split("|")
    return { id: oid, createdAt, completedAt: delivered === "-" ? null : delivered, status, type, cost: Number(cost) }
  })
}

const PARENT_STATUS: Record<string, string> = { pending_review: "submitted", in_progress: "creating", ready: "final_review", delivered: "ready", rejected: "closed", cancelled: "closed" }

/** A browser request with a session at the stub provider for `userId`. */
async function asBrowser(userId: string, opts: { qs?: string; headers?: Record<string, string>; authenticatedAt?: number; userMode?: StubAuth["options"]["userMode"] } = {}) {
  await stub?.close()
  stub = await startStubAuth({ userId, userMode: opts.userMode })
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", stub.url)
  cookies.jar = cookieJar([stub.cookie({ authenticatedAt: opts.authenticatedAt })])
  const res = await ordersRoute(new Request(`http://localhost:3000/api/parent/orders${opts.qs ?? ""}`, { headers: opts.headers ?? {} }))
  return { status: res.status, body: await res.json(), headers: res.headers }
}

async function walk(userId: string, limit?: number): Promise<{ pages: Order[][]; cursors: string[] }> {
  const pages: Order[][] = []
  const cursors: string[] = []
  let cursor: string | null = null
  for (let guard = 0; guard < 20; guard++) {
    const qs = new URLSearchParams()
    if (cursor) qs.set("cursor", cursor)
    if (limit) qs.set("limit", String(limit))
    const res = await asBrowser(userId, { qs: qs.size ? `?${qs}` : "" })
    expect(res.status).toBe(200)
    pages.push(res.body.orders)
    cursor = res.body.nextCursor
    if (!cursor) break
    cursors.push(cursor)
  }
  return { pages, cursors }
}

const direct = (pathAndQuery: string, token?: string) =>
  fetch(`${backendUrl}${pathAndQuery}`, { headers: token ? { "x-cartoona-internal-auth": token } : {} })

const sign = (subject: string, over: { path?: string; secret?: string } = {}) =>
  signAssertion({
    identity: toVerifiedIdentity({ provider: "supabase", subject }),
    authenticatedAt: Date.now() - DAY_MS,
    requestId: "cutover-direct-01",
    method: "GET",
    path: over.path ?? "/v1/parent/orders",
    secret: Buffer.from(over.secret ?? AUTH_SECRET, "hex"),
  })

async function startBackend(db?: () => Queryable): Promise<{ app: FastifyInstance; url: string }> {
  const app = buildBackendApp(db ? { db, closeDb: async () => {} } : {
    db: () => ({ query: (text: string, values?: readonly unknown[]) => { queries += 1; return getPool().query(text, values as unknown[]) } }) as Queryable,
  })
  await app.listen({ host: "127.0.0.1", port: 0 })
  return { app, url: `http://127.0.0.1:${(app.server.address() as net.AddressInfo).port}` }
}

const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))]

describe.skipIf(!enabled)("V0.1.45 parent orders LIST: copied data -> Fastify -> Next (local Docker PostgreSQL 17)", () => {
  vi.setConfig({ testTimeout: 120_000, hookTimeout: 300_000 })

  beforeAll(async () => {
    env = await pgEnv()
    await buildSupabaseSource(env, SRC, path.join(root, "tests/fixtures/data-copy/supabase-source-fixture.sql"))
    await psql(env, SRC, "", path.join(root, "tests/fixtures/data-copy/parent-orders-extra.sql"))
    await migrateTarget(env, TGT)
    const copied = await runDataCopy({ sourceUrl: ownerUrl(env, SRC), targetUrl: ownerUrl(env, TGT), migrationsDir: path.join(root, "database/migrations"), env: {} })
    expect(copied.outcome).toBe("completed")
    // A parent account that has not created its profile yet (owner write, test only).
    await psql(env, TGT, `insert into public.users (id, role) values ('${NO_PROFILE_USER}', 'parent');
      insert into public.user_identities (user_id, provider, provider_subject) values ('${NO_PROFILE_USER}', 'supabase', '${NO_PROFILE_USER}')`)
    const r = await script(env, "scripts/db/app-login-role.sh", { DATABASE_URL: `postgresql://cartoona@postgres:5432/${TGT}`, CARTOONA_APP_DB_PASSWORD: DB_PASSWORD }, [ROLE])
    expect(r.code).toBe(0)
    vi.stubEnv("DATABASE_URL", `postgresql://${ROLE}:${DB_PASSWORD}@127.0.0.1:${env.port}/${TGT}`)
    vi.stubEnv("CARTOONA_INTERNAL_AUTH_SECRET", AUTH_SECRET)
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-key")
    vi.stubEnv("BACKEND_REQUEST_TIMEOUT_MS", "2000")
    ;({ app: backend, url: backendUrl } = await startBackend())
    vi.stubEnv("BACKEND_INTERNAL_URL", backendUrl)
  })

  afterAll(async () => {
    await stub?.close()
    await backend?.close()
    await closePool()
    vi.unstubAllEnvs()
    if (!env) return
    await dropDbs(env, [SRC, TGT])
    await psql(env, "postgres", `drop role if exists ${ROLE}`).catch(() => undefined)
  })

  describe("20. the copied parent's list, through Next and Fastify", () => {
    it("parent A walks every page: exactly the database's visible orders, in order, no duplicates", async () => {
      const want = await expectedOrders(P.a)
      expect(want.length).toBeGreaterThanOrEqual(25)
      const { pages } = await walk(U.a)
      expect(pages.map((p) => p.length)).toEqual([20, want.length - 20])
      const got = pages.flat()
      expect(got.map((o) => o.id)).toEqual(want.map((o) => o.id))
      expect(new Set(got.map((o) => o.id)).size).toBe(got.length)
    })

    it("every field matches the copied rows: created/completed timestamps (µs), status, type, cost", async () => {
      const want = await expectedOrders(P.a)
      const got = (await walk(U.a, 50)).pages.flat()
      expect(got).toHaveLength(want.length)
      got.forEach((o, i) => {
        expect(o.createdAt).toBe(want[i].createdAt)
        expect(o.completedAt).toBe(want[i].completedAt)
        expect(o.status).toBe(PARENT_STATUS[want[i].status])
        expect(o.requestType).toBe(want[i].type)
        expect(o.candyCost).toBe(want[i].cost)
        expect(Object.keys(o).sort()).toEqual(["candyCost", "completedAt", "createdAt", "displayTitle", "id", "requestType", "status"])
      })
      expect(got.filter((o) => o.completedAt !== null).length).toBe(6)
      expect(got.find((o) => o.id === "a2000000-0000-4000-8000-000000000001")?.completedAt).toBe("2026-09-02T10:00:00.345678+00:00")
      // child_name is not part of the list read model (it never was); it survives the copy unchanged:
      expect(await psql(env, TGT, `select md5(string_agg(id || coalesce(child_name, '-') || submission_key, ',' order by id)) from public.orders`))
        .toBe(await psql(env, SRC, `select md5(string_agg(id || coalesce(child_name, '-') || submission_key, ',' order by id)) from public.orders`))
    })

    it("small pages: limit 7 walks the same sequence; each cursor decodes to the last row of its page", async () => {
      const want = (await expectedOrders(P.a)).map((o) => o.id)
      const { pages, cursors } = await walk(U.a, 7)
      expect(pages.flat().map((o) => o.id)).toEqual(want)
      expect(pages.slice(0, -1).every((p) => p.length === 7)).toBe(true)
      cursors.forEach((c, i) => expect(decodeOrdersCursor(c)?.id).toBe(pages[i][6].id))
    })

    it("the /dashboard/orders first page uses the same loader and gets the same first page", async () => {
      await asBrowser(U.a)
      const caller = await verifyParentOrdersCaller()
      expect(caller.ok).toBe(true)
      const page = caller.ok ? await fetchParentOrdersPage(caller.context, { cursor: null, limit: null }) : null
      const viaRoute = await asBrowser(U.a)
      expect(page).toEqual({ ok: true, orders: viaRoute.body.orders, nextCursor: viaRoute.body.nextCursor })
    })

    it("responses are private: no-store and a request id", async () => {
      const res = await asBrowser(U.a)
      expect(res.headers.get("cache-control")).toBe("no-store")
      expect(res.headers.get("x-request-id")).toBeTruthy()
    })
  })

  describe("22. cross-parent isolation (overlapping timestamps)", () => {
    it("A never receives a B order and B never an A order, on first and later pages", async () => {
      const a = (await walk(U.a, 5)).pages
      const b = (await walk(U.b, 5)).pages
      expect(a.length).toBeGreaterThan(2)
      expect(b.length).toBeGreaterThan(2)
      const aIds = new Set(a.flat().map((o) => o.id))
      const bIds = new Set(b.flat().map((o) => o.id))
      for (const id of bIds) expect(aIds.has(id)).toBe(false)
      expect(b.flat().map((o) => o.id)).toEqual((await expectedOrders(P.b)).map((o) => o.id))
      // the overlap is real: both parents have orders at identical timestamps
      const shared = a.flat().filter((o) => b.flat().some((x) => x.createdAt === o.createdAt))
      expect(shared.length).toBeGreaterThanOrEqual(20)
    })

    it("A's cursor replayed by B returns only B's rows: WHERE parent_id = the authenticated profile is the boundary", async () => {
      const aFirst = await asBrowser(U.a, { qs: "?limit=3" })
      const replay = await asBrowser(U.b, { qs: `?cursor=${encodeURIComponent(aFirst.body.nextCursor)}` })
      expect(replay.status).toBe(200)
      const aIds = new Set((await expectedOrders(P.a)).map((o) => o.id))
      expect(replay.body.orders.length).toBeGreaterThan(0)
      expect(replay.body.orders.every((o: Order) => !aIds.has(o.id))).toBe(true)
    })
  })

  describe("21. forgery", () => {
    it("X-User-Id / X-Role / a forged assertion header / parentProfileId cannot select another parent", async () => {
      const res = await asBrowser(U.a, {
        qs: `?parentProfileId=${P.b}&userId=${U.b}`,
        headers: { "x-user-id": U.b, "x-role": "parent", "x-cartoona-internal-auth": sign(U.b), "x-parent-profile-id": P.b },
      })
      expect(res.status).toBe(200)
      const bIds = new Set((await expectedOrders(P.b)).map((o) => o.id))
      expect(res.body.orders.every((o: Order) => !bIds.has(o.id))).toBe(true)
      expect(res.body.orders[0].id).toBe((await expectedOrders(P.a))[0].id)
    })

    it("X-Role cannot turn an admin into a parent", async () => {
      const res = await asBrowser(U.admin, { headers: { "x-role": "parent", "x-user-id": U.a } })
      expect([res.status, res.body.code]).toEqual([403, "forbidden"])
    })

    it("direct to Fastify: parentProfileId -> 400; forged, other-path and v1 assertions -> 401", async () => {
      expect((await direct(`/v1/parent/orders?parentProfileId=${P.b}`, sign(U.a))).status).toBe(400)
      expect((await direct("/v1/parent/orders", sign(U.a, { secret: randomBytes(32).toString("hex") }))).status).toBe(401)
      expect((await direct("/v1/parent/orders", sign(U.a, { path: "/v1/auth/me" }))).status).toBe(401)
      expect((await direct("/v1/parent/orders", "v1." + sign(U.a).split(".").slice(1).join("."))).status).toBe(401)
      expect((await direct("/v1/parent/orders")).status).toBe(401)
    })

    it("expired session -> 401 session_expired (cookies cleared); invalidated session -> 401 session_invalidated", async () => {
      const expired = await asBrowser(U.a, { authenticatedAt: Date.now() - 31 * DAY_MS })
      expect([expired.status, expired.body.code]).toEqual([401, "session_expired"])
      expect((cookies.jar as ReturnType<typeof cookieJar>).cleared("sb-")).toBe(true)

      await psql(env, TGT, `update public.users set sessions_not_before = now() + interval '1 minute' where id = '${U.a}'`)
      try {
        const invalidated = await asBrowser(U.a)
        expect([invalidated.status, invalidated.body.code]).toEqual([401, "session_invalidated"])
        expect((cookies.jar as ReturnType<typeof cookieJar>).cleared("sb-")).toBe(true)
      } finally {
        await psql(env, TGT, `update public.users set sessions_not_before = null where id = '${U.a}'`)
      }
    })
  })

  describe("4/5/23. roles, accounts and failures", () => {
    it("admin and super_admin -> 403 forbidden; deleted copied user -> 403 forbidden", async () => {
      for (const user of [U.admin, U.superAdmin, U.deleted]) {
        const res = await asBrowser(user)
        expect([res.status, res.body.code], user).toEqual([403, "forbidden"])
        expect(JSON.stringify(res.body)).not.toMatch(/a2000000|c2000000/)
      }
    })

    it("identity mapping missing -> 403 identity_not_linked", async () => {
      const res = await asBrowser("a1000000-0000-4000-8000-0000000000ee")
      expect([res.status, res.body.code]).toEqual([403, "identity_not_linked"])
    })

    it("parent profile missing -> documented empty page (Fastify 404 parent_profile_not_found)", async () => {
      expect(await asBrowser(NO_PROFILE_USER).then((r) => [r.status, r.body])).toEqual([200, { orders: [], nextCursor: null }])
      const res = await direct("/v1/parent/orders", sign(NO_PROFILE_USER))
      expect([res.status, await res.json()]).toEqual([404, { error: "parent_profile_not_found" }])
    })

    it("Fastify stopped -> bounded 503 service_unavailable", async () => {
      const dead = await startBackend()
      const deadUrl = dead.url
      await dead.app.close()
      vi.stubEnv("BACKEND_INTERNAL_URL", deadUrl)
      try {
        const t = Date.now()
        const res = await asBrowser(U.a)
        expect([res.status, res.body.code]).toEqual([503, "service_unavailable"])
        expect(Date.now() - t).toBeLessThan(5_000)
        expect(JSON.stringify(res.body)).not.toMatch(/127\.0\.0\.1|ECONNREFUSED/)
      } finally {
        vi.stubEnv("BACKEND_INTERNAL_URL", backendUrl)
      }
    })

    it("PostgreSQL unavailable behind Fastify -> 503 service_unavailable", async () => {
      const pool = new Pool({ connectionString: `postgresql://nobody:x@127.0.0.1:1/none`, connectionTimeoutMillis: 300 })
      pool.on("error", () => undefined)
      // A real pg pool aimed at a closed port: the backend's own error mapping, not a fake.
      const broken = await startBackend(() => pool as unknown as Queryable)
      vi.stubEnv("BACKEND_INTERNAL_URL", broken.url)
      try {
        const res = await asBrowser(U.a)
        expect([res.status, res.body.code]).toEqual([503, "service_unavailable"])
      } finally {
        vi.stubEnv("BACKEND_INTERNAL_URL", backendUrl)
        await broken.app.close()
        await pool.end()
      }
    })

    it("Supabase Auth (stub) unavailable -> 503 auth_unavailable, no sign-out, no backend call", async () => {
      const before = queries
      for (const userMode of ["server_error", "hang"] as const) {
        const res = await asBrowser(U.a, { userMode })
        expect([res.status, res.body.code], userMode).toEqual([503, "auth_unavailable"])
        expect((cookies.jar as ReturnType<typeof cookieJar>).cleared("sb-")).toBe(false)
      }
      expect(queries).toBe(before)
    })

    it("malformed backend response -> safe 503", async () => {
      const server = http.createServer((_, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end('{"orders":[{"id":"x"}],"nextCursor":null}') })
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()))
      vi.stubEnv("BACKEND_INTERNAL_URL", `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`)
      try {
        const res = await asBrowser(U.a)
        expect([res.status, res.body.code]).toEqual([503, "service_unavailable"])
      } finally {
        vi.stubEnv("BACKEND_INTERNAL_URL", backendUrl)
        await new Promise((r) => server.close(r))
      }
    })
  })

  describe("24. local warm timings and round trips (localhost, not a production estimate)", () => {
    it("direct Fastify vs Next -> Fastify -> PostgreSQL, first page of 20", async () => {
      const N = 40
      // Round-trip accounting for ONE Next request.
      await asBrowser(U.a)
      stub!.requests.length = 0
      queries = 0
      const one = await ordersRoute(new Request("http://localhost:3000/api/parent/orders"))
      expect(one.status).toBe(200)
      const providerCalls = stub!.requests.length
      const dbQueries = queries
      expect(providerCalls).toBe(1) // GET /auth/v1/user (getSession reads the cookie locally)
      expect(dbQueries).toBe(3) // identity, profile, orders page (with delivered_at inline)

      const directMs: number[] = []
      for (let i = 0; i < N + 5; i++) {
        const t = performance.now()
        const res = await direct("/v1/parent/orders", sign(U.a))
        expect(res.status).toBe(200)
        await res.json()
        if (i >= 5) directMs.push(performance.now() - t)
      }
      const nextMs: number[] = []
      for (let i = 0; i < N + 5; i++) {
        const t = performance.now()
        const res = await ordersRoute(new Request("http://localhost:3000/api/parent/orders"))
        expect(res.status).toBe(200)
        expect((await res.json()).orders).toHaveLength(20)
        if (i >= 5) nextMs.push(performance.now() - t)
      }
      const fmt = (xs: number[]) => ({ medianMs: +pct(xs, 50).toFixed(1), p90Ms: +pct(xs, 90).toFixed(1) })
      console.log(`[orders cutover perf] ${JSON.stringify({ requests: N, directFastify: fmt(directMs), nextToFastify: fmt(nextMs), perNextRequest: { providerCalls, backendCalls: 1, dbQueries } })}`)
    })
  })
})
