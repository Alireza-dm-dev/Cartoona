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
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`)
  },
}))

import type { FastifyInstance } from "fastify"
import { buildBackendApp } from "@/backend/src/app"
import { GET as referralsGET } from "@/app/api/referrals/route"
import { POST as bindPOST } from "@/app/api/referrals/bind/route"
import { GET as adminReferralsGET } from "@/app/api/admin/referrals/route"
import { PATCH as settingsPATCH } from "@/app/api/admin/referrals/settings/route"
import { GET as adminHomepageGET, PUT as homepagePUT } from "@/app/api/admin/homepage/route"
import { POST as homepageMediaPOST, DELETE as homepageMediaDELETE } from "@/app/api/admin/homepage/media/[slot]/route"
import { PUT as heroLayoutPUT } from "@/app/api/admin/homepage/hero-layout/route"
import { POST as examplesPOST, GET as examplesGET } from "@/app/api/admin/examples/route"
import { PATCH as examplePATCH, DELETE as exampleDELETE } from "@/app/api/admin/examples/[exampleId]/route"
import { PUT as exampleMediaPUT } from "@/app/api/admin/examples/[exampleId]/media/route"
import { PATCH as examplePublishPATCH } from "@/app/api/admin/examples/[exampleId]/publish/route"
import { POST as accountSetupPOST } from "@/app/api/parent/account-setup/route"
import { POST as consentPOST } from "@/app/api/parent-consent/route"
import { GET as summaryGET } from "@/app/api/parent/account-summary/route"
import { POST as purchasesPOST, GET as purchasesGET } from "@/app/api/candy-purchases/route"
import { GET as ordersGET } from "@/app/api/parent/orders/route"
import { GET as galleryGET } from "@/app/api/parent/gallery/route"
import { gateAdminPage, gateParentPage } from "@/lib/auth/page-gates"
import { resolveCallerRole } from "@/lib/auth/backend-role"
import { getResolvedHomepage } from "@/lib/homepage/resolver"
import { loadPublicExamples } from "@/lib/examples/backend-examples"
import { fetchParentOrderDetail, verifyParentOrderDetailCaller } from "@/lib/parent/orders/backend-order-detail"
import { DEFAULT_HOMEPAGE_CONTENT } from "@/lib/homepage/default-content"
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
 * V0.1.53 - NO Supabase DATABASE at runtime, on REAL local services
 * (opt-in: CARTOONA_PLAIN_PG=docker):
 *
 *   Supabase-shaped source -> V0.1.44 copy -> plain PostgreSQL 17 (0001-0019)
 *   stub Supabase Auth + in-memory Storage (real @supabase/ssr, supabase-js)
 *   -> Next route handlers / page gates / loaders -> Fastify (listening,
 *   RESTRICTED login role) -> SELECTs + trusted functions.
 *
 * The stub answers /rest/v1 with 404 and records every request, so any Supabase
 * database call by a migrated path shows up in `restCalls()`; every flow below
 * ends by asserting there was none. Nothing contacts any hosted service.
 */

const enabled = process.env.CARTOONA_PLAIN_PG === "docker"
const id = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`
const SRC = `sds_${id}`
const TGT = `sdt_${id}`
const ROLE = `cartoona_app_sd${id}`
const DB_PASSWORD = randomBytes(24).toString("hex")
const AUTH_SECRET = randomBytes(32).toString("hex")
const ORIGIN = "http://localhost:3000"

const A = { user: "a1000000-0000-4000-8000-000000000001", profile: "b1000000-0000-4000-8000-000000000001" } // copied parent, referrer of B
const B = { user: "a1000000-0000-4000-8000-000000000002", profile: "b1000000-0000-4000-8000-000000000002" } // copied parent, referred by A
const ADMIN = "a1000000-0000-4000-8000-000000000003"
const SUPER = "a1000000-0000-4000-8000-000000000005"
const ORDER_A_DELIVERED = "a2000000-0000-4000-8000-000000000001"

let env: PgEnv
let backend: FastifyInstance | null = null
let backendUrl = ""
let stub: StubAuth | null = null
let appPool: Pool
let owner: Pool
const keep = new Set<string>()
const perf: Record<string, { median: number; p90: number }> = {}

// ── assertions (direct to the backend) ───────────────────────────────────────
const ident = (s: string) => toVerifiedIdentity({ provider: "supabase", subject: s })
const secret = () => Buffer.from(AUTH_SECRET, "hex")
const rid = () => `sd-${randomBytes(4).toString("hex")}`
type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE"
async function direct(method: Method, user: string | null, p: string, body?: unknown, query = "", extraHeaders: Record<string, string> = {}) {
  const raw = body === undefined ? undefined : JSON.stringify(body)
  const headers: Record<string, string> = { ...(raw ? { "content-type": "application/json" } : {}), ...extraHeaders }
  if (user !== null) {
    headers["x-cartoona-internal-auth"] =
      method === "GET"
        ? signAssertion({ identity: ident(user), authenticatedAt: Date.now() - DAY_MS, requestId: rid(), method, path: p, secret: secret() })
        : signWriteAssertion({ identity: ident(user), authenticatedAt: Date.now() - DAY_MS, requestId: rid(), method, path: p, body: raw ?? "", secret: secret() })
  }
  const res = await fetch(`${backendUrl}${p}${query}`, { method, body: raw, headers })
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> } // eslint-disable-line @typescript-eslint/no-explicit-any
}

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
  return { user, profile }
}
const codeOf = async (profile: string) => (await q<{ referral_code: string }>("select referral_code from public.parent_profiles where id = $1", [profile]))[0].referral_code
const relCount = async (referred: string) => Number((await q<{ n: string }>("select count(*) n from public.referral_relationships where referred_parent_id = $1", [referred]))[0].n)
const ledgerCount = async () => Number((await q<{ n: string }>("select count(*) n from public.candy_transactions"))[0].n)
const walletSum = async () => Number((await q<{ n: string }>("select coalesce(sum(balance),0) n from public.candy_wallets"))[0].n)

// ── Next harness ─────────────────────────────────────────────────────────────
async function signIn(userId: string) {
  if (stub) for (const k of stub.storage.objects) keep.add(k)
  await stub?.close()
  stub = await startStubAuth({ userId, role: "parent" })
  for (const k of keep) stub.storage.objects.add(k)
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", stub.url)
  cookies.jar = cookieJar([stub.cookie()])
  setRateLimitStore(new InMemoryRateLimitStore())
}
const restCalls = () => (stub?.requests ?? []).filter((r) => r.path.startsWith("/rest/v1/"))
const jsonHeaders = { "content-type": "application/json", origin: ORIGIN, "sec-fetch-site": "same-origin" }
const formHeaders = { origin: ORIGIN, "sec-fetch-site": "same-origin" }
const asJson = async (res: Response) => ({ status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> }) // eslint-disable-line @typescript-eslint/no-explicit-any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const call = async (handler: (...a: any[]) => Promise<Response>, method: string, p: string, body?: unknown, headers: Record<string, string> = jsonHeaders) =>
  asJson(await handler(new Request(`${ORIGIN}${p}`, { method, headers, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) })))
