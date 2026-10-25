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
import { GET as purchasesGET, POST as purchasesPOST } from "@/app/api/candy-purchases/route"
import { GET as packagesGET } from "@/app/api/candy-packages/route"
import { POST as couponPOST } from "@/app/api/candy-purchases/[id]/coupon/route"
import { POST as validatePOST } from "@/app/api/coupons/validate/route"
import { POST as payPOST } from "@/app/api/candy-purchases/[id]/pay/route"
import { POST as webhookPOST } from "@/app/api/payments/webhooks/[provider]/route"
import { GET as returnGET } from "@/app/api/payments/return/[provider]/route"
import { GET as summaryGET } from "@/app/api/parent/account-summary/route"
import { GET as ordersGET } from "@/app/api/parent/orders/route"
import { GET as adminListGET, POST as adminCreatePOST } from "@/app/api/admin/coupons/route"
import { GET as adminDetailGET, PATCH as adminPATCH } from "@/app/api/admin/coupons/[id]/route"
import { closePool, getPool } from "@/lib/db/pool"
import type { Queryable } from "@/lib/db/types"
import { signAssertion, signServiceAssertion, signWriteAssertion } from "@/lib/identity/assertion"
import { toVerifiedIdentity } from "@/lib/identity/types"
import { InMemoryRateLimitStore, setRateLimitStore } from "@/lib/rate-limit"
import { runDataCopy } from "@/scripts/db/data-copy/copy"
import { buildSupabaseSource, dropDbs, migrateTarget, ownerUrl, pgEnv, psql, root, script, type PgEnv } from "../helpers/data-copy-db"
import { cookieJar, startStubAuth, type StubAuth } from "../helpers/stub-supabase-auth"
import { startStubPaymentProvider, type StubPaymentProvider } from "../helpers/stub-payment-provider"
import { DAY_MS } from "../helpers/supabase-jwt"

/**
 * V0.1.51 candy purchase / payment cutover on REAL local services
 * (opt-in: CARTOONA_PLAIN_PG=docker):
 *
 *   Supabase-shaped source -> V0.1.44 copy -> plain PostgreSQL 17 (0001-0019)
 *   stub Supabase Auth (real @supabase/ssr) -> Next purchase/coupon/pay routes
 *   -> Fastify (listening, RESTRICTED login role) -> trusted functions;
 *   stub payment provider (signed webhooks, verify API) -> Next webhook/return
 *   routes -> service assertion -> confirm/fail functions.
 *
 * Financial invariants are asserted in the database. Nothing contacts
 * Supabase, a payment provider or any hosted service.
 */

