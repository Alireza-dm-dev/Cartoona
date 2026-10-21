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
import { GET as welcomeCreditsRoute } from "@/app/api/parent/welcome-credits/route"
import { GET as accountSummaryRoute } from "@/app/api/parent/account-summary/route"
import { getPublicHeaderAccount } from "@/lib/auth/public-header-account"
import { closePool, getPool } from "@/lib/db/pool"
import type { Queryable } from "@/lib/db/types"
import { signAssertion } from "@/lib/identity/assertion"
import { toVerifiedIdentity } from "@/lib/identity/types"
import { runDataCopy } from "@/scripts/db/data-copy/copy"
import { buildSupabaseSource, dropDbs, migrateTarget, ownerUrl, pgEnv, psql, root, script, type PgEnv } from "../helpers/data-copy-db"
import { cookieJar, startStubAuth, type StubAuth } from "../helpers/stub-supabase-auth"
import { DAY_MS } from "../helpers/supabase-jwt"

/**
 * V0.1.46 parent ACCOUNT reads cutover, end to end on REAL local services
 * (opt-in: CARTOONA_PLAIN_PG=docker):
 *
 *   Supabase-shaped source (real migration chain + fixtures; wallets, grants
 *   and debits made by the real triggers and request function) -> V0.1.44
 *   copy -> plain PostgreSQL 17
 *   stub Supabase Auth (real @supabase/ssr) -> Next GET /api/parent/welcome-credits,
 *   GET /api/parent/account-summary and the public header lookup
 *   -> signed v2 assertions -> Fastify (listening, restricted login role)
 *   -> requireAuth -> requireRole("parent") -> parent profile -> repositories
 *
 * Expectations are read from the copied database (and checked against the
 * source), never hardcoded. Nothing contacts Supabase or any hosted service.
 */

const enabled = process.env.CARTOONA_PLAIN_PG === "docker"
const id = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`
const SRC = `pas_${id}`
const TGT = `pat_${id}`
const ROLE = `cartoona_app_pa${id}`
const DB_PASSWORD = randomBytes(24).toString("hex")
const AUTH_SECRET = randomBytes(32).toString("hex")

const U = {
  a: "a1000000-0000-4000-8000-000000000001",
  b: "a1000000-0000-4000-8000-000000000002",
  admin: "a1000000-0000-4000-8000-000000000003",
  deleted: "a1000000-0000-4000-8000-000000000004",
  superAdmin: "a1000000-0000-4000-8000-000000000005",
  c: "a1000000-0000-4000-8000-000000000006",
}
const P = { a: "b1000000-0000-4000-8000-000000000001", b: "b1000000-0000-4000-8000-000000000002", c: "b1000000-0000-4000-8000-000000000006" }
const NO_PROFILE_USER = "a1000000-0000-4000-8000-0000000000bb"
const UNLINKED = "a1000000-0000-4000-8000-0000000000ee"
const PARENTS = [U.a, U.b, U.c]

let env: PgEnv
let backend: FastifyInstance | null = null
let backendUrl = ""
let stub: StubAuth | null = null
let queries = 0

interface Account { fullName: string | null; balance: number; credits: number }

/** One parent's account values, straight from a database (the copy target, or the source). */
async function accountIn(db: string, userId: string): Promise<Account> {
  const out = await psql(env, db, `select coalesce(p.full_name, '<null>') || '|' || coalesce(w.balance, 0) || '|' || coalesce(greatest(c.granted_count - c.used_count, 0), 0)
    from public.parent_profiles p
    left join public.candy_wallets w on w.parent_id = p.id
    left join public.parent_welcome_credits c on c.parent_id = p.id
    where p.user_id = '${userId}'`)
  const [name, balance, credits] = out.split("|")
  return { fullName: name === "<null>" ? null : name, balance: Number(balance), credits: Number(credits) }
}

const expected = (userId: string) => accountIn(TGT, userId)

type Surface = "welcome-credits" | "account-summary"

/** A browser request with a session at the stub provider for `userId`. */
async function asBrowser(userId: string, surface: Surface, opts: { qs?: string; headers?: Record<string, string>; authenticatedAt?: number; userMode?: StubAuth["options"]["userMode"] } = {}) {
  await signIn(userId, opts)
  const handler = surface === "welcome-credits" ? welcomeCreditsRoute : accountSummaryRoute
  const res = await handler(new Request(`http://localhost:3000/api/parent/${surface}${opts.qs ?? ""}`, { headers: opts.headers ?? {} }))
  return { status: res.status, body: await res.json(), headers: res.headers }
}

