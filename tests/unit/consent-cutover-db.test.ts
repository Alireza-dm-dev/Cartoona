import { describe, it, expect, beforeAll, afterAll, vi } from "vitest"
import { randomBytes } from "node:crypto"
import type net from "node:net"
import path from "node:path"
import { Pool, type PoolClient } from "pg"

const cookies = vi.hoisted(() => ({ jar: null as null | { getAll(): Array<{ name: string; value: string }>; setAll(c: Array<{ name: string; value: string }>): void } }))
vi.mock("next/headers", () => ({
  cookies: async () => ({
    getAll: () => cookies.jar?.getAll() ?? [],
    set: (name: string, value: string) => cookies.jar?.setAll([{ name, value }]),
  }),
}))

import type { FastifyInstance } from "fastify"
import { isRedirectError } from "next/dist/client/components/redirect-error"
import { getURLFromRedirectError } from "next/dist/client/components/redirect"
import { buildBackendApp } from "@/backend/src/app"
import { GET as consentGET, POST as consentPOST } from "@/app/api/parent-consent/route"
import { POST as requestsPOST } from "@/app/api/requests/route"
import ParentConsentPage from "@/app/(auth)/parent-consent/page"
import ParentConsentForm from "@/app/(auth)/parent-consent/parent-consent-form"
import CompleteRequestPage from "@/app/(auth)/complete-request/page"
import { resolveSuccessfulLoginDestination } from "@/lib/auth/parent-destinations"
import { readParentConsent } from "@/lib/parent/consent/consent-client"
import { PARENT_PORTAL_HOME } from "@/lib/parent/navigation/parent-nav"
import { closePool, getPool } from "@/lib/db/pool"
import { DbError } from "@/lib/db/errors"
import type { Queryable } from "@/lib/db/types"
import { newWriteNonce, signAssertion, signWriteAssertion } from "@/lib/identity/assertion"
import { toVerifiedIdentity } from "@/lib/identity/types"
import { consumeWriteNonce } from "@/lib/repositories/write-nonces"
import { InMemoryRateLimitStore, setRateLimitStore } from "@/lib/rate-limit"
import { runDataCopy } from "@/scripts/db/data-copy/copy"
import { buildSupabaseSource, dropDbs, migrateTarget, ownerUrl, pgEnv, psql, root, script, type PgEnv } from "../helpers/data-copy-db"
import { cookieJar, cookieName, startStubAuth, type StubAuth } from "../helpers/stub-supabase-auth"
import { DAY_MS } from "../helpers/supabase-jwt"

/**
 * V0.1.48 consent cutover, end to end on REAL local services
 * (opt-in: CARTOONA_PLAIN_PG=docker):
 *
 *   Supabase-shaped source (real migrations + fixtures, incl. un-consented
 *   parents) -> V0.1.44 copy -> plain PostgreSQL 17 (0001-0014)
 *   stub Supabase Auth (real @supabase/ssr) -> Next consent route (CSRF, v3
 *   write), /parent-consent and /complete-request pages, the POST
 *   /api/requests gate, the /login decision -> Fastify (listening, restricted
 *   login role) -> requireAuth / requireWriteAuth -> PostgreSQL.
 *
 * Proves: read-after-write through every gate, no consent loop, outcomeUnknown
 * recovery, replay, cross-parent isolation, auth/session cases, outage
 * semantics, database privileges, copy preservation, and local timings.
 * Nothing contacts Supabase or any hosted service.
 */