const enabled = process.env.CARTOONA_PLAIN_PG === "docker"
const id = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`
const SRC = `pps_${id}`
const TGT = `ppt_${id}`
const ROLE = `cartoona_app_pp${id}`
const DB_PASSWORD = randomBytes(24).toString("hex")
const AUTH_SECRET = randomBytes(32).toString("hex")
const STUB_KEY = randomBytes(16).toString("hex")
const STUB_SECRET = randomBytes(32).toString("hex")
const ORIGIN = "http://localhost:3000"

const COPIED_A = { user: "a1000000-0000-4000-8000-000000000001", profile: "b1000000-0000-4000-8000-000000000001" }
const COPIED_B = { user: "a1000000-0000-4000-8000-000000000002", profile: "b1000000-0000-4000-8000-000000000002" }
const ADMIN = "a1000000-0000-4000-8000-000000000003"
const COPIED_PAID = "f2000000-0000-4000-8000-000000000001"
const COPIED_PENDING_WITH_COUPON = "f2000000-0000-4000-8000-000000000003"

let env: PgEnv
let backend: FastifyInstance | null = null
let backendUrl = ""
let stub: StubAuth | null = null
let provider: StubPaymentProvider
let appPool: Pool
let owner: Pool
let packages: Array<{ id: string; candy: number; price: number }> = []

const fault = { down: false, delayAfterMs: 0, confirms: 0 }
function faultyDb(): () => Queryable {
  return () => ({
    query: async (text: string, values?: readonly unknown[]) => {
      const isConfirm = text.includes("confirm_payment_attempt_trusted")
      if (fault.down && isConfirm) throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" })
      const result = await getPool().query(text, values as unknown[])
      if (isConfirm) {
        fault.confirms += 1
        if (fault.delayAfterMs) await new Promise((r) => setTimeout(r, fault.delayAfterMs))
      }
      return result
    },
  }) as Queryable
}

// ── assertions ───────────────────────────────────────────────────────────────
const ident = (s: string) => toVerifiedIdentity({ provider: "supabase", subject: s })
const secret = () => Buffer.from(AUTH_SECRET, "hex")
const rid = () => `pp-${randomBytes(4).toString("hex")}`
async function direct(method: "GET" | "POST" | "PATCH", user: string, p: string, body?: unknown, query = "") {
  const raw = body === undefined ? undefined : JSON.stringify(body)
  const token = method === "GET"
    ? signAssertion({ identity: ident(user), authenticatedAt: Date.now() - DAY_MS, requestId: rid(), method, path: p, secret: secret() })
    : signWriteAssertion({ identity: ident(user), authenticatedAt: Date.now() - DAY_MS, requestId: rid(), method, path: p, body: raw ?? "", secret: secret() })
  const res = await fetch(`${backendUrl}${p}${query}`, { method, body: raw, headers: { ...(raw ? { "content-type": "application/json" } : {}), "x-cartoona-internal-auth": token } })
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}
async function serviceEvent(body: Record<string, unknown>, token?: string) {
  const raw = JSON.stringify(body)
  const t = token ?? signServiceAssertion({ service: "payments", requestId: rid(), method: "POST", path: "/v1/payments/events", body: raw, secret: secret() })
  const res = await fetch(`${backendUrl}/v1/payments/events`, { method: "POST", body: raw, headers: { "content-type": "application/json", "x-cartoona-internal-auth": t } })
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}
const succeeded = (sessionId: string, amount: number, over: Record<string, unknown> = {}) => ({
  provider: "stub", eventId: `evt_${randomUUID()}`, type: "payment.succeeded", sessionId, transactionId: `tx_${randomUUID()}`, amount, currency: "IRR", failureCode: null, ...over,
})

// ── database facts ───────────────────────────────────────────────────────────
const q = async <T = Record<string, unknown>>(sql: string, args: unknown[] = []) => (await owner.query(sql, args)).rows as T[]
async function newParent(opts: { balance?: number } = {}) {
  const user = randomUUID()
  await appPool.query("select public.provision_supabase_parent_identity($1)", [user])
  const profile = (await q<{ id: string }>("select id from public.parent_profiles where user_id = $1", [user]))[0].id
  await q("update public.candy_wallets set balance = $2 where parent_id = $1", [profile, opts.balance ?? 0])
  await q("update public.parent_profiles set consent_granted = true, consent_granted_at = now() where id = $1", [profile])
  return { user, profile }
}
async function facts(profile: string) {
  const one = async (sql: string) => Number((await q<{ n: string }>(sql, [profile]))[0].n)
  return {
    balance: await one("select balance n from public.candy_wallets where parent_id = $1"),
    credits: await one("select count(*) n from public.candy_transactions t join public.candy_wallets w on w.id = t.wallet_id where w.parent_id = $1 and t.type = 'purchase'"),
    creditSum: await one("select coalesce(sum(t.amount),0) n from public.candy_transactions t join public.candy_wallets w on w.id = t.wallet_id where w.parent_id = $1 and t.type = 'purchase'"),
    paid: await one("select count(*) n from public.candy_purchases where parent_id = $1 and status = 'paid'"),
    purchases: await one("select count(*) n from public.candy_purchases where parent_id = $1"),
  }
}
async function reconciles(profile: string) {
  const ledger = Number((await q<{ n: string }>("select coalesce(sum(t.amount),0) n from public.candy_transactions t join public.candy_wallets w on w.id = t.wallet_id where w.parent_id = $1", [profile]))[0].n)
  const paidCandy = Number((await q<{ n: string }>("select coalesce(sum(candy_amount),0) n from public.candy_purchases where parent_id = $1 and status = 'paid'", [profile]))[0].n)
  const credits = Number((await q<{ n: string }>("select coalesce(sum(t.amount),0) n from public.candy_transactions t join public.candy_wallets w on w.id = t.wallet_id where w.parent_id = $1 and t.type = 'purchase'", [profile]))[0].n)
  expect(credits).toBe(paidCandy)
  return ledger
}
async function sqlState(work: Promise<unknown>): Promise<string | undefined> {
  const e = await work.then(() => null, (x: unknown) => x)
  return (e as { code?: string } | null)?.code
}

// ── Next harness ─────────────────────────────────────────────────────────────
async function signIn(userId: string, role = "parent") {
  await stub?.close()
  stub = await startStubAuth({ userId, role })
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", stub.url)
  cookies.jar = cookieJar([stub.cookie()])
  setRateLimitStore(new InMemoryRateLimitStore())
}
const browserHeaders = { "content-type": "application/json", origin: ORIGIN, "sec-fetch-site": "same-origin" }
// Response bodies are inspected loosely in assertions; their shapes are pinned by the expectations themselves.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const asJson = async (res: Response) => ({ status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> })
const bCreate = async (packageId: string) => asJson(await purchasesPOST(new Request(`${ORIGIN}/api/candy-purchases`, { method: "POST", body: JSON.stringify({ package_id: packageId }), headers: browserHeaders })))
const bHistory = async () => asJson(await purchasesGET(new Request(`${ORIGIN}/api/candy-purchases`)))
const bPay = async (purchaseId: string, key = randomUUID()) =>
  asJson(await payPOST(new Request(`${ORIGIN}/api/candy-purchases/${purchaseId}/pay`, { method: "POST", body: JSON.stringify({ idempotency_key: key }), headers: browserHeaders }), { params: Promise.resolve({ id: purchaseId }) }))
const bApply = async (purchaseId: string, code: string, key = randomUUID()) =>
  asJson(await couponPOST(new Request(`${ORIGIN}/api/candy-purchases/${purchaseId}/coupon`, { method: "POST", body: JSON.stringify({ code, idempotency_key: key }), headers: browserHeaders }), { params: Promise.resolve({ id: purchaseId }) }))
const bValidate = async (purchaseId: string, code: string) =>
  asJson(await validatePOST(new Request(`${ORIGIN}/api/coupons/validate`, { method: "POST", body: JSON.stringify({ purchase_id: purchaseId, code }), headers: browserHeaders })))
const bSummary = async () => asJson(await summaryGET(new Request(`${ORIGIN}/api/parent/account-summary`)))
const bReturn = async (session: string) => returnGET(new Request(`${ORIGIN}/api/payments/return/stub?session=${session}`), { params: Promise.resolve({ provider: "stub" }) })
const webhook = async (raw: string, headers: Record<string, string>, providerId = "stub") => {
  const res = await webhookPOST(new Request(`${ORIGIN}/api/payments/webhooks/${providerId}`, { method: "POST", body: raw, headers }), { params: Promise.resolve({ provider: providerId }) })
  return { status: res.status, body: await res.text() }
}
const sessionOf = (checkoutUrl: string) => checkoutUrl.split("/checkout/")[1]
/** create -> pay (stub session) ; returns ids */
async function startPurchase(pkg = packages[0]) {
  const created = await bCreate(pkg.id)
  expect(created.status).toBe(201)
  const purchaseId = created.body.purchase.id as string
  const pay = await bPay(purchaseId)
  expect(pay.status).toBe(200)
  return { purchaseId, sessionId: sessionOf(pay.body.checkoutUrl) }
}
const supabaseDbCalls = () => (stub?.requests ?? []).filter((r) => r.path.startsWith("/rest/v1/"))
const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))]

describe.skipIf(!enabled)("V0.1.51 candy purchase / payment cutover (local Docker PostgreSQL 17)", () => {
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
    packages = (await q<{ id: string; candy_amount: number; price_amount: number }>("select id, candy_amount, price_amount from public.candy_packages where is_active order by display_order")).map((p) => ({ id: p.id, candy: p.candy_amount, price: p.price_amount }))
    provider = await startStubPaymentProvider({ apiKey: STUB_KEY, webhookSecret: STUB_SECRET })
    provider.setWebhookTarget(async (raw, headers) => webhook(raw, headers))
    vi.stubEnv("DATABASE_URL", roleUrl)
    vi.stubEnv("CARTOONA_INTERNAL_AUTH_SECRET", AUTH_SECRET)
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-key")
    vi.stubEnv("BACKEND_REQUEST_TIMEOUT_MS", "3000")
    vi.stubEnv("CARTOONA_PAYMENT_PROVIDER", "stub")
    vi.stubEnv("CARTOONA_PAYMENT_STUB_URL", provider.url)
    vi.stubEnv("CARTOONA_PAYMENT_STUB_API_KEY", STUB_KEY)
    vi.stubEnv("CARTOONA_PAYMENT_STUB_WEBHOOK_SECRET", STUB_SECRET)
    const app = buildBackendApp({ db: faultyDb(), closeDb: async () => {} })
    await app.listen({ host: "127.0.0.1", port: 0 })
    backend = app
    backendUrl = `http://127.0.0.1:${(app.server.address() as net.AddressInfo).port}`
    vi.stubEnv("BACKEND_INTERNAL_URL", backendUrl)
  })

  afterAll(async () => {
    vi.restoreAllMocks()
    await stub?.close()
    await provider?.close()
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
  describe("6/7/31. privileges: EXECUTE on the purchase functions, no direct financial write", () => {
    it.each([
      ["INSERT candy_purchases", `insert into public.candy_purchases (parent_id, package_id, candy_amount, price_amount, original_price_amount, final_price_amount) select '${COPIED_A.profile}', id, 1, 1, 1, 1 from public.candy_packages limit 1`],
      ["UPDATE candy_purchases status", `update public.candy_purchases set status = 'paid'`],
      ["UPDATE candy_purchases price", `update public.candy_purchases set final_price_amount = 1`],
      ["INSERT payment_attempts", `insert into public.payment_attempts (purchase_id, provider, requested_amount, requested_currency, attempt_number, idempotency_key) values ('${COPIED_PENDING_WITH_COUPON}', 'x', 1, 'IRR', 9, 'k')`],
      ["UPDATE payment_attempts", `update public.payment_attempts set status = 'verified'`],
      ["INSERT payment_webhook_events", `insert into public.payment_webhook_events (provider, provider_event_id, event_type) values ('x', 'e', 't')`],
      ["INSERT coupon_redemptions", `insert into public.coupon_redemptions (coupon_id, purchase_id, parent_profile_id, normalized_code_snapshot, discount_type_snapshot, discount_value_snapshot, original_price_amount, discount_amount, final_price_amount, currency, idempotency_key) values ('f1000000-0000-4000-8000-000000000001', '${COPIED_PAID}', '${COPIED_A.profile}', 'X', 'percentage', 1, 1, 0, 1, 'IRR', 'k')`],
      ["UPDATE coupon_redemptions", `update public.coupon_redemptions set status = 'cancelled'`],
      ["INSERT coupons", `insert into public.coupons (code, name, discount_type, discount_value) values ('FREEBIE', 'x', 'percentage', 10000)`],
      ["UPDATE coupons", `update public.coupons set global_usage_limit = null`],
      ["DELETE coupon_package_rules", `delete from public.coupon_package_rules`],
      ["UPDATE candy_wallets", `update public.candy_wallets set balance = balance + 1000`],
      ["INSERT candy_transactions", `insert into public.candy_transactions (wallet_id, amount, type, idempotency_key) select id, 1000, 'purchase', 'free' from public.candy_wallets limit 1`],
      ["UPDATE candy_packages price", `update public.candy_packages set price_amount = 1`],
      ["SELECT payment_attempts provider refs", `select provider_session_id, checkout_url from public.payment_attempts`],
      ["EXECUTE complete_candy_purchase_trusted (the dev simulation)", `select * from public.complete_candy_purchase_trusted('${COPIED_PENDING_WITH_COUPON}', '${COPIED_A.profile}', 'free')`],
    ])("the app role cannot %s -> 42501", async (_l, sql) => {
      expect(await sqlState(appPool.query(sql))).toBe("42501")
    })

    it("the SECURITY DEFINER functions the role may execute are exactly the audited list", async () => {
      const rows = (await q<{ proname: string }>(`select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.prosecdef and has_function_privilege($1, p.oid, 'execute') order by 1`, [ROLE])).map((r) => r.proname)
      expect([...rows].sort()).toEqual([
        "apply_coupon_to_purchase_trusted", "confirm_payment_attempt_trusted", "consume_internal_write_nonce", "create_candy_purchase_trusted",
        "create_coupon_trusted", "create_parent_request_trusted", "create_payment_attempt_trusted", "fail_payment_attempt_trusted",
        "provision_supabase_parent_identity", "record_parent_consent_trusted", "record_payment_attempt_session_trusted",
        "update_coupon_trusted", "validate_coupon_for_purchase_trusted",
        // V0.1.52 (0018): fulfilment + final media + the access audit.
        "approve_final_media_trusted", "get_order_status_history_admin_trusted", "record_final_media_access_audit_trusted",
        "record_final_media_trusted", "supersede_final_media_trusted", "update_order_status_trusted",
        // V0.1.53 (0019): referrals, homepage CMS, examples CMS.
        "bind_parent_referral_code_trusted", "create_example_trusted", "delete_example_trusted", "delete_homepage_media_trusted",
        "get_admin_referral_overview_trusted", "get_admin_referral_relationships_trusted", "get_parent_referral_summary_trusted",
        "record_homepage_media_replacement_trusted", "replace_example_media_trusted", "update_admin_referral_program_settings_trusted",
        "update_example_trusted", "update_homepage_content_trusted", "update_homepage_hero_layout_trusted",
      ].sort())
      for (const fn of ["create_candy_purchase_trusted", "confirm_payment_attempt_trusted", "fail_payment_attempt_trusted"]) {
        expect((await q(`select has_function_privilege('public', p.oid, 'execute') pub from pg_proc p where proname = $1`, [fn]))[0]).toEqual({ pub: false })
      }
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  describe("14/18. catalog and history from PostgreSQL", () => {
    it("GET /api/candy-packages is the active PostgreSQL catalog, same shape and caching", async () => {
      const res = await packagesGET()
      expect(res.headers.get("cache-control")).toContain("s-maxage=300")
      const body = await res.json()
      expect(body.packages.map((p: { id: string; priceAmount: number; candyAmount: number }) => [p.id, p.candyAmount, p.priceAmount])).toEqual(packages.map((p) => [p.id, p.candy, p.price]))
    })

    it("the copied parent's history keeps the copied paid purchase, the pending one with its coupon name, and paymentStarted", async () => {
      await signIn(COPIED_A.user)
      const h = await bHistory()
      expect(h.status).toBe(200)
      const byId = new Map(h.body.purchases.map((p: { id: string }) => [p.id, p]))
      expect(byId.get(COPIED_PAID)).toMatchObject({ status: "paid", paymentStarted: true, couponApplied: false })
      expect(byId.get(COPIED_PENDING_WITH_COUPON)).toMatchObject({ status: "pending", couponApplied: true, couponCodeSnapshot: "WELCOME10", couponName: "Welcome 10%", couponStatus: "reserved", paymentStarted: false })
      expect(JSON.stringify(h.body)).not.toMatch(/f3000000|f1000000|f5000000|simulation|provider|attempt/)
      expect(supabaseDbCalls()).toEqual([])
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  describe("8/15/31. purchase creation: server-derived price, strict body, CSRF", () => {
    it("creates a pending purchase priced from the active catalog; no candy moves; zero Supabase DB calls", async () => {
      const p = await newParent()
      await signIn(p.user)
      const r = await bCreate(packages[1].id)
      expect(r.status).toBe(201)
      expect(r.body.purchase).toMatchObject({ candy_amount: packages[1].candy, price_amount: packages[1].price, final_price_amount: packages[1].price, discount_amount: 0, status: "pending", currency: "IRR" })
      expect(await facts(p.profile)).toMatchObject({ balance: 0, credits: 0, purchases: 1, paid: 0 })
      expect(supabaseDbCalls()).toEqual([])
    })

    it("the browser cannot choose price, candy amount, wallet, owner or status", async () => {
      const p = await newParent()
      await signIn(p.user)
      for (const extra of [{ price_amount: 1 }, { candy_amount: 100000 }, { wallet_id: randomUUID() }, { parent_id: p.profile }, { status: "paid" }, { final_price_amount: 0 }]) {
        const res = await purchasesPOST(new Request(`${ORIGIN}/api/candy-purchases`, { method: "POST", body: JSON.stringify({ package_id: packages[0].id, ...extra }), headers: browserHeaders }))
        expect(res.status, JSON.stringify(extra)).toBe(400)
      }
      for (const extra of [{ priceAmount: 1 }, { candyAmount: 1 }, { parentProfileId: p.profile }, { userId: p.user }]) {
        expect((await direct("POST", p.user, "/v1/parent/candy-purchases", { packageId: packages[0].id, ...extra })).status).toBe(400)
      }
      expect((await facts(p.profile)).purchases).toBe(0)
    })

    it("an inactive or unknown package is 404; CSRF refuses cross-site writes", async () => {
      const p = await newParent()
      await signIn(p.user)
      await q("update public.candy_packages set is_active = false where id = $1", [packages[2].id])
      try {
        expect((await bCreate(packages[2].id)).status).toBe(404)
      } finally {
        await q("update public.candy_packages set is_active = true where id = $1", [packages[2].id])
      }
      expect((await bCreate(randomUUID())).status).toBe(404)
      const foreign = await purchasesPOST(new Request(`${ORIGIN}/api/candy-purchases`, { method: "POST", body: JSON.stringify({ package_id: packages[0].id }), headers: { ...browserHeaders, origin: "https://evil.example" } }))
      expect(foreign.status).toBe(403)
      expect((await facts(p.profile)).purchases).toBe(0)
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  describe("13. coupons move with the purchase (one transaction, one database)", () => {
    it("validate previews, apply reserves exactly once per key, a second coupon is refused", async () => {
      const p = await newParent()
      await signIn(p.user)
      await q(`insert into public.coupons (code, name, discount_type, discount_value, is_active) values ('PCT20', 'Twenty', 'percentage', 2000, true) on conflict do nothing`)
      const { body } = await bCreate(packages[0].id)
      const purchaseId = body.purchase.id
      const v = await bValidate(purchaseId, "pct20")
      expect(v).toMatchObject({ status: 200, body: { coupon: { normalizedCode: "PCT20", finalPriceAmount: packages[0].price * 0.8 } } })
      const key = randomUUID()
      const a1 = await bApply(purchaseId, "PCT20", key)
      const a2 = await bApply(purchaseId, "PCT20", key)
      expect(a1.body.coupon).toMatchObject({ status: "reserved", finalPriceAmount: packages[0].price * 0.8 })
      expect(a2.body.coupon).toEqual(a1.body.coupon)
      expect((await q("select count(*)::int n from public.coupon_redemptions where purchase_id = $1", [purchaseId]))[0]).toEqual({ n: 1 })
      expect((await bApply(purchaseId, "WELCOME10")).body.error.code).toBe("coupon_already_applied")
      const other = (await bCreate(packages[0].id)).body.purchase.id
      expect((await bValidate(other, "NOPE99")).body.error.code).toBe("coupon_not_found")
      expect((await bValidate(other, "NOPE99")).body.error.message).toBe((await bValidate(other, "EXPIRED1")).body.error.message) // non-enumerating
    })

    it("GLOBAL usage limit holds under concurrency: 10 parents applying a limit-3 coupon at once -> exactly 3", async () => {
      const code = `LIM${randomBytes(3).toString("hex").toUpperCase()}`
      await q(`insert into public.coupons (code, name, discount_type, discount_value, is_active, global_usage_limit) values ($1, 'Limited', 'fixed_amount', 1000, true, 3)`, [code])
      const parents = await Promise.all(Array.from({ length: 10 }, () => newParent()))
      const purchases = await Promise.all(parents.map(async (p) => (await direct("POST", p.user, "/v1/parent/candy-purchases", { packageId: packages[0].id })).body.purchase as { id: string }))
      const results = await Promise.all(parents.map((p, i) => direct("POST", p.user, `/v1/parent/candy-purchases/${purchases[i].id}/coupon`, { code, idempotencyKey: randomUUID() })))
      expect(results.filter((r) => r.status === 200)).toHaveLength(3)
      expect(results.filter((r) => r.body.error === "coupon_usage_limit_reached")).toHaveLength(7)
      expect((await q("select count(*)::int n from public.coupon_redemptions r join public.coupons c on c.id = r.coupon_id where c.code = $1", [code]))[0]).toEqual({ n: 3 })
    })

    it("PER-PARENT limit holds under concurrency: one parent, 6 purchases, limit 2 -> exactly 2", async () => {
      const code = `PP${randomBytes(3).toString("hex").toUpperCase()}`
      await q(`insert into public.coupons (code, name, discount_type, discount_value, is_active, per_parent_usage_limit) values ($1, 'Per parent', 'fixed_amount', 1000, true, 2)`, [code])
      const p = await newParent()
      const purchases = await Promise.all(Array.from({ length: 6 }, async () => (await direct("POST", p.user, "/v1/parent/candy-purchases", { packageId: packages[0].id })).body.purchase as { id: string }))
      const results = await Promise.all(purchases.map((x) => direct("POST", p.user, `/v1/parent/candy-purchases/${x.id}/coupon`, { code, idempotencyKey: randomUUID() })))
      expect(results.filter((r) => r.status === 200)).toHaveLength(2)
    })

    it("informational: the 0005 apply body WITHOUT the coupon lock (plus the ambiguity fix) can exceed the limit", async () => {
      const src = fs.readFileSync(path.join(root, "database/migrations/0005_business_functions.sql"), "utf8")
      const start = src.indexOf("CREATE FUNCTION public.apply_coupon_to_purchase_trusted(")
      const end = src.indexOf("\n$_$;\n", start) + 6
      const body = src.slice(start, end)
        .replace("public.apply_coupon_to_purchase_trusted(", "public.apply_coupon_v0005_probe(")
        .replace("AS $_$\n", "AS $_$\n#variable_conflict use_column\n")
      await q(body)
      await q(`grant execute on function public.apply_coupon_v0005_probe(uuid, uuid, text, text) to cartoona_app`)
      const code = `OLD${randomBytes(3).toString("hex").toUpperCase()}`
      await q(`insert into public.coupons (code, name, discount_type, discount_value, is_active, global_usage_limit) values ($1, 'Old', 'fixed_amount', 1000, true, 3)`, [code])
      const parents = await Promise.all(Array.from({ length: 12 }, () => newParent()))
      const purchases = await Promise.all(parents.map(async (p) => (await direct("POST", p.user, "/v1/parent/candy-purchases", { packageId: packages[0].id })).body.purchase as { id: string }))
      const results = await Promise.all(parents.map((p, i) => appPool.query("select * from public.apply_coupon_v0005_probe($1, $2, $3, $4)", [p.profile, purchases[i].id, code, randomUUID()]).then(() => true, () => false)))
      const ok = results.filter(Boolean).length
      process.stderr.write(`[coupon limit race] pre-V0.1.51 apply body, 12 concurrent, limit 3: ${ok} succeeded\n`)
      await q("drop function public.apply_coupon_v0005_probe(uuid, uuid, text, text)")
      expect(ok).toBeGreaterThanOrEqual(3)
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  describe("8/9/23. starting a payment: PostgreSQL attempt first, provider session for the payable amount", () => {
    it("the provider is asked for the POST-coupon amount and references OUR attempt id; the same key resumes, never a second session", async () => {
      const p = await newParent()
      await signIn(p.user)
      await q(`insert into public.coupons (code, name, discount_type, discount_value, is_active) values ('HALFOFF', 'Half', 'percentage', 5000, true) on conflict do nothing`)
      const { body } = await bCreate(packages[0].id)
      const purchaseId = body.purchase.id
      expect((await bApply(purchaseId, "HALFOFF")).status).toBe(200)
      const key = randomUUID()
      const first = await bPay(purchaseId, key)
      const again = await bPay(purchaseId, key)
      expect(first.status).toBe(200)
      expect(again.body.checkoutUrl).toBe(first.body.checkoutUrl)
      const session = provider.sessions.get(sessionOf(first.body.checkoutUrl))!
      expect(session.amount).toBe(packages[0].price / 2)
      const attempts = await q<{ id: string; requested_amount: number; status: string; provider_session_id: string }>("select id, requested_amount, status, provider_session_id from public.payment_attempts where purchase_id = $1", [purchaseId])
      expect(attempts).toHaveLength(1)
      expect(attempts[0]).toMatchObject({ requested_amount: packages[0].price / 2, status: "awaiting_payment", provider_session_id: session.id })
      expect(session.reference).toBe(attempts[0].id)
      // Once paying started, the price is frozen: no coupon change.
      expect((await bApply(purchaseId, "WELCOME10")).body.error.code).toBe("coupon_purchase_has_payment_attempt")
      expect(await facts(p.profile)).toMatchObject({ balance: 0, credits: 0 })
    })

    it("double click on pay (two different keys at once) gives two attempts but can still credit only once", async () => {
      const p = await newParent()
      await signIn(p.user)
      const { body } = await bCreate(packages[0].id)
      const [a, b] = await Promise.all([bPay(body.purchase.id), bPay(body.purchase.id)])
      expect(a.status).toBe(200)
      expect(b.status).toBe(200)
      await provider.pay(sessionOf(a.body.checkoutUrl))
      await provider.pay(sessionOf(b.body.checkoutUrl))
      expect(await facts(p.profile)).toMatchObject({ balance: packages[0].candy, credits: 1, paid: 1 })
      // The second capture is flagged for review, never credited.
      expect((await q("select e.failure_code from public.payment_webhook_events e join public.payment_attempts a on a.id = e.attempt_id where a.purchase_id = $1 order by e.received_at", [body.purchase.id])).map((r) => r.failure_code)).toEqual([null, "already_paid"])
    })

    it("no provider configured -> 503 payment_unavailable and nothing is created; a 100% coupon -> NOTHING_TO_CHARGE", async () => {
      const p = await newParent()
      await signIn(p.user)
      const { body } = await bCreate(packages[0].id)
      vi.stubEnv("CARTOONA_PAYMENT_PROVIDER", "")
      try {
        expect((await bPay(body.purchase.id)).body.error.code).toBe("PAYMENT_UNAVAILABLE")
      } finally {
        vi.stubEnv("CARTOONA_PAYMENT_PROVIDER", "stub")
      }
      expect((await q("select count(*)::int n from public.payment_attempts where purchase_id = $1", [body.purchase.id]))[0]).toEqual({ n: 0 })
      await q(`insert into public.coupons (code, name, discount_type, discount_value, is_active) values ('FULLFREE', 'Free', 'percentage', 10000, true) on conflict do nothing`)
      expect((await bApply(body.purchase.id, "FULLFREE")).status).toBe(200)
      expect(await bPay(body.purchase.id)).toMatchObject({ status: 409, body: { error: { code: "NOTHING_TO_CHARGE" } } })
    })

    it("another parent's purchase cannot be paid (404, like a missing one), discounted or validated (403, the existing coupon contract)", async () => {
      const a = await newParent()
      const b = await newParent()
      await signIn(a.user)
      const { body } = await bCreate(packages[0].id)
      await signIn(b.user)
      expect((await bPay(body.purchase.id)).status).toBe(404)
      expect((await bApply(body.purchase.id, "WELCOME10")).body.error.code).toBe("coupon_purchase_not_owner")
      expect((await bValidate(body.purchase.id, "WELCOME10")).body.error.code).toBe("coupon_purchase_not_owner")
      expect((await q("select count(*)::int n from public.coupon_redemptions where purchase_id = $1", [body.purchase.id]))[0]).toEqual({ n: 0 })
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  describe("10/11/12/16/17. provider-verified confirmation: exactly one credit", () => {
    it("a verified webhook credits the wallet once: purchase paid, attempt verified, ledger row, coupon redeemed", async () => {
      const p = await newParent({ balance: 5 })
      await signIn(p.user)
      const { purchaseId, sessionId } = await startPurchase()
      const [d] = await provider.pay(sessionId)
      expect(d).toMatchObject({ status: 200 })
      expect(JSON.parse(d.body)).toEqual({ status: "processed" })
      expect(await facts(p.profile)).toMatchObject({ balance: 5 + packages[0].candy, credits: 1, creditSum: packages[0].candy, paid: 1 })
      expect((await q("select status, verified_amount, provider_transaction_id from public.payment_attempts where purchase_id = $1", [purchaseId]))[0]).toEqual({ status: "verified", verified_amount: packages[0].price, provider_transaction_id: `tx_${sessionId}` })
      expect((await q("select idempotency_key from public.candy_transactions where idempotency_key = $1", [`purchase_credit:${purchaseId}`]))).toHaveLength(1)
      await reconciles(p.profile)
    })

    it("the SAME paid event delivered 20 times concurrently -> one credit, 19 duplicates", async () => {
      const p = await newParent()
      await signIn(p.user)
      const { sessionId } = await startPurchase()
      provider.mode.webhook = 20
      provider.mode.concurrent = true
      let ds
      try {
        ds = await provider.pay(sessionId)
      } finally {
        provider.mode.webhook = "send"
        provider.mode.concurrent = false
      }
      const statuses = ds.map((d) => JSON.parse(d.body).status)
      expect(statuses.filter((s) => s === "processed")).toHaveLength(1)
      expect(statuses.filter((s) => s === "duplicate_event")).toHaveLength(19)
      expect(await facts(p.profile)).toMatchObject({ balance: packages[0].candy, credits: 1 })
    })

    it("20 DIFFERENT events for one payment racing (two workers, retries with new ids) -> one credit", async () => {
      const p = await newParent()
      await signIn(p.user)
      const { sessionId } = await startPurchase()
      const tx = `tx_${randomUUID()}`
      const results = await Promise.all(Array.from({ length: 20 }, () => serviceEvent(succeeded(sessionId, packages[0].price, { transactionId: tx }))))
      expect(results.map((r) => r.status)).toEqual(Array(20).fill(200))
      const outcomes = results.map((r) => r.body.outcome)
      expect(outcomes.filter((o) => o === "processed")).toHaveLength(1)
      expect(outcomes.filter((o) => o === "already_paid")).toHaveLength(19)
      expect(await facts(p.profile)).toMatchObject({ balance: packages[0].candy, credits: 1 })
    })

    it("browser return (server-side verify) and webhook racing -> one credit; the return alone also confirms when the webhook is lost", async () => {
      const p = await newParent()
      await signIn(p.user)
      const raced = await startPurchase()
      provider.mode.webhook = "drop"
      try {
        await provider.pay(raced.sessionId)
      } finally {
        provider.mode.webhook = "send"
      }
      const raw = JSON.stringify({ id: `evt_${randomUUID()}`, type: "payment.succeeded", session_id: raced.sessionId, transaction_id: `tx_${raced.sessionId}`, amount: packages[0].price, currency: "IRR" })
      const [ret, hook] = await Promise.all([bReturn(raced.sessionId), webhook(raw, { "content-type": "application/json", "x-stub-signature": provider.sign(raw) })])
      expect(ret.status).toBe(303)
      expect(ret.headers.get("location")).toBe(`${ORIGIN}/dashboard/billing?payment=paid`)
      expect(hook.status).toBe(200)
      expect(await facts(p.profile)).toMatchObject({ balance: packages[0].candy, credits: 1 })
      // Repeated returns are duplicates.
      expect((await bReturn(raced.sessionId)).headers.get("location")).toContain("payment=paid")
      expect(await facts(p.profile)).toMatchObject({ credits: 1 })

      const lost = await startPurchase()
      provider.mode.webhook = "drop"
      try {
        await provider.pay(lost.sessionId)
      } finally {
        provider.mode.webhook = "send"
      }
      expect(await facts(p.profile)).toMatchObject({ credits: 1 })
      expect((await bReturn(lost.sessionId)).headers.get("location")).toContain("payment=paid")
      expect(await facts(p.profile)).toMatchObject({ balance: packages[0].candy * 2, credits: 2 })
    })

    it("a decline fails the purchase without credit; a retry (new attempt) can then pay once; a late failure never regresses a paid purchase", async () => {
      const p = await newParent()
      await signIn(p.user)
      const { purchaseId, sessionId } = await startPurchase()
      const [d] = await provider.decline(sessionId)
      expect(JSON.parse(d.body).status).toBe("processed")
      expect((await q("select status from public.candy_purchases where id = $1", [purchaseId]))[0]).toEqual({ status: "failed" })
      expect(await facts(p.profile)).toMatchObject({ balance: 0, credits: 0 })
      expect((await bReturn(sessionId)).headers.get("location")).toContain("payment=failed")
      const retry = await bPay(purchaseId)
      expect(retry.status).toBe(200)
      expect((await q("select status from public.candy_purchases where id = $1", [purchaseId]))[0]).toEqual({ status: "pending" })
      await provider.pay(sessionOf(retry.body.checkoutUrl))
      expect(await facts(p.profile)).toMatchObject({ balance: packages[0].candy, credits: 1, paid: 1 })
      // Out of order: a failure for the OLD session after the purchase is paid.
      const late = await serviceEvent({ provider: "stub", eventId: `evt_${randomUUID()}`, type: "payment.failed", sessionId: sessionOf(retry.body.checkoutUrl), transactionId: null, amount: null, currency: null, failureCode: "late" })
      expect(late.body.outcome).toBe("already_paid")
      expect((await q("select status from public.candy_purchases where id = $1", [purchaseId]))[0]).toEqual({ status: "paid" })
      await reconciles(p.profile)
    })

    it("amount / currency mismatch, unknown session and a reused transaction id credit nothing and are flagged", async () => {
      const p = await newParent()
      await signIn(p.user)
      const one = await startPurchase()
      provider.mode.chargedAmount = 1
      try {
        const [d] = await provider.pay(one.sessionId)
        expect(JSON.parse(d.body).status).toBe("amount_mismatch")
      } finally {
        provider.mode.chargedAmount = null
      }
      expect((await serviceEvent(succeeded(one.sessionId, packages[0].price, { currency: "USD" }))).body.outcome).toBe("currency_mismatch")
      expect((await serviceEvent(succeeded("sess_does_not_exist", 1))).body.outcome).toBe("attempt_not_found")
      expect(await facts(p.profile)).toMatchObject({ balance: 0, credits: 0, paid: 0 })
      const ok = await serviceEvent(succeeded(one.sessionId, packages[0].price, { transactionId: "tx_shared" }))
      expect(ok.body.outcome).toBe("processed")
      const two = await startPurchase()
      expect((await serviceEvent(succeeded(two.sessionId, packages[0].price, { transactionId: "tx_shared" }))).body.outcome).toBe("transaction_reused")
      expect(await facts(p.profile)).toMatchObject({ credits: 1, paid: 1 })
      expect((await q("select failure_code from public.payment_webhook_events where processing_status = 'failed' and failure_code in ('amount_mismatch','currency_mismatch','transaction_reused')")).length).toBeGreaterThanOrEqual(3)
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  describe("10/31/33. forgery and authentication", () => {
    it("a forged, tampered or stale webhook is 401 and changes nothing; an unknown provider path is 404", async () => {
      const p = await newParent()
      await signIn(p.user)
      const { sessionId } = await startPurchase()
      const raw = JSON.stringify({ id: "evt_forged", type: "payment.succeeded", session_id: sessionId, transaction_id: "tx_f", amount: packages[0].price, currency: "IRR" })
      expect((await webhook(raw, { "content-type": "application/json" })).status).toBe(401)
      expect((await webhook(raw, { "x-stub-signature": provider.sign(raw.replace("tx_f", "tx_g")) })).status).toBe(401)
      expect((await webhook(raw, { "x-stub-signature": provider.sign(raw, Math.floor(Date.now() / 1000) - 3600) })).status).toBe(401)
      provider.mode.badSignature = true
      try {
        expect((await provider.pay(sessionId))[0].status).toBe(401)
      } finally {
        provider.mode.badSignature = false
      }
      expect((await webhook(raw, { "x-stub-signature": provider.sign(raw) }, "realgateway")).status).toBe(404)
      expect(await facts(p.profile)).toMatchObject({ balance: 0, credits: 0, paid: 0 })
    })

    it("a parent cannot confirm their own purchase: a v3 parent assertion on the event route is 401, and the browser return never trusts its query", async () => {
      const p = await newParent()
      await signIn(p.user)
      const { sessionId } = await startPurchase()
      const raw = JSON.stringify(succeeded(sessionId, packages[0].price))
      const parentToken = signWriteAssertion({ identity: ident(p.user), authenticatedAt: Date.now() - DAY_MS, requestId: rid(), method: "POST", path: "/v1/payments/events", body: raw, secret: secret() })
      expect((await serviceEvent(JSON.parse(raw), parentToken)).status).toBe(401)
      // A service token is refused on every parent route.
      const svc = signServiceAssertion({ service: "payments", requestId: rid(), method: "POST", path: "/v1/parent/candy-purchases", body: "{}", secret: secret() })
      expect((await fetch(`${backendUrl}/v1/parent/candy-purchases`, { method: "POST", body: "{}", headers: { "content-type": "application/json", "x-cartoona-internal-auth": svc } })).status).toBe(401)
      // Returning with an unpaid session (or a made-up "paid" query) credits nothing.
      const ret = await returnGET(new Request(`${ORIGIN}/api/payments/return/stub?session=${sessionId}&status=paid&amount=1`), { params: Promise.resolve({ provider: "stub" }) })
      expect(ret.headers.get("location")).toContain("payment=pending")
      expect(await facts(p.profile)).toMatchObject({ balance: 0, credits: 0 })
    })

    it("a replayed service assertion is 409 and creates no second effect", async () => {
      const p = await newParent()
      await signIn(p.user)
      const { sessionId } = await startPurchase()
      const body = succeeded(sessionId, packages[0].price)
      const raw = JSON.stringify(body)
      const token = signServiceAssertion({ service: "payments", requestId: rid(), method: "POST", path: "/v1/payments/events", body: raw, secret: secret() })
      expect((await serviceEvent(body, token)).status).toBe(200)
      expect((await serviceEvent(body, token)).status).toBe(409)
      expect(await facts(p.profile)).toMatchObject({ credits: 1 })
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  describe("22/33. outcome unknown and database failures: provider retries, still one credit", () => {
    it("database unavailable at confirmation -> webhook 500 (provider retries), nothing written; the retry processes it once", async () => {
      const p = await newParent()
      await signIn(p.user)
      const { sessionId } = await startPurchase()
      const raw = JSON.stringify({ id: `evt_${randomUUID()}`, type: "payment.succeeded", session_id: sessionId, transaction_id: `tx_${sessionId}`, amount: packages[0].price, currency: "IRR" })
      fault.down = true
      try {
        expect((await webhook(raw, { "x-stub-signature": provider.sign(raw) })).status).toBe(500)
      } finally {
        fault.down = false
      }
      expect(await facts(p.profile)).toMatchObject({ credits: 0 })
      const retry = await webhook(raw, { "x-stub-signature": provider.sign(raw) })
      expect(retry).toMatchObject({ status: 200 })
      expect(JSON.parse(retry.body).status).toBe("processed")
      expect(await facts(p.profile)).toMatchObject({ credits: 1, balance: packages[0].candy })
    })

    it("the confirmation COMMITS but its answer is lost -> 500 to the provider; the retried event is a duplicate: one credit", async () => {
      const p = await newParent()
      await signIn(p.user)
      const { sessionId } = await startPurchase()
      const raw = JSON.stringify({ id: `evt_${randomUUID()}`, type: "payment.succeeded", session_id: sessionId, transaction_id: `tx_${sessionId}`, amount: packages[0].price, currency: "IRR" })
      vi.stubEnv("BACKEND_REQUEST_TIMEOUT_MS", "400")
      fault.delayAfterMs = 900
      try {
        expect((await webhook(raw, { "x-stub-signature": provider.sign(raw) })).status).toBe(500)
      } finally {
        fault.delayAfterMs = 0
        vi.stubEnv("BACKEND_REQUEST_TIMEOUT_MS", "3000")
        await new Promise((r) => setTimeout(r, 1000))
      }
      expect(await facts(p.profile)).toMatchObject({ credits: 1 })
      const retry = await webhook(raw, { "x-stub-signature": provider.sign(raw) })
      expect(JSON.parse(retry.body).status).toBe("duplicate_event")
      expect(await facts(p.profile)).toMatchObject({ credits: 1, balance: packages[0].candy })
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  describe("19/20/27. purchase -> balance -> request -> balance, from PostgreSQL only; copied vs provisioned", () => {
    async function roundtrip(user: string, profile: string) {
      await signIn(user)
      await q("update public.parent_welcome_credits set granted_count = 1, used_count = 1 where parent_id = $1", [profile])
      const x = (await bSummary()).body.wallet.balance as number
      const { purchaseId, sessionId } = await startPurchase(packages[0])
      await provider.pay(sessionId)
      const afterBuy = (await bSummary()).body.wallet.balance as number
      const orderId = randomUUID()
      const req = await direct("POST", user, "/v1/parent/requests", {
        submissionKey: randomUUID(), orderId, type: "video", title: null, description: "d", character: "Dino Dodo", durationKey: "short", durationChoice: "5_10",
        videoScript: "story", videoStyle: null, animationStyle: null, charactersSpeak: false, childName: null, file: null,
      })
      expect(req.status).toBe(200)
      const z = req.body.candyCost as number
      const afterRequest = (await bSummary()).body.wallet.balance as number
      const history = (await bHistory()).body.purchases as Array<{ id: string; status: string }>
      const orders = (await asJson(await ordersGET(new Request(`${ORIGIN}/api/parent/orders`)))).body.orders as Array<{ id: string }>
      return { x, y: packages[0].candy, z, afterBuy, afterRequest, paidInHistory: history.find((h) => h.id === purchaseId)?.status, orderListed: orders.some((o) => o.id === orderId), supabaseDb: supabaseDbCalls().length }
    }

    it("copied pre-cutover parent: X -> X+Y -> X+Y-Z, history shows the paid purchase, the orders list shows the request", async () => {
      const r = await roundtrip(COPIED_B.user, COPIED_B.profile)
      expect(r.afterBuy).toBe(r.x + r.y)
      expect(r.afterRequest).toBe(r.x + r.y - r.z)
      expect(r).toMatchObject({ paidInHistory: "paid", orderListed: true, supabaseDb: 0 })
      const ledger = await reconciles(COPIED_B.profile)
      expect((await facts(COPIED_B.profile)).balance).toBe(r.afterRequest)
      void ledger
    })

    it("V0.1.49-provisioned parent: the identical sequence and arithmetic", async () => {
      const p = await newParent({ balance: 7 })
      const r = await roundtrip(p.user, p.profile)
      expect(r).toMatchObject({ x: 7, afterBuy: 7 + r.y, afterRequest: 7 + r.y - r.z, paidInHistory: "paid", orderListed: true, supabaseDb: 0 })
      // Every candy that moved is on the ledger: start 7 (set directly) + credits + debits = balance.
      const ledger = await reconciles(p.profile)
      expect(7 + ledger).toBe(r.afterRequest)
    })

    it("a COPIED paid purchase cannot be credited again by a provider event after the cutover", async () => {
      const before = await facts(COPIED_A.profile)
      // Give the copied verified attempt a provider session (as a real provider would have).
      await q("update public.payment_attempts set provider = 'stub', provider_session_id = 'sess_copied_paid' where purchase_id = $1", [COPIED_PAID])
      const r = await serviceEvent(succeeded("sess_copied_paid", 1))
      expect(r.body.outcome).toBe("already_paid")
      expect(await facts(COPIED_A.profile)).toEqual(before)
      expect((await q("select count(*)::int n from public.candy_transactions where idempotency_key = $1", [`purchase_credit:${COPIED_PAID}`]))[0]).toEqual({ n: 1 })
    })

    it("a COPIED pending purchase with a reserved coupon is paid at the discounted price and the coupon becomes redeemed", async () => {
      await signIn(COPIED_A.user)
      const before = await facts(COPIED_A.profile)
      const pay = await bPay(COPIED_PENDING_WITH_COUPON)
      expect(pay.status).toBe(200)
      const session = provider.sessions.get(sessionOf(pay.body.checkoutUrl))!
      const final = (await q<{ final_price_amount: number; candy_amount: number }>("select final_price_amount, candy_amount from public.candy_purchases where id = $1", [COPIED_PENDING_WITH_COUPON]))[0]
      expect(session.amount).toBe(final.final_price_amount)
      await provider.pay(session.id)
      expect((await q("select status from public.coupon_redemptions where purchase_id = $1", [COPIED_PENDING_WITH_COUPON]))[0]).toEqual({ status: "redeemed" })
      expect((await facts(COPIED_A.profile)).balance).toBe(before.balance + final.candy_amount)
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  describe("13. admin coupon management in PostgreSQL (definitions + limits + usage in one database)", () => {
    it("admin lists (with usage counts), creates, and the parent flow can use the new coupon at once; stale updates are 409; a parent is 403", async () => {
      await signIn(ADMIN, "admin")
      const list = await asJson(await adminListGET(new Request(`${ORIGIN}/api/admin/coupons?search=welcome`)))
      expect(list.status).toBe(200)
      expect(list.body.coupons.find((c: { code: string }) => c.code === "WELCOME10")).toMatchObject({ name: "Welcome 10%", discountType: "percentage" })
      const create = await asJson(await adminCreatePOST(new Request(`${ORIGIN}/api/admin/coupons`, {
        method: "POST",
        headers: browserHeaders,
        body: JSON.stringify({ code: "ADMIN25", name: "Admin 25", description: null, discountType: "fixed_amount", discountValue: 2500, isActive: true, startsAt: null, expiresAt: null, globalUsageLimit: 1, perParentUsageLimit: null, minimumPurchaseAmount: null, maximumDiscountAmount: null, packageIds: [] }),
      })))
      expect(create.status).toBe(201)
      const couponId = create.body.coupon.id as string
      const detail = await asJson(await adminDetailGET(new Request(`${ORIGIN}/api/admin/coupons/${couponId}`), { params: Promise.resolve({ id: couponId }) }))
      expect(detail.body.coupon).toMatchObject({ code: "ADMIN25", createdBy: { id: ADMIN }, reservedCount: 0 })

      const p = await newParent()
      await signIn(p.user)
      const { body } = await bCreate(packages[0].id)
      expect((await bApply(body.purchase.id, "admin25")).body.coupon).toMatchObject({ discountAmount: 2500 })

      await signIn(ADMIN, "admin")
      const stale = await asJson(await adminPATCH(new Request(`${ORIGIN}/api/admin/coupons/${couponId}`, {
        method: "PATCH",
        headers: browserHeaders,
        body: JSON.stringify({ ...create.body.coupon, expectedUpdatedAt: "2020-01-01T00:00:00.000000+00:00", description: null }),
      }), { params: Promise.resolve({ id: couponId }) }))
      expect(stale.status).toBe(409)
      const refreshed = await asJson(await adminDetailGET(new Request(`${ORIGIN}/api/admin/coupons/${couponId}`), { params: Promise.resolve({ id: couponId }) }))
      expect(refreshed.body.coupon).toMatchObject({ reservedCount: 1 })
      const ok = await asJson(await adminPATCH(new Request(`${ORIGIN}/api/admin/coupons/${couponId}`, {
        method: "PATCH",
        headers: browserHeaders,
        body: JSON.stringify({ code: "ADMIN25", name: "Admin 25 renamed", description: null, discountType: "fixed_amount", discountValue: 2500, isActive: true, startsAt: null, expiresAt: null, globalUsageLimit: 1, perParentUsageLimit: null, minimumPurchaseAmount: null, maximumDiscountAmount: null, packageIds: [], expectedUpdatedAt: refreshed.body.coupon.updatedAt }),
      }), { params: Promise.resolve({ id: couponId }) }))
      expect(ok).toMatchObject({ status: 200, body: { coupon: { name: "Admin 25 renamed" } } })

      await signIn(p.user)
      expect((await asJson(await adminListGET(new Request(`${ORIGIN}/api/admin/coupons`)))).status).toBe(403)
      expect((await asJson(await adminCreatePOST(new Request(`${ORIGIN}/api/admin/coupons`, { method: "POST", headers: browserHeaders, body: "{}" })))).status).toBe(403)
      expect((await direct("GET", p.user, "/v1/admin/coupons")).status).toBe(403)
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  describe("34. local timings (Docker, one machine - NOT production estimates)", () => {
    it("purchase creation, confirmation, duplicate confirmation, history, summary, full purchase -> request roundtrip", async () => {
      const N = 20
      const time = async (work: () => Promise<unknown>) => {
        const xs: number[] = []
        for (let i = 0; i < N; i++) {
          const t = performance.now()
          await work()
          xs.push(performance.now() - t)
        }
        return xs
      }
      const p = await newParent({ balance: 100_000 })
      await signIn(p.user)
      vi.stubEnv("RATE_LIMIT_DISABLED", "1") // timings only; the limiter is covered by rate-limit-routes
      const create = await time(() => bCreate(packages[0].id))
      const pending = await Promise.all(Array.from({ length: N }, () => startPurchase()))
      let i = 0
      const confirm = await time(() => serviceEvent(succeeded(pending[i++].sessionId, packages[0].price)))
      const dupBody = succeeded(pending[0].sessionId, packages[0].price)
      const duplicate = await time(() => serviceEvent({ ...dupBody, eventId: `evt_${randomUUID()}` }))
      const history = await time(() => bHistory())
      const summary = await time(() => bSummary())
      const roundtrip = await time(async () => {
        const s = await startPurchase()
        await provider.pay(s.sessionId)
        await direct("POST", p.user, "/v1/parent/requests", {
          submissionKey: randomUUID(), orderId: randomUUID(), type: "video", title: null, description: "d", character: "Dino Dodo", durationKey: "short", durationChoice: "5_10",
          videoScript: "s", videoStyle: null, animationStyle: null, charactersSpeak: false, childName: null, file: null,
        })
        await bSummary()
      })
      const line = (l: string, xs: number[]) => `  ${l.padEnd(62)} median ${pct(xs, 50).toFixed(2)} ms, p90 ${pct(xs, 90).toFixed(2)} ms\n`
      process.stderr.write(
        `[purchase timings, local Docker PostgreSQL 17 + stub Auth + stub provider, ${N} each]\n` +
          line("Next purchase creation (CSRF, provider check, v3 -> Fastify -> PG)", create) +
          line("provider confirmation transaction (service event -> confirm fn)", confirm) +
          line("duplicate confirmation (already paid)", duplicate) +
          line("Next purchase history (PG)", history) +
          line("Next account summary after purchases (PG)", summary) +
          line("full roundtrip: create + pay + webhook + request + summary", roundtrip),
      )
      vi.stubEnv("RATE_LIMIT_DISABLED", "")
      await reconciles(p.profile)
    })
  })
})
