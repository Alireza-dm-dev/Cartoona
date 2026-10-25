import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest"
import { execFile, spawn } from "node:child_process"
import { randomBytes, randomUUID } from "node:crypto"
import type net from "node:net"
import { promisify } from "node:util"
import path from "node:path"

const cookies = vi.hoisted(() => ({ jar: null as null | { getAll(): Array<{ name: string; value: string }>; setAll(c: Array<{ name: string; value: string }>): void } }))
vi.mock("next/headers", () => ({
  cookies: async () => ({
    getAll: () => cookies.jar?.getAll() ?? [],
    set: (name: string, value: string) => cookies.jar?.setAll([{ name, value }]),
  }),
}))

import type { FastifyInstance } from "fastify"
import { buildBackendApp } from "@/backend/src/app"
import { GET as backendMe } from "@/app/api/auth/backend-me/route"
import { getPool } from "@/lib/db/pool"
import { runQuery } from "@/lib/db/query"
import { DbError } from "@/lib/db/errors"
import { signAssertion } from "@/lib/identity/assertion"
import { toVerifiedIdentity } from "@/lib/identity/types"
import { resolveUserIdentity } from "@/lib/repositories/user-identities"
import { setLogSink, type LogRecord } from "@/lib/observability/logger"
import { withPgClusterLock } from "../helpers/pg-cluster-lock"
import { cookieJar, startStubAuth, type StubAuth } from "../helpers/stub-supabase-auth"
import { DAY_MS } from "../helpers/supabase-jwt"

/**
 * End-to-end proof of the V0.1.42 identity chain, opt-in (CARTOONA_PLAIN_PG=docker):
 *
 *   session cookie -> Next /api/auth/backend-me -> Supabase adapter (LOCAL STUB
 *   provider, real @supabase/ssr) -> signed assertion -> REAL Fastify on
 *   loopback -> restricted pool -> user_identities + users in PostgreSQL
 *
 * Scratch database `ac_<id>` (migrations 0001-0010) and a script-provisioned
 * login role; dropped afterwards. Nothing contacts Supabase or a hosted service.
 */

const enabled = process.env.CARTOONA_PLAIN_PG === "docker"
const run = promisify(execFile)
const root = process.cwd()
const id = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`
const DB = `ac_${id}`
const ROLE = `cartoona_app_a${id}`
const DB_PASSWORD = randomBytes(24).toString("hex")
const AUTH_SECRET = randomBytes(32).toString("hex")
let container = ""
let pgPort = ""

async function owner(sql: string, db = DB): Promise<string> {
  const { stdout } = await run("docker", [
    "exec", "-i", container, "psql", "-U", "cartoona", "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-d", db,
    "-c", "SET client_min_messages = warning", "-c", sql,
  ])
  return stdout.trim()
}

async function ownerAttempt(sql: string): Promise<{ ok: boolean; err: string }> {
  try {
    await owner(sql)
    return { ok: true, err: "" }
  } catch (e) {
    return { ok: false, err: String((e as { stderr?: string }).stderr ?? e) }
  }
}

function script(file: string, env: Record<string, string>, args: string[] = []): Promise<{ stdout: string; code: number }> {
  return new Promise((resolve) => {
    const child = spawn("bash", [path.join(root, file), ...args], {
      cwd: root,
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", NODE_ENV: "test", PSQL: path.join(root, "scripts/db/psql-docker.sh"), CARTOONA_PG_CONTAINER: container, ...env },
    })
    let stdout = ""
    child.stdout.on("data", (d) => (stdout += d))
    child.stderr.on("data", () => {})
    child.on("close", (code) => resolve({ stdout, code: code ?? -1 }))
  })
}

/** The documented backfill (docs/AUTH_ARCHITECTURE.md): migrated users keep id = Supabase auth uid. */
const BACKFILL_SQL = `
  INSERT INTO public.user_identities (user_id, provider, provider_subject)
  SELECT u.id, 'supabase', u.id::text
  FROM public.users u
  ON CONFLICT (provider, provider_subject) DO NOTHING`

// Fixture accounts: "migrated" users whose Cartoona id IS their Supabase uid.
const PARENT = randomUUID()
const ADMIN = randomUUID()
const DELETED = randomUUID()
const UNLINKED = randomUUID() // a Supabase identity with NO Cartoona user

let stub: StubAuth | null = null
let backend: FastifyInstance | null = null
let logs: LogRecord[] = []

async function startBackend() {
  backend = buildBackendApp()
  await backend.listen({ host: "127.0.0.1", port: 0 })
  const port = (backend.server.address() as net.AddressInfo).port
  vi.stubEnv("BACKEND_INTERNAL_URL", `http://127.0.0.1:${port}`)
  return `http://127.0.0.1:${port}`
}

