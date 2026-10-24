import { describe, it, expect, beforeAll, afterAll, vi } from "vitest"
import { randomBytes, randomUUID } from "node:crypto"
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
import { POST as requestsPOST } from "@/app/api/requests/route"
import { GET as byKeyGET } from "@/app/api/requests/by-submission-key/route"
import { POST as setupPOST } from "@/app/api/parent/account-setup/route"
import { POST as consentPOST } from "@/app/api/parent-consent/route"
import { GET as ordersGET } from "@/app/api/parent/orders/route"
import { GET as summaryGET } from "@/app/api/parent/account-summary/route"
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
 * V0.1.50 request submission cutover, end to end on REAL local services
 * (opt-in: CARTOONA_PLAIN_PG=docker):
 *
 *   Supabase-shaped source -> V0.1.44 copy -> plain PostgreSQL 17 (0001-0016),
 *   V0.1.49-provisioned parents on top,
 *   stub Supabase Auth + in-memory stub Storage (real @supabase/ssr and
 *   storage-js) -> Next POST /api/requests (CSRF, upload, v3) -> Fastify
 *   (listening, RESTRICTED login role) -> create_parent_request_trusted().
 *
 * Financial invariants are asserted in the database itself, never on mocks.
 * Nothing contacts Supabase or any hosted service.
 */

const enabled = process.env.CARTOONA_PLAIN_PG === "docker"
const id = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`
const SRC = `rqs_${id}`
const TGT = `rqt_${id}`
const ROLE = `cartoona_app_rq${id}`
const DB_PASSWORD = randomBytes(24).toString("hex")
const AUTH_SECRET = randomBytes(32).toString("hex")
const ORIGIN = "http://localhost:3000"
const PATH = "/v1/parent/requests"
const BY_KEY = "/v1/parent/requests/by-submission-key"

// Catalog costs (0008 seed): image 12 (+3 with a reference file), video.short 40, drawing.short 35.
const IMAGE = 12
const IMAGE_FILE = 15
const VIDEO = 40
const VIDEO_FILE = 45 // + video.reference_file (5)
const DRAWING = 35

const COPIED_A = { user: "a1000000-0000-4000-8000-000000000001", profile: "b1000000-0000-4000-8000-000000000001" }
const ADMIN = "a1000000-0000-4000-8000-000000000003"

let env: PgEnv
let backend: FastifyInstance | null = null
let backendUrl = ""
let stub: StubAuth | null = null
let appPool: Pool
let owner: Pool

/** Failure injection for the ONE listening backend; reset by every test that sets it. */
const fault = { delayBeforeMs: 0, delayAfterMs: 0, down: false, writes: 0, stallAfterWrite: 0, stallAll: 0 }

function faultyDb(): () => Queryable {
  return () => ({
    query: async (text: string, values?: readonly unknown[]) => {
      if (fault.down) throw Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5433"), { code: "ECONNREFUSED" })
      if (fault.stallAll) await new Promise((r) => setTimeout(r, fault.stallAll))
      const isWrite = text.includes("create_parent_request_trusted")
      if (isWrite && fault.delayBeforeMs) await new Promise((r) => setTimeout(r, fault.delayBeforeMs))
      const result = await getPool().query(text, values as unknown[])
      if (isWrite) {
        fault.writes += 1
        // From now on every query stalls: the recovery lookup cannot be answered in time either.
        if (fault.stallAfterWrite) fault.stallAll = fault.stallAfterWrite
        // Autocommit: the transaction has COMMITTED; only the response is late.
        if (fault.delayAfterMs) await new Promise((r) => setTimeout(r, fault.delayAfterMs))
      }
      return result
    },
  }) as Queryable
}

async function startBackend(db: () => Queryable): Promise<{ app: FastifyInstance; url: string }> {
  const app = buildBackendApp({ db, closeDb: async () => {} })
  await app.listen({ host: "127.0.0.1", port: 0 })
  return { app, url: `http://127.0.0.1:${(app.server.address() as net.AddressInfo).port}` }
}

const ident = (subject: string) => toVerifiedIdentity({ provider: "supabase", subject })
const secret = () => Buffer.from(AUTH_SECRET, "hex")
const signRead = (user: string, p = BY_KEY) =>
  signAssertion({ identity: ident(user), authenticatedAt: Date.now() - DAY_MS, requestId: "rq-read-000001", method: "GET", path: p, secret: secret() })
const signWrite = (user: string, body: string, over: { path?: string; method?: string } = {}) =>
  signWriteAssertion({ identity: ident(user), authenticatedAt: Date.now() - DAY_MS, requestId: `rq-w-${randomBytes(4).toString("hex")}`, method: over.method ?? "POST", path: over.path ?? PATH, body, secret: secret() })

