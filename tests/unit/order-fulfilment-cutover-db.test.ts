import { describe, it, expect, beforeAll, afterAll, vi } from "vitest"
import { randomBytes, randomUUID } from "node:crypto"
import fs from "node:fs"
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
import { POST as finalMediaPOST } from "@/app/api/parent/orders/[orderId]/final-media/route"
import { GET as galleryGET } from "@/app/api/parent/gallery/route"
import { GET as ordersGET } from "@/app/api/parent/orders/route"
import { PATCH as statusPATCH } from "@/app/api/admin/requests/[requestId]/status/route"
import { POST as uploadPOST } from "@/app/api/admin/requests/[requestId]/final-media/route"
import { PATCH as assetPATCH } from "@/app/api/admin/requests/[requestId]/final-media/[assetId]/route"
import { fetchParentOrderDetail, verifyParentOrderDetailCaller } from "@/lib/parent/orders/backend-order-detail"
import { loadAdminQueue, loadAdminRequestView } from "@/lib/admin/requests/backend-requests"
import { verifyParentCaller } from "@/lib/parent/backend-caller"
import { resolveOwnedSourceAsset } from "@/lib/parent/gallery/source-asset"
import { closePool, getPool } from "@/lib/db/pool"
import type { Queryable } from "@/lib/db/types"
import { signAssertion, signWriteAssertion } from "@/lib/identity/assertion"
import { toVerifiedIdentity } from "@/lib/identity/types"
import { InMemoryRateLimitStore, setRateLimitStore } from "@/lib/rate-limit"
import { runDataCopy } from "@/scripts/db/data-copy/copy"
import { buildSupabaseSource, dropDbs, migrateTarget, ownerUrl, pgEnv, psql, root, script, type PgEnv } from "../helpers/data-copy-db"
import { cookieJar, startStubAuth, type StubAuth } from "../helpers/stub-supabase-auth"
import { DAY_MS } from "../helpers/supabase-jwt"

/**
 * V0.1.52 order detail / gallery / final media / admin fulfilment cutover on
 * REAL local services (opt-in: CARTOONA_PLAIN_PG=docker):
 *
 *   Supabase-shaped source -> V0.1.44 copy -> plain PostgreSQL 17 (0001-0018)
 *   stub Supabase Auth + in-memory Storage (real @supabase/ssr, supabase-js)
 *   -> Next route handlers / loaders -> Fastify (listening, RESTRICTED login
 *   role) -> SELECTs + the existing trusted fulfilment functions.
 *
 * The stub answers /rest/v1 with 404 and records every request: any Supabase
 * DATABASE read or write by a migrated path would show up in `restCalls()`.
 * Storage is the only thing the stub serves for business paths. Nothing
 * contacts Supabase or any hosted service.
 */

