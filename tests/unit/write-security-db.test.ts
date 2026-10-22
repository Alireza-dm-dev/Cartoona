import { describe, it, expect, beforeAll, afterAll, vi } from "vitest"
import { randomBytes } from "node:crypto"
import type net from "node:net"
import { Pool, type PoolClient } from "pg"

const cookies = vi.hoisted(() => ({ jar: null as null | { getAll(): Array<{ name: string; value: string }>; setAll(c: Array<{ name: string; value: string }>): void } }))
vi.mock("next/headers", () => ({
  cookies: async () => ({
    getAll: () => cookies.jar?.getAll() ?? [],
    set: (name: string, value: string) => cookies.jar?.setAll([{ name, value }]),
  }),
}))

import type { FastifyInstance } from "fastify"
import { buildBackendApp } from "@/backend/src/app"
import { backendWriteJson } from "@/lib/backend/client"
import { BackendClientError } from "@/lib/backend/errors"
import { getPublicHeaderAccount } from "@/lib/auth/public-header-account"
import { closePool, getPool } from "@/lib/db/pool"
import { DbError } from "@/lib/db/errors"
import type { Queryable } from "@/lib/db/types"
import { newWriteNonce, signAssertion, signWriteAssertion } from "@/lib/identity/assertion"
import { toVerifiedIdentity } from "@/lib/identity/types"
import { consumeWriteNonce } from "@/lib/repositories/write-nonces"
import { dropDbs, migrateTarget, pgEnv, psql, script, type PgEnv } from "../helpers/data-copy-db"
import { cookieJar, startStubAuth, type StubAuth } from "../helpers/stub-supabase-auth"
import { DAY_MS } from "../helpers/supabase-jwt"

/**
 * V0.1.47 write security on REAL local services (opt-in: CARTOONA_PLAIN_PG=docker):
 *
 *   Next server-side client (backendWriteJson: v3, nonce, body digest)
 *   -> Fastify (listening, restricted login role) -> requireWriteAuth
 *   -> consume_internal_write_nonce() -> PATCH /v1/parent/profile -> UPDATE
 *   then read back through the V0.1.46 read paths (Fastify GET and the Next
 *   public header via the stub provider).
 *
 * Plus the nonce function itself: first use, replay, genuine concurrency,
 * expiry bounds and cleanup, and the app role's privileges. Fixture rows are
 * written by the owner in a scratch database; nothing contacts Supabase.
 */