/** One direct POST /v1/parent/requests with a FRESH assertion (new nonce) each call. */
async function create(user: string, body: unknown, extraHeaders: Record<string, string> = {}) {
  const raw = typeof body === "string" ? body : JSON.stringify(body)
  const res = await fetch(`${backendUrl}${PATH}`, {
    method: "POST",
    body: raw,
    headers: { "content-type": "application/json", "x-cartoona-internal-auth": signWrite(user, raw), ...extraHeaders },
  })
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}
async function lookup(user: string, key: string) {
  const res = await fetch(`${backendUrl}${BY_KEY}?submissionKey=${key}`, { headers: { "x-cartoona-internal-auth": signRead(user) } })
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

// ── request bodies (what the Next BFF sends) ─────────────────────────────────
const file = (user: string, orderId: string, name = "ref.png") => ({ path: `${user}/${orderId}/${name}`, mimeType: "image/png", originalFilename: name })
function imageBody(user: string, over: Record<string, unknown> = {}, withFile = false) {
  const orderId = randomUUID()
  return {
    submissionKey: randomUUID(), orderId, type: "image", title: null, description: "a scene", character: "Captain Candy",
    durationKey: null, durationChoice: null, videoScript: null, videoStyle: null, animationStyle: null, charactersSpeak: null,
    childName: "Sara", file: withFile ? file(user, orderId) : null, ...over,
  }
}
function videoBody(user: string, over: Record<string, unknown> = {}) {
  return { ...imageBody(user), type: "video", character: "Dino Dodo", durationKey: "short", durationChoice: "5_10", videoScript: "once upon a time", charactersSpeak: true, ...over }
}
function drawingBody(user: string, over: Record<string, unknown> = {}) {
  const orderId = randomUUID()
  return {
    ...imageBody(user), orderId, type: "drawing_animation", title: "my drawing", character: null, durationKey: "short",
    animationStyle: "wave", childName: null, file: file(user, orderId, "draw.png"), ...over,
  }
}

// ── database facts (owner connection; the app role cannot read these directly) ──
async function newParent(opts: { balance?: number; credits?: number; consent?: boolean } = {}) {
  const user = randomUUID()
  expect((await appPool.query("select public.provision_supabase_parent_identity($1) as o", [user])).rows[0].o).toBe("created")
  const profile = (await owner.query("select id from public.parent_profiles where user_id = $1", [user])).rows[0].id as string
  await setState(profile, opts)
  return { user, profile }
}
/** granted_count must be > 0 (CHECK), so "no credits left" is granted 1 / used 1; facts().used reports usage on top of that. */
const usedBase = new Map<string, number>()
async function setState(profile: string, opts: { balance?: number; credits?: number; consent?: boolean } = {}) {
  const credits = opts.credits ?? 3
  usedBase.set(profile, credits === 0 ? 1 : 0)
  await owner.query("update public.candy_wallets set balance = $2 where parent_id = $1", [profile, opts.balance ?? 100])
  await owner.query("update public.parent_welcome_credits set granted_count = $2, used_count = $3 where parent_id = $1", [profile, credits === 0 ? 1 : credits, credits === 0 ? 1 : 0])
  await owner.query("delete from public.parent_welcome_credit_usages where parent_id = $1", [profile]).catch(() => undefined)
  if (opts.consent !== false) await owner.query("update public.parent_profiles set consent_granted = true, consent_granted_at = now() where id = $1", [profile])
}
async function facts(profile: string) {
  const one = async (sql: string) => Number((await owner.query(sql, [profile])).rows[0].n)
  return {
    orders: await one("select count(*) n from public.orders where parent_id = $1"),
    balance: await one("select balance n from public.candy_wallets where parent_id = $1"),
    ledger: await one("select count(*) n from public.candy_transactions t join public.candy_wallets w on w.id = t.wallet_id where w.parent_id = $1 and t.type = 'order_debit'"),
    ledgerSum: await one("select coalesce(sum(t.amount), 0) n from public.candy_transactions t join public.candy_wallets w on w.id = t.wallet_id where w.parent_id = $1 and t.type = 'order_debit'"),
    used: (await one("select used_count n from public.parent_welcome_credits where parent_id = $1")) - (usedBase.get(profile) ?? 0),
    usages: await one("select count(*) n from public.parent_welcome_credit_usages where parent_id = $1"),
    media: await one("select count(*) n from public.media_assets m join public.orders o on o.id = m.order_id where o.parent_id = $1"),
    video: await one("select count(*) n from public.video_requests v join public.orders o on o.id = v.order_id where o.parent_id = $1"),
    drawing: await one("select count(*) n from public.drawing_animation_requests v join public.orders o on o.id = v.order_id where o.parent_id = $1"),
  }
}
/** Balance reconciliation: start - balance == the candy actually charged on this parent's candy-paid orders == ledger debits. */
async function reconciles(profile: string, start: number) {
  const f = await facts(profile)
  const charged = Number((await owner.query("select coalesce(sum(candy_cost),0) n from public.orders where parent_id = $1 and payment_source = 'candy'", [profile])).rows[0].n)
  expect(start - f.balance).toBe(charged)
  expect(-f.ledgerSum + 0).toBe(charged)
  expect(f.balance).toBeGreaterThanOrEqual(0)
  const creditOrders = Number((await owner.query("select count(*) n from public.orders where parent_id = $1 and payment_source = 'welcome_image_credit'", [profile])).rows[0].n)
  expect(f.used).toBe(creditOrders)
  expect(f.usages).toBe(creditOrders)
}

// ── Next harness ─────────────────────────────────────────────────────────────
async function signIn(userId: string, opts: { authenticatedAt?: number } = {}) {
  await stub?.close()
  stub = await startStubAuth({ userId, role: "parent" })
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", stub.url)
  cookies.jar = cookieJar([stub.cookie({ authenticatedAt: opts.authenticatedAt })])
}
const png = (name = "photo.png") => new File([new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4])], name, { type: "image/png" })
const imageDraft = (over: Record<string, unknown> = {}) => ({
  version: 1, type: "image", createdAt: "2026-10-24T00:00:00.000Z", estimatedCandyCost: IMAGE, selectedCharacterId: "Captain Candy",
  sceneDescription: "a scene", style: "", occasion: "", parentNote: "", referenceFileName: "", childName: "Sara", ...over,
})
const videoDraft = () => ({
  version: 1, type: "video", createdAt: "2026-10-24T00:00:00.000Z", estimatedCandyCost: VIDEO, selectedCharacterId: "Dino Dodo",
  storyDescription: "a story", duration: "5_10", charactersSpeak: false, occasion: "", parentNote: "", referenceFileName: "", childName: null,
})
const drawingDraft = () => ({
  version: 1, type: "drawing", createdAt: "2026-10-24T00:00:00.000Z", estimatedCandyCost: DRAWING, drawingFileName: "draw.png", title: "drawing",
  movementType: "wave", animationDescription: "", backgroundScene: "", duration: "کوتاه", parentNote: "",
})
function browserForm(draft: unknown, key: string, extra: { file?: File | null; sourceAssetId?: string } = {}) {
  const fd = new FormData()
  fd.set("draft", JSON.stringify(draft))
  fd.set("submissionKey", key)
  if (extra.file) fd.set("file", extra.file)
  if (extra.sourceAssetId) fd.set("sourceAssetId", extra.sourceAssetId)
  return fd
}
async function browserSubmit(fd: FormData, headers: Record<string, string> = { origin: ORIGIN, "sec-fetch-site": "same-origin" }) {
  setRateLimitStore(new InMemoryRateLimitStore())
  const res = await requestsPOST(new Request(`${ORIGIN}/api/requests`, { method: "POST", body: fd, headers }))
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}
async function browserByKey(key: string) {
  const res = await byKeyGET(new Request(`${ORIGIN}/api/requests/by-submission-key?submissionKey=${key}`))
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}
async function withBackendEnv<T>(url: string, timeoutMs: string, work: () => Promise<T>): Promise<T> {
  vi.stubEnv("BACKEND_INTERNAL_URL", url)
  vi.stubEnv("BACKEND_REQUEST_TIMEOUT_MS", timeoutMs)
  try {
    return await work()
  } finally {
    vi.stubEnv("BACKEND_INTERNAL_URL", backendUrl)
    vi.stubEnv("BACKEND_REQUEST_TIMEOUT_MS", "3000")
  }
}
const supabaseDbCalls = () => (stub?.requests ?? []).filter((r) => r.path.startsWith("/rest/v1/"))
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))]
async function sqlState(work: Promise<unknown>): Promise<string | undefined> {
  const e = await work.then(() => null, (x: unknown) => x)
  return (e as { code?: string } | null)?.code
}