const enabled = process.env.CARTOONA_PLAIN_PG === "docker"
const id = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`
const SRC = `pcs_${id}`
const TGT = `pct_${id}`
const ROLE = `cartoona_app_pc${id}`
const DB_PASSWORD = randomBytes(24).toString("hex")
const AUTH_SECRET = randomBytes(32).toString("hex")
const ORIGIN = "http://localhost:3000"
const PATH = "/v1/parent/consent"

const U = {
  a: "a1000000-0000-4000-8000-000000000001", // consented (copied)
  b: "a1000000-0000-4000-8000-000000000002", // consented (copied)
  admin: "a1000000-0000-4000-8000-000000000003",
  deleted: "a1000000-0000-4000-8000-000000000004",
  superAdmin: "a1000000-0000-4000-8000-000000000005",
  d: "a1000000-0000-4000-8000-000000000007", // NOT consented
  e: "a1000000-0000-4000-8000-000000000008", // NOT consented
  f: "a1000000-0000-4000-8000-000000000009", // consented, microsecond time
  g: "a1000000-0000-4000-8000-0000000000aa", // NOT consented (created in the target; used by the uncertain-outcome tests)
  h: "a1000000-0000-4000-8000-0000000000ab", // NOT consented (target; sessions_not_before)
}
const NO_PROFILE_USER = "a1000000-0000-4000-8000-0000000000bb"
const UNLINKED = "a1000000-0000-4000-8000-0000000000ee"

let env: PgEnv
let backend: FastifyInstance | null = null
let backendUrl = ""
let stub: StubAuth | null = null
let appPool: Pool

const tgt = (sql: string) => psql(env, TGT, sql)
const consentIn = (db: string, user: string) =>
  psql(env, db, `select consent_granted || '|' || coalesce(to_char(consent_granted_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'), '-') from public.parent_profiles where user_id = '${user}'`)
const allConsent = (db: string) =>
  psql(env, db, `select string_agg(user_id || '=' || consent_granted || '@' || coalesce(consent_granted_at::text, '-'), ',' order by user_id) from public.parent_profiles`)

async function signIn(userId: string, opts: { authenticatedAt?: number; role?: string; userMode?: StubAuth["options"]["userMode"] } = {}) {
  await stub?.close()
  stub = await startStubAuth({ userId, role: opts.role ?? "parent", userMode: opts.userMode })
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", stub.url)
  cookies.jar = cookieJar([stub.cookie({ authenticatedAt: opts.authenticatedAt })])
}
const jar = () => cookies.jar as ReturnType<typeof cookieJar>
const signedOut = () => jar().cleared(cookieName(stub!.url))

const browserPost = (body = '{"consentGranted":true}', headers: Record<string, string> = {}) =>
  consentPOST(new Request(`${ORIGIN}/api/parent-consent`, {
    method: "POST",
    body,
    headers: { "content-type": "application/json", origin: ORIGIN, "sec-fetch-site": "same-origin", ...headers },
  }))
const browserGet = () => consentGET(new Request(`${ORIGIN}/api/parent-consent`))
async function json(res: Response) {
  return { status: res.status, body: await res.json() }
}

/** The /parent-consent page as the signed-in parent: "form:<granted>", a notice title, or a redirect URL. */
async function consentPage(): Promise<string> {
  try {
    const el = (await ParentConsentPage()) as { type: unknown; props: { initiallyGranted?: boolean; title?: string } }
    if (el.type === ParentConsentForm) return `form:${el.props.initiallyGranted}`
    // V0.1.49: an account not ready in PostgreSQL gets the bootstrap retry card.
    if ((el.type as { name?: string }).name === "SetupIncomplete") return "setup_incomplete"
    return `notice:${el.props.title}`
  } catch (e) {
    if (isRedirectError(e)) return `redirect:${getURLFromRedirectError(e)}`
    throw e
  }
}

/** The /complete-request page: "render", "alert:<text>", or a redirect URL. */
async function completeRequestPage(): Promise<string> {
  try {
    const el = (await CompleteRequestPage()) as { props: { role?: string; children?: unknown } }
    if (el.props.role === "alert") return `alert:${JSON.stringify(el.props.children).includes("رضایت") ? "consent" : "other"}`
    return "render"
  } catch (e) {
    if (isRedirectError(e)) return `redirect:${getURLFromRedirectError(e)}`
    throw e
  }
}

/** POST /api/requests up to its first post-gate check: 403 = refused by the consent gate, 400 = passed it (no draft sent). */
async function requestGate(): Promise<{ status: number; body: Record<string, unknown> }> {
  setRateLimitStore(new InMemoryRateLimitStore())
  const fd = new FormData()
  fd.set("probe", "1")
  return json(await requestsPOST(new Request(`${ORIGIN}/api/requests`, { method: "POST", body: fd, headers: { origin: ORIGIN, "sec-fetch-site": "same-origin" } })))
}

/** The /login decision for a just-signed-in parent with no ?from=. */
async function loginDestination(): Promise<string> {
  const viaBff = (async () => consentGET(new Request(`${ORIGIN}/api/parent-consent`))) as unknown as typeof fetch
  return resolveSuccessfulLoginDestination(null, (await readParentConsent(viaBff)) === true)
}

/** Every consent surface, as one signed-in parent. */
async function allGates(user: string) {
  await signIn(user)
  return {
    api: (await json(await browserGet())).body,
    page: await consentPage(),
    completeRequest: await completeRequestPage(),
    requestGate: (await requestGate()).status,
    login: await loginDestination(),
  }
}

const ident = (subject: string) => toVerifiedIdentity({ provider: "supabase", subject })
const signRead = (user: string, over: { path?: string } = {}) =>
  signAssertion({ identity: ident(user), authenticatedAt: Date.now() - DAY_MS, requestId: "pc-read-000001", method: "GET", path: over.path ?? PATH, secret: Buffer.from(AUTH_SECRET, "hex") })
const signWrite = (user: string, body: string, over: { path?: string; method?: string } = {}) =>
  signWriteAssertion({ identity: ident(user), authenticatedAt: Date.now() - DAY_MS, requestId: `pc-w-${randomBytes(4).toString("hex")}`, method: over.method ?? "POST", path: over.path ?? PATH, body, secret: Buffer.from(AUTH_SECRET, "hex") })
const directGet = (token?: string, url = backendUrl) =>
  fetch(`${url}${PATH}`, { headers: token ? { "x-cartoona-internal-auth": token } : {} })
const directPost = (body: string, token?: string, extra: Record<string, string> = {}, url = backendUrl) =>
  fetch(`${url}${PATH}`, { method: "POST", body, headers: { "content-type": "application/json", ...(token ? { "x-cartoona-internal-auth": token } : {}), ...extra } })

let consentWrites = 0
function countingDb(opts: { delayBeforeMs?: number; delayAfterMs?: number; down?: boolean } = {}): () => Queryable {
  return () => ({
    query: async (text: string, values?: readonly unknown[]) => {
      if (opts.down) throw Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5433"), { code: "ECONNREFUSED" })
      const isWrite = text.includes("record_parent_consent_trusted")
      if (isWrite && opts.delayBeforeMs) await new Promise((r) => setTimeout(r, opts.delayBeforeMs))
      const result = await getPool().query(text, values as unknown[])
      if (isWrite) {
        consentWrites += 1
        // Autocommit: the grant has COMMITTED; only the response is late.
        if (opts.delayAfterMs) await new Promise((r) => setTimeout(r, opts.delayAfterMs))
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

async function withBackend<T>(url: string, timeoutMs: string, work: () => Promise<T>): Promise<T> {
  vi.stubEnv("BACKEND_INTERNAL_URL", url)
  vi.stubEnv("BACKEND_REQUEST_TIMEOUT_MS", timeoutMs)
  try {
    return await work()
  } finally {
    vi.stubEnv("BACKEND_INTERNAL_URL", backendUrl)
    vi.stubEnv("BACKEND_REQUEST_TIMEOUT_MS", "2000")
  }
}

async function sqlState(work: Promise<unknown>): Promise<string | undefined> {
  const e = await work.then(() => null, (x: unknown) => x)
  return (e as { code?: string } | null)?.code
}

const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))]

describe.skipIf(!enabled)("V0.1.48 consent cutover: copied data -> Fastify -> Next (local Docker PostgreSQL 17)", () => {
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
    // Target-only accounts (owner writes, test only): two more un-consented
    // parents, and a parent account without a profile.
    await tgt(`insert into public.users (id, role) values ('${U.g}', 'parent'), ('${U.h}', 'parent'), ('${NO_PROFILE_USER}', 'parent');
      insert into public.user_identities (user_id, provider, provider_subject) values
        ('${U.g}', 'supabase', '${U.g}'), ('${U.h}', 'supabase', '${U.h}'), ('${NO_PROFILE_USER}', 'supabase', '${NO_PROFILE_USER}');
      insert into public.parent_profiles (user_id, full_name) values ('${U.g}', 'Parent G'), ('${U.h}', 'Parent H')`)
    const r = await script(env, "scripts/db/app-login-role.sh", { DATABASE_URL: `postgresql://cartoona@postgres:5432/${TGT}`, CARTOONA_APP_DB_PASSWORD: DB_PASSWORD }, [ROLE])
    expect(r.code).toBe(0)
    const roleUrl = `postgresql://${ROLE}:${DB_PASSWORD}@127.0.0.1:${env.port}/${TGT}`
    appPool = new Pool({ connectionString: roleUrl, max: 12 })
    vi.stubEnv("DATABASE_URL", roleUrl)
    vi.stubEnv("CARTOONA_INTERNAL_AUTH_SECRET", AUTH_SECRET)
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-key")
    vi.stubEnv("BACKEND_REQUEST_TIMEOUT_MS", "2000")
    ;({ app: backend, url: backendUrl } = await startBackend(countingDb()))
    vi.stubEnv("BACKEND_INTERNAL_URL", backendUrl)
  })

  afterAll(async () => {
    vi.restoreAllMocks()
    await stub?.close()
    await backend?.close()
    await appPool?.end()
    await closePool()
    vi.unstubAllEnvs()
    if (!env) return
    await dropDbs(env, [SRC, TGT])
    await psql(env, "postgres", `drop role if exists ${ROLE}`).catch(() => undefined)
  })

  describe("29. the copy preserved every consent value exactly", () => {
    it("source false -> target false, source true -> target true, times to the microsecond, nothing regenerated", async () => {
      const source = await allConsent(SRC)
      const copiedRows = (await allConsent(TGT)).split(",").filter((r) => !r.startsWith(U.g) && !r.startsWith(U.h))
      expect(copiedRows.join(",")).toBe(source)
      expect(await consentIn(SRC, U.d)).toBe("false|-")
      expect(await consentIn(TGT, U.d)).toBe("false|-")
      expect(await consentIn(TGT, U.e)).toBe("false|-")
      expect(await consentIn(TGT, U.f)).toBe("true|2026-08-05T09:05:00.123456")
      expect(await consentIn(TGT, U.a)).toBe(await consentIn(SRC, U.a))
    })

    it("the copied value is what the backend serves", async () => {
      expect(await (await directGet(signRead(U.f))).json()).toEqual({ consentGranted: true, consentGrantedAt: "2026-08-05T09:05:00.123Z" })
      expect(await (await directGet(signRead(U.d))).json()).toEqual({ consentGranted: false, consentGrantedAt: null })
    })
  })

  describe("25/26. read-after-write through every gate, and no consent loop", () => {
    it("before: every surface sees parent D as NOT consented", async () => {
      expect(await allGates(U.d)).toEqual({
        api: { consentGranted: false },
        page: "form:false",
        completeRequest: "redirect:/parent-consent",
        requestGate: 403,
        login: "/parent-consent",
      })
    })

    it("the browser write: CSRF passes, v3 -> Fastify -> PostgreSQL changes, the stored time comes back", async () => {
      await signIn(U.d)
      const res = await json(await browserPost())
      expect(res.status).toBe(200)
      expect(res.body).toMatchObject({ success: true, consentGranted: true })
      const stored = await tgt(`select to_char(consent_granted_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') from public.parent_profiles where user_id = '${U.d}'`)
      expect(res.body.consentGrantedAt).toBe(stored)
      expect(await consentIn(TGT, U.d)).toMatch(/^true\|/)
    })

    it("after: EVERY surface sees the same PostgreSQL value - no gate sends D back to /parent-consent", async () => {
      expect(await allGates(U.d)).toEqual({
        api: { consentGranted: true },
        page: "form:true", // the form continues to /complete-request or /dashboard at once
        completeRequest: "render",
        requestGate: 400, // past the consent gate (refused later only for the missing draft)
        login: PARENT_PORTAL_HOME,
      })
    })

    it("loop regression: navigating dashboard -> complete-request -> parent-consent -> complete-request never lands on /parent-consent", async () => {
      await signIn(U.d)
      const visits = [await completeRequestPage(), await consentPage(), await completeRequestPage(), await consentPage()]
      expect(visits).toEqual(["render", "form:true", "render", "form:true"])
      // The /parent-consent form, when granted, goes onward - never to itself.
      const form = await import("@/app/(auth)/parent-consent/parent-consent-form")
      expect(form.default).toBe(ParentConsentForm)
    })

    it("granting again (a legitimate retry) is harmless and keeps the first grant's time", async () => {
      const before = await consentIn(TGT, U.d)
      await signIn(U.d)
      expect((await browserPost()).status).toBe(200)
      expect(await consentIn(TGT, U.d)).toBe(before)
    })

    it("only D changed: every other profile's consent is untouched", async () => {
      const others = (await allConsent(TGT)).split(",").filter((r) => !r.startsWith(U.d))
      const sourceOthers = (await allConsent(SRC)).split(",").filter((r) => !r.startsWith(U.d))
      expect(others.filter((r) => !r.startsWith(U.g) && !r.startsWith(U.h))).toEqual(sourceOthers)
    })
  })

  describe("10/27. CSRF on the real route", () => {
    it.each([
      ["hostile Origin", { origin: "https://evil.example" }, 403],
      ["cross-site fetch", { "sec-fetch-site": "cross-site" }, 403],
      ["text/plain (simple cross-site request)", { "content-type": "text/plain" }, 415],
      ["forged X-Forwarded-Host with a hostile Origin", { origin: "https://evil.example", "x-forwarded-host": "evil.example" }, 403],
    ])("%s -> %i, provider never asked, nothing written", async (_l, headers, status) => {
      await signIn(U.e)
      stub!.requests.length = 0
      const res = await browserPost(undefined, headers)
      expect(res.status).toBe(status)
      expect(stub!.requests).toHaveLength(0)
      expect(await consentIn(TGT, U.e)).toBe("false|-")
    })

    it("missing Origin -> 403", async () => {
      await signIn(U.e)
      const res = await consentPOST(new Request(`${ORIGIN}/api/parent-consent`, { method: "POST", body: '{"consentGranted":true}', headers: { "content-type": "application/json" } }))
      expect(res.status).toBe(403)
      expect(await consentIn(TGT, U.e)).toBe("false|-")
    })

    it("the internal Next -> Fastify write carries no browser header and needs none (no Origin at all)", async () => {
      const body = '{"consentGranted":true}'
      // A direct server-to-server write, no Origin / Sec-Fetch-Site: authorised by the v3 assertion alone.
      const res = await directPost(body, signWrite(U.h, body))
      expect(res.status).toBe(200)
      // ... and a browser-looking hostile Origin on it changes nothing either way.
      expect((await directPost(body, signWrite(U.h, body), { origin: "https://evil.example", "sec-fetch-site": "cross-site" })).status).toBe(200)
      await tgt(`update public.parent_profiles set consent_granted = false, consent_granted_at = null where user_id = '${U.h}'`)
    })
  })

  describe("18/19. outcomeUnknown and replay", () => {
    it("committed, but the answer is lost: Next times out once, re-reads, finds consent, and reports SUCCESS - one write, no replay", async () => {
      const slow = await startBackend(countingDb({ delayAfterMs: 1500 }))
      try {
        consentWrites = 0
        await signIn(U.g)
        const res = await withBackend(slow.url, "500", async () => json(await browserPost()))
        expect(res.status).toBe(200)
        expect(res.body).toMatchObject({ success: true, consentGranted: true })
        expect(consentWrites).toBe(1)
        expect(await consentIn(TGT, U.g)).toMatch(/^true\|/)
        expect(signedOut()).toBe(false)
      } finally {
        await slow.app.close()
      }
      await tgt(`update public.parent_profiles set consent_granted = false, consent_granted_at = null where user_id = '${U.g}'`)
    })

    it("not yet committed when Next gives up: 503 consent_outcome_unknown (never 'failed'); the late commit is then seen by 'check status'; replaying the SAME assertion is 409; a user retry (new nonce) is safe", async () => {
      const slow = await startBackend(countingDb({ delayBeforeMs: 1200 }))
      const sent: Array<{ url: string; token: string; body: string }> = []
      // Record exactly what the Next server sent to the backend (the signed
      // write), passing every request through to the real fetch.
      const realFetch = globalThis.fetch
      const capture = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        const url = String(input)
        if (url.startsWith(slow.url) && init?.method === "POST") {
          sent.push({ url, token: (init.headers as Record<string, string>)["X-Cartoona-Internal-Auth"], body: new TextDecoder().decode(init.body as Uint8Array) })
        }
        return realFetch(input, init)
      })
      try {
        consentWrites = 0
        await signIn(U.g)
        const res = await withBackend(slow.url, "500", async () => json(await browserPost()))
        expect(res.status).toBe(503)
        expect(res.body.code).toBe("consent_outcome_unknown")
        expect(res.body.error).toMatch(/نتوانستیم تأیید کنیم که رضایت شما ثبت شده است/)
        expect(signedOut()).toBe(false)
        expect(sent).toHaveLength(1)

        // The write lands after Next stopped waiting.
        await new Promise((r) => setTimeout(r, 1500))
        expect(consentWrites).toBe(1)
        expect(await consentIn(TGT, U.g)).toMatch(/^true\|/)
        const committed = await consentIn(TGT, U.g)

        // "Check status" (GET /api/parent-consent) now confirms it.
        expect((await json(await browserGet())).body).toEqual({ consentGranted: true })

        // A transport replay of the very same signed request: refused, no second write.
        const replay = await directPost(sent[0].body, sent[0].token)
        expect([replay.status, await replay.json()]).toEqual([409, { error: "replayed_request" }])
        expect(consentWrites).toBe(1)

        // The user's deliberate retry: new assertion, new nonce -> 200, same stored time.
        capture.mockRestore()
        const retry = await json(await browserPost())
        expect(retry.status).toBe(200)
        expect(await consentIn(TGT, U.g)).toBe(committed)
      } finally {
        capture.mockRestore()
        await slow.app.close()
      }
    })

    it("a v3 assertion is single-use against the real nonce table, also under 20 concurrent copies", async () => {
      const body = '{"consentGranted":true}'
      const token = signWrite(U.b, body)
      const statuses = await Promise.all(Array.from({ length: 20 }, () => directPost(body, token).then((r) => r.status)))
      expect(statuses.filter((s) => s === 200)).toHaveLength(1)
      expect(statuses.filter((s) => s === 409)).toHaveLength(19)
    })
  })

  describe("20. cross-parent isolation", () => {
    it("A's write never alters B or E: forged headers, ids in the body, hostile query", async () => {
      const snapshot = await allConsent(TGT)
      await signIn(U.a)
      const forged = { "x-user-id": U.e, "x-role": "super_admin", "x-parent-profile-id": U.e, "x-cartoona-internal-auth": signWrite(U.e, '{"consentGranted":true}') }
      expect((await browserPost(undefined, forged)).status).toBe(200) // A's own (already granted) consent
      expect((await browserPost(`{"consentGranted":true,"userId":"${U.e}"}`)).status).toBe(422)
      expect((await browserPost(`{"consentGranted":true,"parentProfileId":"b1000000-0000-4000-8000-000000000008"}`)).status).toBe(422)
      const hostileQuery = await consentPOST(new Request(`${ORIGIN}/api/parent-consent?userId=${U.e}`, {
        method: "POST", body: '{"consentGranted":true}', headers: { "content-type": "application/json", origin: ORIGIN },
      }))
      expect(hostileQuery.status).toBe(200) // the query is never read; still A's own row
      expect(await allConsent(TGT)).toBe(snapshot)
    })

    it("direct to Fastify: wrong-path, tampered-body, v2-on-write, ids in the body or query -> refused, E unchanged", async () => {
      const body = '{"consentGranted":true}'
      const v2 = signAssertion({ identity: ident(U.e), authenticatedAt: Date.now() - DAY_MS, requestId: "pc-v2-0000001", method: "GET", path: PATH, secret: Buffer.from(AUTH_SECRET, "hex") })
      expect((await directPost(body, signWrite(U.e, body, { path: "/v1/parent/profile" }))).status).toBe(401)
      expect((await directPost('{"consentGranted": true}', signWrite(U.e, body))).status).toBe(401)
      expect((await directPost(body, v2)).status).toBe(401)
      const withId = `{"consentGranted":true,"userId":"${U.e}"}`
      expect((await directPost(withId, signWrite(U.a, withId))).status).toBe(400)
      expect((await fetch(`${backendUrl}${PATH}?userId=${U.e}`, { method: "POST", body, headers: { "content-type": "application/json", "x-cartoona-internal-auth": signWrite(U.a, body) } })).status).toBe(400) // the assertion binds the path; the route refuses any query
      expect(await consentIn(TGT, U.e)).toBe("false|-")
      // A v3 assertion is refused on the read; a v2 one is the only way to read.
      expect((await directGet(signWrite(U.e, ""))).status).toBe(401)
      expect((await directGet(signRead(U.e))).status).toBe(200)
    })
  })

  describe("21. auth and session cases, read and write", () => {
    it.each([
      ["admin", U.admin, "admin", 403, "forbidden"],
      ["super_admin", U.superAdmin, "super_admin", 403, "forbidden"],
      ["deleted user", U.deleted, "parent", 403, "forbidden"],
      ["unlinked identity", UNLINKED, "parent", 403, "identity_not_linked"],
    ])("%s -> %i %s on GET and POST, nothing written, no sign-out", async (_l, user, role, status, code) => {
      const snapshot = await allConsent(TGT)
      await signIn(user, { role })
      expect(await json(await browserGet())).toMatchObject({ status, body: { code } })
      expect(await json(await browserPost())).toMatchObject({ status, body: { code } })
      expect(await allConsent(TGT)).toBe(snapshot)
      expect(signedOut()).toBe(false)
    })

    it("a parent without a profile: GET false (as before), POST 403 no_parent_profile, page offers the account bootstrap (V0.1.49), nothing created by the GET", async () => {
      await signIn(NO_PROFILE_USER)
      expect((await json(await browserGet())).body).toEqual({ consentGranted: false })
      expect(await json(await browserPost())).toMatchObject({ status: 403, body: { code: "no_parent_profile" } })
      expect(await consentPage()).toBe("setup_incomplete")
      expect(await completeRequestPage()).toBe("redirect:/parent-consent")
      expect(await tgt(`select count(*) from public.parent_profiles where user_id = '${NO_PROFILE_USER}'`)).toBe("0")
    })

    it("expired session (31 days) -> 401 PARENT_SESSION_EXPIRED and a local sign-out; the page sends to login", async () => {
      await signIn(U.e, { authenticatedAt: Date.now() - 31 * DAY_MS })
      expect(await json(await browserPost())).toMatchObject({ status: 401, body: { code: "PARENT_SESSION_EXPIRED" } })
      expect(await consentIn(TGT, U.e)).toBe("false|-")
      await signIn(U.e, { authenticatedAt: Date.now() - 31 * DAY_MS })
      // V0.1.53: the page gate (PostgreSQL role + session policy) sends an expired session to login.
      expect(await consentPage()).toBe("redirect:/login?reason=session_expired&from=%2Fparent-consent")
    })

    it("invalidated session (sessions_not_before after sign-in) -> 401 PARENT_SESSION_EXPIRED + sign-out, nothing written", async () => {
      await tgt(`update public.users set sessions_not_before = now() where id = '${U.h}'`)
      try {
        await signIn(U.h, { authenticatedAt: Date.now() - DAY_MS })
        expect(await json(await browserPost())).toMatchObject({ status: 401, body: { code: "PARENT_SESSION_EXPIRED" } })
        expect(signedOut()).toBe(true)
        expect(await consentIn(TGT, U.h)).toBe("false|-")
      } finally {
        await tgt(`update public.users set sessions_not_before = null where id = '${U.h}'`)
      }
    })

    it("identity provider down -> 503 SESSION_CHECK_UNAVAILABLE, no sign-out, nothing written", async () => {
      await signIn(U.e, { userMode: "server_error" })
      expect(await json(await browserPost())).toMatchObject({ status: 503, body: { code: "SESSION_CHECK_UNAVAILABLE" } })
      expect(signedOut()).toBe(false)
      expect(await consentIn(TGT, U.e)).toBe("false|-")
    })
  })

  describe("22. database / backend outage: 'could not determine' is never 'not consented'", () => {
    it("database down: GET 503 (not false), POST 503 consent_outcome_unknown, gates show a retry - no redirect, no sign-out", async () => {
      const down = await startBackend(countingDb({ down: true }))
      try {
        await withBackend(down.url, "2000", async () => {
          await signIn(U.a) // consented
          expect(await json(await browserGet())).toMatchObject({ status: 503, body: { code: "service_unavailable" } })
          expect(await json(await browserPost())).toMatchObject({ status: 503, body: { code: "consent_outcome_unknown" } })
          // V0.1.53: the page gate cannot confirm the session/role either -> the retry notice (never access, never a redirect).
          expect(await consentPage()).toBe("notice:بررسی نشست")
          expect(await completeRequestPage()).toBe("alert:other")
          const gate = await requestGate()
          expect([gate.status, gate.body.code]).toEqual([503, "request_unavailable"])
          // /login: unknown routes like "not granted" - to /parent-consent, which re-reads and forwards.
          expect(await loginDestination()).toBe("/parent-consent")
          expect(signedOut()).toBe(false)
        })
      } finally {
        await down.app.close()
      }
    })

    it("backend unreachable (the ~5 s Docker startup window): same safe answers, the write is reported uncertain", async () => {
      await withBackend("http://127.0.0.1:9", "2000", async () => {
        await signIn(U.e)
        expect((await json(await browserGet())).status).toBe(503)
        const res = await json(await browserPost())
        expect([res.status, res.body.code]).toEqual([503, "consent_outcome_unknown"])
        expect(signedOut()).toBe(false)
      })
      expect(await consentIn(TGT, U.e)).toBe("false|-")
    })
  })

  describe("28. the restricted role's privileges", () => {
    it("CAN read consent, execute the consent function and consume a nonce", async () => {
      expect((await appPool.query(`select consent_granted from public.parent_profiles where user_id = $1`, [U.a])).rows).toEqual([{ consent_granted: true }])
      expect((await appPool.query(`select * from public.record_parent_consent_trusted($1)`, [U.a])).rowCount).toBe(1)
      expect(await consumeWriteNonce(appPool, { nonce: newWriteNonce(), expiresAtSeconds: Math.floor(Date.now() / 1000) + 30, requestId: "pc-priv-00001" })).toBe(true)
    })

    it.each([
      ["update consent directly", `UPDATE public.parent_profiles SET consent_granted = true WHERE user_id = '${U.e}'`],
      ["update the consent time directly", `UPDATE public.parent_profiles SET consent_granted_at = now() WHERE user_id = '${U.a}'`],
      ["update a referral code", "UPDATE public.parent_profiles SET referral_code = 'CT000000000000'"],
      ["update a profile's owner", `UPDATE public.parent_profiles SET user_id = '${U.b}'`],
      ["update created_at", "UPDATE public.parent_profiles SET created_at = now()"],
      ["insert a profile", `INSERT INTO public.parent_profiles (user_id) VALUES ('${NO_PROFILE_USER}')`],
      ["delete a profile", "DELETE FROM public.parent_profiles"],
      ["read the nonce table", "SELECT * FROM public.internal_write_nonces"],
      ["insert a nonce directly", `INSERT INTO public.internal_write_nonces (nonce, expires_at, request_id) VALUES ('${"Q".repeat(43)}', now(), 'pc-direct-0001')`],
      ["delete nonces", "DELETE FROM public.internal_write_nonces"],
      ["update a wallet", "UPDATE public.candy_wallets SET balance = 1000"],
      ["complete a candy purchase", "SELECT * FROM public.complete_candy_purchase_trusted(gen_random_uuid(), gen_random_uuid(), 'x')"],
      // V0.1.50: create_parent_request_trusted is executable (0016): its privileges are asserted in request-cutover-db.test.ts.
      // V0.1.52: record_final_media_trusted is executable (0018); its privileges and role check are asserted in order-fulfilment-cutover-db.test.ts.
    ])("CANNOT %s (42501)", async (_l, sql) => {
      expect(await sqlState(appPool.query(sql))).toBe("42501")
    })

    it("the function is one-way, never inserts, and does nothing for an admin, a deleted parent or a missing profile", async () => {
      const before = await allConsent(TGT)
      for (const user of [U.admin, U.deleted, NO_PROFILE_USER, UNLINKED]) {
        expect((await appPool.query(`select * from public.record_parent_consent_trusted($1)`, [user])).rowCount, user).toBe(0)
      }
      // Already granted: same time back, nothing changes.
      const f = await appPool.query(`select consent_granted, consent_granted_at from public.record_parent_consent_trusted($1)`, [U.f])
      expect(f.rows[0].consent_granted_at.toISOString()).toBe("2026-08-05T09:05:00.123Z")
      expect(await allConsent(TGT)).toBe(before)
      expect(await tgt("select count(*) from public.parent_profiles where user_id in ('" + [U.admin, NO_PROFILE_USER].join("','") + "')")).toBe("0")
      const bad = await appPool.query("select * from public.record_parent_consent_trusted(null)").then(() => null, (e: unknown) => e)
      expect((bad as { code?: string }).code).toBe("22023")
    })

    it("10 concurrent grants for one un-consented parent write ONE time; all return it", async () => {
      await tgt(`update public.parent_profiles set consent_granted = false, consent_granted_at = null where user_id = '${U.h}'`)
      const clients: PoolClient[] = await Promise.all(Array.from({ length: 10 }, () => appPool.connect()))
      try {
        const results = await Promise.all(clients.map((c) => c.query(`select consent_granted_at from public.record_parent_consent_trusted($1)`, [U.h])))
        const times = new Set(results.map((r) => r.rows[0].consent_granted_at.toISOString()))
        expect(times.size).toBe(1)
        expect(await consentIn(TGT, U.h)).toMatch(/^true\|/)
      } finally {
        for (const c of clients) c.release()
      }
      await tgt(`update public.parent_profiles set consent_granted = false, consent_granted_at = null where user_id = '${U.h}'`)
    })

    it("only EXECUTE on the consent function was added; still no table-wide UPDATE", async () => {
      expect(await tgt("select has_function_privilege('cartoona_app', 'public.record_parent_consent_trusted(uuid)', 'EXECUTE')")).toBe("t")
      expect(await tgt("select has_function_privilege('public', 'public.record_parent_consent_trusted(uuid)', 'EXECUTE')")).toBe("f")
      expect(await tgt("select has_table_privilege('cartoona_app', 'public.parent_profiles', 'UPDATE')")).toBe("f")
      expect(await tgt(`select string_agg(column_name, ',' order by column_name) from information_schema.column_privileges
        where grantee = 'cartoona_app' and table_name = 'parent_profiles' and privilege_type = 'UPDATE'`)).toBe("full_name,updated_at")
      expect(await tgt("select string_agg(version, ',' order by version) from public.schema_migrations")).toMatch(/0014_parent_consent_write,0015_supabase_parent_provisioning,0016_parent_request_privileges,0017_candy_purchase_payment,0018_order_fulfilment_media,0019_remove_supabase_db_dependencies$/)
    })

    it("a raw DbError from the app role never leaks through the backend", async () => {
      const e = await appPool.query("UPDATE public.parent_profiles SET consent_granted = true").then(() => null, (x: unknown) => x)
      expect(e).not.toBeInstanceOf(DbError) // raw pg error here; the backend wraps it (backend-parent-consent.test.ts)
    })
  })

  describe("33. timings (local Docker, NOT production estimates)", () => {
    it("consent GET direct / via Next; write direct / via Next; write + verification read", async () => {
      const N = 40
      const series = { getDirect: [] as number[], getNext: [] as number[], postDirect: [] as number[], postNext: [] as number[], writeThenRead: [] as number[] }
      await signIn(U.b)
      const body = '{"consentGranted":true}'
      for (let i = 0; i < N + 5; i++) {
        let t = performance.now()
        expect((await directGet(signRead(U.b))).status).toBe(200)
        const gd = performance.now() - t
        t = performance.now()
        expect((await browserGet()).status).toBe(200)
        const gn = performance.now() - t
        t = performance.now()
        expect((await directPost(body, signWrite(U.b, body))).status).toBe(200)
        const pd = performance.now() - t
        t = performance.now()
        expect((await browserPost()).status).toBe(200)
        const pn = performance.now() - t
        t = performance.now()
        expect((await browserPost()).status).toBe(200)
        expect((await json(await browserGet())).body).toEqual({ consentGranted: true })
        const wr = performance.now() - t
        if (i >= 5) {
          series.getDirect.push(gd); series.getNext.push(gn); series.postDirect.push(pd); series.postNext.push(pn); series.writeThenRead.push(wr)
        }
      }
      const fmt = (xs: number[]) => `median ${pct(xs, 50).toFixed(2)} ms, p90 ${pct(xs, 90).toFixed(2)} ms`
      process.stderr.write(`[consent timings, local Docker PostgreSQL 17 + in-process stub provider, ${N} each]
  GET  Fastify direct (v2, identity + SELECT):                    ${fmt(series.getDirect)}
  GET  Next /api/parent-consent -> provider -> Fastify -> PG:      ${fmt(series.getNext)}
  POST Fastify direct (v3, identity, nonce, consent function):    ${fmt(series.postDirect)}
  POST Next (CSRF, provider, v3 -> Fastify -> PG):                ${fmt(series.postNext)}
  POST via Next + verification GET via Next:                      ${fmt(series.writeThenRead)}\n`)
    })
  })
})