/** A browser request: its session cookie for `userId` at the stub provider, plus whatever headers it adds. */
async function asBrowser(userId: string, opts: { cookie?: boolean; expired?: boolean; authenticatedAt?: number; headers?: Record<string, string>; stubMode?: Partial<StubAuth["options"]> } = {}) {
  await stub?.close()
  stub = await startStubAuth({ userId, ...opts.stubMode })
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", stub.url)
  cookies.jar = cookieJar(opts.cookie === false ? [] : [stub.cookie({ expired: opts.expired, authenticatedAt: opts.authenticatedAt })])
  return backendMe(new Request("http://localhost:3000/api/auth/backend-me", { headers: opts.headers ?? {} }))
}

describe.skipIf(!enabled)("identity chain: Next -> assertion -> Fastify -> PostgreSQL (local Docker PostgreSQL 17)", () => {
  vi.setConfig({ testTimeout: 60_000 })
  let restoreSink: () => void = () => {}

  beforeAll(async () => {
    restoreSink = setLogSink((r) => logs.push(r))
    container = (await run("docker", ["compose", "ps", "-q", "postgres"], { cwd: root })).stdout.trim()
    if (!container) throw new Error("compose postgres service is not running: docker compose up -d postgres")
    pgPort = (await run("docker", ["compose", "port", "postgres", "5432"], { cwd: root })).stdout.trim().split(":").pop() ?? ""
    await owner(`create database ${DB}`, "postgres")
    const ownerUrl = `postgresql://cartoona@postgres:5432/${DB}`
    const migrated = await withPgClusterLock(() => script("scripts/db/migrate-local.sh", { DATABASE_URL: ownerUrl }))
    expect(migrated.stdout).toMatch(/done - 18 applied/)
    expect((await script("scripts/db/app-login-role.sh", { DATABASE_URL: ownerUrl, CARTOONA_APP_DB_PASSWORD: DB_PASSWORD }, [ROLE])).code).toBe(0)

    // "Migrated" users (id = Supabase uid), then the documented backfill.
    await owner(`insert into public.users (id, email, role) values
      ('${PARENT}', 'p@x.test', 'parent'), ('${ADMIN}', 'a@x.test', 'admin'), ('${DELETED}', 'd@x.test', 'parent')`)
    await owner(`update public.users set deleted_at = now() where id = '${DELETED}'`)
    await owner(BACKFILL_SQL)

    vi.stubEnv("DATABASE_URL", `postgresql://${ROLE}:${DB_PASSWORD}@127.0.0.1:${pgPort}/${DB}`)
    vi.stubEnv("CARTOONA_INTERNAL_AUTH_SECRET", AUTH_SECRET)
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-key")
    await startBackend()
  }, 180_000)

  afterEach(async () => {
    await stub?.close()
    stub = null
    logs = []
  })

  afterAll(async () => {
    restoreSink()
    await backend?.close()
    vi.unstubAllEnvs()
    if (!container) return
    await owner(`drop database if exists ${DB} with (force)`, "postgres")
    await owner(`drop role if exists ${ROLE}`, "postgres")
  })

  describe("identity resolution in PostgreSQL (as the restricted role)", () => {
    it("12. a linked Supabase subject maps to exactly one Cartoona user", async () => {
      expect(await resolveUserIdentity(getPool(), { provider: "supabase", providerSubject: PARENT }))
        .toEqual({ userId: PARENT, role: "parent", deleted: false, sessionsNotBefore: null })
      expect(await owner(`select count(*) from public.user_identities where provider='supabase' and provider_subject='${PARENT}'`)).toBe("1")
    })

    it("13. a missing mapping is null (identity_not_linked), and nothing is created", async () => {
      expect(await resolveUserIdentity(getPool(), { provider: "supabase", providerSubject: UNLINKED })).toBeNull()
      expect(await owner(`select count(*) from public.users where id='${UNLINKED}'`)).toBe("0")
      expect(await owner(`select count(*) from public.user_identities where provider_subject='${UNLINKED}'`)).toBe("0")
    })

    it("14. a duplicate (provider, subject) is impossible", async () => {
      const dup = await ownerAttempt(`insert into public.user_identities (user_id, provider, provider_subject) values ('${ADMIN}', 'supabase', '${PARENT}')`)
      expect(dup.ok).toBe(false)
      expect(dup.err).toMatch(/user_identities_provider_subject_key/)
    })

    it("15. the role comes from public.users (a role change there is what resolution returns)", async () => {
      await owner(`update public.users set role = 'super_admin' where id = '${ADMIN}'`)
      try {
        expect((await resolveUserIdentity(getPool(), { provider: "supabase", providerSubject: ADMIN }))?.role).toBe("super_admin")
      } finally {
        await owner(`update public.users set role = 'admin' where id = '${ADMIN}'`)
      }
    })

    it("the backfill is idempotent and keeps Cartoona ids equal to the Supabase uid", async () => {
      await owner(BACKFILL_SQL)
      expect(await owner("select count(*) from public.user_identities")).toBe("3")
      expect(await owner("select count(*) from public.user_identities where user_id::text <> provider_subject")).toBe("0")
    })

    it("18. the application role reads users/user_identities but cannot write them", async () => {
      await expect(runQuery(getPool(), "SELECT count(*) FROM public.user_identities")).resolves.toBeDefined()
      for (const sql of [
        `INSERT INTO public.user_identities (user_id, provider, provider_subject) VALUES ('${ADMIN}', 'supabase', '${UNLINKED}')`,
        `UPDATE public.user_identities SET user_id = '${ADMIN}'`,
        "DELETE FROM public.user_identities",
        "UPDATE public.users SET role = 'super_admin'",
        `INSERT INTO public.users (id, role) VALUES ('${UNLINKED}', 'admin')`,
      ]) {
        const error = await runQuery(getPool(), sql).catch((e: unknown) => e)
        expect(error, sql).toBeInstanceOf(DbError)
        expect((error as DbError).sqlState).toBe("42501")
      }
    })
  })

  describe("25. end to end through the Next route", () => {
    it("valid session -> Next adapter -> assertion -> Fastify -> PostgreSQL -> the Cartoona user and DB role", async () => {
      const res = await asBrowser(PARENT)
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ authenticated: true, userId: PARENT, role: "parent" })
      expect(res.headers.get("cache-control")).toBe("no-store")
      // The provider was asked once, with the session's own token; the assertion never reached the browser.
      expect(stub!.requests.filter((r) => r.path === "/auth/v1/user")).toHaveLength(1)
      expect([...res.headers.keys()].some((h) => /internal-auth/i.test(h))).toBe(false)
    })

    it("an admin's role comes from PostgreSQL", async () => {
      const res = await asBrowser(ADMIN)
      expect(await res.json()).toMatchObject({ userId: ADMIN, role: "admin" })
    })

    it("16/17. browser-supplied X-User-Id / X-Role / role claims are ignored", async () => {
      const res = await asBrowser(PARENT, { headers: { "x-user-id": ADMIN, "x-role": "super_admin", "x-cartoona-internal-auth": "v1.forged.sig" } })
      expect(await res.json()).toEqual({ authenticated: true, userId: PARENT, role: "parent" })
    })

    it("valid identity without a mapping -> 403 identity_not_linked", async () => {
      const res = await asBrowser(UNLINKED)
      expect(res.status).toBe(403)
      expect(await res.json()).toEqual({ error: "identity_not_linked" })
    })

    it("a soft-deleted account -> 403 forbidden", async () => {
      const res = await asBrowser(DELETED)
      expect(res.status).toBe(403)
      expect(await res.json()).toEqual({ error: "forbidden" })
    })

    it("no session -> 401, and the backend is never called", async () => {
      const res = await asBrowser(PARENT, { cookie: false })
      expect(res.status).toBe(401)
      expect(await res.json()).toEqual({ error: "unauthenticated" })
      expect(stub!.requests).toHaveLength(0)
      expect(logs.some((l) => l.event === "BACKEND_REQUEST_COMPLETED")).toBe(false)
    })

    it("session rejected by the provider -> 401", async () => {
      const res = await asBrowser(PARENT, { stubMode: { userMode: "unauthorized" } })
      expect(res.status).toBe(401)
    })

    it("provider hangs -> 503 auth_unavailable within the 4 s verification deadline", async () => {
      const t = performance.now()
      const res = await asBrowser(PARENT, { expired: true, stubMode: { refreshMode: "hang" } })
      const ms = performance.now() - t
      expect(res.status).toBe(503)
      expect(await res.json()).toEqual({ error: "auth_unavailable" })
      expect(ms).toBeLessThan(4_800)
      expect(cookies.jar && (cookies.jar as ReturnType<typeof cookieJar>).cleared("sb-")).toBe(false)
    })

    it("frontend and backend secrets disagree -> 503 (our misconfiguration, not the visitor's session)", async () => {
      // Next and Fastify share this process (and process.env) here, so pin the
      // backend's secret explicitly and give the Next side a different one.
      await backend!.close()
      backend = buildBackendApp({ authSecret: () => Buffer.from(AUTH_SECRET, "hex") })
      await backend.listen({ host: "127.0.0.1", port: 0 })
      vi.stubEnv("BACKEND_INTERNAL_URL", `http://127.0.0.1:${(backend.server.address() as net.AddressInfo).port}`)
      vi.stubEnv("CARTOONA_INTERNAL_AUTH_SECRET", randomBytes(32).toString("hex"))
      try {
        const res = await asBrowser(PARENT)
        expect(res.status).toBe(503)
        expect(await res.json()).toEqual({ error: "service_unavailable" })
        expect(logs.find((l) => l.event === "AUTH_REJECTED" && l.reason === "assertion_rejected")).toBeTruthy()
      } finally {
        vi.stubEnv("CARTOONA_INTERNAL_AUTH_SECRET", AUTH_SECRET)
      }
    })
  })

  describe("25. direct calls to Fastify", () => {
    const base = () => process.env.BACKEND_INTERNAL_URL!
    const sign = (subject: string, over: { secret?: string; path?: string; authenticatedAt?: number } = {}) =>
      signAssertion({
        identity: toVerifiedIdentity({ provider: "supabase", subject }),
        authenticatedAt: over.authenticatedAt ?? Date.now() - DAY_MS,
        requestId: "direct-call-0001",
        method: "GET",
        path: over.path ?? "/v1/auth/me",
        secret: Buffer.from(over.secret ?? AUTH_SECRET, "hex"),
      })

    it("without an assertion -> 401, even with identity headers", async () => {
      const res = await fetch(`${base()}/v1/auth/me`, { headers: { "x-user-id": PARENT, "x-role": "admin" } })
      expect(res.status).toBe(401)
      expect(await res.json()).toEqual({ error: "unauthenticated" })
    })

    it("a forged assertion -> 401", async () => {
      const res = await fetch(`${base()}/v1/auth/me`, { headers: { "x-cartoona-internal-auth": sign(PARENT, { secret: randomBytes(32).toString("hex") }) } })
      expect(res.status).toBe(401)
    })

    it("an assertion minted for another path -> 401", async () => {
      const res = await fetch(`${base()}/v1/auth/me`, { headers: { "x-cartoona-internal-auth": sign(PARENT, { path: "/v1/creation-pricing" }) } })
      expect(res.status).toBe(401)
    })

    it("a valid assertion -> the mapped principal with its database role", async () => {
      const res = await fetch(`${base()}/v1/auth/me`, { headers: { "x-cartoona-internal-auth": sign(ADMIN) } })
      expect(await res.json()).toEqual({ authenticated: true, userId: ADMIN, role: "admin" })
    })
  })

  describe("V0.1.43: sessions_not_before in real PostgreSQL", () => {
    it("17/18. migration 0011 applied: the column exists, nullable, and defaults to NULL", async () => {
      expect(await owner("select version from public.schema_migrations where version = '0011_users_sessions_not_before'")).toBe("0011_users_sessions_not_before")
      expect(await owner("select data_type||','||is_nullable||','||coalesce(column_default,'none') from information_schema.columns where table_schema='public' and table_name='users' and column_name='sessions_not_before'"))
        .toBe("timestamp with time zone,YES,none")
      expect(await owner("select count(*) from public.users where sessions_not_before is not null")).toBe("0")
    })

    it("19/20. the resolver reads it, per user (isolation)", async () => {
      await owner(`update public.users set sessions_not_before = '2026-10-01T00:00:00.250Z' where id = '${ADMIN}'`)
      try {
        expect((await resolveUserIdentity(getPool(), { provider: "supabase", providerSubject: ADMIN }))?.sessionsNotBefore).toBe(Date.parse("2026-10-01T00:00:00.250Z"))
        expect((await resolveUserIdentity(getPool(), { provider: "supabase", providerSubject: PARENT }))?.sessionsNotBefore).toBeNull()
      } finally {
        await owner(`update public.users set sessions_not_before = null where id = '${ADMIN}'`)
      }
    })

    it("21/22. the restricted role can read the column but cannot write it (no forced-logout privilege yet)", async () => {
      await expect(runQuery(getPool(), "SELECT sessions_not_before FROM public.users LIMIT 1")).resolves.toBeDefined()
      for (const sql of [`UPDATE public.users SET sessions_not_before = now() WHERE id = '${PARENT}'`, "UPDATE public.users SET sessions_not_before = NULL"]) {
        const error = await runQuery(getPool(), sql).catch((e: unknown) => e)
        expect(error, sql).toBeInstanceOf(DbError)
        expect((error as DbError).sqlState).toBe("42501")
      }
    })
  })

  describe("V0.1.43: session policy end to end (Next -> assertion -> Fastify -> PostgreSQL)", () => {
    it("a fresh session -> 200", async () => {
      expect((await asBrowser(PARENT, { authenticatedAt: Date.now() - DAY_MS })).status).toBe(200)
    })

    it("a 31-day-old session -> 401 session_expired, and no backend call is made", async () => {
      const res = await asBrowser(PARENT, { authenticatedAt: Date.now() - 31 * DAY_MS })
      expect(res.status).toBe(401)
      expect(await res.json()).toEqual({ error: "session_expired" })
      expect(logs.some((l) => l.event === "BACKEND_REQUEST_COMPLETED")).toBe(false)
    })

    it("a session older than sessions_not_before -> 401 session_invalidated (enforced by the backend)", async () => {
      const signedIn = Date.now() - 5 * DAY_MS
      await owner(`update public.users set sessions_not_before = now() - interval '1 day' where id = '${PARENT}'`)
      try {
        const res = await asBrowser(PARENT, { authenticatedAt: signedIn })
        expect(res.status).toBe(401)
        expect(await res.json()).toEqual({ error: "session_invalidated" })
        // A sign-in AFTER the invalidation is valid again.
        expect((await asBrowser(PARENT, { authenticatedAt: Date.now() - 60_000 })).status).toBe(200)
      } finally {
        await owner(`update public.users set sessions_not_before = null where id = '${PARENT}'`)
      }
    })

    it("sessions_not_before equal to the sign-in second is the documented VALID boundary", async () => {
      const signedIn = Math.floor((Date.now() - 2 * DAY_MS) / 1000) * 1000
      await owner(`update public.users set sessions_not_before = to_timestamp(${signedIn / 1000}) where id = '${PARENT}'`)
      try {
        expect((await asBrowser(PARENT, { authenticatedAt: signedIn })).status).toBe(200)
        expect((await asBrowser(PARENT, { authenticatedAt: signedIn - 1000 })).status).toBe(401)
      } finally {
        await owner(`update public.users set sessions_not_before = null where id = '${PARENT}'`)
      }
    })

    it("a refreshed token does not extend the original lifetime", async () => {
      // Expired access token -> the adapter refreshes; the sign-in was 30 days minus 1 minute ago.
      const ok = await asBrowser(PARENT, { expired: true, authenticatedAt: Date.now() - 30 * DAY_MS + 60_000 })
      expect(ok.status).toBe(200)
      expect(stub!.refreshedTokens).toHaveLength(1)
      // Same refresh, a session that is already past 30 days: still expired after refresh.
      const late = await asBrowser(PARENT, { expired: true, authenticatedAt: Date.now() - 30 * DAY_MS - 60_000 })
      expect(late.status).toBe(401)
      expect(await late.json()).toEqual({ error: "session_expired" })
    })

    it("a forged sign-in time fails the signature; a 31-day-old one fails the policy even when correctly signed", async () => {
      const base = process.env.BACKEND_INTERNAL_URL!
      const old = signAssertion({
        identity: toVerifiedIdentity({ provider: "supabase", subject: PARENT }),
        authenticatedAt: Date.now() - 31 * DAY_MS,
        requestId: "policy-check-0001", method: "GET", path: "/v1/auth/me",
        secret: Buffer.from(AUTH_SECRET, "hex"),
      })
      expect((await (await fetch(`${base}/v1/auth/me`, { headers: { "x-cartoona-internal-auth": old } })).json())).toEqual({ error: "session_expired" })
      const [v, payload, sig] = old.split(".")
      const younger = JSON.parse(Buffer.from(payload, "base64url").toString())
      younger.aat = Math.floor(Date.now() / 1000) - 60
      const forged = `${v}.${Buffer.from(JSON.stringify(younger)).toString("base64url")}.${sig}`
      const res = await fetch(`${base}/v1/auth/me`, { headers: { "x-cartoona-internal-auth": forged } })
      expect(res.status).toBe(401)
      expect(await res.json()).toEqual({ error: "unauthenticated" })
    })

    it("a V0.1.42 v1 assertion is rejected", async () => {
      const crypto = await import("node:crypto")
      const iat = Math.floor(Date.now() / 1000)
      const enc = Buffer.from(JSON.stringify({ v: 1, prv: "supabase", sub: PARENT, iat, exp: iat + 30, rid: "legacy-v1-0001", mth: "GET", pth: "/v1/auth/me" })).toString("base64url")
      const mac = crypto.createHmac("sha256", Buffer.from(AUTH_SECRET, "hex")).update("cartoona-internal-auth\nv1\n").update(enc).digest("base64url")
      const res = await fetch(`${process.env.BACKEND_INTERNAL_URL}/v1/auth/me`, { headers: { "x-cartoona-internal-auth": `v1.${enc}.${mac}` } })
      expect(res.status).toBe(401)
    })

    it("database unavailable -> 503 service_unavailable through the Next route (never a sign-out)", async () => {
      const saved = process.env.DATABASE_URL!
      await backend!.close()
      vi.stubEnv("DATABASE_URL", saved.replace(`:${pgPort}/`, ":1/"))
      await startBackend()
      try {
        const res = await asBrowser(PARENT)
        expect(res.status).toBe(503)
        expect(await res.json()).toEqual({ error: "service_unavailable" })
        expect((cookies.jar as ReturnType<typeof cookieJar>).cleared("sb-")).toBe(false)
      } finally {
        await backend!.close()
        vi.stubEnv("DATABASE_URL", saved)
        await startBackend()
      }
    })

    it("backend unreachable -> 503 service_unavailable", async () => {
      const saved = process.env.BACKEND_INTERNAL_URL!
      vi.stubEnv("BACKEND_INTERNAL_URL", "http://127.0.0.1:1")
      try {
        const res = await asBrowser(PARENT)
        expect(res.status).toBe(503)
        expect(await res.json()).toEqual({ error: "service_unavailable" })
      } finally {
        vi.stubEnv("BACKEND_INTERNAL_URL", saved)
      }
    })
  })
})