describe.skipIf(!enabled)("V0.1.50 request submission cutover (local Docker PostgreSQL 17)", () => {
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
    vi.stubEnv("DATABASE_URL", roleUrl)
    vi.stubEnv("CARTOONA_INTERNAL_AUTH_SECRET", AUTH_SECRET)
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-key")
    vi.stubEnv("BACKEND_REQUEST_TIMEOUT_MS", "3000")
    ;({ app: backend, url: backendUrl } = await startBackend(faultyDb()))
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
  describe("5/6. privileges: EXECUTE on the request function and no direct financial write", () => {
    it.each([
      ["INSERT orders", `insert into public.orders (parent_id, type, status, candy_cost) values ('${COPIED_A.profile}', 'image', 'pending_review', 0)`],
      ["INSERT video_requests", `insert into public.video_requests (order_id, script) values ('${randomUUID()}', 'x')`],
      ["INSERT drawing_animation_requests", `insert into public.drawing_animation_requests (order_id, upload_url, animation_style) values ('${randomUUID()}', 'p', 'x')`],
      ["INSERT media_assets", `insert into public.media_assets (order_id, type, file_url, mime_type) values ('${randomUUID()}', 'upload', 'p', 'image/png')`],
      ["UPDATE candy_wallets", `update public.candy_wallets set balance = balance + 1000`],
      ["INSERT candy_transactions", `insert into public.candy_transactions (wallet_id, amount, type, idempotency_key) values ('${randomUUID()}', 5, 'grant', 'k')`],
      ["INSERT parent_welcome_credit_usages", `insert into public.parent_welcome_credit_usages (parent_id, order_id) values ('${COPIED_A.profile}', '${randomUUID()}')`],
      ["UPDATE parent_welcome_credits (granted)", `update public.parent_welcome_credits set granted_count = 99`],
      ["UPDATE parent_welcome_credits (used)", `update public.parent_welcome_credits set used_count = 0`],
      ["UPDATE orders.status", `update public.orders set status = 'delivered'`],
      ["INSERT order_status_history", `insert into public.order_status_history (order_id, new_status) values ('${randomUUID()}', 'x')`],
      ["INSERT characters", `insert into public.characters (name) values ('x')`],
      ["UPDATE creation_pricing", `update public.creation_pricing set candy_cost = 1`],
      ["EXECUTE complete_candy_purchase_trusted", `select * from public.complete_candy_purchase_trusted('${randomUUID()}', '${COPIED_A.profile}', 'ref')`],
      ["EXECUTE update_order_status_trusted", `select * from public.update_order_status_trusted('${randomUUID()}', '${ADMIN}', 'delivered', now(), null, null)`],
      ["EXECUTE record_final_media_trusted", `select * from public.record_final_media_trusted('${ADMIN}', '${randomUUID()}', 'p', 'video/mp4', 1, 'f')`],
      ["EXECUTE create_payment_attempt_trusted", `select * from public.create_payment_attempt_trusted('${randomUUID()}', '${COPIED_A.profile}', 'p', now(), 'k')`],
    ])("the app role cannot %s -> 42501", async (_label, sql) => {
      expect(await sqlState(appPool.query(sql))).toBe("42501")
    })

    it("it CAN execute the request function and read characters/pricing/profile/orders; PUBLIC cannot execute it", async () => {
      expect((await owner.query(`select has_function_privilege($1, p.oid, 'execute') as app, has_function_privilege('public', p.oid, 'execute') as pub, p.prosecdef as def
        from pg_proc p where p.proname = 'create_parent_request_trusted'`, [ROLE])).rows[0]).toEqual({ app: true, pub: false, def: true })
      for (const t of ["characters", "creation_pricing", "parent_profiles", "orders", "candy_wallets", "parent_welcome_credits"]) {
        expect(await sqlState(appPool.query(`select 1 from public.${t} limit 1`)), t).toBeUndefined()
      }
    })

    it("the request function is the only financial EXECUTE the role holds beyond nonce + consent + provisioning", async () => {
      const rows = (await owner.query(`select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and has_function_privilege($1, p.oid, 'execute') and p.prosecdef order by 1`, [ROLE])).rows.map((r) => r.proname)
      expect(rows).toEqual(["consume_internal_write_nonce", "create_parent_request_trusted", "provision_supabase_parent_identity", "record_parent_consent_trusted"].sort())
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  describe("7/8/19. the Fastify route: auth, strict body, no caller-supplied identity", () => {
    it("requires a v3 write assertion: none, a v2 read assertion, a wrong path and a tampered body are all refused and create nothing", async () => {
      const p = await newParent()
      const body = imageBody(p.user)
      const raw = JSON.stringify(body)
      const post = (token: string | undefined, b = raw) => fetch(`${backendUrl}${PATH}`, { method: "POST", body: b, headers: { "content-type": "application/json", ...(token ? { "x-cartoona-internal-auth": token } : {}) } })
      expect((await post(undefined)).status).toBe(401)
      expect((await post(signRead(p.user, PATH))).status).toBe(401)
      expect((await post(signWrite(p.user, raw, { path: "/v1/parent/consent" }))).status).toBe(401)
      expect((await post(signWrite(p.user, raw), JSON.stringify({ ...body, description: "tampered" }))).status).toBe(401)
      expect((await facts(p.profile)).orders).toBe(0)
    })

    it("parent only: an admin and an unlinked subject are refused", async () => {
      expect((await create(ADMIN, imageBody(ADMIN))).status).toBe(403)
      expect((await create(randomUUID(), imageBody(randomUUID()))).status).toBe(403)
    })

    it("the body has EXACT keys; no actor, profile, wallet, price, status, balance or role can be supplied", async () => {
      const p = await newParent()
      for (const extra of [
        { parentProfileId: p.profile }, { userId: p.user }, { role: "admin" }, { walletId: randomUUID() }, { candyCost: 0 }, { price: 0 },
        { paymentSource: "welcome_image_credit" }, { status: "delivered" }, { balance: 1000 }, { creditAmount: 99 }, { parent_id: p.profile },
      ]) {
        const r = await create(p.user, { ...imageBody(p.user), ...extra })
        expect(r.status, JSON.stringify(extra)).toBe(400)
        expect(r.body).toEqual({ error: "invalid_request" })
      }
      const { submissionKey, ...missing } = imageBody(p.user)
      void submissionKey
      expect((await create(p.user, missing)).status).toBe(400)
      expect((await create(p.user, { ...imageBody(p.user), submissionKey: "not-a-uuid" })).status).toBe(400)
      expect((await create(p.user, { ...imageBody(p.user), type: "audio" })).status).toBe(400)
      expect((await create(p.user, { ...imageBody(p.user), charactersSpeak: "yes" })).status).toBe(400)
      expect((await create(p.user, "[]")).status).toBe(400)
      expect((await facts(p.profile)).orders).toBe(0)
    })

    it("a file key outside the caller's own <user>/<order>/ folder is refused (another parent's folder, another order, traversal)", async () => {
      const p = await newParent()
      const other = await newParent()
      const b = imageBody(p.user, {}, true)
      expect((await create(p.user, { ...b, file: { ...(b.file as object), path: `${other.user}/${b.orderId}/ref.png` } })).status).toBe(400)
      expect((await create(p.user, { ...b, file: { ...(b.file as object), path: `${p.user}/${randomUUID()}/ref.png` } })).status).toBe(400)
      expect((await create(p.user, { ...b, file: { ...(b.file as object), extra: 1 } })).status).toBe(400)
      expect((await facts(p.profile)).orders).toBe(0)
    })

    it("X-User-Id / X-Role / X-Parent-Profile-Id headers are ignored: identity is the assertion only", async () => {
      const a = await newParent()
      const b = await newParent()
      const r = await create(a.user, imageBody(a.user), { "x-user-id": b.user, "x-role": "admin", "x-parent-profile-id": b.profile })
      expect(r.status).toBe(200)
      expect((await facts(a.profile)).orders).toBe(1)
      expect((await facts(b.profile)).orders).toBe(0)
    })

    it("a query string on POST is refused; responses are no-store and carry no profile/wallet/path data", async () => {
      const p = await newParent()
      const raw = JSON.stringify(imageBody(p.user))
      const q = await fetch(`${backendUrl}${PATH}?parentProfileId=${p.profile}`, { method: "POST", body: raw, headers: { "content-type": "application/json", "x-cartoona-internal-auth": signWrite(p.user, raw) } })
      expect(q.status).toBe(400)
      const ok = await fetch(`${backendUrl}${PATH}`, { method: "POST", body: raw, headers: { "content-type": "application/json", "x-cartoona-internal-auth": signWrite(p.user, raw) } })
      expect(ok.headers.get("cache-control")).toBe("no-store")
      expect(Object.keys(await ok.json()).sort()).toEqual(["candyCost", "orderId", "paymentSource", "replayed", "status", "type"])
    })

    it("a long Persian draft (description + story near the 5000-char cap) fits the route's body limit", async () => {
      const p = await newParent()
      const persian = "داستان ".repeat(700).slice(0, 4900)
      const r = await create(p.user, videoBody(p.user, { description: persian, videoScript: persian }))
      expect(r.status).toBe(200)
      expect(JSON.stringify(videoBody(p.user, { description: persian, videoScript: persian })).length).toBeGreaterThan(9_000)
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  describe("13/15. each request type: rows, cost, source, relationships", () => {
    it("image without a file: credit-funded, cost 0, one order, no media row, no ledger row, no balance change", async () => {
      const p = await newParent()
      const b = imageBody(p.user)
      const r = await create(p.user, b)
      expect(r).toMatchObject({ status: 200, body: { type: "image", status: "pending_review", candyCost: 0, replayed: false, paymentSource: "welcome_image_credit" } })
      expect(r.body.orderId).toBe(b.orderId)
      expect(await facts(p.profile)).toMatchObject({ orders: 1, balance: 100, ledger: 0, used: 1, usages: 1, media: 0, video: 0, drawing: 0 })
      const o = (await owner.query("select * from public.orders where id = $1", [b.orderId])).rows[0]
      expect(o).toMatchObject({ parent_id: p.profile, type: "image", status: "pending_review", child_name: "Sara", submission_key: b.submissionKey, payment_source: "welcome_image_credit", candy_cost: 0 })
      expect(o.character_id).toBe((await owner.query("select id from public.characters where name = 'Captain Candy'")).rows[0].id)
      expect(o.title).toBeNull()
      await reconciles(p.profile, 100)
    })

    it("image WITH a reference file (credits exhausted): candy 15, media row linked to the order with the verified MIME and the parent's file name", async () => {
      const p = await newParent({ credits: 0 })
      const b = imageBody(p.user, {}, true)
      const r = await create(p.user, b)
      expect(r).toMatchObject({ status: 200, body: { candyCost: IMAGE_FILE, paymentSource: "candy" } })
      expect(await facts(p.profile)).toMatchObject({ orders: 1, balance: 100 - IMAGE_FILE, ledger: 1, media: 1, usages: 0 })
      expect((await owner.query("select order_id, type, file_url, mime_type, original_filename from public.media_assets where order_id = $1", [b.orderId])).rows[0])
        .toEqual({ order_id: b.orderId, type: "upload", file_url: `${p.user}/${b.orderId}/ref.png`, mime_type: "image/png", original_filename: "ref.png" })
      const t = (await owner.query("select amount, type, reference_type, reference_id, idempotency_key from public.candy_transactions where idempotency_key = $1", [`order_debit:${b.orderId}`])).rows[0]
      expect(t).toEqual({ amount: -IMAGE_FILE, type: "order_debit", reference_type: "order", reference_id: b.orderId, idempotency_key: `order_debit:${b.orderId}` })
      await reconciles(p.profile, 100)
    })

    it("video: ALWAYS candy (never a welcome credit even with 3 left), video_requests row with the parent's choices, tier-matched price", async () => {
      const p = await newParent()
      const b = videoBody(p.user)
      const r = await create(p.user, b)
      expect(r).toMatchObject({ status: 200, body: { type: "video", candyCost: VIDEO, paymentSource: "candy" } })
      expect(await facts(p.profile)).toMatchObject({ orders: 1, balance: 100 - VIDEO, ledger: 1, used: 0, usages: 0, video: 1 })
      expect((await owner.query("select script, style, duration_choice, characters_speak from public.video_requests where order_id = $1", [b.orderId])).rows[0])
        .toEqual({ script: "once upon a time", style: null, duration_choice: "5_10", characters_speak: true })
      await reconciles(p.profile, 100)
    })

    it("video rules are the function's: tier/choice mismatch, missing characters_speak and a style on drawing are refused with their own codes, nothing written", async () => {
      const p = await newParent()
      const mismatch = await create(p.user, videoBody(p.user, { durationChoice: "30_plus" }))
      expect(mismatch).toMatchObject({ status: 422, body: { error: "request_invalid_duration_choice" } })
      const speak = await create(p.user, videoBody(p.user, { charactersSpeak: null }))
      expect(speak).toMatchObject({ status: 422, body: { error: "request_characters_speak_required" } })
      const style = await create(p.user, drawingBody(p.user, { videoStyle: "x" }))
      expect(style).toMatchObject({ status: 422, body: { error: "request_video_style_not_allowed" } })
      expect(await facts(p.profile)).toMatchObject({ orders: 0, ledger: 0, usages: 0, balance: 100 })
    })

    it("drawing animation: candy 35, requires a file, drawing_animation_requests + media rows, no character, no credit", async () => {
      const p = await newParent()
      const b = drawingBody(p.user)
      const r = await create(p.user, b)
      expect(r).toMatchObject({ status: 200, body: { type: "drawing_animation", candyCost: DRAWING, paymentSource: "candy" } })
      expect(await facts(p.profile)).toMatchObject({ orders: 1, balance: 100 - DRAWING, ledger: 1, used: 0, drawing: 1, media: 1 })
      expect((await owner.query("select upload_url, animation_style from public.drawing_animation_requests where order_id = $1", [b.orderId])).rows[0])
        .toEqual({ upload_url: `${p.user}/${b.orderId}/draw.png`, animation_style: "wave" })
      expect((await owner.query("select character_id, title from public.orders where id = $1", [b.orderId])).rows[0]).toEqual({ character_id: null, title: "my drawing" })
      const noFile = await create(p.user, drawingBody(p.user, { file: null }))
      expect(noFile).toMatchObject({ status: 422, body: { error: "request_file_required" } })
      const withCharacter = await create(p.user, drawingBody(p.user, { character: "Captain Candy" }))
      expect(withCharacter).toMatchObject({ status: 422, body: { error: "request_character_not_allowed" } })
      expect((await facts(p.profile)).orders).toBe(1)
    })

    it("an unknown character is character_unavailable (422) and a non-image MIME is request_file_type_invalid; neither charges", async () => {
      const p = await newParent()
      expect(await create(p.user, imageBody(p.user, { character: "No Such Hero" }))).toMatchObject({ status: 422, body: { error: "character_unavailable" } })
      const b = imageBody(p.user, {}, true)
      expect(await create(p.user, { ...b, file: { ...(b.file as object), mimeType: "application/pdf" } })).toMatchObject({ status: 422, body: { error: "request_file_type_invalid" } })
      expect(await facts(p.profile)).toMatchObject({ orders: 0, balance: 100, usages: 0 })
    })

    it("consent is enforced IN THE FUNCTION: an un-consented parent is refused 403 by the database itself", async () => {
      const p = await newParent({ consent: false })
      expect(await create(p.user, imageBody(p.user))).toMatchObject({ status: 403, body: { error: "request_consent_required" } })
      expect(await facts(p.profile)).toMatchObject({ orders: 0, usages: 0, balance: 100 })
    })

    it("a parent with no profile (identity linked, nothing else) is 404 parent_profile_not_found", async () => {
      const user = randomUUID()
      await owner.query("insert into public.users (id, role) values ($1::uuid, 'parent')", [user])
      await owner.query("insert into public.user_identities (user_id, provider, provider_subject) values ($1::uuid, 'supabase', $1::text)", [user])
      expect(await create(user, imageBody(user))).toMatchObject({ status: 404, body: { error: "parent_profile_not_found" } })
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  describe("11/12. welcome credits first, then candy", () => {
    it("3 credits: requests 1/2/3 credit-funded, request 4 candy-funded; counts, usage rows and ledger exact", async () => {
      const p = await newParent({ balance: 100 })
      const sources: string[] = []
      for (let i = 0; i < 4; i++) {
        const r = await create(p.user, imageBody(p.user))
        expect(r.status).toBe(200)
        sources.push(r.body.paymentSource as string)
      }
      expect(sources).toEqual(["welcome_image_credit", "welcome_image_credit", "welcome_image_credit", "candy"])
      expect(await facts(p.profile)).toMatchObject({ orders: 4, used: 3, usages: 3, ledger: 1, balance: 100 - IMAGE })
      await reconciles(p.profile, 100)
    })

    it("an image with ZERO candy succeeds while a credit exists; the credit count never goes negative", async () => {
      const p = await newParent({ balance: 0, credits: 1 })
      expect((await create(p.user, imageBody(p.user))).body.paymentSource).toBe("welcome_image_credit")
      expect(await create(p.user, imageBody(p.user))).toMatchObject({ status: 402, body: { error: "INSUFFICIENT_CANDIES" } })
      expect(await facts(p.profile)).toMatchObject({ orders: 1, used: 1, usages: 1, balance: 0 })
      expect(await sqlState(owner.query("update public.parent_welcome_credits set used_count = granted_count + 1 where parent_id = $1", [p.profile]))).toBeDefined()
    })

    it("concurrent credit claims: 8 simultaneous images against 3 credits and no candy -> exactly 3 succeed, 5 are 402, usage rows exactly 3", async () => {
      const p = await newParent({ balance: 0, credits: 3 })
      const results = await Promise.all(Array.from({ length: 8 }, () => create(p.user, imageBody(p.user))))
      expect(results.filter((r) => r.status === 200)).toHaveLength(3)
      expect(results.filter((r) => r.status === 402)).toHaveLength(5)
      expect(await facts(p.profile)).toMatchObject({ orders: 3, used: 3, usages: 3, ledger: 0, balance: 0 })
    })
  })

  describe("12/14. candy debit: exact cost, no overdraft, concurrency, nothing partial", () => {
    it("balance == exact cost succeeds and leaves 0", async () => {
      const p = await newParent({ balance: VIDEO, credits: 0 })
      expect(await create(p.user, videoBody(p.user))).toMatchObject({ status: 200, body: { candyCost: VIDEO } })
      expect(await facts(p.profile)).toMatchObject({ balance: 0, ledger: 1, orders: 1 })
      await reconciles(p.profile, VIDEO)
    })

    it("balance one short of the cost (video and drawing) is refused 402 and NOTHING is created or changed", async () => {
      const p = await newParent({ balance: DRAWING - 1, credits: 3 })
      const before = await facts(p.profile)
      expect(await create(p.user, videoBody(p.user))).toMatchObject({ status: 402, body: { error: "INSUFFICIENT_CANDIES" } })
      expect(await create(p.user, drawingBody(p.user))).toMatchObject({ status: 402 })
      expect(await facts(p.profile)).toEqual(before)
    })

    it("12 concurrent videos competing for a balance of 3 x cost + 1: exactly 3 succeed, the balance ends at 1, never negative", async () => {
      const p = await newParent({ balance: VIDEO * 3 + 1, credits: 0 })
      const results = await Promise.all(Array.from({ length: 12 }, () => create(p.user, videoBody(p.user))))
      expect(results.filter((r) => r.status === 200)).toHaveLength(3)
      expect(results.filter((r) => r.status === 402)).toHaveLength(9)
      expect(await facts(p.profile)).toMatchObject({ orders: 3, ledger: 3, balance: 1 })
      await reconciles(p.profile, VIDEO * 3 + 1)
    })

    it("a candy-funded balance cannot be overdrafted directly either: the CHECK constraint stays", async () => {
      const p = await newParent()
      expect(await sqlState(owner.query("update public.candy_wallets set balance = -1 where parent_id = $1", [p.profile]))).toBe("23514")
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  describe("12/20. idempotency and assertion replay (two different protections)", () => {
    it("same parent + same submission key, new assertion each time: the SAME order comes back, replayed, no second charge", async () => {
      const p = await newParent({ credits: 0 })
      const b = videoBody(p.user)
      const first = await create(p.user, b)
      const again = await create(p.user, { ...b, orderId: randomUUID() }) // a retry mints a new order id (new storage key); the key decides
      const third = await create(p.user, { ...b, orderId: randomUUID() })
      expect(first.body).toMatchObject({ orderId: b.orderId, replayed: false })
      expect(again.body).toMatchObject({ orderId: b.orderId, replayed: true, candyCost: VIDEO, paymentSource: "candy" })
      expect(third.body).toMatchObject({ orderId: b.orderId, replayed: true })
      expect(await facts(p.profile)).toMatchObject({ orders: 1, ledger: 1, balance: 100 - VIDEO, video: 1 })
    })

    it("a replay reports the ORIGINAL payment source and spends nothing, even after the credits are gone", async () => {
      const p = await newParent({ credits: 1 })
      const b = imageBody(p.user)
      expect((await create(p.user, b)).body.paymentSource).toBe("welcome_image_credit")
      const replay = await create(p.user, b)
      expect(replay.body).toMatchObject({ replayed: true, paymentSource: "welcome_image_credit", candyCost: 0 })
      expect(await facts(p.profile)).toMatchObject({ orders: 1, used: 1, usages: 1, balance: 100, ledger: 0 })
    })

    it("20 concurrent identical submissions (distinct assertions): ONE order, ONE charge, everyone gets the winner's order", async () => {
      const p = await newParent({ credits: 0 })
      const b = videoBody(p.user)
      const results = await Promise.all(Array.from({ length: 20 }, () => create(p.user, { ...b, orderId: randomUUID() })))
      expect(results.map((r) => r.status)).toEqual(Array(20).fill(200))
      expect(new Set(results.map((r) => r.body.orderId)).size).toBe(1)
      expect(results.filter((r) => r.body.replayed === false)).toHaveLength(1)
      expect(await facts(p.profile)).toMatchObject({ orders: 1, ledger: 1, balance: 100 - VIDEO, video: 1 })
      await reconciles(p.profile, 100)
    })

    it("20 concurrent identical IMAGE submissions with credits: exactly ONE credit consumed", async () => {
      const p = await newParent({ credits: 3 })
      const b = imageBody(p.user)
      const results = await Promise.all(Array.from({ length: 20 }, () => create(p.user, { ...b, orderId: randomUUID() })))
      expect(results.map((r) => r.status)).toEqual(Array(20).fill(200))
      expect(await facts(p.profile)).toMatchObject({ orders: 1, used: 1, usages: 1 })
    })

    it("the SAME assertion twice: first 200, second 409 replayed_request; no second charge. A fresh assertion with the same key still recovers the order", async () => {
      const p = await newParent({ credits: 0 })
      const b = videoBody(p.user)
      const raw = JSON.stringify(b)
      const token = signWrite(p.user, raw)
      const send = () => fetch(`${backendUrl}${PATH}`, { method: "POST", body: raw, headers: { "content-type": "application/json", "x-cartoona-internal-auth": token } })
      const first = await send()
      const second = await send()
      expect(first.status).toBe(200)
      expect(second.status).toBe(409)
      expect(await second.json()).toEqual({ error: "replayed_request" })
      expect(await facts(p.profile)).toMatchObject({ orders: 1, ledger: 1 })
      // The legitimate retry: new assertion, new nonce, SAME key.
      expect(await create(p.user, b)).toMatchObject({ status: 200, body: { orderId: b.orderId, replayed: true } })
      expect(await facts(p.profile)).toMatchObject({ orders: 1, ledger: 1 })
    })

    it("the same submission key used by a DIFFERENT parent is a different request (keys are per parent) and never exposes the first parent's order", async () => {
      const a = await newParent({ credits: 0 })
      const b = await newParent({ credits: 0 })
      const key = randomUUID()
      const ra = await create(a.user, videoBody(a.user, { submissionKey: key }))
      const rb = await create(b.user, videoBody(b.user, { submissionKey: key }))
      expect(ra.status).toBe(200)
      expect(rb.status).toBe(200)
      expect(rb.body.orderId).not.toBe(ra.body.orderId)
      expect(rb.body.replayed).toBe(false)
      expect((await facts(a.profile)).orders).toBe(1)
      expect((await facts(b.profile)).orders).toBe(1)
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  describe("21. atomicity: a failure at ANY stage leaves nothing behind", () => {
    const stages = [
      { name: "after the order insert (media_assets)", table: "media_assets", make: (u: string) => imageBody(u, {}, true), start: { credits: 0 } },
      { name: "after the order insert (video_requests)", table: "video_requests", make: (u: string) => videoBody(u), start: { credits: 0 } },
      { name: "after the order insert (drawing_animation_requests)", table: "drawing_animation_requests", make: (u: string) => drawingBody(u), start: { credits: 0 } },
      { name: "at the welcome-credit usage insert", table: "parent_welcome_credit_usages", make: (u: string) => imageBody(u), start: { credits: 3 } },
      { name: "at the ledger insert (last statement of the candy path)", table: "candy_transactions", make: (u: string) => videoBody(u), start: { credits: 0 } },
    ] as const

    it.each(stages)("a failure $name rolls back the order, child rows, credit use, debit and ledger", async ({ table, make, start }) => {
      const p = await newParent({ balance: 100, ...start })
      const trigger = `inject_${table}_${randomBytes(3).toString("hex")}`
      await owner.query(`create function public.${trigger}() returns trigger language plpgsql as $$ begin raise exception 'injected failure at ${table}'; end $$`)
      await owner.query(`create trigger ${trigger} before insert on public.${table} for each row execute function public.${trigger}()`)
      try {
        const before = await facts(p.profile)
        const r = await create(p.user, make(p.user))
        // An unclassified database error is "service unavailable": the write's outcome is unknown to the caller.
        expect(r).toMatchObject({ status: 503, body: { error: "service_unavailable" } })
        expect(JSON.stringify(r.body)).not.toMatch(/injected|failure|trigger/)
        expect(await facts(p.profile)).toEqual(before)
        expect(before).toMatchObject({ orders: 0 })
      } finally {
        await owner.query(`drop trigger ${trigger} on public.${table}`)
        await owner.query(`drop function public.${trigger}()`)
      }
      // The same request works once the fault is gone, and charges exactly once.
      expect((await create(p.user, make(p.user))).status).toBe(200)
      expect((await facts(p.profile)).orders).toBe(1)
    })

    it("a failure on the order row itself (a CHECK violation) leaves the wallet and credits untouched", async () => {
      const p = await newParent({ balance: 100, credits: 3 })
      await owner.query("alter table public.orders add constraint rq_inject check (child_name is distinct from 'BOOM') not valid")
      try {
        expect((await create(p.user, imageBody(p.user, { childName: "BOOM" }))).status).toBe(503)
        expect(await facts(p.profile)).toMatchObject({ orders: 0, used: 0, usages: 0, balance: 100, ledger: 0 })
      } finally {
        await owner.query("alter table public.orders drop constraint rq_inject")
      }
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  describe("17/19. recovery lookup by submission key", () => {
    it("finds the caller's own order with the minimum fields, and nothing else", async () => {
      const p = await newParent({ credits: 0 })
      const b = videoBody(p.user)
      await create(p.user, b)
      const r = await lookup(p.user, b.submissionKey as string)
      expect(r).toEqual({ status: 200, body: { found: true, orderId: b.orderId, type: "video", status: "pending_review", candyCost: VIDEO, paymentSource: "candy" } })
      expect(await lookup(p.user, randomUUID())).toEqual({ status: 200, body: { found: false } })
    })

    it("cross-parent: parent B probing parent A's key learns nothing - identical to an unused key", async () => {
      const a = await newParent()
      const b = await newParent()
      const body = imageBody(a.user)
      await create(a.user, body)
      expect(await lookup(b.user, body.submissionKey as string)).toEqual({ status: 200, body: { found: false } })
      expect(await lookup(b.user, randomUUID())).toEqual({ status: 200, body: { found: false } })
    })

    it("is a v2 READ route: a write assertion is refused; the query is exactly one UUID; admin and unlinked are refused", async () => {
      const p = await newParent()
      const k = randomUUID()
      const withToken = (token: string, qs: string) => fetch(`${backendUrl}${BY_KEY}${qs}`, { headers: { "x-cartoona-internal-auth": token } })
      expect((await withToken(signWrite(p.user, "", { path: BY_KEY }), `?submissionKey=${k}`)).status).toBe(401)
      expect((await withToken(signRead(p.user), "")).status).toBe(400)
      expect((await withToken(signRead(p.user), "?submissionKey=nope")).status).toBe(400)
      expect((await withToken(signRead(p.user), `?submissionKey=${k}&parentProfileId=${p.profile}`)).status).toBe(400)
      expect((await withToken(signRead(ADMIN), `?submissionKey=${k}`)).status).toBe(403)
      expect((await withToken(signRead(randomUUID()), `?submissionKey=${k}`)).status).toBe(403)
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  describe("10/22/23. the Next BFF: the whole chain, with Supabase Auth + Storage only", () => {
    it("image upload: 200, order/credit in PostgreSQL, the object in storage under <user>/<order>/, ZERO Supabase database calls", async () => {
      const p = await newParent()
      await signIn(p.user)
      const key = randomUUID()
      const r = await browserSubmit(browserForm(imageDraft(), key, { file: png() }))
      expect(r.status).toBe(200)
      expect(r.body).toMatchObject({ success: true, type: "image", candyCost: 0, replayed: false, paymentSource: "welcome_image_credit" })
      const orderId = r.body.orderId as string
      expect(await facts(p.profile)).toMatchObject({ orders: 1, used: 1, usages: 1, media: 1 })
      expect([...stub!.storage.objects]).toEqual([`parent-uploads/${p.user}/${orderId}/photo.png`])
      expect((await owner.query("select file_url, mime_type, original_filename from public.media_assets where order_id = $1", [orderId])).rows[0])
        .toEqual({ file_url: `${p.user}/${orderId}/photo.png`, mime_type: "image/png", original_filename: "photo.png" })
      // 23. No Supabase Database/RPC business write (or read) happened: only Auth and Storage.
      expect(supabaseDbCalls()).toEqual([])
      expect(stub!.requests.some((q) => q.path.includes("/rpc/"))).toBe(false)
      expect(new Set(stub!.requests.map((q) => q.path.split("/").slice(0, 3).join("/")))).toEqual(new Set(["/auth/v1", "/storage/v1"]))
    })

    it("read-after-write (22): the orders list, the account summary and the recovery lookup all see it through PostgreSQL", async () => {
      const p = await newParent({ balance: 100, credits: 0 })
      await signIn(p.user)
      const key = randomUUID()
      const r = await browserSubmit(browserForm(videoDraft(), key))
      expect(r.status).toBe(200)
      expect(r.body).toMatchObject({ candyCost: VIDEO, paymentSource: "candy" })
      const orders = await (await ordersGET(new Request(`${ORIGIN}/api/parent/orders`))).json()
      expect(orders.orders.map((o: { id: string }) => o.id)).toEqual([r.body.orderId])
      const summary = await (await summaryGET(new Request(`${ORIGIN}/api/parent/account-summary`))).json()
      expect(summary).toMatchObject({ wallet: { balance: 100 - VIDEO }, welcomeImageCreditsRemaining: 0 })
      expect(await browserByKey(key)).toMatchObject({ status: 200, body: { found: true, orderId: r.body.orderId } })
      expect(supabaseDbCalls()).toEqual([])
    })

    it("drawing animation and gallery-free video through the BFF: correct types and costs", async () => {
      const p = await newParent({ credits: 0 })
      await signIn(p.user)
      const d = await browserSubmit(browserForm(drawingDraft(), randomUUID(), { file: png("draw.png") }))
      expect(d).toMatchObject({ status: 200, body: { type: "drawing_animation", candyCost: DRAWING } })
      expect(await facts(p.profile)).toMatchObject({ drawing: 1, media: 1, balance: 100 - DRAWING })
    })

    it("CSRF: no Origin, a foreign Origin, cross-site fetch metadata, and JSON bodies are refused before anything happens", async () => {
      const p = await newParent()
      await signIn(p.user)
      const fd = () => browserForm(imageDraft(), randomUUID(), { file: png() })
      expect((await browserSubmit(fd(), { "sec-fetch-site": "same-origin" })).body).toMatchObject({ code: "csrf_rejected" })
      expect((await browserSubmit(fd(), { origin: "https://evil.example", "sec-fetch-site": "same-origin" })).status).toBe(403)
      expect((await browserSubmit(fd(), { origin: ORIGIN, "sec-fetch-site": "cross-site" })).status).toBe(403)
      setRateLimitStore(new InMemoryRateLimitStore())
      const json = await requestsPOST(new Request(`${ORIGIN}/api/requests`, { method: "POST", body: "{}", headers: { "content-type": "application/json", origin: ORIGIN } }))
      expect(json.status).toBe(415)
      expect(await facts(p.profile)).toMatchObject({ orders: 0, usages: 0 })
      expect(stub!.storage.objects.size).toBe(0)
    })

    it("not consented -> blocked with the product error, NOTHING uploaded; unprovisioned -> the setup flow's profile error, nothing uploaded", async () => {
      const p = await newParent({ consent: false })
      await signIn(p.user)
      const r = await browserSubmit(browserForm(imageDraft(), randomUUID(), { file: png() }))
      expect(r.status).toBe(403)
      expect(String(r.body.error)).toContain("رضایت")
      expect(stub!.storage.objects.size).toBe(0)

      const stranger = randomUUID() // signed in at the provider, never provisioned here
      await signIn(stranger)
      const u = await browserSubmit(browserForm(imageDraft(), randomUUID(), { file: png() }))
      expect(u.status).toBe(403)
      expect(String(u.body.error)).toBe("فقط حساب‌های والد می‌توانند درخواست ثبت کنند")
      expect(stub!.storage.objects.size).toBe(0)
    })

    it("insufficient candy -> the existing 402 product error; the object this attempt uploaded is removed; nothing charged", async () => {
      const p = await newParent({ balance: 1, credits: 0 })
      await signIn(p.user)
      const r = await browserSubmit(browserForm(imageDraft(), randomUUID(), { file: png() }))
      expect(r).toMatchObject({ status: 402, body: { code: "INSUFFICIENT_CANDIES" } })
      expect(stub!.storage.objects.size).toBe(0)
      expect(stub!.storage.removed).toHaveLength(1)
      expect(await facts(p.profile)).toMatchObject({ orders: 0, balance: 1 })
    })

    it("duplicate submit: the second call with the same key is answered by the lookup BEFORE any upload - one order, one object, one charge", async () => {
      const p = await newParent({ credits: 0 })
      await signIn(p.user)
      const key = randomUUID()
      const first = await browserSubmit(browserForm(videoDraft(), key, { file: png() }))
      const second = await browserSubmit(browserForm(videoDraft(), key, { file: png() }))
      expect(first.body.replayed).toBe(false)
      expect(second.body).toMatchObject({ orderId: first.body.orderId, replayed: true })
      expect(stub!.storage.objects.size).toBe(1)
      expect(await facts(p.profile)).toMatchObject({ orders: 1, ledger: 1, balance: 100 - VIDEO_FILE })
    })

    it("10 concurrent duplicate clicks through the BFF: one order, one charge, no orphan object", async () => {
      const p = await newParent({ credits: 0 })
      await signIn(p.user)
      const key = randomUUID()
      setRateLimitStore(new InMemoryRateLimitStore({ now: () => 0 }))
      const results = await Promise.all(Array.from({ length: 10 }, async () => {
        const res = await requestsPOST(new Request(`${ORIGIN}/api/requests`, { method: "POST", body: browserForm(videoDraft(), key, { file: png() }), headers: { origin: ORIGIN, "sec-fetch-site": "same-origin" } }))
        return { status: res.status, body: (await res.json()) as Record<string, unknown> }
      }))
      expect(results.map((r) => r.status).filter((s) => s !== 200 && s !== 429)).toEqual([])
      const ok = results.filter((r) => r.status === 200)
      expect(new Set(ok.map((r) => r.body.orderId)).size).toBe(1)
      expect(await facts(p.profile)).toMatchObject({ orders: 1, ledger: 1, balance: 100 - VIDEO_FILE })
      expect(stub!.storage.objects.size).toBe(1) // race losers removed their own upload
    })

    it("the browser sees none of: backend URL, assertion, internal secret, DB password, storage path, profile id", async () => {
      const p = await newParent()
      await signIn(p.user)
      const res = await requestsPOST(new Request(`${ORIGIN}/api/requests`, { method: "POST", body: browserForm(imageDraft(), randomUUID(), { file: png() }), headers: { origin: ORIGIN, "sec-fetch-site": "same-origin" } }))
      const text = JSON.stringify([await res.text(), [...res.headers.entries()]])
      for (const needle of [backendUrl, AUTH_SECRET, DB_PASSWORD, p.profile, `${p.user}/`, "x-cartoona-internal-auth", "127.0.0.1", "photo.png"]) {
        expect(text, needle).not.toContain(needle)
      }
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  describe("16/31. outcome unknown, recovery and the failure matrix", () => {
    it("backend unreachable BEFORE the submit (connection refused): retryable 503, nothing uploaded, no charge", async () => {
      const p = await newParent()
      await signIn(p.user)
      const r = await withBackendEnv("http://127.0.0.1:9", "800", () => browserSubmit(browserForm(imageDraft(), randomUUID(), { file: png() })))
      expect(r.status).toBe(503)
      expect(r.body.code).toBe("request_unavailable")
      expect(stub!.storage.objects.size).toBe(0)
      expect(await facts(p.profile)).toMatchObject({ orders: 0, usages: 0, balance: 100 })
    })

    it("PostgreSQL down: the identity/consent gate answers 503 first - nothing uploaded, nothing charged", async () => {
      const p = await newParent()
      await signIn(p.user)
      fault.down = true
      try {
        const r = await browserSubmit(browserForm(imageDraft(), randomUUID(), { file: png() }))
        expect(r.status).toBe(503)
        expect(stub!.storage.objects.size).toBe(0)
      } finally {
        fault.down = false
      }
      expect(await facts(p.profile)).toMatchObject({ orders: 0, usages: 0 })
    })

    it("the write COMMITS but its response is lost (timeout): the BFF asks by key, finds the order and reports SUCCESS - one charge, upload kept", async () => {
      const p = await newParent({ credits: 0 })
      await signIn(p.user)
      fault.delayAfterMs = 900
      fault.writes = 0
      try {
        const key = randomUUID()
        const r = await withBackendEnv(backendUrl, "400", () => browserSubmit(browserForm(videoDraft(), key, { file: png() })))
        expect(r.status).toBe(200)
        expect(r.body).toMatchObject({ success: true, type: "video", candyCost: VIDEO_FILE })
        expect(fault.writes).toBe(1)
        expect(await facts(p.profile)).toMatchObject({ orders: 1, ledger: 1, balance: 100 - VIDEO_FILE })
        expect(stub!.storage.objects.size).toBe(1)
        expect(stub!.storage.removed).toEqual([])
        expect([...stub!.storage.objects][0]).toContain(String(r.body.orderId))
      } finally {
        fault.delayAfterMs = 0
        await sleep(1000)
      }
    })

    it("the write is still IN FLIGHT at the timeout: the lookup finds nothing -> 503 request_not_created (never 'failed'); the retry with the SAME key then replays: one charge", async () => {
      const p = await newParent({ credits: 0 })
      await signIn(p.user)
      fault.delayBeforeMs = 1200
      const key = randomUUID()
      let first
      try {
        first = await withBackendEnv(backendUrl, "400", () => browserSubmit(browserForm(videoDraft(), key, { file: png() })))
      } finally {
        fault.delayBeforeMs = 0
      }
      expect(first.status).toBe(503)
      expect(first.body.code).toBe("request_not_created")
      expect(String(first.body.error)).not.toContain("ناموفق")
      expect(stub!.storage.removed).toEqual([]) // the in-flight write may still own the object
      await sleep(1500) // the delayed write now commits
      expect(await facts(p.profile)).toMatchObject({ orders: 1, ledger: 1 })
      const retry = await browserSubmit(browserForm(videoDraft(), key, { file: png() }))
      expect(retry).toMatchObject({ status: 200, body: { replayed: true } })
      expect(await facts(p.profile)).toMatchObject({ orders: 1, ledger: 1, balance: 100 - VIDEO_FILE })
      expect(stub!.storage.objects.size).toBe(1)
    })

    it("the answer is lost AND the lookup cannot be answered either: 503 request_outcome_unknown with the Persian 'could not confirm' text, upload kept; the SAME key then resolves it without a second charge", async () => {
      const p = await newParent({ credits: 0 })
      await signIn(p.user)
      const key = randomUUID()
      fault.delayAfterMs = 1500
      fault.stallAfterWrite = 1200
      try {
        const r = await withBackendEnv(backendUrl, "400", () => browserSubmit(browserForm(videoDraft(), key, { file: png() })))
        expect(r.status).toBe(503)
        expect(r.body.code).toBe("request_outcome_unknown")
        expect(r.body.error).toBe("نتوانستیم تأیید کنیم که درخواست ثبت شده است یا نه.")
        expect(stub!.storage.removed).toEqual([]) // the order exists and owns it
      } finally {
        fault.delayAfterMs = 0
        fault.stallAfterWrite = 0
        await sleep(1700)
        fault.stallAll = 0
      }
      expect(await facts(p.profile)).toMatchObject({ orders: 1, ledger: 1, balance: 100 - VIDEO_FILE })
      expect(await browserByKey(key)).toMatchObject({ body: { found: true } })
      const retry = await browserSubmit(browserForm(videoDraft(), key, { file: png() }))
      expect(retry).toMatchObject({ status: 200, body: { replayed: true } })
      expect(await facts(p.profile)).toMatchObject({ orders: 1, ledger: 1, balance: 100 - VIDEO_FILE })
    })

    it("a replayed assertion is rejected (409) and never creates a second order", async () => {
      const p = await newParent({ credits: 0 })
      const b = videoBody(p.user)
      const raw = JSON.stringify(b)
      const token = signWrite(p.user, raw)
      const send = () => fetch(`${backendUrl}${PATH}`, { method: "POST", body: raw, headers: { "content-type": "application/json", "x-cartoona-internal-auth": token } })
      expect((await send()).status).toBe(200)
      expect((await send()).status).toBe(409)
      expect((await send()).status).toBe(409)
      expect((await facts(p.profile)).orders).toBe(1)
    })

    it("the recovery route through the BFF: found / absent / invalid / signed-out; another parent's key is 'absent'", async () => {
      const a = await newParent({ credits: 0 })
      const b = await newParent()
      await signIn(a.user)
      const key = randomUUID()
      expect((await browserSubmit(browserForm(videoDraft(), key))).status).toBe(200)
      expect(await browserByKey(key)).toMatchObject({ status: 200, body: { found: true, type: "video", candyCost: VIDEO } })
      expect(await browserByKey(randomUUID())).toEqual({ status: 200, body: { found: false } })
      expect((await browserByKey("nope")).status).toBe(400)
      await signIn(b.user)
      expect(await browserByKey(key)).toEqual({ status: 200, body: { found: false } })
      cookies.jar = cookieJar([])
      expect((await browserByKey(key)).status).toBe(401)
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  describe("23/27. copied (pre-cutover) parents and V0.1.49-provisioned parents behave identically", () => {
    async function runSequence(user: string, profile: string) {
      const out: Array<Record<string, unknown>> = []
      const base = await facts(profile)
      const record = async (b: Record<string, unknown>) => {
        const r = await create(user, b)
        const f = await facts(profile)
        out.push({ status: r.status, code: r.body.error ?? null, type: r.body.type ?? null, cost: r.body.candyCost ?? null, source: r.body.paymentSource ?? null, balance: f.balance, used: f.used, ledger: f.ledger - base.ledger, orders: f.orders - base.orders })
      }
      for (let i = 0; i < 4; i++) await record(imageBody(user))
      await record(imageBody(user, {}, true))
      await record(videoBody(user))
      await record(drawingBody(user))
      return out
    }

    it("same starting state -> identical credit/candy outcomes for 4 images, a file image, a video and a drawing", async () => {
      await setState(COPIED_A.profile, { balance: 120, credits: 3 })
      const provisioned = await newParent({ balance: 120, credits: 3 })
      const copied = await runSequence(COPIED_A.user, COPIED_A.profile)
      const fresh = await runSequence(provisioned.user, provisioned.profile)
      expect(fresh).toEqual(copied)
      expect(copied.map((r) => r.source)).toEqual(["welcome_image_credit", "welcome_image_credit", "welcome_image_credit", "candy", "candy", "candy", "candy"])
      expect(copied.map((r) => r.status)).toEqual([200, 200, 200, 200, 200, 200, 200])
    })

    it("the V0.1.49 path end to end: sign in -> account-setup -> consent -> request, through the Next routes", async () => {
      const user = randomUUID()
      await signIn(user)
      const browser = (route: (r: Request) => Promise<Response>, body: string, p: string) =>
        route(new Request(`${ORIGIN}${p}`, { method: "POST", body, headers: { "content-type": "application/json", origin: ORIGIN, "sec-fetch-site": "same-origin" } }))
      expect((await browser(setupPOST, "{}", "/api/parent/account-setup")).status).toBe(200)
      // Not consented yet: the request is refused and nothing is uploaded.
      expect((await browserSubmit(browserForm(imageDraft(), randomUUID(), { file: png() }))).status).toBe(403)
      expect((await browser(consentPOST, '{"consentGranted":true}', "/api/parent-consent")).status).toBe(200)
      const r = await browserSubmit(browserForm(imageDraft(), randomUUID(), { file: png() }))
      expect(r).toMatchObject({ status: 200, body: { paymentSource: "welcome_image_credit", candyCost: 0 } })
      const profile = (await owner.query("select id from public.parent_profiles where user_id = $1", [user])).rows[0].id
      expect(await facts(profile)).toMatchObject({ orders: 1, used: 1, usages: 1, balance: 0 })
      expect(supabaseDbCalls()).toEqual([])
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  describe("32. local timings (Docker, one machine - NOT production estimates)", () => {
    it("direct Fastify, Next -> Fastify -> PostgreSQL, idempotent lookup and recovery lookup", async () => {
      const N = 25
      const time = async (n: number, work: (i: number) => Promise<unknown>) => {
        const xs: number[] = []
        for (let i = 0; i < n; i++) {
          const t = performance.now()
          await work(i)
          xs.push(performance.now() - t)
        }
        return xs
      }
      const credit = await newParent({ balance: 10_000, credits: N })
      const candy = await newParent({ balance: 100_000, credits: 0 })
      const viaNext = await newParent({ balance: 100_000, credits: 0 })
      const keyed = await newParent({ credits: 0 })
      const direct = {
        credit: await time(N, () => create(credit.user, imageBody(credit.user))),
        candy: await time(N, () => create(candy.user, imageBody(candy.user))),
      }
      const kb = videoBody(keyed.user)
      await create(keyed.user, kb)
      const dup = await time(N, () => create(keyed.user, { ...kb, orderId: randomUUID() }))
      const look = await time(N, () => lookup(keyed.user, kb.submissionKey as string))
      await signIn(viaNext.user)
      const next = await time(N, () => browserSubmit(browserForm(imageDraft(), randomUUID())))
      const nextUpload = await time(N, () => browserSubmit(browserForm(imageDraft(), randomUUID(), { file: png() })))
      await signIn(keyed.user)
      const recover = await time(N, () => browserByKey(kb.submissionKey as string))
      const line = (label: string, xs: number[]) => `  ${label.padEnd(58)} median ${pct(xs, 50).toFixed(2)} ms, p90 ${pct(xs, 90).toFixed(2)} ms\n`
      process.stderr.write(
        `[request timings, local Docker PostgreSQL 17 + stub Auth/Storage, ${N} each]\n` +
          line("Fastify direct, welcome-credit-funded image", direct.credit) +
          line("Fastify direct, candy-funded image", direct.candy) +
          line("Fastify direct, duplicate key (idempotent replay)", dup) +
          line("Fastify direct, by-submission-key lookup", look) +
          line("Next -> Fastify -> PG, candy image, no file", next) +
          line("Next -> Fastify -> PG, candy image + storage upload", nextUpload) +
          line("Next recovery lookup (/api/requests/by-submission-key)", recover),
      )
      expect(direct.credit.length).toBe(N)
    })
  })
})