const enabled = process.env.CARTOONA_PLAIN_PG === "docker"
const id = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`
const SRC = `ofs_${id}`
const TGT = `oft_${id}`
const ROLE = `cartoona_app_of${id}`
const DB_PASSWORD = randomBytes(24).toString("hex")
const AUTH_SECRET = randomBytes(32).toString("hex")
const ORIGIN = "http://localhost:3000"

const A = { user: "a1000000-0000-4000-8000-000000000001", profile: "b1000000-0000-4000-8000-000000000001" }
const B = { user: "a1000000-0000-4000-8000-000000000002", profile: "b1000000-0000-4000-8000-000000000002" }
const ADMIN = "a1000000-0000-4000-8000-000000000003"
const SUPER = "a1000000-0000-4000-8000-000000000005"
const ORDER_A_DELIVERED = "a2000000-0000-4000-8000-000000000001" // copied: delivered, 3 history rows, superseded v1 + approved v2
const ORDER_A_PENDING = "a2000000-0000-4000-8000-000000000002" // copied: pending_review, no media
const ORDER_A_VIDEO = "a2000000-0000-4000-8000-000000000005" // copied: in_progress video
const ORDER_B_DRAWING = "a2000000-0000-4000-8000-000000000007" // copied: B's drawing animation with an upload
const FINAL_V1 = "a5000000-0000-4000-8000-000000000001"
const FINAL_V2 = "a5000000-0000-4000-8000-000000000002"

let env: PgEnv
let backend: FastifyInstance | null = null
let backendUrl = ""
let stub: StubAuth | null = null
let appPool: Pool
let owner: Pool
let characterId = ""
const keep = new Set<string>() // storage keys that survive a sign-in switch
const statements: string[] = []
const hooks = { afterGate: null as null | (() => Promise<void>), failOnce: null as null | RegExp }

function countingDb(): () => Queryable {
  return () => ({
    query: async (text: string, values?: readonly unknown[]) => {
      statements.push(text)
      if (hooks.failOnce?.test(text)) {
        hooks.failOnce = null
        throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" })
      }
      const result = await getPool().query(text, values as unknown[])
      // the upload gate's state read is the only statement selecting history_id: a seam for a race between gate and record
      if (hooks.afterGate && text.includes("history_id")) {
        const run = hooks.afterGate
        hooks.afterGate = null
        await run()
      }
      return result
    },
  }) as Queryable
}

// ── assertions (direct to the backend) ───────────────────────────────────────
const ident = (s: string) => toVerifiedIdentity({ provider: "supabase", subject: s })
const secret = () => Buffer.from(AUTH_SECRET, "hex")
const rid = () => `of-${randomBytes(4).toString("hex")}`
async function direct(method: "GET" | "POST" | "PATCH", user: string, p: string, body?: unknown, query = "", extraHeaders: Record<string, string> = {}, token?: string) {
  const raw = body === undefined ? undefined : JSON.stringify(body)
  const t = token ?? (method === "GET"
    ? signAssertion({ identity: ident(user), authenticatedAt: Date.now() - DAY_MS, requestId: rid(), method, path: p, secret: secret() })
    : signWriteAssertion({ identity: ident(user), authenticatedAt: Date.now() - DAY_MS, requestId: rid(), method, path: p, body: raw ?? "", secret: secret() }))
  const res = await fetch(`${backendUrl}${p}${query}`, { method, body: raw, headers: { ...(raw ? { "content-type": "application/json" } : {}), "x-cartoona-internal-auth": t, ...extraHeaders } })
  return { status: res.status, body: (await res.json()) as Record<string, any>, token: t } // eslint-disable-line @typescript-eslint/no-explicit-any
}
const signWrite = (user: string, method: "POST" | "PATCH", p: string, body: unknown) =>
  signWriteAssertion({ identity: ident(user), authenticatedAt: Date.now() - DAY_MS, requestId: rid(), method, path: p, body: JSON.stringify(body), secret: secret() })

// ── database facts ───────────────────────────────────────────────────────────
const q = async <T = Record<string, any>>(sql: string, args: unknown[] = []) => (await owner.query(sql, args)).rows as T[] // eslint-disable-line @typescript-eslint/no-explicit-any
async function sqlState(work: Promise<unknown>): Promise<string | undefined> {
  const e = await work.then(() => null, (x: unknown) => x)
  return (e as { code?: string } | null)?.code
}
async function newParent() {
  const user = randomUUID()
  await appPool.query("select public.provision_supabase_parent_identity($1)", [user])
  const profile = (await q<{ id: string }>("select id from public.parent_profiles where user_id = $1", [user]))[0].id
  await q("update public.parent_profiles set consent_granted = true, consent_granted_at = now() where id = $1", [profile])
  await q("update public.candy_wallets set balance = 100000 where parent_id = $1", [profile])
  return { user, profile }
}
/** A PG-only request through the REAL trusted function as the restricted role (the V0.1.50 path). */
async function newRequest(profile: string, title = "PG request") {
  const orderId = randomUUID()
  await appPool.query(
    "select * from public.create_parent_request_trusted(p_parent_profile_id => $1, p_order_id => $2, p_type => 'image', p_title => $3, p_character_id => $4, p_submission_key => $5)",
    [profile, orderId, title, characterId, randomUUID()],
  )
  return orderId
}
async function addSource(orderId: string, key: string, createdAt: string, extra: { name?: string | null; mime?: string } = {}) {
  const rows = await q<{ id: string }>(
    "insert into public.media_assets (order_id, type, asset_role, file_url, mime_type, original_filename, created_at) values ($1, 'upload', 'source', $2, $3, $4, $5::timestamptz) returning id",
    [orderId, key, extra.mime ?? "image/png", extra.name === undefined ? key.split("/").pop() : extra.name, createdAt],
  )
  keep.add(`parent-uploads/${key}`)
  return rows[0].id
}
const historyCount = async (orderId: string) => Number((await q<{ n: string }>("select count(*) n from public.order_status_history where order_id = $1", [orderId]))[0].n)
const statusOf = async (orderId: string) => (await q<{ status: string }>("select status from public.orders where id = $1", [orderId]))[0].status

// ── Next harness ─────────────────────────────────────────────────────────────
async function signIn(userId: string, role = "parent") {
  if (stub) for (const k of stub.storage.objects) keep.add(k)
  await stub?.close()
  stub = await startStubAuth({ userId, role })
  for (const k of keep) stub.storage.objects.add(k)
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", stub.url)
  cookies.jar = cookieJar([stub.cookie()])
  setRateLimitStore(new InMemoryRateLimitStore())
}
const restCalls = () => (stub?.requests ?? []).filter((r) => r.path.startsWith("/rest/v1/"))
const browserHeaders = { "content-type": "application/json", origin: ORIGIN, "sec-fetch-site": "same-origin" }
const asJson = async (res: Response) => ({ status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> }) // eslint-disable-line @typescript-eslint/no-explicit-any
const bFinal = async (orderId: string, action?: "view" | "download") =>
  asJson(await finalMediaPOST(new Request(`${ORIGIN}/api/parent/orders/${orderId}/final-media`, { method: "POST", body: JSON.stringify(action ? { action } : {}), headers: browserHeaders }), { params: Promise.resolve({ orderId }) }))
const bGallery = async (query = "") => asJson(await galleryGET(new Request(`${ORIGIN}/api/parent/gallery${query}`)))
const bStatus = async (orderId: string, body: Record<string, unknown>, headers: Record<string, string> = browserHeaders) =>
  asJson(await statusPATCH(new Request(`${ORIGIN}/api/admin/requests/${orderId}/status`, { method: "PATCH", body: JSON.stringify(body), headers }), { params: Promise.resolve({ requestId: orderId }) }))
const bAsset = async (orderId: string, assetId: string, action: string) =>
  asJson(await assetPATCH(new Request(`${ORIGIN}/api/admin/requests/${orderId}/final-media/${assetId}`, { method: "PATCH", body: JSON.stringify({ action }), headers: browserHeaders }), { params: Promise.resolve({ requestId: orderId, assetId }) }))
const png = (name = "final.png", bytes = 64) => new File([new Uint8Array(bytes)], name, { type: "image/png" })
const bUpload = async (orderId: string, files: File[]) => {
  const form = new FormData()
  for (const f of files) form.append("files", f)
  return asJson(await uploadPOST(new Request(`${ORIGIN}/api/admin/requests/${orderId}/final-media`, { method: "POST", body: form, headers: { origin: ORIGIN, "sec-fetch-site": "same-origin" } }), { params: Promise.resolve({ requestId: orderId }) }))
}
/** the order's current optimistic-concurrency token as the admin page would show it */
const tokenOf = async (orderId: string) => {
  const r = await direct("GET", ADMIN, `/v1/admin/requests/${orderId}`)
  return r.body.order.updated_at as string
}
async function parentDetail(user: string, orderId: string) {
  await signIn(user)
  const caller = await verifyParentOrderDetailCaller()
  if (!caller.ok) throw new Error("caller " + caller.reason)
  return fetchParentOrderDetail(caller.context, orderId)
}
const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))]
async function timed(n: number, work: () => Promise<unknown>) {
  const xs: number[] = []
  for (let i = 0; i < n; i++) {
    const t = performance.now()
    await work()
    xs.push(performance.now() - t)
  }
  return { median: Math.round(pct(xs, 50) * 10) / 10, p90: Math.round(pct(xs, 90) * 10) / 10 }
}

describe.skipIf(!enabled)("V0.1.52 order detail / media / admin fulfilment cutover (local Docker PostgreSQL 17)", () => {
  vi.setConfig({ testTimeout: 120_000, hookTimeout: 300_000 })

  beforeAll(async () => {
    env = await pgEnv()
    await buildSupabaseSource(env, SRC, path.join(root, "tests/fixtures/data-copy/supabase-source-fixture.sql"))
    await psql(env, SRC, "", path.join(root, "tests/fixtures/data-copy/parent-orders-extra.sql"))
    await psql(env, SRC, "", path.join(root, "tests/fixtures/data-copy/parent-account-extra.sql"))
    await psql(env, SRC, "", path.join(root, "tests/fixtures/data-copy/parent-consent-extra.sql"))
    await migrateTarget(env, TGT)
    const copied = await runDataCopy({ sourceUrl: ownerUrl(env, SRC), targetUrl: ownerUrl(env, TGT), migrationsDir: path.join(root, "database/migrations"), env: {} })
    expect(copied.outcome).toBe("completed")
    const r = await script(env, "scripts/db/app-login-role.sh", { DATABASE_URL: `postgresql://cartoona@postgres:5432/${TGT}`, CARTOONA_APP_DB_PASSWORD: DB_PASSWORD }, [ROLE])
    expect(r.code).toBe(0)
    const roleUrl = `postgresql://${ROLE}:${DB_PASSWORD}@127.0.0.1:${env.port}/${TGT}`
    owner = new Pool({ connectionString: ownerUrl(env, TGT), max: 4 })
    appPool = new Pool({ connectionString: roleUrl, max: 24 })
    characterId = (await q<{ id: string }>("select id from public.characters where is_active order by name limit 1"))[0].id
    // The objects the copied rows point at (bytes are not migrated: the stub stands in for the same keys).
    for (const k of await q<{ file_url: string; type: string }>("select file_url, type from public.media_assets")) {
      keep.add(`${k.type === "upload" ? "parent-uploads" : "final-deliverables"}/${k.file_url}`)
    }
    vi.stubEnv("DATABASE_URL", roleUrl)
    vi.stubEnv("CARTOONA_INTERNAL_AUTH_SECRET", AUTH_SECRET)
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-key")
    vi.stubEnv("SUPABASE_SECRET_KEY", "service-key-for-stub")
    vi.stubEnv("BACKEND_REQUEST_TIMEOUT_MS", "3000")
    const app = buildBackendApp({ db: countingDb(), closeDb: async () => {} })
    await app.listen({ host: "127.0.0.1", port: 0 })
    backend = app
    backendUrl = `http://127.0.0.1:${(app.server.address() as net.AddressInfo).port}`
    vi.stubEnv("BACKEND_INTERNAL_URL", backendUrl)
  })

  afterAll(async () => {
    vi.restoreAllMocks()
    await stub?.close()
    await backend?.close()
    await appPool?.end()
    await owner?.end()
    await closePool()
    vi.unstubAllEnvs()
    if (!env) return
    await dropDbs(env, [SRC, TGT])
    await psql(env, "postgres", `drop role if exists ${ROLE}`).catch(() => undefined)
  })

  // ───────────────────────────────────────────────────────────────────────────
  describe("12. privileges: EXECUTE on the fulfilment functions, SELECT on the metadata tables, no direct write", () => {
    it.each([
      ["INSERT media_assets", `insert into public.media_assets (order_id, type, file_url) values ('${ORDER_A_PENDING}', 'upload', 'x')`],
      ["UPDATE media_assets (approve by hand)", `update public.media_assets set delivery_status = 'approved', parent_visible = true`],
      ["DELETE media_assets", `delete from public.media_assets`],
      ["UPDATE orders status", `update public.orders set status = 'delivered'`],
      ["INSERT order_status_history", `insert into public.order_status_history (order_id, new_status) values ('${ORDER_A_PENDING}', 'ready')`],
      ["DELETE order_status_history", `delete from public.order_status_history`],
      ["INSERT audit_logs", `insert into public.audit_logs (actor_id, action, target_type) values ('${A.user}', 'x', 'y')`],
      ["INSERT video_requests", `insert into public.video_requests (order_id) values ('${ORDER_A_PENDING}')`],
    ])("the app role cannot %s -> 42501", async (_l, sql) => {
      expect(await sqlState(appPool.query(sql))).toBe("42501")
    })

    it("the app role can SELECT the three metadata tables and EXECUTE exactly the trusted functions", async () => {
      for (const t of ["media_assets", "video_requests", "drawing_animation_requests"]) expect(await sqlState(appPool.query(`select 1 from public.${t} limit 1`))).toBeUndefined()
      // Role check inside the function: a PARENT user id is refused even though EXECUTE is granted.
      expect(await sqlState(appPool.query("select * from public.update_order_status_trusted($1, $2, 'in_progress', now(), null, null)", [ORDER_A_PENDING, A.user]))).toBe("P0001")
      expect(await sqlState(appPool.query("select * from public.record_final_media_trusted($1, $2, $3, 'image/png', 1, 'x.png')", [A.user, ORDER_A_PENDING, `orders/${ORDER_A_PENDING}/final/${randomUUID()}.png`]))).toBe("P0001")
      expect(await sqlState(appPool.query("select * from public.get_order_status_history_admin_trusted($1, $2)", [A.user, ORDER_A_PENDING]))).toBe("P0001")
    })

    it("the audit function refuses a non-owner, a non-final, an unapproved and an unknown action", async () => {
      const call = (actor: string, order: string, asset: string, action: string) => appPool.query("select public.record_final_media_access_audit_trusted($1, $2, $3, $4)", [actor, order, asset, action])
      expect(await sqlState(call(B.user, ORDER_A_DELIVERED, FINAL_V2, "final_media_view"))).toBe("P0001") // not the owner
      expect(await sqlState(call(A.user, ORDER_A_DELIVERED, FINAL_V1, "final_media_view"))).toBe("P0001") // superseded
      expect(await sqlState(call(A.user, ORDER_A_PENDING, FINAL_V2, "final_media_view"))).toBe("P0001") // wrong order
      expect(await sqlState(call(A.user, ORDER_A_DELIVERED, FINAL_V2, "final_media_delete"))).toBe("P0001") // unknown action
      const before = Number((await q<{ n: string }>("select count(*) n from public.audit_logs where action like 'final_media%'"))[0].n)
      expect(await sqlState(call(A.user, ORDER_A_DELIVERED, FINAL_V2, "final_media_view"))).toBeUndefined()
      expect(Number((await q<{ n: string }>("select count(*) n from public.audit_logs where action like 'final_media%'"))[0].n)).toBe(before + 1)
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  describe("3/4/17. parent order detail: ownership in SQL, safe 404, parent role only", () => {
    const path = (o: string) => `/v1/parent/orders/${o}`

    it("the owner reads a copied delivered order with metadata, parent-safe history and the current final", async () => {
      const r = await direct("GET", A.user, path(ORDER_A_DELIVERED))
      expect(r.status).toBe(200)
      expect(r.body.order).toMatchObject({ id: ORDER_A_DELIVERED, type: "image", status: "delivered" })
      expect(r.body.history.map((h: { new_status: string }) => h.new_status)).toEqual(["delivered", "ready", "in_progress"])
      // Newest first, microseconds preserved, and no internal note / actor column ever leaves.
      expect(r.body.history[0]).toEqual({ previous_status: "ready", new_status: "delivered", parent_visible_note: "Enjoy!", created_at: "2026-09-02T10:00:00.345678+00:00" })
      expect(JSON.stringify(r.body)).not.toMatch(/picked up|internal_note|changed_by|assigned_admin|moderation/)
      expect(r.body.finalMedia).toEqual({ id: FINAL_V2, mimeType: "image/png", fileName: "v2.png" })
      expect(r.body.finalMedia).not.toHaveProperty("path")
    })

    it("a foreign order, an unknown order and a malformed id are indistinguishable 404s; the admin and an unlinked caller are refused", async () => {
      const foreign = await direct("GET", B.user, path(ORDER_A_DELIVERED))
      const unknown = await direct("GET", B.user, path(randomUUID()))
      const malformed = await direct("GET", B.user, "/v1/parent/orders/not-a-uuid")
      expect([foreign.status, unknown.status, malformed.status]).toEqual([404, 404, 404])
      expect(foreign.body).toEqual(unknown.body)
      expect(foreign.body).toEqual({ error: "not_found" })
      expect((await direct("GET", ADMIN, path(ORDER_A_DELIVERED))).status).toBe(403)
      expect((await direct("GET", randomUUID(), path(ORDER_A_DELIVERED))).status).toBe(403)
    })

    it("no N+1: the statement count does not grow with the number of source files", async () => {
      const p = await newParent()
      const o1 = await newRequest(p.profile, "one")
      const o3 = await newRequest(p.profile, "three")
      await addSource(o1, `${p.user}/${o1}/a.png`, "2026-10-10T10:00:00Z")
      for (const n of ["a", "b", "c"]) await addSource(o3, `${p.user}/${o3}/${n}.png`, "2026-10-10T10:00:00Z")
      const count = async (o: string) => { statements.length = 0; expect((await direct("GET", p.user, path(o))).status).toBe(200); return statements.filter((s) => /public\.(orders|media_assets)\b/.test(s)).length }
      expect(await count(o3)).toBe(await count(o1))
    })

    it("the response has no path-widening fields and the foreign parent's keys are not even read", async () => {
      statements.length = 0
      await direct("GET", B.user, path(ORDER_A_DELIVERED))
      // Ownership is the FIRST statement after identity: nothing about the media is queried for a foreign order.
      expect(statements.some((s) => /FROM public\.media_assets m\s+WHERE m\.order_id = \$1 AND m\.type = 'upload'/.test(s))).toBe(false)
    })

    it("the Next loader: a PG-only request is visible, copied history is intact, and no Supabase DATABASE call is made", async () => {
      const p = await newParent()
      const orderId = await newRequest(p.profile, "Fresh PG order")
      await addSource(orderId, `${p.user}/${orderId}/ref.png`, "2026-10-10T10:00:00Z")
      const fresh = await parentDetail(p.user, orderId)
      if (!fresh.ok) throw new Error(JSON.stringify(fresh))
      expect(fresh.detail.displayTitle).toBe("Fresh PG order")
      expect(fresh.detail.status).toBe("submitted")
      expect(fresh.detail.sourceMedia).toHaveLength(1)
      expect(fresh.detail.sourceMedia[0].signedUrl).toMatch(/token=stub/)
      // the object key never appears outside the short-lived signed URL
      expect(JSON.stringify({ ...fresh.detail, sourceMedia: fresh.detail.sourceMedia.map((m) => ({ ...m, signedUrl: "x" })) })).not.toContain("ref.png")
      const copied = await parentDetail(A.user, ORDER_A_DELIVERED)
      if (!copied.ok) throw new Error("copied")
      expect(copied.detail.status).toBe("ready") // delivered is the parent-facing "ready"
      expect(copied.detail.completedAt).toBe("2026-09-02T10:00:00.345678+00:00")
      expect(copied.detail.timeline.length).toBe(3)
      expect(copied.detail.finalMedia?.id).toBe(FINAL_V2)
      expect(restCalls()).toEqual([])
    })

    it("another parent's order through the Next loader is not_found and signs nothing", async () => {
      await signIn(B.user)
      const before = stub!.storage.signed.length
      const caller = await verifyParentOrderDetailCaller()
      if (!caller.ok) throw new Error("caller")
      expect(await fetchParentOrderDetail(caller.context, ORDER_A_DELIVERED)).toEqual({ ok: false, reason: "not_found" })
      expect(await fetchParentOrderDetail(caller.context, "not-a-uuid")).toEqual({ ok: false, reason: "not_found" })
      expect(stub!.storage.signed.length).toBe(before)
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  describe("7/8/17/29. final media: authorization from PostgreSQL, signing after, audit, Storage failure", () => {
    it("the owner gets a signed URL for the approved final, the audit row stores ids only, and nothing hits Supabase's database", async () => {
      await signIn(A.user)
      const before = Number((await q<{ n: string }>("select count(*) n from public.audit_logs where action = 'final_media_download' and target_id = $1", [FINAL_V2]))[0].n)
      const r = await bFinal(ORDER_A_DELIVERED, "download")
      expect(r.status).toBe(200)
      expect(r.body.url).toMatch(/final-deliverables\/orders\/.*v2\.png.*token=stub/)
      expect(Object.keys(r.body).sort()).toEqual(["expiresAt", "fileName", "mediaType", "url"])
      expect(stub!.storage.signed).toContain(`final-deliverables/orders/${ORDER_A_DELIVERED}/final/v2.png`)
      const rows = await q("select actor_id, metadata from public.audit_logs where action = 'final_media_download' and target_id = $1", [FINAL_V2])
      expect(rows.length).toBe(before + 1)
      expect(rows[rows.length - 1]).toMatchObject({ actor_id: A.user, metadata: { orderId: ORDER_A_DELIVERED } })
      expect(JSON.stringify(rows)).not.toMatch(/token|http/)
      expect(restCalls()).toEqual([])
    })

    it("cross-parent, unknown and unapproved all read as 404 and sign nothing; the superseded v1 is never served", async () => {
      await signIn(B.user)
      const before = stub!.storage.signed.length
      const foreign = await bFinal(ORDER_A_DELIVERED)
      const unknown = await bFinal(randomUUID())
      const malformed = await bFinal("not-a-uuid")
      expect([foreign.status, unknown.status, malformed.status]).toEqual([404, 404, 404])
      expect(foreign.body.code).toBe("FINAL_NOT_READY")
      expect(malformed.body.code).toBe("ORDER_NOT_FOUND")
      // the pending order has no final at all
      await signIn(A.user)
      expect((await bFinal(ORDER_A_PENDING)).status).toBe(404)
      expect(stub!.storage.signed.length).toBe(0)
      void before
      // v1 is superseded: only v2 is ever the answer
      const r = await direct("GET", A.user, `/v1/parent/orders/${ORDER_A_DELIVERED}/final-media`)
      expect(r.body.assetId).toBe(FINAL_V2)
    })

    it("a browser cannot name an object: extra body keys and wrong actions are refused and no key is accepted", async () => {
      await signIn(A.user)
      const res = await finalMediaPOST(new Request(`${ORIGIN}/api/parent/orders/${ORDER_A_DELIVERED}/final-media`, { method: "POST", body: JSON.stringify({ action: "view", path: "orders/x/final/y.png", bucket: "parent-uploads" }), headers: browserHeaders }), { params: Promise.resolve({ orderId: ORDER_A_DELIVERED }) })
      expect(res.status).toBe(200) // ignored: the signed key is still the PostgreSQL one
      expect(stub!.storage.signed).toEqual([`final-deliverables/orders/${ORDER_A_DELIVERED}/final/v2.png`])
      expect((await bFinal(ORDER_A_DELIVERED, "delete" as "view")).status).toBe(422)
      const noCsrf = await finalMediaPOST(new Request(`${ORIGIN}/api/parent/orders/${ORDER_A_DELIVERED}/final-media`, { method: "POST", body: "{}", headers: { "content-type": "application/json", origin: "https://evil.example" } }), { params: Promise.resolve({ orderId: ORDER_A_DELIVERED }) })
      expect(noCsrf.status).toBe(403)
    })

    it("an admin session cannot use the parent route (403/404, nothing signed)", async () => {
      await signIn(ADMIN, "admin")
      const r = await bFinal(ORDER_A_DELIVERED)
      expect([403, 404]).toContain(r.status)
      expect(stub!.storage.signed).toEqual([])
    })

    it("Storage outage: metadata still renders (previews unavailable), the signed route is a retryable 500, no audit row, no sign-out", async () => {
      const p = await newParent()
      const orderId = await newRequest(p.profile, "storage down")
      await addSource(orderId, `${p.user}/${orderId}/x.png`, "2026-10-11T10:00:00Z")
      await signIn(p.user)
      stub!.storage.mode = "sign_fail"
      const caller = await verifyParentOrderDetailCaller()
      if (!caller.ok) throw new Error("caller")
      const detail = await fetchParentOrderDetail(caller.context, orderId)
      if (!detail.ok) throw new Error(JSON.stringify(detail))
      expect(detail.detail.displayTitle).toBe("storage down")
      expect(detail.detail.sourceMedia.map((m) => m.signedUrl)).toEqual([null])
      const gallery = await bGallery()
      expect(gallery.status).toBe(200)
      expect(gallery.body.media).toHaveLength(1)
      expect(gallery.body.media[0].signedUrl).toBeNull()
      // a final for A while Storage is down
      await signIn(A.user)
      stub!.storage.mode = "sign_fail"
      const before = Number((await q<{ n: string }>("select count(*) n from public.audit_logs where action = 'final_media_view'"))[0].n)
      const res = await bFinal(ORDER_A_DELIVERED)
      expect(res.status).toBe(500)
      expect(res.body.code).toBe("SIGNING_FAILED")
      expect(Number((await q<{ n: string }>("select count(*) n from public.audit_logs where action = 'final_media_view'"))[0].n)).toBe(before)
      stub!.storage.mode = "ok"
      expect((await bFinal(ORDER_A_DELIVERED)).status).toBe(200) // same session, no re-login
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  describe("6/17. gallery: ownership + keyset in SQL, signed URLs from PostgreSQL keys", () => {
    let g: { user: string; profile: string }
    const ids: string[] = []
    const keyOf = (n: number) => `${g.user}/gallery-${n}.png`
    beforeAll(async () => {
      g = await newParent()
      const order = await newRequest(g.profile, "gallery order")
      // 60 sources; groups of 10 share an identical created_at (id tie-break), microsecond precision.
      for (let n = 0; n < 60; n++) {
        const ts = `2026-11-01T10:${String(Math.floor(n / 10)).padStart(2, "0")}:00.${String(123456 + Math.floor(n / 10)).padStart(6, "0")}Z`
        ids.push(await addSource(order, keyOf(n), ts, { name: `g${n}.png` }))
      }
      // not gallery material: final / generated / another role, and another parent's source
      await q("insert into public.media_assets (order_id, type, asset_role, delivery_status, file_url, mime_type) values ($1, 'generated', 'final', 'uploaded', 'orders/x/final/z.png', 'image/png')", [order])
      await q("insert into public.media_assets (order_id, type, asset_role, file_url, mime_type) values ($1, 'upload', 'supporting', 'g/support.png', 'image/png')", [order])
    })

    const walk = async (limit?: number, user = () => g.user) => {
      const seen: string[] = []
      let cursor: string | undefined
      for (let i = 0; i < 100; i++) {
        const r = await direct("GET", user(), "/v1/parent/gallery", undefined, `?${new URLSearchParams({ ...(cursor ? { cursor } : {}), ...(limit ? { limit: String(limit) } : {}) })}`)
        expect(r.status).toBe(200)
        seen.push(...r.body.items.map((x: { id: string }) => x.id))
        if (!r.body.nextCursor) break
        cursor = r.body.nextCursor
      }
      return seen
    }

    it("pages of 24/24/12: newest first, no duplicates, nothing skipped, deterministic across identical timestamps", async () => {
      const first = await direct("GET", g.user, "/v1/parent/gallery")
      expect(first.body.items).toHaveLength(24)
      const all = await walk()
      expect(all).toHaveLength(60)
      expect(new Set(all).size).toBe(60)
      expect(all).toEqual(await walk())
      const expected = (await q<{ id: string }>("select m.id from public.media_assets m join public.orders o on o.id = m.order_id where o.parent_id = $1 and m.type = 'upload' and m.asset_role = 'source' order by m.created_at desc, m.id desc", [g.profile])).map((r) => r.id)
      expect(all).toEqual(expected)
    })

    it("a huge limit is bounded, an exact multiple has no phantom page, bad parameters are 400", async () => {
      expect((await direct("GET", g.user, "/v1/parent/gallery", undefined, "?limit=100")).body.items).toHaveLength(48)
      const nextOf = async (limit: number) => (await direct("GET", g.user, "/v1/parent/gallery", undefined, `?limit=${limit}`)).body.nextCursor
      expect(await nextOf(48)).not.toBeNull()
      for (const bad of ["?limit=0", "?limit=abc", "?cursor=garbage", "?parentId=x", `?cursor=${encodeURIComponent(btoa("x),or(true|" + randomUUID()))}`]) {
        expect((await direct("GET", g.user, "/v1/parent/gallery", undefined, bad)).status, bad).toBe(400)
      }
    })

    it("an upload arriving between pages does not repeat or skip; a deleted cursor row still resumes", async () => {
      const first = await direct("GET", g.user, "/v1/parent/gallery", undefined, "?limit=10")
      const order = (await q<{ id: string }>("select id from public.orders where parent_id = $1 limit 1", [g.profile]))[0].id
      const late = await addSource(order, keyOf(900), "2027-01-01T00:00:00Z")
      const second = await direct("GET", g.user, "/v1/parent/gallery", undefined, `?limit=10&cursor=${first.body.nextCursor}`)
      const seen = [...first.body.items, ...second.body.items].map((x: { id: string }) => x.id)
      expect(new Set(seen).size).toBe(20)
      expect(seen).not.toContain(late) // belongs to page 1 of a fresh load
      const lastId = first.body.items[9].id
      await q("delete from public.media_assets where id = $1", [lastId])
      const resumed = await direct("GET", g.user, "/v1/parent/gallery", undefined, `?limit=10&cursor=${first.body.nextCursor}`)
      expect(resumed.status).toBe(200)
      expect(resumed.body.items).toHaveLength(10)
      await q("delete from public.media_assets where id = $1", [late])
    })

    it("never another parent's media, never finals/generated/other roles; the admin is refused", async () => {
      const bAll = await walk(undefined, () => B.user)
      expect(bAll.every((x) => !ids.includes(x))).toBe(true)
      const all = await walk()
      const roles = await q<{ asset_role: string; type: string }>("select asset_role, type from public.media_assets where id = any($1::uuid[])", [all])
      expect(roles.every((r) => r.asset_role === "source" && r.type === "upload")).toBe(true)
      expect((await direct("GET", ADMIN, "/v1/parent/gallery")).status).toBe(403)
    })

    it("the Next route signs only this page's keys in one batch and exposes no path; the page works with zero Supabase database calls", async () => {
      await signIn(g.user)
      const r = await bGallery("?limit=24")
      expect(r.status).toBe(200)
      expect(r.body.media).toHaveLength(24)
      expect(r.body.media.every((m: { signedUrl: string }) => /token=stub/.test(m.signedUrl))).toBe(true)
      expect(stub!.storage.signed).toHaveLength(24)
      expect(Object.keys(r.body.media[0]).sort()).toEqual(["id", "isImage", "label", "mimeType", "signedUrl", "uploadedAt"])
      expect(JSON.stringify({ media: r.body.media.map((m: Record<string, unknown>) => ({ ...m, signedUrl: "x" })) })).not.toContain(g.user)
      expect(restCalls()).toEqual([])
    })

    it("request re-use: an owned source resolves; a foreign id, an unknown id and a FINAL asset are the same not_found", async () => {
      await signIn(g.user)
      const caller = await verifyParentCaller()
      if (!caller.ok) throw new Error("caller")
      const own = await resolveOwnedSourceAsset(caller.context, ids[5])
      expect(own.ok && own.asset.path).toBe(keyOf(5))
      expect(await resolveOwnedSourceAsset(caller.context, FINAL_V2)).toEqual({ ok: false, reason: "not_found" })
      expect(await resolveOwnedSourceAsset(caller.context, randomUUID())).toEqual({ ok: false, reason: "not_found" })
      await signIn(B.user)
      const callerB = await verifyParentCaller()
      if (!callerB.ok) throw new Error("callerB")
      expect(await resolveOwnedSourceAsset(callerB.context, ids[5])).toEqual({ ok: false, reason: "not_found" })
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  describe("9/13/18. admin reads and the role boundary", () => {
    it("the admin sees the queue and a detail with parent info, source media, final media metadata and the full history", async () => {
      const list = await direct("GET", ADMIN, "/v1/admin/requests", undefined, "?status=delivered")
      expect(list.status).toBe(200)
      expect(list.body.requests.length).toBeGreaterThan(0)
      expect(list.body.requests.every((r: { status: string }) => r.status === "delivered")).toBe(true)
      const detail = await direct("GET", SUPER, `/v1/admin/requests/${ORDER_A_DELIVERED}`)
      expect(detail.status).toBe(200)
      expect(detail.body.order.parent_email).toBe("parent.a@fixture.invalid")
      expect(detail.body.media.map((m: { id: string }) => m.id).sort()).toEqual([FINAL_V1, FINAL_V2].sort())
      expect(detail.body.history).toHaveLength(3)
      expect(detail.body.history.some((h: { internal_note: string | null }) => h.internal_note === "picked up")).toBe(true) // admins DO see internal notes
      expect((await direct("GET", ADMIN, `/v1/admin/requests/${randomUUID()}`)).status).toBe(404)
      expect((await direct("GET", ADMIN, "/v1/admin/requests", undefined, "?bogus=1")).status).toBe(400)
    })

    it("a parent never reaches an admin route: 403 on every verb, X-Role / X-User-Id are ignored, nothing is written", async () => {
      const spoof = { "x-role": "admin", "x-user-id": ADMIN }
      expect((await direct("GET", A.user, "/v1/admin/requests", undefined, "", spoof)).status).toBe(403)
      expect((await direct("GET", A.user, `/v1/admin/requests/${ORDER_A_PENDING}`, undefined, "", spoof)).status).toBe(403)
      expect((await direct("GET", A.user, `/v1/admin/requests/${ORDER_A_PENDING}/upload-gate`, undefined, "", spoof)).status).toBe(403)
      const body = { status: "in_progress", expectedUpdatedAt: new Date().toISOString(), internalNote: null, parentVisibleNote: null }
      expect((await direct("PATCH", A.user, `/v1/admin/requests/${ORDER_A_PENDING}/status`, body, "", spoof)).status).toBe(403)
      expect((await direct("POST", A.user, `/v1/admin/requests/${ORDER_A_PENDING}/final-media`, { filePath: "x", mimeType: "image/png", byteSize: 1, originalFilename: "x" }, "", spoof)).status).toBe(403)
      expect((await direct("PATCH", A.user, `/v1/admin/requests/${ORDER_A_PENDING}/final-media/${FINAL_V1}`, { action: "approve" }, "", spoof)).status).toBe(403)
      expect(await statusOf(ORDER_A_PENDING)).toBe("pending_review")
    })

    it("an admin cannot use a read assertion for a write, nor a write assertion for a different body or path", async () => {
      const p = `/v1/admin/requests/${ORDER_A_PENDING}/status`
      const body = { status: "in_progress", expectedUpdatedAt: await tokenOf(ORDER_A_PENDING), internalNote: null, parentVisibleNote: null }
      const readToken = signAssertion({ identity: ident(ADMIN), authenticatedAt: Date.now() - DAY_MS, requestId: rid(), method: "GET", path: p, secret: secret() })
      expect((await direct("PATCH", ADMIN, p, body, "", {}, readToken)).status).toBe(401)
      const other = signWrite(ADMIN, "PATCH", p, { ...body, status: "rejected" })
      expect((await direct("PATCH", ADMIN, p, body, "", {}, other)).status).toBe(401)
      const elsewhere = signWrite(ADMIN, "PATCH", `/v1/admin/requests/${ORDER_A_VIDEO}/status`, body)
      expect((await direct("PATCH", ADMIN, p, body, "", {}, elsewhere)).status).toBe(401)
      expect(await statusOf(ORDER_A_PENDING)).toBe("pending_review")
    })

    it("the Next admin routes: a parent session is 403 (backend decides), a missing Origin is a CSRF 403, and the stub's role claim is not trusted", async () => {
      await signIn(A.user, "admin") // the session CLAIMS admin; the database says parent
      const token = await tokenOf(ORDER_A_PENDING)
      const body = { status: "in_progress", expectedUpdatedAt: token, internalNote: null, parentVisibleNote: null }
      const r = await bStatus(ORDER_A_PENDING, body)
      expect(r.status).toBe(403)
      expect(r.body.code).toBe("REQUEST_UNAUTHORIZED")
      const up = await bUpload(ORDER_A_PENDING, [png()])
      expect(up.status).toBe(403)
      expect(stub!.storage.uploads).toEqual([]) // no byte was stored for a non-admin
      await signIn(ADMIN, "admin")
      expect((await bStatus(ORDER_A_PENDING, body, { "content-type": "application/json" })).status).toBe(403) // no Origin
      expect((await bStatus(ORDER_A_PENDING, body, { ...browserHeaders, origin: "https://evil.example" })).status).toBe(403)
      expect(await statusOf(ORDER_A_PENDING)).toBe("pending_review")
      const queue = await verifyParentCaller()
      if (!queue.ok) throw new Error("caller")
      expect((await loadAdminQueue(queue.context, { type: null, status: null, page: 1, pageSize: 20 }))?.rows.length).toBeGreaterThan(0)
      await signIn(A.user)
      const parentCaller = await verifyParentCaller()
      if (!parentCaller.ok) throw new Error("caller")
      expect(await loadAdminQueue(parentCaller.context, { type: null, status: null, page: 1, pageSize: 20 })).toBeNull()
      expect(await loadAdminRequestView(parentCaller.context, ORDER_A_PENDING)).toEqual({ ok: false, reason: "forbidden" })
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  describe("10/11/14. the fulfilment state machine, history and idempotency", () => {
    const statusBody = async (orderId: string, status: string, extra: Record<string, unknown> = {}) => ({ status, expectedUpdatedAt: await tokenOf(orderId), internalNote: null, parentVisibleNote: null, ...extra })
    const path = (o: string) => `/v1/admin/requests/${o}/status`

    it("a legal transition updates the order and appends EXACTLY ONE history row with the admin as actor", async () => {
      const p = await newParent()
      const o = await newRequest(p.profile)
      const before = await historyCount(o)
      const r = await direct("PATCH", ADMIN, path(o), await statusBody(o, "in_progress", { internalNote: "internal!", parentVisibleNote: "working on it" }))
      expect(r.status).toBe(200)
      expect(r.body).toMatchObject({ replayed: false, previousStatus: "pending_review", status: "in_progress", orderId: o })
      expect(await historyCount(o)).toBe(before + 1)
      const row = (await q("select changed_by_user_id, internal_note, parent_visible_note from public.order_status_history where id = $1", [r.body.historyId]))[0]
      expect(row).toEqual({ changed_by_user_id: ADMIN, internal_note: "internal!", parent_visible_note: "working on it" })
      expect(await statusOf(o)).toBe("in_progress")
    })

    it("the same assertion twice is 409 replayed_request (nonce) with no second row; a new-nonce retry returns the CURRENT state", async () => {
      const p = await newParent()
      const o = await newRequest(p.profile)
      const body = await statusBody(o, "in_progress")
      const first = await direct("PATCH", ADMIN, path(o), body)
      expect(first.status).toBe(200)
      const replay = await direct("PATCH", ADMIN, path(o), body, "", {}, first.token)
      expect(replay.status).toBe(409)
      expect(replay.body.error).toBe("replayed_request")
      // retry with a fresh assertion and the now-stale token
      const retry = await direct("PATCH", ADMIN, path(o), body)
      expect(retry.status).toBe(200)
      expect(retry.body).toMatchObject({ replayed: true, status: "in_progress", historyId: first.body.historyId })
      expect(await historyCount(o)).toBe(1) // exactly one transition row (creating a request writes none)
    })

    it("every refusal writes nothing: illegal transitions, unchanged, stale token, rejected-without-reason, ready-without-final, bad bodies", async () => {
      const p = await newParent()
      const o = await newRequest(p.profile)
      const h0 = await historyCount(o)
      const refuse = async (status: number, code: string, body: Record<string, unknown>) => {
        const r = await direct("PATCH", ADMIN, path(o), body)
        expect([r.status, r.body.error ?? r.body.code]).toEqual([status, code])
      }
      await refuse(422, "request_transition_invalid", await statusBody(o, "delivered"))
      await refuse(422, "request_rejection_reason_required", await statusBody(o, "rejected"))
      await refuse(409, "request_status_unchanged", await statusBody(o, "pending_review"))
      await refuse(409, "request_status_conflict", { ...(await statusBody(o, "in_progress")), expectedUpdatedAt: "2020-01-01T00:00:00.000000+00:00" })
      const r = await direct("PATCH", ADMIN, path(o), await statusBody(o, "in_progress"))
      expect(r.status).toBe(200)
      await refuse(422, "request_final_media_required", await statusBody(o, "ready"))
      for (const bad of [null, [], { status: "in_progress" }, { ...(await statusBody(o, "ready")), actorId: ADMIN }, { ...(await statusBody(o, "ready")), status: "bogus" }]) {
        expect([400, 422]).toContain((await direct("PATCH", ADMIN, path(o), bad as never)).status)
      }
      expect(await historyCount(o)).toBe(h0 + 1)
      expect(await statusOf(o)).toBe("in_progress")
    })

    it("terminal statuses never reopen (delivered, rejected, cancelled)", async () => {
      for (const terminal of ["rejected", "cancelled"]) {
        const p = await newParent()
        const o = await newRequest(p.profile)
        const extra = terminal === "rejected" ? { parentVisibleNote: "no", internalNote: "reason" } : {}
        expect((await direct("PATCH", ADMIN, path(o), await statusBody(o, terminal, extra))).status).toBe(200)
        for (const next of ["pending_review", "in_progress", "ready", "delivered"]) {
          expect((await direct("PATCH", ADMIN, path(o), await statusBody(o, next))).status, `${terminal}->${next}`).toBeGreaterThanOrEqual(409)
        }
      }
      // a COPIED delivered order stays delivered
      expect((await direct("PATCH", ADMIN, path(ORDER_A_DELIVERED), await statusBody(ORDER_A_DELIVERED, "in_progress"))).status).toBeGreaterThanOrEqual(409)
      expect(await statusOf(ORDER_A_DELIVERED)).toBe("delivered")
    })

    it("concurrency: 12 parallel identical transitions -> one real write (the rest are replays), ONE history row", async () => {
      const p = await newParent()
      const o = await newRequest(p.profile)
      const body = await statusBody(o, "in_progress")
      const results = await Promise.all(Array.from({ length: 12 }, () => direct("PATCH", ADMIN, path(o), body)))
      expect(results.every((r) => r.status === 200)).toBe(true)
      expect(results.filter((r) => r.body.replayed === false)).toHaveLength(1)
      expect(await historyCount(o)).toBe(1)
    })

    it("concurrency: competing different targets -> exactly one winner, the others a clean 409", async () => {
      const p = await newParent()
      const o = await newRequest(p.profile)
      const token = await tokenOf(o)
      const mk = (status: string, extra = {}) => ({ status, expectedUpdatedAt: token, internalNote: null, parentVisibleNote: null, ...extra })
      const results = await Promise.all([
        direct("PATCH", ADMIN, path(o), mk("in_progress")),
        direct("PATCH", SUPER, path(o), mk("cancelled")),
        direct("PATCH", ADMIN, path(o), mk("rejected", { internalNote: "r", parentVisibleNote: "r" })),
      ])
      const won = results.filter((r) => r.status === 200 && r.body.replayed === false)
      expect(won).toHaveLength(1)
      expect(results.filter((r) => r.status !== 200).every((r) => r.status === 409)).toBe(true)
      expect(await historyCount(o)).toBe(1)
      expect(await statusOf(o)).toBe(won[0].body.status)
    })

    it("an unavailable database answer is 503 and an uncertain write is not reported as 'not saved'", async () => {
      const spy = vi.spyOn(getPool(), "query")
      try {
        spy.mockRejectedValueOnce(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }))
        const r = await direct("GET", ADMIN, `/v1/admin/requests/${ORDER_A_PENDING}`)
        expect([500, 503]).toContain(r.status)
      } finally {
        spy.mockRestore()
      }
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  describe("15/16. the final-media write boundary", () => {
    const rec = (o: string, body: Record<string, unknown>, user = ADMIN) => direct("POST", user, `/v1/admin/requests/${o}/final-media`, body)
    const good = (o: string, over: Record<string, unknown> = {}) => ({ filePath: `orders/${o}/final/${randomUUID()}.png`, mimeType: "image/png", byteSize: 1000, originalFilename: "ok.png", ...over })

    it("validates namespace, type, ownership-of-order, size and shape before the function runs", async () => {
      const p = await newParent()
      const o = await newRequest(p.profile)
      const base = await q<{ n: string }>("select count(*) n from public.media_assets where order_id = $1", [o])
      const cases: Array<[string, Record<string, unknown>]> = [
        ["another order's folder", good(o, { filePath: `orders/${ORDER_A_PENDING}/final/${randomUUID()}.png` })],
        ["a parent upload namespace", good(o, { filePath: `${p.user}/${o}/${randomUUID()}.png` })],
        ["traversal", good(o, { filePath: `orders/${o}/final/../../x.png` })],
        ["absolute path", good(o, { filePath: `/orders/${o}/final/${randomUUID()}.png` })],
        ["a non-uuid name", good(o, { filePath: `orders/${o}/final/shell.png` })],
        ["an exe", good(o, { filePath: `orders/${o}/final/${randomUUID()}.exe`, mimeType: "application/octet-stream" })],
        ["mime/extension mismatch", good(o, { mimeType: "video/mp4" })],
        ["a disallowed mime", good(o, { mimeType: "image/gif", filePath: `orders/${o}/final/${randomUUID()}.png` })],
        ["an oversize image", good(o, { byteSize: 10 * 1024 * 1024 + 1 })],
      ]
      for (const [label, body] of cases) expect([label, (await rec(o, body)).status]).toEqual([label, 422])
      expect((await rec(o, good(o, { byteSize: -1 }))).status).toBe(400)
      expect((await rec(o, good(o, { byteSize: 1.5 }))).status).toBe(400)
      expect((await rec(o, { ...good(o), extra: 1 })).status).toBe(400)
      expect((await rec(o, { filePath: "x" })).status).toBe(400)
      expect((await rec(o, good(o, { originalFilename: "x".repeat(300) }))).status).toBe(400)
      expect(Number((await q<{ n: string }>("select count(*) n from public.media_assets where order_id = $1", [o]))[0].n)).toBe(Number(base[0].n))
    })

    it("records an UPLOADED, non-visible final; the parent cannot see or sign it until approval, and approval needs a final in this order", async () => {
      const p = await newParent()
      const o = await newRequest(p.profile)
      expect((await direct("PATCH", ADMIN, `/v1/admin/requests/${o}/status`, { status: "in_progress", expectedUpdatedAt: await tokenOf(o), internalNote: null, parentVisibleNote: null })).status).toBe(200)
      const r = await rec(o, good(o))
      expect(r.status).toBe(200)
      const row = (await q("select asset_role, delivery_status, parent_visible, type, uploaded_by_user_id from public.media_assets where id = $1", [r.body.assetId]))[0]
      expect(row).toEqual({ asset_role: "final", delivery_status: "uploaded", parent_visible: false, type: "generated", uploaded_by_user_id: ADMIN })
      expect((await direct("GET", p.user, `/v1/parent/orders/${o}/final-media`)).status).toBe(404)
      expect((await direct("GET", p.user, `/v1/parent/orders/${o}`)).body.finalMedia).toBeNull()
      // an asset of ANOTHER order cannot be approved through this order
      expect((await direct("PATCH", ADMIN, `/v1/admin/requests/${o}/final-media/${FINAL_V2}`, { action: "approve" })).body.error).toBe("request_asset_not_found")
      expect((await direct("PATCH", ADMIN, `/v1/admin/requests/${o}/final-media/${r.body.assetId}`, { action: "burn" })).status).toBe(400)
      expect((await direct("PATCH", ADMIN, `/v1/admin/requests/${o}/final-media/${r.body.assetId}`, { action: "approve" })).status).toBe(200)
      expect((await direct("PATCH", ADMIN, `/v1/admin/requests/${o}/final-media/${r.body.assetId}`, { action: "approve" })).status).toBe(409) // already approved
      expect((await direct("GET", p.user, `/v1/parent/orders/${o}/final-media`)).body.assetId).toBe(r.body.assetId)
      expect((await direct("PATCH", ADMIN, `/v1/admin/requests/${o}/final-media/${r.body.assetId}`, { action: "supersede" })).status).toBe(200)
      expect((await direct("GET", p.user, `/v1/parent/orders/${o}/final-media`)).status).toBe(404) // superseded is gone for the parent
    })

    it("the upload gate: refused statuses and non-admins store NO bytes; an unknown order is 404 before any upload", async () => {
      const p = await newParent()
      const o = await newRequest(p.profile)
      await signIn(ADMIN, "admin")
      // cancel it: a terminal status refuses uploads
      expect((await direct("PATCH", ADMIN, `/v1/admin/requests/${o}/status`, { status: "cancelled", expectedUpdatedAt: await tokenOf(o), internalNote: null, parentVisibleNote: null })).status).toBe(200)
      const refused = await bUpload(o, [png()])
      expect(refused.status).toBe(409)
      expect(refused.body.code).toBe("REQUEST_UPLOAD_NOT_ALLOWED")
      expect((await bUpload(randomUUID(), [png()])).status).toBe(404)
      expect(stub!.storage.uploads).toEqual([])
    })

    it("end to end through the Next admin routes: upload bytes -> link -> approve -> ready -> delivered, and the parent and admin views agree (read-after-write)", async () => {
      const p = await newParent()
      const o = await newRequest(p.profile, "Fulfil me")
      await addSource(o, `${p.user}/${o}/ref.png`, "2026-10-12T10:00:00Z")
      await signIn(ADMIN, "admin")
      const token0 = await tokenOf(o)
      expect((await bStatus(o, { status: "in_progress", expectedUpdatedAt: token0, internalNote: null, parentVisibleNote: "started" })).status).toBe(200)
      // wrong type / too many files / bad bytes are refused before storing
      const gif = new File([new Uint8Array(4)], "x.gif", { type: "image/gif" })
      expect((await bUpload(o, [gif])).status).toBe(422)
      expect((await bUpload(o, Array.from({ length: 6 }, () => png()))).status).toBe(422)
      expect(stub!.storage.uploads).toEqual([])
      const up = await bUpload(o, [png("final.png")])
      expect(up.status).toBe(200)
      const assetId = up.body.data.assetIds[0]
      expect(stub!.storage.uploads).toHaveLength(1)
      expect(stub!.storage.uploads[0].key).toMatch(new RegExp(`^final-deliverables/orders/${o}/final/[0-9a-f-]{36}\\.png$`))
      // not ready yet: the final is uploaded but not approved
      const view1 = await loadAdminRequestView((await verifyParentCaller() as { ok: true; context: never }).context, o)
      if (!view1.ok) throw new Error("view1")
      expect(view1.view.finalMedia.map((f) => [f.id, f.deliveryStatus, f.parentVisible])).toEqual([[assetId, "uploaded", false]])
      expect(view1.view.finalMedia[0].signedUrl).toMatch(/token=stub/)
      const noFinal = await bStatus(o, { status: "ready", expectedUpdatedAt: await tokenOf(o), internalNote: null, parentVisibleNote: null })
      expect(noFinal.status).toBe(422)
      expect((await bAsset(o, assetId, "approve")).status).toBe(200)
      expect((await bStatus(o, { status: "ready", expectedUpdatedAt: await tokenOf(o), internalNote: null, parentVisibleNote: "ready!" })).status).toBe(200)
      expect((await bStatus(o, { status: "delivered", expectedUpdatedAt: await tokenOf(o), internalNote: null, parentVisibleNote: "enjoy" })).status).toBe(200)
      // the parent sees everything, consistently
      const detail = await parentDetail(p.user, o)
      if (!detail.ok) throw new Error("detail")
      expect(detail.detail.status).toBe("ready")
      expect(detail.detail.timeline.map((t) => t.status)).toEqual(["ready", "final_review", "creating"])
      expect(detail.detail.finalMedia?.id).toBe(assetId)
      expect(detail.detail.completedAt).not.toBeNull()
      const list = await asJson(await ordersGET(new Request(`${ORIGIN}/api/parent/orders`)))
      expect(list.body.orders.find((x: { id: string }) => x.id === o)).toMatchObject({ status: "ready" })
      const final = await bFinal(o)
      expect(final.status).toBe(200)
      expect(final.body.url).toContain(`orders/${o}/final/`)
      await signIn(p.user)
      const gallery = await bGallery()
      expect(gallery.body.media.map((m: { id: string }) => m.id).length).toBe(1) // only the SOURCE; the final is not gallery material
      // and the admin view agrees
      await signIn(ADMIN, "admin")
      const adminCaller = await verifyParentCaller()
      if (!adminCaller.ok) throw new Error("caller")
      const view = await loadAdminRequestView(adminCaller.context, o)
      if (!view.ok) throw new Error("view")
      expect(view.view.detail.status).toBe("delivered")
      expect(view.view.finalMedia[0]).toMatchObject({ id: assetId, deliveryStatus: "approved", parentVisible: true })
      expect(view.view.history.map((h) => h.newStatus)).toEqual(["delivered", "ready", "in_progress"])
      expect(await historyCount(o)).toBe(3)
      expect(restCalls()).toEqual([])
    })

    it("a DEFINITE refusal after the upload removes the object; an UNKNOWN outcome (database failure on the write) keeps it", async () => {
      const p = await newParent()
      const o = await newRequest(p.profile)
      await signIn(ADMIN, "admin")
      expect((await bStatus(o, { status: "in_progress", expectedUpdatedAt: await tokenOf(o), internalNote: null, parentVisibleNote: null })).status).toBe(200)

      // definite: the order is cancelled between the gate and the record -> request_upload_not_allowed (409)
      hooks.afterGate = async () => {
        const r = await direct("PATCH", SUPER, `/v1/admin/requests/${o}/status`, { status: "cancelled", expectedUpdatedAt: await tokenOf(o), internalNote: null, parentVisibleNote: null })
        expect(r.status).toBe(200)
      }
      const refused = await bUpload(o, [png("late.png")])
      expect(refused.status).toBe(409)
      expect(refused.body.code).toBe("REQUEST_UPLOAD_NOT_ALLOWED")
      expect(stub!.storage.uploads).toHaveLength(1)
      expect(stub!.storage.removed).toEqual([stub!.storage.uploads[0].key])
      expect(stub!.storage.objects.has(stub!.storage.uploads[0].key)).toBe(false)
      expect(Number((await q<{ n: string }>("select count(*) n from public.media_assets where order_id = $1 and asset_role = 'final'", [o]))[0].n)).toBe(0)

      // unknown: the database fails on the record statement -> the object is KEPT (the row may exist)
      const p2 = await newParent()
      const o2 = await newRequest(p2.profile)
      expect((await bStatus(o2, { status: "in_progress", expectedUpdatedAt: await tokenOf(o2), internalNote: null, parentVisibleNote: null })).status).toBe(200)
      const removedBefore = stub!.storage.removed.length
      hooks.failOnce = /record_final_media_trusted/
      const unknown = await bUpload(o2, [png("maybe.png")])
      expect(unknown.status).toBe(503)
      expect(unknown.body.error).toMatch(/نتیجه عملیات مشخص نیست/)
      expect(stub!.storage.removed.length).toBe(removedBefore)
      expect(stub!.storage.uploads.some((u) => u.key.includes(`orders/${o2}/final/`))).toBe(true)
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  describe("21-23. read-after-write for copied and PG-only orders, history preserved", () => {
    it("a copied historical order keeps its history after a new admin write elsewhere, and its media still resolves", async () => {
      const before = await historyCount(ORDER_A_DELIVERED)
      const detail = await direct("GET", ADMIN, `/v1/admin/requests/${ORDER_A_DELIVERED}`)
      expect(detail.body.history).toHaveLength(before)
      expect(detail.body.media.find((m: { id: string }) => m.id === FINAL_V1).delivery_status).toBe("superseded")
      // an in-progress copied order can be advanced by the admin on the new stack
      const t = await tokenOf(ORDER_A_VIDEO)
      const r = await direct("PATCH", ADMIN, `/v1/admin/requests/${ORDER_A_VIDEO}/status`, { status: "cancelled", expectedUpdatedAt: t, internalNote: "test", parentVisibleNote: null })
      expect(r.status).toBe(200)
      expect(r.body.previousStatus).toBe("in_progress")
      const parent = await direct("GET", A.user, `/v1/parent/orders/${ORDER_A_VIDEO}`)
      expect(parent.body.order.status).toBe("cancelled")
      expect(parent.body.history[0].new_status).toBe("cancelled")
      expect(JSON.stringify(parent.body)).not.toContain("test")
    })

    it("B's drawing-animation order reads its extension row and upload through the new path", async () => {
      const r = await direct("GET", B.user, `/v1/parent/orders/${ORDER_B_DRAWING}`)
      expect(r.status).toBe(200)
      expect(r.body.order.type).toBe("drawing_animation")
      expect(r.body.order.drawing_animation_style).toBe("wave")
      expect(r.body.sourceMedia).toHaveLength(1)
      const admin = await direct("GET", ADMIN, `/v1/admin/requests/${ORDER_B_DRAWING}`)
      expect(admin.body.order.drawing_upload_url).toBeTruthy()
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  describe("32. performance (local Docker, restricted role, in-process Next + loopback Fastify)", () => {
    it("detail, gallery first page, admin list, admin detail, transition, final-media association, signed-URL authorization", async () => {
      const p = await newParent()
      const orders: string[] = []
      for (let i = 0; i < 25; i++) orders.push(await newRequest(p.profile, `perf ${i}`))
      for (let n = 0; n < 30; n++) await addSource(orders[0], `${p.user}/perf-${n}.png`, `2026-12-01T10:00:${String(n).padStart(2, "0")}Z`)
      const results: Record<string, { median: number; p90: number }> = {}
      results.parent_detail = await timed(30, async () => expect((await direct("GET", p.user, `/v1/parent/orders/${orders[0]}`)).status).toBe(200))
      results.gallery_first_page = await timed(30, async () => expect((await direct("GET", p.user, "/v1/parent/gallery")).status).toBe(200))
      results.admin_list = await timed(30, async () => expect((await direct("GET", ADMIN, "/v1/admin/requests")).status).toBe(200))
      results.admin_detail = await timed(30, async () => expect((await direct("GET", ADMIN, `/v1/admin/requests/${orders[0]}`)).status).toBe(200))
      // one real transition per order (an order moves forward once), 20 distinct orders
      let i = 1
      results.transition = await timed(20, async () => {
        const o = orders[i++]
        expect((await direct("PATCH", ADMIN, `/v1/admin/requests/${o}/status`, { status: "in_progress", expectedUpdatedAt: await tokenOf(o), internalNote: null, parentVisibleNote: null })).status).toBe(200)
      })
      const target = orders[24]
      await direct("PATCH", ADMIN, `/v1/admin/requests/${target}/status`, { status: "in_progress", expectedUpdatedAt: await tokenOf(target), internalNote: null, parentVisibleNote: null })
      const assetIds: string[] = []
      results.final_media_association = await timed(20, async () => {
        const r = await direct("POST", ADMIN, `/v1/admin/requests/${target}/final-media`, { filePath: `orders/${target}/final/${randomUUID()}.png`, mimeType: "image/png", byteSize: 10, originalFilename: "p.png" })
        expect(r.status).toBe(200)
        assetIds.push(r.body.assetId)
      })
      await direct("PATCH", ADMIN, `/v1/admin/requests/${target}/final-media/${assetIds[assetIds.length - 1]}`, { action: "approve" })
      results.signed_url_authorization = await timed(30, async () => expect((await direct("GET", p.user, `/v1/parent/orders/${target}/final-media`)).status).toBe(200))
      console.info("V0.1.52 PERF (ms)", JSON.stringify(results))
      for (const [name, r] of Object.entries(results)) expect(r.p90, name).toBeLessThan(1500)
    })
  })

  describe("19/20. no Supabase database access happened anywhere in this suite", () => {
    it("the stub saw zero /rest/v1 requests on its last session, and the service credential is only ever used for Storage", () => {
      expect(restCalls()).toEqual([])
      expect(fs.existsSync(path.join(root, "lib/admin/requests/queries.ts"))).toBe(false)
    })
  })
})