async function signIn(userId: string, opts: { authenticatedAt?: number; userMode?: StubAuth["options"]["userMode"] } = {}) {
  await stub?.close()
  stub = await startStubAuth({ userId, userMode: opts.userMode })
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", stub.url)
  cookies.jar = cookieJar([stub.cookie({ authenticatedAt: opts.authenticatedAt })])
}

/** The public header (marketing/creation layouts) for a signed-in `userId`. */
async function header(userId: string, opts: { authenticatedAt?: number; userMode?: StubAuth["options"]["userMode"] } = {}) {
  await signIn(userId, opts)
  return getPublicHeaderAccount({})
}

const jar = () => cookies.jar as ReturnType<typeof cookieJar>

const direct = (pathAndQuery: string, token?: string) =>
  fetch(`${backendUrl}${pathAndQuery}`, { headers: token ? { "x-cartoona-internal-auth": token } : {} })

const sign = (subject: string, path: string, over: { secret?: string } = {}) =>
  signAssertion({
    identity: toVerifiedIdentity({ provider: "supabase", subject }),
    authenticatedAt: Date.now() - DAY_MS,
    requestId: "account-direct-01",
    method: "GET",
    path,
    secret: Buffer.from(over.secret ?? AUTH_SECRET, "hex"),
  })

async function startBackend(db?: () => Queryable): Promise<{ app: FastifyInstance; url: string }> {
  const app = buildBackendApp(db ? { db, closeDb: async () => {} } : {
    db: () => ({ query: (text: string, values?: readonly unknown[]) => { queries += 1; return getPool().query(text, values as unknown[]) } }) as Queryable,
  })
  await app.listen({ host: "127.0.0.1", port: 0 })
  return { app, url: `http://127.0.0.1:${(app.server.address() as net.AddressInfo).port}` }
}

async function withBackendUrl<T>(url: string, work: () => Promise<T>): Promise<T> {
  vi.stubEnv("BACKEND_INTERNAL_URL", url)
  try {
    return await work()
  } finally {
    vi.stubEnv("BACKEND_INTERNAL_URL", backendUrl)
  }
}

const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))]