const enabled = process.env.CARTOONA_PLAIN_PG === "docker"
const id = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`
const DB = `ws_${id}`
const ROLE = `cartoona_app_ws${id}`
const DB_PASSWORD = randomBytes(24).toString("hex")
const AUTH_SECRET = randomBytes(32).toString("hex")
const PATH = "/v1/parent/profile"

const U = {
  a: "c1000000-0000-4000-8000-000000000001",
  b: "c1000000-0000-4000-8000-000000000002",
  admin: "c1000000-0000-4000-8000-000000000003",
  superAdmin: "c1000000-0000-4000-8000-000000000004",
  deleted: "c1000000-0000-4000-8000-000000000005",
  invalidated: "c1000000-0000-4000-8000-000000000006",
  noProfile: "c1000000-0000-4000-8000-000000000007",
  unlinked: "c1000000-0000-4000-8000-0000000000ee",
}

let env: PgEnv
let roleUrl = ""
let app: Pool
let backend: FastifyInstance | null = null
let backendUrl = ""
let stub: StubAuth | null = null
let updates = 0

const owner = (sql: string) => psql(env, DB, sql)
const nameOf = async (user: string) => {
  const v = await owner(`select coalesce(full_name, '<null>') from public.parent_profiles where user_id = '${user}'`)
  return v === "<null>" ? null : v
}
const nonceRows = async () => Number(await owner("select count(*) from public.internal_write_nonces"))

const ident = (subject: string) => toVerifiedIdentity({ provider: "supabase", subject })
const auth = (user: string, authenticatedAt = Date.now() - DAY_MS) => ({ identity: ident(user), authenticatedAt })

const signWrite = (user: string, body: string, over: { path?: string; method?: string; authenticatedAt?: number } = {}) =>
  signWriteAssertion({
    identity: ident(user),
    authenticatedAt: over.authenticatedAt ?? Date.now() - DAY_MS,
    requestId: `ws-direct-${randomBytes(4).toString("hex")}`,
    method: over.method ?? "PATCH",
    path: over.path ?? PATH,
    body,
    secret: Buffer.from(AUTH_SECRET, "hex"),
  })

const patchDirect = (body: string, token: string | undefined, extra: Record<string, string> = {}, url = backendUrl) =>
  fetch(`${url}${PATH}`, { method: "PATCH", body, headers: { "content-type": "application/json", ...(token ? { "x-cartoona-internal-auth": token } : {}), ...extra } })

const readProfile = async (user: string) => {
  const token = signAssertion({ identity: ident(user), authenticatedAt: Date.now() - DAY_MS, requestId: "ws-read-000001", method: "GET", path: PATH, secret: Buffer.from(AUTH_SECRET, "hex") })
  const res = await fetch(`${backendUrl}${PATH}`, { headers: { "x-cartoona-internal-auth": token } })
  return { status: res.status, body: await res.json() }
}

/** The Next server-side write call, exactly as a future BFF route will make it. */
const nextWrite = (user: string, fullName: unknown, deps: { fetchImpl?: typeof fetch } = {}) =>
  backendWriteJson(
    {
      operation: "parent_profile_update",
      method: "PATCH",
      path: PATH,
      body: { fullName },
      parse: (json) => json as { fullName: string | null },
      acceptStatuses: [400, 401, 403, 404, 409],
      auth: auth(user),
    },
    deps,
  )

function countingDb(delayAfterUpdateMs = 0): () => Queryable {
  return () => ({
    query: async (text: string, values?: readonly unknown[]) => {
      const result = await getPool().query(text, values as unknown[])
      if (text.includes("UPDATE public.parent_profiles")) {
        updates += 1
        // The UPDATE has already committed (autocommit): only the RESPONSE is late.
        if (delayAfterUpdateMs) await new Promise((r) => setTimeout(r, delayAfterUpdateMs))
      }
      return result
    },
  }) as Queryable
}

async function startBackend(db: () => Queryable): Promise<{ app: FastifyInstance; url: string }> {
  const instance = buildBackendApp({ db, closeDb: async () => {} })
  await instance.listen({ host: "127.0.0.1", port: 0 })
  return { app: instance, url: `http://127.0.0.1:${(instance.server.address() as net.AddressInfo).port}` }
}

async function sqlState(work: Promise<unknown>): Promise<string | undefined> {
  const e = await work.then(() => null, (x: unknown) => x)
  return (e as { code?: string } | null)?.code
}

const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))]