const callP = async (handler: (...a: any[]) => Promise<Response>, params: any, method: string, p: string, body?: unknown, headers: Record<string, string> = jsonHeaders) => // eslint-disable-line @typescript-eslint/no-explicit-any
  asJson(await handler(new Request(`${ORIGIN}${p}`, { method, headers, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) }), { params: Promise.resolve(params) }))
const to = async (p: Promise<unknown>) => p.then(() => "no-redirect", (e: Error) => e.message)
const pngBytes = (w = 64, h = 64) => {
  const b = new Uint8Array(new ArrayBuffer(40))
  b.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
  new DataView(b.buffer).setUint32(16, w)
  new DataView(b.buffer).setUint32(20, h)
  return b
}
const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))]
async function timed(name: string, n: number, work: (i: number) => Promise<unknown>) {
  const xs: number[] = []
  for (let i = 0; i < n; i++) {
    const t = performance.now()
    await work(i)
    xs.push(performance.now() - t)
  }
  perf[name] = { median: Math.round(pct(xs, 50) * 10) / 10, p90: Math.round(pct(xs, 90) * 10) / 10 }
}

describe.skipIf(!enabled)("V0.1.53 no Supabase database at runtime (local Docker PostgreSQL 17)", () => {
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
    vi.stubEnv("SUPABASE_SECRET_KEY", "service-key-for-stub")
    vi.stubEnv("BACKEND_REQUEST_TIMEOUT_MS", "3000")
    const app = buildBackendApp({ db: () => ({ query: (t: string, v?: readonly unknown[]) => getPool().query(t, v as unknown[]) }) as Queryable, closeDb: async () => {} })
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
  describe("37. global privilege audit of the application role", () => {
    it("no table is writable by the application role (the one column-level UPDATE is parent_profiles.full_name/updated_at)", async () => {
      const tables = (await q<{ tablename: string }>("select tablename from pg_tables where schemaname = 'public'")).map((r) => r.tablename)
      expect(tables.length).toBeGreaterThan(30)
      for (const t of tables) {
        for (const priv of ["INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"]) {
          const has = (await q<{ h: boolean }>("select has_table_privilege($1, $2::regclass, $3) h", [ROLE, `public.${t}`, priv]))[0].h
          expect(has, `${t} ${priv}`).toBe(false)
        }
      }
      const cols = await q<{ table_name: string; column_name: string }>(
        "select table_name, column_name from information_schema.column_privileges where grantee = 'cartoona_app' and privilege_type = 'UPDATE' and table_schema = 'public' order by 1, 2",
      )
      expect(cols).toEqual([
        { table_name: "parent_profiles", column_name: "full_name" },
        { table_name: "parent_profiles", column_name: "updated_at" },
      ])
    })

    it("the nonce table is not even readable; money and ledger tables are read-only", async () => {
      expect(await sqlState(appPool.query("select 1 from public.internal_write_nonces limit 1"))).toBe("42501")
      for (const t of ["candy_wallets", "candy_transactions", "candy_purchases", "payment_attempts", "coupon_redemptions", "referral_relationships", "referral_program_settings"]) {
        expect(await sqlState(appPool.query(`delete from public.${t}`)), t).toBe("42501")
      }
    })

    it("the SECURITY DEFINER functions the role may execute are exactly the audited list (32)", async () => {
      const rows = (await q<{ proname: string }>(
        `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.prosecdef and has_function_privilege($1, p.oid, 'execute') order by 1`,
        [ROLE],
      )).map((r) => r.proname)
      expect(rows).toEqual([
        "apply_coupon_to_purchase_trusted", "approve_final_media_trusted", "bind_parent_referral_code_trusted", "confirm_payment_attempt_trusted",
        "consume_internal_write_nonce", "create_candy_purchase_trusted", "create_coupon_trusted", "create_example_trusted",
        "create_parent_request_trusted", "create_payment_attempt_trusted", "delete_example_trusted", "delete_homepage_media_trusted",
        "fail_payment_attempt_trusted", "get_admin_referral_overview_trusted", "get_admin_referral_relationships_trusted",
        "get_order_status_history_admin_trusted", "get_parent_referral_summary_trusted", "provision_supabase_parent_identity",
        "record_final_media_access_audit_trusted", "record_final_media_trusted", "record_homepage_media_replacement_trusted",
        "record_parent_consent_trusted", "record_payment_attempt_session_trusted", "replace_example_media_trusted",
        "supersede_final_media_trusted", "update_admin_referral_program_settings_trusted", "update_coupon_trusted", "update_example_trusted",
        "update_homepage_content_trusted", "update_homepage_hero_layout_trusted", "update_order_status_trusted",
        "validate_coupon_for_purchase_trusted",
      ].sort())
      // none is executable by PUBLIC
      const pub = await q<{ proname: string }>(
        `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname like any (array['%referral%trusted','%example%trusted','%homepage%trusted']) and has_function_privilege('public', p.oid, 'execute')`,
      )
      expect(pub).toEqual([])
    })

    it("CMS and referral functions refuse a non-admin / non-parent inside PostgreSQL even with EXECUTE granted", async () => {
      expect(await sqlState(appPool.query("select * from public.update_homepage_content_trusted($1, '{}'::jsonb, 1)", [A.user]))).toBe("P0001")
      expect(await sqlState(appPool.query("select * from public.create_example_trusted($1, $2, 'video', 't', '', 'd', $3, false, 1)", [A.user, randomUUID(), "examples/x/y.png"]))).toBe("P0001")
      expect(await sqlState(appPool.query("select * from public.delete_homepage_media_trusted($1, 'hero.background')", [A.user]))).toBe("P0001")
      expect((await appPool.query("select * from public.get_admin_referral_overview_trusted($1)", [A.user])).rowCount).toBe(0)
      expect((await appPool.query("select * from public.update_admin_referral_program_settings_trusted($1, true, 1, now())", [A.user])).rows[0].status).toBe("forbidden")
      // an ADMIN has no parent referral summary or binding
      expect((await appPool.query("select * from public.get_parent_referral_summary_trusted($1)", [ADMIN])).rowCount).toBe(0)
      expect((await appPool.query("select * from public.bind_parent_referral_code_trusted($1, 'CT')", [ADMIN])).rows[0].status).toBe("session_expired")
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  describe("3-6. role resolution and page gates come from PostgreSQL, never from Supabase", () => {
    it("parent / admin / super_admin resolve through the backend; a stub that CLAIMS admin for a parent is ignored", async () => {
      await signIn(A.user)
      stub!.options.role = "admin" // the old Supabase `users` read would have believed this
      const parent = await resolveCallerRole()
      expect(parent).toMatchObject({ ok: true, role: "parent", userId: A.user })
      await signIn(ADMIN)
      expect(await resolveCallerRole()).toMatchObject({ ok: true, role: "admin" })
      await signIn(SUPER)
      expect(await resolveCallerRole()).toMatchObject({ ok: true, role: "super_admin" })
      expect(restCalls()).toEqual([])
    })

    it("gateAdminPage: admins in; a parent is sent to /dashboard before any admin markup; signed out -> admin login", async () => {
      await signIn(ADMIN)
      expect((await gateAdminPage()).ok).toBe(true)
      await signIn(A.user)
      stub!.options.role = "admin"
      expect(await to(gateAdminPage())).toBe("REDIRECT:/dashboard")
      cookies.jar = cookieJar([])
      expect(await to(gateAdminPage("/admin/requests"))).toBe("REDIRECT:/admin-login?from=%2Fadmin%2Frequests")
      expect(restCalls()).toEqual([])
    })

    it("gateParentPage: parent in; admin allowed on /dashboard but sent to /admin from parent-only steps", async () => {
      await signIn(A.user)
      expect((await gateParentPage("/dashboard")).ok).toBe(true)
      await signIn(ADMIN)
      expect((await gateParentPage("/dashboard")).ok).toBe(true)
      expect(await to(gateParentPage("/complete-request", { adminTo: "/admin" }))).toBe("REDIRECT:/admin")
      expect(await to(gateParentPage("/parent-consent", { adminTo: "/admin", allowUnlinked: true }))).toBe("REDIRECT:/admin")
    })

    it("a DELETED account and an UNLINKED identity are denied; an unlinked one is routed to the bootstrap page, never given access", async () => {
      const p = await newParent()
      await q("update public.users set deleted_at = now() where id = $1", [p.user])
      await signIn(p.user)
      expect(await resolveCallerRole()).toEqual({ ok: false, reason: "forbidden" })
      expect(await to(gateAdminPage())).toBe("REDIRECT:/dashboard")
      expect(await to(gateParentPage("/dashboard"))).toBe("REDIRECT:/login?from=%2Fdashboard")
      await signIn(randomUUID())
      expect(await resolveCallerRole()).toEqual({ ok: false, reason: "identity_not_linked" })
      expect(await to(gateParentPage("/dashboard"))).toBe("REDIRECT:/parent-consent")
      expect(await gateParentPage("/parent-consent", { allowUnlinked: true })).toEqual({ ok: true, resolution: null })
      expect(await to(gateAdminPage())).toBe("REDIRECT:/dashboard")
    })

    it("sessions invalidated in PostgreSQL end the session at the gate (sessions_not_before)", async () => {
      const p = await newParent()
      await q("update public.users set sessions_not_before = now() + interval '1 hour' where id = $1", [p.user])
      await signIn(p.user)
      const r = await resolveCallerRole()
      expect(r).toEqual({ ok: false, reason: "session_expired" })
      expect(await to(gateParentPage("/dashboard"))).toBe("REDIRECT:/login?reason=session_expired&from=%2Fdashboard")
    })

    it("a backend outage is neither access nor a sign-out: the gates report unavailable", async () => {
      await signIn(ADMIN)
      vi.stubEnv("BACKEND_INTERNAL_URL", "http://127.0.0.1:1")
      try {
        expect(await resolveCallerRole()).toEqual({ ok: false, reason: "unavailable" })
        expect(await gateAdminPage()).toEqual({ ok: false, unavailable: true })
        expect(await gateParentPage("/dashboard")).toEqual({ ok: false, unavailable: true })
      } finally {
        vi.stubEnv("BACKEND_INTERNAL_URL", backendUrl)
      }
      expect(stub!.requests.some((r) => r.path.includes("logout") || r.path.includes("signout"))).toBe(false)
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  describe("9-12. referrals in PostgreSQL: summary, one-time binding, abuse, settings", () => {
    it("the summary of a COPIED referrer: code, program, referred count; and a fresh parent has its own code", async () => {
      const r = await direct("GET", A.user, "/v1/parent/referrals")
      expect(r.status).toBe(200)
      expect(r.body).toMatchObject({ referralCode: await codeOf(A.profile), isEnabled: true, isBound: false, referredCount: 1 })
      expect((await direct("GET", ADMIN, "/v1/parent/referrals")).status).toBe(403)
      expect((await direct("GET", A.user, "/v1/parent/referrals", undefined, "?parentId=x")).status).toBe(400)
      const b = await direct("GET", B.user, "/v1/parent/referrals")
      expect(b.body).toMatchObject({ isBound: true, referredCount: 0 }) // the copied relationship survived
    })

    it("binding: valid code binds once, same code is idempotent, another code is refused, nothing moves in the wallet or ledger", async () => {
      const referrer = await newParent()
      const other = await newParent()
      const p = await newParent()
      const ledger0 = await ledgerCount()
      const wallets0 = await walletSum()
      const first = await direct("POST", p.user, "/v1/parent/referrals/bind", { code: await codeOf(referrer.profile) })
      expect(first.body.status).toBe("bound")
      expect((await direct("POST", p.user, "/v1/parent/referrals/bind", { code: await codeOf(referrer.profile) })).body.status).toBe("already_bound_same")
      expect((await direct("POST", p.user, "/v1/parent/referrals/bind", { code: await codeOf(other.profile) })).body.status).toBe("already_bound_other")
      expect(await relCount(p.profile)).toBe(1)
      // lower-case / spaced input normalizes to the same code
      expect((await direct("POST", p.user, "/v1/parent/referrals/bind", { code: ` ${(await codeOf(referrer.profile)).toLowerCase()} ` })).body.status).toBe("already_bound_same")
      // there is NO referral reward in the schema: no ledger row, no balance change
      expect(await ledgerCount()).toBe(ledger0)
      expect(await walletSum()).toBe(wallets0)
      const sum = await direct("GET", referrer.user, "/v1/parent/referrals")
      expect(sum.body.referredCount).toBe(1)
    })

    it("self-referral, an unknown code and malformed codes are all `invalid_code`; no relationship is created", async () => {
      const p = await newParent()
      expect((await direct("POST", p.user, "/v1/parent/referrals/bind", { code: await codeOf(p.profile) })).body.status).toBe("invalid_code")
      expect((await direct("POST", p.user, "/v1/parent/referrals/bind", { code: "CT000000000000" })).body.status).toBe("invalid_code")
      expect((await direct("POST", p.user, "/v1/parent/referrals/bind", { code: "'; drop table x; --" })).body.status).toBe("invalid_code")
      expect(await relCount(p.profile)).toBe(0)
    })

    it("the browser can supply the code and NOTHING else: ids, amounts, balances and extra keys are 400, cross-parent forgery binds nobody else", async () => {
      const referrer = await newParent()
      const victim = await newParent()
      const p = await newParent()
      const code = await codeOf(referrer.profile)
      for (const body of [
        { code, referrerId: referrer.profile }, { code, parentId: victim.profile }, { code, reward: 99999 }, { code, balance: 1000 },
        { code: 5 }, { code: "" }, { code: "x".repeat(101) }, {}, [], null,
      ]) expect((await direct("POST", p.user, "/v1/parent/referrals/bind", body as never)).status, JSON.stringify(body)).toBe(400)
      expect(await relCount(victim.profile)).toBe(0)
      expect(await relCount(p.profile)).toBe(0)
      // the principal is the only subject: binding as p never binds the victim
      await direct("POST", p.user, "/v1/parent/referrals/bind", { code })
      expect(await relCount(p.profile)).toBe(1)
      expect(await relCount(victim.profile)).toBe(0)
      // an admin cannot bind, and an unsigned/forged request is refused
      expect((await direct("POST", ADMIN, "/v1/parent/referrals/bind", { code })).status).toBe(403)
      expect((await direct("POST", null, "/v1/parent/referrals/bind", { code })).status).toBe(401)
    })

    it("CONCURRENCY: 14 parallel binds of one referred parent -> exactly one `bound`, one relationship", async () => {
      const referrer = await newParent()
      const p = await newParent()
      const code = await codeOf(referrer.profile)
      const results = await Promise.all(Array.from({ length: 14 }, () => direct("POST", p.user, "/v1/parent/referrals/bind", { code })))
      const statuses = results.map((r) => r.body.status as string)
      expect(statuses.filter((s) => s === "bound")).toHaveLength(1)
      expect(statuses.filter((s) => s === "already_bound_same")).toHaveLength(13)
      expect(await relCount(p.profile)).toBe(1)
    })

    it("CONCURRENCY: two different referrers racing for one parent -> one relationship, the loser is `already_bound_other`", async () => {
      const r1 = await newParent()
      const r2 = await newParent()
      const p = await newParent()
      const results = await Promise.all([
        ...Array.from({ length: 6 }, async () => direct("POST", p.user, "/v1/parent/referrals/bind", { code: await codeOf(r1.profile) })),
        ...Array.from({ length: 6 }, async () => direct("POST", p.user, "/v1/parent/referrals/bind", { code: await codeOf(r2.profile) })),
      ])
      expect(results.filter((r) => r.body.status === "bound")).toHaveLength(1)
      expect(await relCount(p.profile)).toBe(1)
      expect(results.every((r) => ["bound", "already_bound_same", "already_bound_other"].includes(r.body.status))).toBe(true)
    })

    it("the binding attempt limit (5 per minute) is enforced in the database", async () => {
      const referrer = await newParent()
      const p = await newParent()
      for (let i = 0; i < 5; i++) expect((await direct("POST", p.user, "/v1/parent/referrals/bind", { code: `CT00000000000${i}` })).body.status).toBe("invalid_code")
      expect((await direct("POST", p.user, "/v1/parent/referrals/bind", { code: await codeOf(referrer.profile) })).body.status).toBe("rate_limited")
      expect(await relCount(p.profile)).toBe(0)
    })

    it("admin settings: parent 403, validation, optimistic concurrency (one winner), immutable history, and a disabled program refuses binds", async () => {
      const overview = async () => (await direct("GET", ADMIN, "/v1/admin/referrals")).body.overview
      const o = await overview()
      const patch = (user: string, body: unknown) => direct("PATCH", user, "/v1/admin/referrals/settings", body)
      expect((await patch(A.user, { isEnabled: true, rewardBasisPoints: 1, expectedUpdatedAt: o.settingsUpdatedAt })).status).toBe(403)
      expect((await patch(ADMIN, { isEnabled: true, rewardBasisPoints: 1 })).status).toBe(400)
      expect((await patch(ADMIN, { isEnabled: true, rewardBasisPoints: 1.5, expectedUpdatedAt: o.settingsUpdatedAt })).status).toBe(400)
      expect((await patch(ADMIN, { isEnabled: true, rewardBasisPoints: 10001, expectedUpdatedAt: o.settingsUpdatedAt })).body.status).toBe("invalid_settings")
      const history0 = o.settingsHistoryCount
      // 6 concurrent writers holding the SAME token: exactly one `updated`, the rest `conflict`
      const raced = await Promise.all(Array.from({ length: 6 }, () => patch(ADMIN, { isEnabled: false, rewardBasisPoints: 2500, expectedUpdatedAt: o.settingsUpdatedAt })))
      expect(raced.filter((r) => r.body.status === "updated")).toHaveLength(1)
      expect(raced.filter((r) => r.body.status === "conflict")).toHaveLength(5)
      const after = await overview()
      expect(after).toMatchObject({ isEnabled: false, rewardBasisPoints: 2500, settingsHistoryCount: history0 + 1 })
      // unchanged values write nothing
      expect((await patch(SUPER, { isEnabled: false, rewardBasisPoints: 2500, expectedUpdatedAt: after.settingsUpdatedAt })).body.status).toBe("unchanged")
      expect((await overview()).settingsHistoryCount).toBe(history0 + 1)
      // disabled program: summary says so and a bind is refused
      const referrer = await newParent()
      const p = await newParent()
      expect((await direct("GET", referrer.user, "/v1/parent/referrals")).body).toMatchObject({ isEnabled: false, rewardBasisPoints: 2500 })
      expect((await direct("POST", p.user, "/v1/parent/referrals/bind", { code: await codeOf(referrer.profile) })).body.status).toBe("program_disabled")
      expect(await relCount(p.profile)).toBe(0)
      // restore
      const cur = await overview()
      expect((await patch(ADMIN, { isEnabled: true, rewardBasisPoints: 1500, expectedUpdatedAt: cur.settingsUpdatedAt })).body.status).toBe("updated")
    })

    it("the admin list: parents refused, bounds enforced, pages and totals correct", async () => {
      expect((await direct("GET", A.user, "/v1/admin/referrals")).status).toBe(403)
      expect((await direct("GET", ADMIN, "/v1/admin/referrals", undefined, "?bogus=1")).status).toBe(400)
      expect((await direct("GET", ADMIN, "/v1/admin/referrals", undefined, `?search=${"x".repeat(101)}`)).status).toBe(400)
      const r = await direct("GET", ADMIN, "/v1/admin/referrals", undefined, "?pageSize=1000")
      expect(r.status).toBe(200)
      expect(r.body.pageSize).toBe(50)
      expect(r.body.total).toBeGreaterThanOrEqual(1)
      expect(r.body.relationships.some((x: { referralCodeSnapshot: string }) => typeof x.referralCodeSnapshot === "string")).toBe(true)
    })

    it("through Next: CSRF guard, verified session, no Supabase database call; the same answers as the backend", async () => {
      const referrer = await newParent()
      const p = await newParent()
      await signIn(p.user)
      const code = await codeOf(referrer.profile)
      expect((await call(bindPOST, "POST", "/api/referrals/bind", { code }, { ...jsonHeaders, origin: "https://evil.example" })).status).toBe(403)
      expect((await call(bindPOST, "POST", "/api/referrals/bind", { code }, { "content-type": "text/plain", origin: ORIGIN })).status).toBe(415)
      const ok = await call(bindPOST, "POST", "/api/referrals/bind", { code })
      expect([ok.status, ok.body.status]).toEqual([200, "bound"])
      const again = await call(bindPOST, "POST", "/api/referrals/bind", { code })
      expect(again.body.status).toBe("already_bound")
      const other = await newParent()
      expect((await call(bindPOST, "POST", "/api/referrals/bind", { code: await codeOf(other.profile) })).status).toBe(409)
      expect((await call(bindPOST, "POST", "/api/referrals/bind", { code: "CT000000000000" })).status).toBe(409) // already bound wins over validation
      const sum = await asJson(await referralsGET(new Request(`${ORIGIN}/api/referrals`)))
      expect(sum.body).toMatchObject({ referralCode: await codeOf(p.profile), binding: { isBound: true }, program: { isEnabled: true } })
      // admin routes
      expect((await asJson(await adminReferralsGET(new Request(`${ORIGIN}/api/admin/referrals`)))).status).toBe(403)
      await signIn(ADMIN)
      const list = await asJson(await adminReferralsGET(new Request(`${ORIGIN}/api/admin/referrals?pageSize=5`)))
      expect(list.status).toBe(200)
      expect(list.body.settings.isEnabled).toBe(true)
      const st = await call(settingsPATCH, "PATCH", "/api/admin/referrals/settings", { isEnabled: true, rewardBasisPoints: 1500, expectedUpdatedAt: list.body.settings.updatedAt })
      expect([st.status, st.body.status]).toEqual([200, "unchanged"])
      await signIn(p.user)
      expect((await call(settingsPATCH, "PATCH", "/api/admin/referrals/settings", { isEnabled: false, rewardBasisPoints: 1, expectedUpdatedAt: list.body.settings.updatedAt })).status).toBe(403)
      expect(restCalls()).toEqual([])
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  describe("13-15. homepage CMS in PostgreSQL", () => {
    const publicGet = () => direct("GET", null, "/v1/public/homepage")

    it("the public read is anonymous, complete and private-data-free", async () => {
      const r = await publicGet()
      expect(r.status).toBe(200)
      expect(r.body.content.revision).toBeGreaterThanOrEqual(1)
      expect(r.body.heroLayout.tvRect).toMatchObject({ x: expect.any(Number) })
      expect(JSON.stringify(r.body)).not.toMatch(/updated_by|user_id|email|@/)
      expect((await direct("GET", null, "/v1/public/homepage", undefined, "?x=1")).status).toBe(400)
    })

    it("content writes: admin only, optimistic revision, structure checked, one winner under concurrency", async () => {
      const cur = (await publicGet()).body.content as { contentJson: Record<string, any>; revision: number } // eslint-disable-line @typescript-eslint/no-explicit-any
      const next = { ...cur.contentJson, hero: { ...cur.contentJson.hero, title: "V0.1.53 title" } }
      const put = (user: string, body: unknown) => direct("PUT", user, "/v1/admin/homepage", body)
      expect((await put(A.user, { content: next, expectedRevision: cur.revision })).status).toBe(403)
      expect((await put(ADMIN, { content: next })).status).toBe(400)
      expect((await put(ADMIN, { content: next, expectedRevision: 0 })).status).toBe(400)
      const { hero, ...noHero } = next // eslint-disable-line @typescript-eslint/no-unused-vars
      expect((await put(ADMIN, { content: noHero, expectedRevision: cur.revision })).body.error).toBe("homepage_admin_invalid")
      const raced = await Promise.all(Array.from({ length: 6 }, (_, i) => put(i % 2 ? ADMIN : SUPER, { content: next, expectedRevision: cur.revision })))
      expect(raced.filter((r) => r.status === 200)).toHaveLength(1)
      expect(raced.filter((r) => r.status === 409 && r.body.error === "homepage_admin_conflict")).toHaveLength(5)
      const after = (await publicGet()).body.content
      expect(after.revision).toBe(cur.revision + 1)
      expect(after.contentJson.hero.title).toBe("V0.1.53 title")
      expect((await q<{ updated_by_user_id: string }>("select updated_by_user_id from public.homepage_content"))[0].updated_by_user_id).toMatch(new RegExp(`${ADMIN}|${SUPER}`))
    })

    it("through Next: CSRF, parent 403, validation 422, conflict 409 with the current snapshot, and no Supabase database call", async () => {
      await signIn(ADMIN)
      const editor = await asJson(await adminHomepageGET())
      expect(editor.status).toBe(200)
      expect(editor.body).toMatchObject({ isDefault: false, source: "database" })
      const content = { ...editor.body.content, hero: { ...editor.body.content.hero, title: "Saved via Next" } }
      expect((await call(homepagePUT, "PUT", "/api/admin/homepage", { content, expectedRevision: editor.body.revision }, { ...jsonHeaders, origin: "https://evil.example" })).status).toBe(403)
      const saved = await call(homepagePUT, "PUT", "/api/admin/homepage", { content, expectedRevision: editor.body.revision })
      expect([saved.status, saved.body.revision]).toEqual([200, editor.body.revision + 1])
      const stale = await call(homepagePUT, "PUT", "/api/admin/homepage", { content, expectedRevision: editor.body.revision })
      expect(stale.status).toBe(409)
      expect(stale.body).toMatchObject({ code: "HOMEPAGE_CONFLICT", revision: editor.body.revision + 1 })
      expect(stale.body.content.hero.title).toBe("Saved via Next")
      const bad = await call(homepagePUT, "PUT", "/api/admin/homepage", { content: { ...content, hero: "x" }, expectedRevision: saved.body.revision })
      expect([bad.status, bad.body.code]).toEqual([422, "HOMEPAGE_INVALID"])
      await signIn(A.user)
      expect((await call(homepagePUT, "PUT", "/api/admin/homepage", { content, expectedRevision: saved.body.revision })).status).toBe(403)
      expect((await asJson(await adminHomepageGET())).status).toBe(403)
      expect(restCalls()).toEqual([])
    })

    it("media: bytes to Storage, metadata to PostgreSQL; replace removes the old object; revert removes row and object; parents store nothing", async () => {
      const slotPath = "safety.image"
      const upload = async (bytes: Uint8Array, mime = "image/png") => {
        const form = new FormData()
        form.append("file", new File([bytes as BlobPart], "x.png", { type: mime }))
        return asJson(await homepageMediaPOST(new Request(`${ORIGIN}/api/admin/homepage/media/${slotPath}`, { method: "POST", body: form, headers: formHeaders }), { params: Promise.resolve({ slot: slotPath }) }))
      }
      // a parent: refused before any byte is stored
      await signIn(A.user)
      expect((await upload(pngBytes())).status).toBe(403)
      expect(stub!.storage.uploads).toEqual([])
      await signIn(ADMIN)
      expect((await upload(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24]))).status).toBe(422) // not an image
      expect(stub!.storage.uploads).toEqual([])
      const first = await upload(pngBytes(80, 60))
      expect(first.status).toBe(200)
      expect(first.body.record).toMatchObject({ slotKey: slotPath, width: 80, height: 60 })
      expect(Object.keys(first.body.record).sort()).not.toContain("storagePath") // the key is never a field, only a resolved preview URL
      expect(JSON.stringify(first.body)).not.toMatch(/storage_path|storagePath/)
      const row1 = (await q<{ storage_path: string }>("select storage_path from public.homepage_media_assets where slot_key = $1", [slotPath]))[0]
      expect(stub!.storage.objects.has(`homepage-media/${row1.storage_path}`)).toBe(true)
      expect((await publicGet()).body.media.find((m: { slotKey: string }) => m.slotKey === slotPath).storagePath).toBe(row1.storage_path)
      // the public resolver now serves the stored object for that slot and the local file for the rest
      // (the resolver only accepts https URLs; production's Storage URL is https, the stub's is http)
      vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://cdn.stub.example.test")
      const resolved = await getResolvedHomepage()
      vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", stub!.url)
      expect(resolved.sources.mediaPerSlot[slotPath as "safety.image"]).toBe("database")
      expect(resolved.media[slotPath as "safety.image"]).toContain(row1.storage_path)
      // replace
      const second = await upload(pngBytes(90, 70))
      expect(second.status).toBe(200)
      expect(stub!.storage.removed).toContain(`homepage-media/${row1.storage_path}`)
      const row2 = (await q<{ storage_path: string }>("select storage_path from public.homepage_media_assets where slot_key = $1", [slotPath]))[0]
      expect(row2.storage_path).not.toBe(row1.storage_path)
      // revert
      const del = await asJson(await homepageMediaDELETE(new Request(`${ORIGIN}/api/admin/homepage/media/${slotPath}`, { method: "DELETE", headers: jsonHeaders, body: "{}" }), { params: Promise.resolve({ slot: slotPath }) }))
      expect(del.status).toBe(200)
      expect(stub!.storage.removed).toContain(`homepage-media/${row2.storage_path}`)
      expect(Number((await q<{ n: string }>("select count(*) n from public.homepage_media_assets where slot_key = $1", [slotPath]))[0].n)).toBe(0)
      expect((await getResolvedHomepage()).sources.mediaPerSlot[slotPath as "safety.image"]).toBe("local-fallback")
      // unknown slot / CSRF
      expect((await asJson(await homepageMediaDELETE(new Request(`${ORIGIN}/api/admin/homepage/media/nope`, { method: "DELETE", headers: jsonHeaders, body: "{}" }), { params: Promise.resolve({ slot: "nope" }) }))).status).toBe(400)
      expect((await asJson(await homepageMediaDELETE(new Request(`${ORIGIN}/api/admin/homepage/media/${slotPath}`, { method: "DELETE" }), { params: Promise.resolve({ slot: slotPath }) }))).status).toBe(415)
      expect(restCalls()).toEqual([])
    })

    it("hero layout: revision-checked, validated, parent refused", async () => {
      await signIn(ADMIN)
      const layout = (await publicGet()).body.heroLayout as { tvRect: Record<string, number>; revision: number }
      const put = (rect: Record<string, unknown>) => call(heroLayoutPUT, "PUT", "/api/admin/homepage/hero-layout", rect)
      const ok = await put({ x: 0.11, y: 0.15, width: 0.09, height: 0.1, expectedRevision: layout.revision })
      expect([ok.status, ok.body.revision]).toEqual([200, layout.revision + 1])
      expect((await put({ x: 0.11, y: 0.15, width: 0.09, height: 0.1, expectedRevision: layout.revision })).status).toBe(409)
      expect((await put({ x: 5, y: 0.15, width: 0.09, height: 0.1, expectedRevision: layout.revision + 1 })).status).toBe(422)
      await signIn(A.user)
      expect((await put({ x: 0.11, y: 0.15, width: 0.09, height: 0.1, expectedRevision: layout.revision + 1 })).status).toBe(403)
    })

    it("the anonymous public homepage: content from PostgreSQL with no session; a backend outage serves the committed defaults without throwing", async () => {
      cookies.jar = cookieJar([])
      const ok = await getResolvedHomepage()
      expect(ok.sources.content).toBe("database")
      vi.stubEnv("BACKEND_INTERNAL_URL", "http://127.0.0.1:1")
      try {
        const down = await getResolvedHomepage()
        expect(down.sources.content).toBe("default-read-error")
        expect(down.content).toEqual(DEFAULT_HOMEPAGE_CONTENT)
      } finally {
        vi.stubEnv("BACKEND_INTERNAL_URL", backendUrl)
      }
      expect(restCalls()).toEqual([])
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  describe("16. examples CMS in PostgreSQL", () => {
    const createForm = (over: Record<string, string> = {}, image: File | null = new File([pngBytes()], "e.png", { type: "image/png" })) => {
      const f = new FormData()
      for (const [k, v] of Object.entries({ title: "Example one", description: "A description", kind: "video", sort_order: "5", is_published: "false", badge_label: "New", ...over })) f.append(k, v)
      if (image) f.append("image", image)
      return f
    }
    const create = async (form: FormData) => asJson(await examplesPOST(new Request(`${ORIGIN}/api/admin/examples`, { method: "POST", body: form, headers: formHeaders })))
    let exId = ""
    let firstKey = ""

    it("a parent is refused and NO byte is stored; the admin creates a row and an object", async () => {
      await signIn(A.user)
      expect((await create(createForm())).status).toBe(403)
      expect(stub!.storage.uploads).toEqual([])
      await signIn(ADMIN)
      expect((await create(createForm({ kind: "bogus" }))).status).toBe(422)
      expect((await create(createForm({}, null))).status).toBe(422)
      expect((await create(createForm({}, new File([new Uint8Array(4)], "x.gif", { type: "image/gif" })))).status).toBe(422)
      expect(stub!.storage.uploads).toEqual([])
      const ok = await create(createForm())
      expect(ok.status).toBe(201)
      exId = ok.body.data.id
      firstKey = ok.body.data.media_url
      expect(firstKey).toMatch(new RegExp(`^examples/${exId}/[0-9a-f-]{36}\\.png$`))
      expect(stub!.storage.objects.has(`example-media/${firstKey}`)).toBe(true)
      expect(ok.body.data).toMatchObject({ kind: "video", title: "Example one", is_published: false, sort_order: 5, badge_label: "New" })
    })

    it("public list shows ONLY published rows; publishing and ordering work; the admin list shows all", async () => {
      expect((await direct("GET", null, "/v1/public/examples")).body.examples.some((e: { id: string }) => e.id === exId)).toBe(false)
      await signIn(ADMIN)
      const pub = await callP(examplePublishPATCH, { exampleId: exId }, "PATCH", `/api/admin/examples/${exId}/publish`, { is_published: true })
      expect([pub.status, pub.body.data.is_published]).toEqual([200, true])
      const second = await create(createForm({ title: "Example two", sort_order: "1", is_published: "true" }))
      const list = (await loadPublicExamples())!
      const ids = list.map((e) => e.id)
      expect(ids.indexOf(second.body.data.id)).toBeLessThan(ids.indexOf(exId)) // sort_order asc
      const admin = await asJson(await examplesGET())
      expect(admin.body.data.some((e: { id: string }) => e.id === exId)).toBe(true)
      await q("update public.examples set is_published = false where id = $1", [second.body.data.id])
      expect((await loadPublicExamples())!.some((e) => e.id === second.body.data.id)).toBe(false)
    })

    it("updates touch only the allowed fields; invalid input is refused by the function as well as the route", async () => {
      await signIn(ADMIN)
      const upd = await callP(examplePATCH, { exampleId: exId }, "PATCH", `/api/admin/examples/${exId}`, { title: "Renamed", sort_order: 9 })
      expect([upd.status, upd.body.data.title, upd.body.data.sort_order]).toEqual([200, "Renamed", 9])
      expect((await callP(examplePATCH, { exampleId: exId }, "PATCH", `/api/admin/examples/${exId}`, { media_url: "examples/x/y.png" })).status).toBe(422)
      expect((await callP(examplePATCH, { exampleId: exId }, "PATCH", `/api/admin/examples/${exId}`, { kind: "bogus" })).status).toBe(422)
      expect((await callP(examplePATCH, { exampleId: randomUUID() }, "PATCH", "/api/admin/examples/x", { title: "x" })).status).toBe(404)
      // straight at the backend: the function is the second line of defence
      expect((await direct("PATCH", ADMIN, `/v1/admin/examples/${exId}`, { media_url: "x" })).status).toBe(400)
      expect((await direct("PATCH", ADMIN, `/v1/admin/examples/${exId}`, { kind: "bogus" })).body.error).toBe("example_admin_invalid")
      expect((await direct("PATCH", ADMIN, `/v1/admin/examples/${exId}`, { sort_order: 99999 })).body.error).toBe("example_admin_invalid")
      expect((await direct("PATCH", A.user, `/v1/admin/examples/${exId}`, { title: "hack" })).status).toBe(403)
      expect((await q<{ title: string }>("select title from public.examples where id = $1", [exId]))[0].title).toBe("Renamed")
    })

    it("an object key outside examples/<this id>/ is refused (traversal, URL, another example)", async () => {
      const other = randomUUID()
      for (const key of [`examples/${other}/a.png`, `examples/${exId}/../x.png`, `https://evil.example/x.png`, `/etc/passwd`, `examples/${exId}`]) {
        const r = await direct("PUT", ADMIN, `/v1/admin/examples/${exId}/media`, { media_url: key })
        expect(r.body.error, key).toBe("example_admin_invalid_media")
      }
      const c = await direct("POST", ADMIN, "/v1/admin/examples", { id: other, kind: "video", title: "t", badge_label: "", description: "d", media_url: `examples/${exId}/a.png`, is_published: false, sort_order: 1 })
      expect(c.body.error).toBe("example_admin_invalid_media")
      expect(Number((await q<{ n: string }>("select count(*) n from public.examples where id = $1", [other]))[0].n)).toBe(0)
    })

    it("replacing the image removes the old object; deleting removes row AND object; a parent can do neither", async () => {
      await signIn(ADMIN)
      const form = new FormData()
      form.append("image", new File([pngBytes()], "n.png", { type: "image/png" }))
      const rep = await asJson(await exampleMediaPUT(new Request(`${ORIGIN}/api/admin/examples/${exId}/media`, { method: "PUT", body: form, headers: formHeaders }), { params: Promise.resolve({ exampleId: exId }) }))
      expect(rep.status).toBe(200)
      expect(rep.body.data.media_url).not.toBe(firstKey)
      expect(stub!.storage.removed).toContain(`example-media/${firstKey}`)
      await signIn(A.user)
      const uploadsBefore = stub!.storage.uploads.length
      const f2 = new FormData()
      f2.append("image", new File([pngBytes()], "n.png", { type: "image/png" }))
      expect((await asJson(await exampleMediaPUT(new Request(`${ORIGIN}/api/admin/examples/${exId}/media`, { method: "PUT", body: f2, headers: formHeaders }), { params: Promise.resolve({ exampleId: exId }) }))).status).toBe(403)
      expect(stub!.storage.uploads.length).toBe(uploadsBefore)
      expect((await callP(exampleDELETE, { exampleId: exId }, "DELETE", `/api/admin/examples/${exId}`, "{}")).status).toBe(403)
      await signIn(ADMIN)
      expect((await callP(exampleDELETE, { exampleId: exId }, "DELETE", `/api/admin/examples/${exId}`, "{}", { origin: ORIGIN })).status).toBe(415) // CSRF guard
      const del = await callP(exampleDELETE, { exampleId: exId }, "DELETE", `/api/admin/examples/${exId}`, "{}")
      expect(del.status).toBe(200)
      expect(stub!.storage.removed).toContain(`example-media/${rep.body.data.media_url}`)
      expect(Number((await q<{ n: string }>("select count(*) n from public.examples where id = $1", [exId]))[0].n)).toBe(0)
      expect((await callP(exampleDELETE, { exampleId: exId }, "DELETE", `/api/admin/examples/${exId}`, "{}")).status).toBe(404)
      expect(restCalls()).toEqual([])
    })

    it("an unknown id is 404; the public route accepts no parameters", async () => {
      expect((await direct("GET", ADMIN, `/v1/admin/examples/${randomUUID()}`)).status).toBe(404)
      expect((await direct("GET", ADMIN, "/v1/admin/examples/not-a-uuid")).status).toBe(404)
      expect((await direct("GET", null, "/v1/public/examples", undefined, "?all=1")).status).toBe(400)
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  describe("7/8/24. a brand-new user needs no Supabase business row", () => {
    it("provision -> role -> consent -> referral -> purchase -> request -> order detail -> gallery, with ZERO Supabase database requests", async () => {
      const newUser = randomUUID()
      await signIn(newUser)
      // before the bootstrap: verified at the provider, no Cartoona account
      expect(await resolveCallerRole()).toEqual({ ok: false, reason: "identity_not_linked" })
      // signup/login bootstrap
      const setup = await call(accountSetupPOST, "POST", "/api/parent/account-setup", {})
      expect([setup.status, setup.body.ready]).toEqual([200, true])
      expect((await call(accountSetupPOST, "POST", "/api/parent/account-setup", {})).status).toBe(200) // idempotent
      const profile = (await q<{ id: string; referral_code: string }>("select id, referral_code from public.parent_profiles where user_id = $1", [newUser]))[0]
      expect(profile.referral_code).toMatch(/^CT/)
      expect(Number((await q<{ n: string }>("select count(*) n from public.candy_wallets where parent_id = $1", [profile.id]))[0].n)).toBe(1)
      expect(Number((await q<{ n: string }>("select count(*) n from public.parent_welcome_credits where parent_id = $1", [profile.id]))[0].n)).toBe(1)
      expect(Number((await q<{ n: string }>("select count(*) n from public.user_identities where user_id = $1", [newUser]))[0].n)).toBe(1)
      // role from PostgreSQL
      expect(await resolveCallerRole()).toMatchObject({ ok: true, role: "parent" })
      expect((await gateParentPage("/dashboard")).ok).toBe(true)
      // consent
      expect((await call(consentPOST, "POST", "/api/parent-consent", { consentGranted: true })).status).toBe(200)
      // referral
      const sum = await asJson(await referralsGET(new Request(`${ORIGIN}/api/referrals`)))
      expect(sum.body.referralCode).toBe(profile.referral_code)
      const referrer = await newParent()
      expect((await call(bindPOST, "POST", "/api/referrals/bind", { code: await codeOf(referrer.profile) })).body.status).toBe("bound")
      // account + purchase (creation only: payment confirmation is covered by the V0.1.51 suites)
      const account = await asJson(await summaryGET(new Request(`${ORIGIN}/api/parent/account-summary`)))
      expect(account.status).toBe(200)
      const pkg = (await q<{ id: string }>("select id from public.candy_packages where is_active order by display_order limit 1"))[0]
      const bought = await call(purchasesPOST, "POST", "/api/candy-purchases", { package_id: pkg.id })
      expect(bought.status).toBe(201)
      expect((await asJson(await purchasesGET(new Request(`${ORIGIN}/api/candy-purchases`)))).body.purchases).toHaveLength(1)
      // request (the V0.1.50 function, as the restricted role) + source file + detail + gallery
      const orderId = randomUUID()
      const character = (await q<{ id: string }>("select id from public.characters where is_active order by name limit 1"))[0].id
      await appPool.query("select * from public.create_parent_request_trusted(p_parent_profile_id => $1, p_order_id => $2, p_type => 'image', p_title => 'new user', p_character_id => $3, p_submission_key => $4)", [profile.id, orderId, character, randomUUID()])
      const key = `${newUser}/${orderId}/ref.png`
      await q("insert into public.media_assets (order_id, type, asset_role, file_url, mime_type, original_filename) values ($1, 'upload', 'source', $2, 'image/png', 'ref.png')", [orderId, key])
      stub!.storage.objects.add(`parent-uploads/${key}`)
      const orders = await asJson(await ordersGET(new Request(`${ORIGIN}/api/parent/orders`)))
      expect(orders.body.orders.map((o: { id: string }) => o.id)).toContain(orderId)
      const caller = await verifyParentOrderDetailCaller()
      if (!caller.ok) throw new Error("caller")
      const detail = await fetchParentOrderDetail(caller.context, orderId)
      expect(detail.ok && detail.detail.sourceMedia[0].signedUrl).toMatch(/token=stub/)
      const gallery = await asJson(await galleryGET(new Request(`${ORIGIN}/api/parent/gallery`)))
      expect(gallery.body.media).toHaveLength(1)
      // THE PROOF: nothing touched Supabase's database, and no Supabase profile/wallet/credit call was made
      expect(restCalls()).toEqual([])
      expect(stub!.requests.filter((r) => r.method !== "GET" && !/^\/(auth|storage)\/v1\//.test(r.path))).toEqual([])
    })

    it("a COPIED parent works the same way end to end (login role, referral, account, orders, detail, gallery) with no Supabase database request", async () => {
      await signIn(A.user)
      expect(await resolveCallerRole()).toMatchObject({ ok: true, role: "parent" })
      expect((await asJson(await referralsGET(new Request(`${ORIGIN}/api/referrals`)))).body.referredCount).toBe(1)
      expect((await asJson(await summaryGET(new Request(`${ORIGIN}/api/parent/account-summary`)))).status).toBe(200)
      expect((await asJson(await ordersGET(new Request(`${ORIGIN}/api/parent/orders`)))).body.orders.length).toBeGreaterThan(0)
      const caller = await verifyParentOrderDetailCaller()
      if (!caller.ok) throw new Error("caller")
      expect((await fetchParentOrderDetail(caller.context, ORDER_A_DELIVERED)).ok).toBe(true)
      expect((await asJson(await galleryGET(new Request(`${ORIGIN}/api/parent/gallery`)))).status).toBe(200)
      expect(restCalls()).toEqual([])
    })

    it("an admin works without any Supabase database read: role, referral settings, CMS, fulfilment queue", async () => {
      await signIn(ADMIN)
      expect(await resolveCallerRole()).toMatchObject({ ok: true, role: "admin" })
      expect((await gateAdminPage()).ok).toBe(true)
      expect((await asJson(await adminReferralsGET(new Request(`${ORIGIN}/api/admin/referrals`)))).status).toBe(200)
      expect((await asJson(await adminHomepageGET())).status).toBe(200)
      expect((await asJson(await examplesGET())).status).toBe(200)
      expect((await direct("GET", ADMIN, "/v1/admin/requests")).status).toBe(200)
      expect(restCalls()).toEqual([])
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  describe("39. performance (local Docker, restricted role, in-process Next + loopback Fastify)", () => {
    it("role resolution, referral summary/bind, homepage + examples reads, admin CMS read/write, new-user bootstrap", async () => {
      const p = await newParent()
      await signIn(p.user)
      await timed("role_resolution", 30, () => resolveCallerRole())
      await timed("referral_summary", 30, () => direct("GET", p.user, "/v1/parent/referrals"))
      const referrer = await newParent()
      const rcode = await codeOf(referrer.profile)
      const binders = await Promise.all(Array.from({ length: 15 }, () => newParent()))
      await timed("referral_bind", 15, (i) => direct("POST", binders[i].user, "/v1/parent/referrals/bind", { code: rcode }))
      await timed("homepage_public_read", 30, () => direct("GET", null, "/v1/public/homepage"))
      await timed("examples_public_read", 30, () => direct("GET", null, "/v1/public/examples"))
      await timed("admin_examples_read", 30, () => direct("GET", ADMIN, "/v1/admin/examples"))
      const exampleId = randomUUID()
      await direct("POST", ADMIN, "/v1/admin/examples", { id: exampleId, kind: "story", title: "perf", badge_label: "", description: "d", media_url: `examples/${exampleId}/a.png`, is_published: false, sort_order: 1 })
      await timed("admin_cms_write", 20, (i) => direct("PATCH", ADMIN, `/v1/admin/examples/${exampleId}`, { sort_order: i + 2 }))
      const users = Array.from({ length: 10 }, () => randomUUID())
      await timed("new_user_bootstrap", 10, async (i) => {
        await signIn(users[i])
        expect((await call(accountSetupPOST, "POST", "/api/parent/account-setup", {})).status).toBe(200)
      })
      console.info("V0.1.53 PERF (ms)", JSON.stringify(perf))
      for (const [name, r] of Object.entries(perf)) expect(r.p90, name).toBeLessThan(1500)
    })
  })
})