describe.skipIf(!enabled)("V0.1.46 parent account reads: copied data -> Fastify -> Next (local Docker PostgreSQL 17)", () => {
  vi.setConfig({ testTimeout: 120_000, hookTimeout: 300_000 })

  beforeAll(async () => {
    env = await pgEnv()
    await buildSupabaseSource(env, SRC, path.join(root, "tests/fixtures/data-copy/supabase-source-fixture.sql"))
    await psql(env, SRC, "", path.join(root, "tests/fixtures/data-copy/parent-orders-extra.sql"))
    await psql(env, SRC, "", path.join(root, "tests/fixtures/data-copy/parent-account-extra.sql"))
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

  describe("19. copied values, through Next and Fastify", () => {
    it("the copy preserved every parent's name, balance and credits, and the parents differ", async () => {
      const values = await Promise.all(PARENTS.map(expected))
      for (const [i, user] of PARENTS.entries()) expect(values[i], user).toEqual(await accountIn(SRC, user))
      // Isolation below is only meaningful if the values are distinguishable.
      expect(new Set(values.map((v) => v.fullName)).size).toBe(3)
      expect(new Set(values.map((v) => v.credits)).size).toBeGreaterThanOrEqual(2)
      expect(values.find((v) => v.fullName === null)).toBeTruthy()
      expect(values.some((v) => v.balance > 0)).toBe(true)
      expect(values.some((v) => v.balance === 0)).toBe(true)
      expect(values.some((v) => v.credits === 3)).toBe(true)
    })

    it("welcome credits: each parent gets exactly the copied max(granted - used, 0)", async () => {
      for (const user of PARENTS) {
        const res = await asBrowser(user, "welcome-credits")
        expect([res.status, res.body], user).toEqual([200, { welcomeImageCreditsRemaining: (await expected(user)).credits }])
        expect(res.headers.get("cache-control")).toBe("no-store")
        expect(res.headers.get("x-request-id")).toBeTruthy()
      }
    })

    it("account summary (billing): each parent's copied balance and credits, with the pre-cutover field names", async () => {
      for (const user of PARENTS) {
        const want = await expected(user)
        const res = await asBrowser(user, "account-summary")
        expect([res.status, res.body], user).toEqual([200, { wallet: { balance: want.balance }, welcomeImageCreditsRemaining: want.credits }])
        expect(res.headers.get("cache-control")).toBe("no-store")
      }
    })

    it("public header: the copied name; a profile without a name is greeted neutrally", async () => {
      for (const user of PARENTS) {
        const { fullName } = await expected(user)
        const account = await header(user)
        expect(account?.displayName, user).toBe(fullName ?? "حساب والد")
        expect(Object.keys(account!).sort()).toEqual(["displayName", "initials"])
      }
    })

    it("one session verification per request; the summary's two reads share it", async () => {
      await signIn(U.a)
      stub!.requests.length = 0
      queries = 0
      const res = await accountSummaryRoute(new Request("http://localhost:3000/api/parent/account-summary"))
      expect(res.status).toBe(200)
      expect(stub!.requests).toHaveLength(1) // GET /auth/v1/user
      expect(queries).toBe(6) // per read: identity, profile id, value
    })
  })

  describe("20. cross-parent isolation and forgery", () => {
    it("A, B and C each see only their own values on every surface", async () => {
      const seen = new Map<string, unknown>()
      for (const user of PARENTS) {
        seen.set(user, {
          credits: (await asBrowser(user, "welcome-credits")).body,
          summary: (await asBrowser(user, "account-summary")).body,
          header: await header(user),
        })
      }
      expect(new Set([...seen.values()].map((v) => JSON.stringify(v))).size).toBe(3)
    })

    it("X-User-Id, X-Role, a forged assertion header, X-Parent-Profile-Id and identity query values cannot select another parent", async () => {
      const a = await expected(U.a)
      const forged = {
        qs: `?parentProfileId=${P.c}&userId=${U.c}`,
        headers: { "x-user-id": U.c, "x-role": "parent", "x-cartoona-internal-auth": sign(U.c, "/v1/parent/candy-balance"), "x-parent-profile-id": P.c },
      }
      expect((await asBrowser(U.a, "account-summary", forged)).body).toEqual({ wallet: { balance: a.balance }, welcomeImageCreditsRemaining: a.credits })
      expect((await asBrowser(U.a, "welcome-credits", forged)).body).toEqual({ welcomeImageCreditsRemaining: a.credits })
    })

    it("X-Role cannot turn an admin into a parent", async () => {
      const res = await asBrowser(U.admin, "account-summary", { headers: { "x-role": "parent", "x-user-id": U.a } })
      expect([res.status, res.body.code]).toEqual([403, "forbidden"])
    })

    it("direct to Fastify: any parameter -> 400; forged, other-path, v1 or missing assertions -> 401", async () => {
      for (const p of ["/v1/parent/profile", "/v1/parent/candy-balance", "/v1/parent/welcome-credits"]) {
        expect((await direct(`${p}?parentProfileId=${P.c}`, sign(U.a, p))).status, p).toBe(400)
        expect((await direct(p, sign(U.a, p, { secret: randomBytes(32).toString("hex") }))).status, p).toBe(401)
        expect((await direct(p, sign(U.a, "/v1/parent/orders"))).status, p).toBe(401)
        expect((await direct(p, "v1." + sign(U.a, p).split(".").slice(1).join("."))).status, p).toBe(401)
        expect((await direct(p)).status, p).toBe(401)
        // The same assertion route-bound to its path yields only the signer's own data:
        const own = await direct(p, sign(U.c, p))
        expect(own.status, p).toBe(200)
      }
    })
  })

  describe("21. roles, accounts and sessions", () => {
    it("admin, super_admin and deleted copied users -> 403 forbidden; header anonymous", async () => {
      for (const user of [U.admin, U.superAdmin, U.deleted]) {
        for (const surface of ["welcome-credits", "account-summary"] as const) {
          const res = await asBrowser(user, surface)
          expect([res.status, res.body.code], `${user} ${surface}`).toEqual([403, "forbidden"])
        }
        expect(await header(user), user).toBeNull()
      }
    })

    it("identity not linked -> 403 identity_not_linked; header anonymous", async () => {
      for (const surface of ["welcome-credits", "account-summary"] as const) {
        const res = await asBrowser(UNLINKED, surface)
        expect([res.status, res.body.code]).toEqual([403, "identity_not_linked"])
      }
      expect(await header(UNLINKED)).toBeNull()
    })

    it("parent without a profile: credits 0, billing's 400 no-profile message, neutral header (Fastify 404)", async () => {
      expect(await asBrowser(NO_PROFILE_USER, "welcome-credits").then((r) => [r.status, r.body])).toEqual([200, { welcomeImageCreditsRemaining: 0 }])
      expect(await asBrowser(NO_PROFILE_USER, "account-summary").then((r) => [r.status, r.body.code])).toEqual([400, "no_parent_profile"])
      expect((await header(NO_PROFILE_USER))?.displayName).toBe("حساب والد")
      for (const p of ["/v1/parent/profile", "/v1/parent/candy-balance", "/v1/parent/welcome-credits"]) {
        const res = await direct(p, sign(NO_PROFILE_USER, p))
        expect([res.status, await res.json()], p).toEqual([404, { error: "parent_profile_not_found" }])
      }
    })

    it("expired session -> 401 and cookies cleared; the header is anonymous and clears nothing", async () => {
      const old = Date.now() - 31 * DAY_MS
      for (const surface of ["welcome-credits", "account-summary"] as const) {
        const res = await asBrowser(U.a, surface, { authenticatedAt: old })
        expect([res.status, res.body.code], surface).toEqual([401, "PARENT_SESSION_EXPIRED"])
        expect(jar().cleared("sb-"), surface).toBe(true)
      }
      expect(await header(U.a, { authenticatedAt: old })).toBeNull()
      expect(jar().cleared("sb-")).toBe(false)
    })

    it("invalidated session (sessions_not_before) -> 401 and cookies cleared; header anonymous", async () => {
      await psql(env, TGT, `update public.users set sessions_not_before = now() + interval '1 minute' where id = '${U.a}'`)
      try {
        for (const surface of ["welcome-credits", "account-summary"] as const) {
          const res = await asBrowser(U.a, surface)
          expect([res.status, res.body.code], surface).toEqual([401, "PARENT_SESSION_EXPIRED"])
          expect(jar().cleared("sb-"), surface).toBe(true)
        }
        expect(await header(U.a)).toBeNull()
        expect(jar().cleared("sb-")).toBe(false)
      } finally {
        await psql(env, TGT, `update public.users set sessions_not_before = null where id = '${U.a}'`)
      }
    })
  })

  describe("21. outages: never a sign-out", () => {
    it("Supabase Auth (stub) unavailable -> 503 SESSION_CHECK_UNAVAILABLE, no sign-out, no backend query; header anonymous", async () => {
      const before = queries
      for (const userMode of ["server_error", "hang"] as const) {
        for (const surface of ["welcome-credits", "account-summary"] as const) {
          const res = await asBrowser(U.a, surface, { userMode })
          expect([res.status, res.body.code], `${userMode} ${surface}`).toEqual([503, "SESSION_CHECK_UNAVAILABLE"])
          expect(jar().cleared("sb-")).toBe(false)
        }
        expect(await header(U.a, { userMode })).toBeNull()
      }
      expect(queries).toBe(before)
    })

    it("Fastify stopped -> bounded 503 service_unavailable; header anonymous", async () => {
      const dead = await startBackend()
      await dead.app.close()
      await withBackendUrl(dead.url, async () => {
        for (const surface of ["welcome-credits", "account-summary"] as const) {
          const t = Date.now()
          const res = await asBrowser(U.a, surface)
          expect([res.status, res.body.code], surface).toEqual([503, "service_unavailable"])
          expect(Date.now() - t).toBeLessThan(5_000)
          expect(jar().cleared("sb-")).toBe(false)
          expect(JSON.stringify(res.body)).not.toMatch(/127\.0\.0\.1|ECONNREFUSED/)
        }
        expect(await header(U.a)).toBeNull()
      })
    })

    it("PostgreSQL unavailable behind Fastify -> 503 service_unavailable; header anonymous", async () => {
      const pool = new Pool({ connectionString: `postgresql://nobody:x@127.0.0.1:1/none`, connectionTimeoutMillis: 300 })
      pool.on("error", () => undefined)
      const broken = await startBackend(() => pool as unknown as Queryable)
      try {
        await withBackendUrl(broken.url, async () => {
          for (const surface of ["welcome-credits", "account-summary"] as const) {
            const res = await asBrowser(U.a, surface)
            expect([res.status, res.body.code], surface).toEqual([503, "service_unavailable"])
            expect(jar().cleared("sb-")).toBe(false)
          }
          expect(await header(U.a)).toBeNull()
        })
      } finally {
        await broken.app.close()
        await pool.end()
      }
    })

    it("malformed backend responses -> safe 503; header anonymous", async () => {
      const server = http.createServer((req, res) => {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(req.url?.includes("profile") ? '{"fullName":{"x":1}}' : '{"balance":"lots","welcomeImageCreditsRemaining":-3}')
      })
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()))
      try {
        await withBackendUrl(`http://127.0.0.1:${(server.address() as net.AddressInfo).port}`, async () => {
          for (const surface of ["welcome-credits", "account-summary"] as const) {
            const res = await asBrowser(U.a, surface)
            expect([res.status, res.body.code], surface).toEqual([503, "service_unavailable"])
          }
          expect(await header(U.a)).toBeNull()
        })
      } finally {
        await new Promise((r) => server.close(r))
      }
    })
  })

  describe("23. local warm timings and round trips (localhost, not a production estimate)", () => {
    it("direct Fastify vs Next -> Fastify -> PostgreSQL, per read", async () => {
      const N = 40
      await signIn(U.a)
      const fmt = (xs: number[]) => ({ medianMs: +pct(xs, 50).toFixed(1), p90Ms: +pct(xs, 90).toFixed(1) })
      const measure = async (work: () => Promise<void>) => {
        const xs: number[] = []
        for (let i = 0; i < N + 5; i++) {
          const t = performance.now()
          await work()
          if (i >= 5) xs.push(performance.now() - t)
        }
        return fmt(xs)
      }
      const directRead = (p: string) => async () => {
        const res = await direct(p, sign(U.a, p))
        expect(res.status).toBe(200)
        await res.json()
      }
      const nextRoute = (handler: (r: Request) => Promise<Response>, p: string) => async () => {
        const res = await handler(new Request(`http://localhost:3000${p}`))
        expect(res.status).toBe(200)
        await res.json()
      }
      const results = {
        directProfile: await measure(directRead("/v1/parent/profile")),
        directCandyBalance: await measure(directRead("/v1/parent/candy-balance")),
        directWelcomeCredits: await measure(directRead("/v1/parent/welcome-credits")),
        nextWelcomeCredits: await measure(nextRoute(welcomeCreditsRoute, "/api/parent/welcome-credits")),
        nextAccountSummary: await measure(nextRoute(accountSummaryRoute, "/api/parent/account-summary")),
        nextPublicHeader: await measure(async () => { expect(await getPublicHeaderAccount({})).not.toBeNull() }),
      }
      console.log(`[account cutover perf] ${JSON.stringify({ requests: N, ...results })}`)
    })
  })
})