describe.skipIf(!enabled)("V0.1.47 write security (local Docker PostgreSQL 17)", () => {
  vi.setConfig({ testTimeout: 120_000, hookTimeout: 300_000 })

  beforeAll(async () => {
    env = await pgEnv()
    await migrateTarget(env, DB)
    const users = Object.entries(U).filter(([k]) => k !== "unlinked")
    await owner(`
      insert into public.users (id, role, deleted_at, sessions_not_before) values
        ${users.map(([k, u]) => `('${u}', '${k === "admin" ? "admin" : k === "superAdmin" ? "super_admin" : "parent"}', ${k === "deleted" ? "now()" : "null"}, ${k === "invalidated" ? "now()" : "null"})`).join(",")};
      insert into public.user_identities (user_id, provider, provider_subject) values
        ${users.map(([, u]) => `('${u}', 'supabase', '${u}')`).join(",")};
      insert into public.parent_profiles (user_id, full_name) values
        ('${U.a}', 'Parent A'), ('${U.b}', 'Parent B'), ('${U.deleted}', 'Deleted'), ('${U.invalidated}', 'Invalidated')`)
    const r = await script(env, "scripts/db/app-login-role.sh", { DATABASE_URL: `postgresql://cartoona@postgres:5432/${DB}`, CARTOONA_APP_DB_PASSWORD: DB_PASSWORD }, [ROLE])
    expect(r.code).toBe(0)
    roleUrl = `postgresql://${ROLE}:${DB_PASSWORD}@127.0.0.1:${env.port}/${DB}`
    app = new Pool({ connectionString: roleUrl, max: 25 })
    vi.stubEnv("DATABASE_URL", roleUrl)
    vi.stubEnv("CARTOONA_INTERNAL_AUTH_SECRET", AUTH_SECRET)
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-key")
    vi.stubEnv("BACKEND_REQUEST_TIMEOUT_MS", "2000")
    ;({ app: backend, url: backendUrl } = await startBackend(countingDb()))
    vi.stubEnv("BACKEND_INTERNAL_URL", backendUrl)
  })

  afterAll(async () => {
    await stub?.close()
    await backend?.close()
    await app?.end()
    await closePool()
    vi.unstubAllEnvs()
    if (!env) return
    await dropDbs(env, [DB])
    await psql(env, "postgres", `drop role if exists ${ROLE}`).catch(() => undefined)
  })

  describe("nonce function (5/7/20)", () => {
    const exp = () => Math.floor(Date.now() / 1000) + 30

    it("first use true, any reuse false", async () => {
      const nonce = newWriteNonce()
      expect(await consumeWriteNonce(app, { nonce, expiresAtSeconds: exp(), requestId: "ws-nonce-0001" })).toBe(true)
      expect(await consumeWriteNonce(app, { nonce, expiresAtSeconds: exp(), requestId: "ws-nonce-0002" })).toBe(false)
      expect(await owner(`select request_id from public.internal_write_nonces where nonce = '${nonce}'`)).toBe("ws-nonce-0001")
    })

    it("20 genuinely concurrent consumers of one nonce on 20 connections: exactly one wins (x10 nonces)", async () => {
      const clients: PoolClient[] = await Promise.all(Array.from({ length: 20 }, () => app.connect()))
      try {
        for (let round = 0; round < 10; round++) {
          const nonce = newWriteNonce()
          const results = await Promise.all(clients.map((c, i) => consumeWriteNonce(c, { nonce, expiresAtSeconds: exp(), requestId: `ws-race-${round}-${i}xx` })))
          expect(results.filter(Boolean)).toHaveLength(1)
        }
      } finally {
        for (const c of clients) c.release()
      }
    })

    it("a deliberately held race: waiters block on the key and lose when the holder commits", async () => {
      const nonce = newWriteNonce()
      const holder = await app.connect()
      const waiters = await Promise.all(Array.from({ length: 5 }, () => app.connect()))
      try {
        await holder.query("BEGIN")
        expect(await consumeWriteNonce(holder, { nonce, expiresAtSeconds: exp(), requestId: "ws-hold-000001" })).toBe(true)
        const pending = waiters.map((w, i) => consumeWriteNonce(w, { nonce, expiresAtSeconds: exp(), requestId: `ws-wait-00000${i}` }))
        // Prove they are really waiting on the uncommitted row.
        await new Promise((r) => setTimeout(r, 300))
        expect(Number(await owner(`select count(*) from pg_stat_activity where datname = '${DB}' and wait_event_type = 'Lock'`))).toBeGreaterThanOrEqual(5)
        await holder.query("COMMIT")
        expect(await Promise.all(pending)).toEqual([false, false, false, false, false])
      } finally {
        holder.release()
        for (const w of waiters) w.release()
      }
    })

    it("if the holder rolls back, exactly one waiter wins instead", async () => {
      const nonce = newWriteNonce()
      const holder = await app.connect()
      const waiters = await Promise.all(Array.from({ length: 4 }, () => app.connect()))
      try {
        await holder.query("BEGIN")
        await consumeWriteNonce(holder, { nonce, expiresAtSeconds: exp(), requestId: "ws-hold-000002" })
        const pending = waiters.map((w, i) => consumeWriteNonce(w, { nonce, expiresAtSeconds: exp(), requestId: `ws-wait-10000${i}` }))
        await new Promise((r) => setTimeout(r, 200))
        await holder.query("ROLLBACK")
        expect((await Promise.all(pending)).filter(Boolean)).toHaveLength(1)
      } finally {
        holder.release()
        for (const w of waiters) w.release()
      }
    })

    it("refuses malformed input and an expiry outside +-5 minutes (22023)", async () => {
      const call = (nonce: string, expires: number, rid = "ws-bad-000001") => consumeWriteNonce(app, { nonce, expiresAtSeconds: expires, requestId: rid })
      for (const work of [() => call("short", exp()), () => call(newWriteNonce(), exp(), "bad id"), () => call(newWriteNonce(), exp() - 600), () => call(newWriteNonce(), exp() + 600)]) {
        const e = await work().then(() => null, (x: unknown) => x)
        expect(e).toBeInstanceOf(DbError)
        expect((e as DbError).sqlState).toBe("22023")
      }
    })

    it("each call purges rows expired more than 10 minutes ago; recent ones stay", async () => {
      const old = newWriteNonce()
      const recent = newWriteNonce()
      await owner(`insert into public.internal_write_nonces (nonce, expires_at, request_id) values
        ('${old}', now() - interval '11 minutes', 'ws-old-000001'), ('${recent}', now() - interval '1 minute', 'ws-recent-001')`)
      await consumeWriteNonce(app, { nonce: newWriteNonce(), expiresAtSeconds: exp(), requestId: "ws-purge-0001" })
      expect(await owner(`select count(*) from public.internal_write_nonces where nonce = '${old}'`)).toBe("0")
      expect(await owner(`select count(*) from public.internal_write_nonces where nonce = '${recent}'`)).toBe("1")
    })

    it("stores no user, subject, path or body - only nonce, expiry, request id, time", async () => {
      expect(await owner("select string_agg(column_name, ',' order by column_name) from information_schema.columns where table_name = 'internal_write_nonces'"))
        .toBe("consumed_at,expires_at,nonce,request_id")
    })
  })

  describe("the restricted role's privileges (6/14)", () => {
    it.each([
      ["read the nonce table", "SELECT * FROM public.internal_write_nonces"],
      ["insert a nonce directly", `INSERT INTO public.internal_write_nonces (nonce, expires_at, request_id) VALUES ('${"Q".repeat(43)}', now(), 'ws-direct-0001')`],
      ["update nonces", "UPDATE public.internal_write_nonces SET consumed_at = now()"],
      ["delete nonces", "DELETE FROM public.internal_write_nonces"],
      ["truncate nonces", "TRUNCATE public.internal_write_nonces"],
      ["update consent", "UPDATE public.parent_profiles SET consent_granted = true"],
      ["update the owner of a profile", `UPDATE public.parent_profiles SET user_id = '${U.b}'`],
      ["update a referral code", "UPDATE public.parent_profiles SET referral_code = 'CT000000000000'"],
      ["insert a profile", `INSERT INTO public.parent_profiles (user_id) VALUES ('${U.noProfile}')`],
      ["delete a profile", "DELETE FROM public.parent_profiles"],
      ["update users", "UPDATE public.users SET role = 'super_admin'"],
      ["update a wallet", "UPDATE public.candy_wallets SET balance = 1000"],
      ["call a trusted business function", "SELECT public.get_parent_orders_delivered_at_trusted(gen_random_uuid(), ARRAY[]::uuid[])"],
    ])("cannot %s (42501)", async (_label, sql) => {
      expect(await sqlState(app.query(sql))).toBe("42501")
    })

    it("can update exactly full_name/updated_at of a profile row, and EXECUTE the nonce function", async () => {
      const privs = await owner(`select string_agg(column_name, ',' order by column_name) from information_schema.column_privileges
        where grantee = 'cartoona_app' and table_name = 'parent_profiles' and privilege_type = 'UPDATE'`)
      expect(privs).toBe("full_name,updated_at")
      expect(await owner("select has_table_privilege('cartoona_app', 'public.parent_profiles', 'UPDATE')")).toBe("f")
      expect(await owner("select has_function_privilege('cartoona_app', 'public.consume_internal_write_nonce(text, timestamp with time zone, text)', 'EXECUTE')")).toBe("t")
      expect(await owner("select has_function_privilege('public', 'public.consume_internal_write_nonce(text, timestamp with time zone, text)', 'EXECUTE')")).toBe("f")
    })
  })

  describe("PATCH /v1/parent/profile end to end, as the restricted role (15/16/20/21)", () => {
    it("Next client -> Fastify -> PostgreSQL: only the caller's row changes; read-after-write via both read paths (23)", async () => {
      const before = { b: await nameOf(U.b) }
      const res = await nextWrite(U.a, "  پدر   آریا ")
      expect([res.status, res.data]).toEqual([200, { fullName: "پدر آریا" }])
      expect(await nameOf(U.a)).toBe("پدر آریا")
      expect(await nameOf(U.b)).toBe(before.b)
      // Read path 1: Fastify GET /v1/parent/profile (V0.1.46).
      expect(await readProfile(U.a)).toEqual({ status: 200, body: { fullName: "پدر آریا" } })
      // Read path 2: the Next public header through the stub provider -> Fastify -> PG.
      await stub?.close()
      stub = await startStubAuth({ userId: U.a })
      vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", stub.url)
      cookies.jar = cookieJar([stub.cookie({})])
      expect((await getPublicHeaderAccount({}))?.displayName).toBe("پدر آریا")
    })

    it("null clears the name; the header falls back neutrally", async () => {
      expect((await nextWrite(U.a, null)).data).toEqual({ fullName: null })
      expect(await nameOf(U.a)).toBeNull()
      expect(await readProfile(U.a)).toEqual({ status: 200, body: { fullName: null } })
      expect((await nextWrite(U.a, "Parent A")).data).toEqual({ fullName: "Parent A" })
    })

    it.each([
      ["admin", U.admin, 403, "forbidden"],
      ["super_admin", U.superAdmin, 403, "forbidden"],
      ["deleted", U.deleted, 403, "forbidden"],
      ["sessions_not_before after sign-in", U.invalidated, 401, "session_invalidated"],
      ["unlinked identity", U.unlinked, 403, "identity_not_linked"],
      ["parent without a profile", U.noProfile, 404, "parent_profile_not_found"],
    ])("%s -> %i %s, nothing written", async (_label, user, status, error) => {
      if (user === U.noProfile) {
        await owner(`insert into public.users (id, role) values ('${U.noProfile}', 'parent') on conflict do nothing;
          insert into public.user_identities (user_id, provider, provider_subject) values ('${U.noProfile}', 'supabase', '${U.noProfile}') on conflict do nothing`)
      }
      const snapshot = await owner("select string_agg(user_id || '=' || coalesce(full_name, '-'), ',' order by user_id) from public.parent_profiles")
      const res = await nextWrite(user, "Hijack")
      expect([res.status, res.data]).toEqual([status, { error }])
      expect(await owner("select string_agg(user_id || '=' || coalesce(full_name, '-'), ',' order by user_id) from public.parent_profiles")).toBe(snapshot)
    })

    it("a session older than 30 days -> 401 session_expired", async () => {
      const res = await backendWriteJson({ operation: "x", method: "PATCH", path: PATH, body: { fullName: "X" }, parse: (j) => j, acceptStatuses: [401], auth: auth(U.a, Date.now() - 31 * DAY_MS) })
      expect([res.status, res.data]).toEqual([401, { error: "session_expired" }])
      expect(await nameOf(U.a)).toBe("Parent A")
    })

    it("forged identity headers and body ids never reach another parent", async () => {
      const body = '{"fullName":"Forged"}'
      const res = await patchDirect(body, signWrite(U.a, body), { "x-user-id": U.b, "x-role": "super_admin", "x-parent-profile-id": U.b })
      expect(res.status).toBe(200)
      expect(await nameOf(U.b)).toBe("Parent B")
      for (const bad of [`{"fullName":"X","parentProfileId":"${U.b}"}`, `{"fullName":"X","userId":"${U.b}"}`]) {
        expect((await patchDirect(bad, signWrite(U.a, bad))).status).toBe(400)
      }
      expect(await nameOf(U.b)).toBe("Parent B")
      expect((await nextWrite(U.a, "Parent A")).status).toBe(200)
    })

    it("tampered body, rebound path/method, v2 for a write, no assertion -> 401, no nonce stored, no write", async () => {
      const rows = await nonceRows()
      const body = '{"fullName":"Tampered"}'
      const v2 = signAssertion({ identity: ident(U.a), authenticatedAt: Date.now() - DAY_MS, requestId: "ws-v2-0000001", method: "GET", path: PATH, secret: Buffer.from(AUTH_SECRET, "hex") })
      for (const [sent, token] of [
        ['{"fullName":"Changed"}', signWrite(U.a, body)],
        [body, signWrite(U.a, body, { path: "/v1/parent/orders" })],
        [body, signWrite(U.a, body, { method: "POST" })],
        [body, v2],
        [body, undefined],
      ] as const) {
        expect((await patchDirect(sent, token)).status).toBe(401)
      }
      expect(await nonceRows()).toBe(rows)
      expect(await nameOf(U.a)).toBe("Parent A")
    })

    it("a v3 assertion replayed on GET is refused and consumes nothing", async () => {
      const rows = await nonceRows()
      const res = await fetch(`${backendUrl}${PATH}`, { headers: { "x-cartoona-internal-auth": signWrite(U.a, "") } })
      expect(res.status).toBe(401)
      expect(await nonceRows()).toBe(rows)
    })
  })

  describe("replay and concurrent duplicates over HTTP (5/7/19/21)", () => {
    it("the same assertion twice: 200 then 409 replayed_request; one UPDATE", async () => {
      const body = '{"fullName":"Replay Test"}'
      const token = signWrite(U.a, body)
      updates = 0
      expect((await patchDirect(body, token)).status).toBe(200)
      const again = await patchDirect(body, token)
      expect([again.status, await again.json()]).toEqual([409, { error: "replayed_request" }])
      expect(updates).toBe(1)
    })

    it("25 concurrent requests carrying ONE assertion: exactly one 200, 24 x 409, exactly one UPDATE", async () => {
      const body = '{"fullName":"Concurrent"}'
      const token = signWrite(U.a, body)
      updates = 0
      const statuses = await Promise.all(Array.from({ length: 25 }, () => patchDirect(body, token).then((r) => r.status)))
      expect(statuses.filter((s) => s === 200)).toHaveLength(1)
      expect(statuses.filter((s) => s === 409)).toHaveLength(24)
      expect(updates).toBe(1)
      expect(await nameOf(U.a)).toBe("Concurrent")
    })

    it("a legitimate retry (new assertion, new nonce, same value) succeeds and ends in the same state", async () => {
      updates = 0
      expect((await nextWrite(U.a, "Concurrent")).status).toBe(200)
      expect((await nextWrite(U.a, "Concurrent")).status).toBe(200)
      expect(updates).toBe(2)
      expect(await nameOf(U.a)).toBe("Concurrent")
    })
  })

  describe("uncertain timeout (9/22)", () => {
    it("committed but answered late: Next times out once, no retry; the write happened once; replay 409; a new retry is safe", async () => {
      const slow = await startBackend(countingDb(1500))
      try {
        updates = 0
        const sent: Array<{ token: string; body: Uint8Array }> = []
        const fetchImpl = (async (url: string, init: RequestInit) => {
          sent.push({ token: (init.headers as Record<string, string>)["X-Cartoona-Internal-Auth"], body: init.body as Uint8Array })
          return fetch(url, init)
        }) as unknown as typeof fetch
        vi.stubEnv("BACKEND_INTERNAL_URL", slow.url)
        vi.stubEnv("BACKEND_REQUEST_TIMEOUT_MS", "250")
        const started = Date.now()
        const error = await nextWrite(U.a, "Slow Commit", { fetchImpl }).then(() => null, (e: unknown) => e)
        const elapsed = Date.now() - started
        vi.stubEnv("BACKEND_INTERNAL_URL", backendUrl)
        vi.stubEnv("BACKEND_REQUEST_TIMEOUT_MS", "2000")

        expect(error).toBeInstanceOf(BackendClientError)
        expect([(error as BackendClientError).kind, (error as BackendClientError).outcomeUnknown]).toEqual(["timeout", true])
        expect(elapsed).toBeLessThan(1000)
        expect(sent).toHaveLength(1)
        // The write DID commit although the caller saw a timeout.
        await new Promise((r) => setTimeout(r, 1600))
        expect(updates).toBe(1)
        expect(await nameOf(U.a)).toBe("Slow Commit")

        // Transport replay of the very same request: refused, no second write.
        const replay = await patchDirect(new TextDecoder().decode(sent[0].body), sent[0].token)
        expect(replay.status).toBe(409)
        expect(updates).toBe(1)

        // The user's retry: new assertion, new nonce, same value -> safe, same end state.
        expect((await nextWrite(U.a, "Slow Commit")).data).toEqual({ fullName: "Slow Commit" })
        expect(await nameOf(U.a)).toBe("Slow Commit")
        expect(await readProfile(U.a)).toEqual({ status: 200, body: { fullName: "Slow Commit" } })
      } finally {
        await slow.app.close()
      }
    })
  })

  describe("timings (local Docker, NOT production estimates)", () => {
    it("direct Fastify write, Next client -> Fastify write, nonce consumption alone, read-after-write", async () => {
      const N = 60
      const direct: number[] = []
      const viaClient: number[] = []
      const nonce: number[] = []
      const raw: number[] = []
      for (let i = 0; i < N + 5; i++) {
        const body = JSON.stringify({ fullName: `Perf ${i % 2}` })
        let t = performance.now()
        expect((await patchDirect(body, signWrite(U.b, body))).status).toBe(200)
        const d = performance.now() - t
        t = performance.now()
        expect((await nextWrite(U.b, `Perf ${i % 2}`)).status).toBe(200)
        const c = performance.now() - t
        t = performance.now()
        await consumeWriteNonce(app, { nonce: newWriteNonce(), expiresAtSeconds: Math.floor(Date.now() / 1000) + 30, requestId: "ws-perf-000001" })
        const n = performance.now() - t
        t = performance.now()
        expect((await nextWrite(U.b, `Perf ${i}`)).status).toBe(200)
        expect((await readProfile(U.b)).body).toEqual({ fullName: `Perf ${i}` })
        const r = performance.now() - t
        if (i >= 5) { direct.push(d); viaClient.push(c); nonce.push(n); raw.push(r) }
      }
      const fmt = (xs: number[]) => `median ${pct(xs, 50).toFixed(2)} ms, p90 ${pct(xs, 90).toFixed(2)} ms`
      process.stderr.write(`[write timings, local Docker PostgreSQL 17, ${N} each]
  Fastify PATCH direct (signed v3, nonce, UPDATE): ${fmt(direct)}
  Next client -> Fastify -> PostgreSQL write:     ${fmt(viaClient)}
  nonce consumption alone (function call):         ${fmt(nonce)}
  write then read-after-write (GET /v1/parent/profile): ${fmt(raw)}\n`)
      expect(await nameOf(U.b)).toBe(`Perf ${N + 4}`)
    })
  })
})
