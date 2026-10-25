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
import { POST as setupPOST } from "@/app/api/parent/account-setup/route"
import { GET as consentGET, POST as consentPOST } from "@/app/api/parent-consent/route"
import { GET as summaryGET } from "@/app/api/parent/account-summary/route"
import { GET as meGET } from "@/app/api/auth/backend-me/route"
import ParentConsentPage from "@/app/(auth)/parent-consent/page"
import ParentConsentForm from "@/app/(auth)/parent-consent/parent-consent-form"
import { ensureParentAccountSetup } from "@/lib/parent/account-setup/account-setup-client"
import { ACCOUNT_SETUP_INCOMPLETE } from "@/lib/parent/account-setup/messages"
import { resolveSuccessfulLoginDestination } from "@/lib/auth/parent-destinations"
import { readParentConsent } from "@/lib/parent/consent/consent-client"
import { PARENT_PORTAL_HOME } from "@/lib/parent/navigation/parent-nav"
import { closePool, getPool } from "@/lib/db/pool"
import type { Queryable } from "@/lib/db/types"
import { signWriteAssertion } from "@/lib/identity/assertion"
import { toVerifiedIdentity } from "@/lib/identity/types"
import { runDataCopy } from "@/scripts/db/data-copy/copy"
import { buildSupabaseSource, dropDbs, migrateTarget, ownerUrl, pgEnv, psql, root, script, type PgEnv } from "../helpers/data-copy-db"
import { cookieJar, cookieName, startStubAuth, type StubAuth } from "../helpers/stub-supabase-auth"
import { DAY_MS } from "../helpers/supabase-jwt"

/**
 * V0.1.49 identity provisioning, on REAL local services
 * (opt-in: CARTOONA_PLAIN_PG=docker):
 *
 *   Supabase-shaped source (real migrations + triggers + fixtures) -> V0.1.44
 *   copy -> plain PostgreSQL 17 (0001-0019) = the pre-cutover population;
 *   brand-new stub Supabase Auth subjects = the post-cutover population.
 *   stub Supabase Auth (real @supabase/ssr) -> Next POST /api/parent/account-setup
 *   (CSRF, v3 write) -> Fastify POST /v1/auth/provision (listening, restricted
 *   login role) -> provision_supabase_parent_identity() -> every migrated
 *   parent read (requireAuth, account summary, consent page/read/write).
 *
 * Nothing contacts Supabase or any hosted service.
 */

const enabled = process.env.CARTOONA_PLAIN_PG === "docker"
const id = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`
const SRC = `pvs_${id}`
const TGT = `pvt_${id}`
const ROLE = `cartoona_app_pv${id}`
const DB_PASSWORD = randomBytes(24).toString("hex")
const AUTH_SECRET = randomBytes(32).toString("hex")
const ORIGIN = "http://localhost:3000"
const PROVISION = "/v1/auth/provision"

// Copied (pre-cutover) accounts from the shared fixture.
const COPIED = {
  a: "a1000000-0000-4000-8000-000000000001", // consented parent, full name, referrer
  b: "a1000000-0000-4000-8000-000000000002", // consented parent, referred
  admin: "a1000000-0000-4000-8000-000000000003",
  deleted: "a1000000-0000-4000-8000-000000000004",
  superAdmin: "a1000000-0000-4000-8000-000000000005",
  d: "a1000000-0000-4000-8000-000000000007", // NOT consented
}
const fresh = () => randomUUID()

let env: PgEnv
let backend: FastifyInstance | null = null
let backendUrl = ""
let stub: StubAuth | null = null
let appPool: Pool

const tgt = (sql: string) => psql(env, TGT, sql)
const asApp = async (sql: string, values: unknown[] = []) => (await appPool.query(sql, values)).rows
const provisionAsApp = async (subject: string) => (await asApp("select public.provision_supabase_parent_identity($1::uuid) as o", [subject]))[0].o as string
async function sqlState(sql: string): Promise<string | undefined> {
  return appPool.query(sql).then(() => undefined, (e: { code?: string }) => e.code)
}

/** Every row the account owns, content included: proves "unchanged" byte for byte. */
const rowsOf = (user: string) => tgt(`select coalesce(json_agg(x order by x::text), '[]') from (
  select to_jsonb(u) x from public.users u where u.id = '${user}'
  union all select to_jsonb(i) from public.user_identities i where i.user_id = '${user}'
  union all select to_jsonb(p) from public.parent_profiles p where p.user_id = '${user}'
  union all select to_jsonb(w) from public.candy_wallets w join public.parent_profiles p on p.id = w.parent_id where p.user_id = '${user}'
  union all select to_jsonb(c) from public.parent_welcome_credits c join public.parent_profiles p on p.id = c.parent_id where p.user_id = '${user}'
) t`)

/**
 * The essential row SHAPE of a parent account - what both populations must
 * share - independent of values that legitimately differ (ids, times, a
 * balance a copied parent has spent, a name).
 */
const shapeOf = (user: string) => tgt(`select json_build_object(
  'role', u.role,
  'deleted', u.deleted_at is not null,
  'sessions_not_before', u.sessions_not_before,
  'identities', (select count(*) from public.user_identities i where i.user_id = u.id),
  'identity_is_supabase_subject', exists (select 1 from public.user_identities i where i.user_id = u.id and i.provider = 'supabase' and i.provider_subject = u.id::text),
  'identity_id_deterministic', exists (select 1 from public.user_identities i where i.user_id = u.id and i.id = md5('cartoona-identity:supabase:' || u.id::text)::uuid),
  'identity_created_with_user', exists (select 1 from public.user_identities i where i.user_id = u.id and i.created_at = u.created_at),
  'profiles', (select count(*) from public.parent_profiles p where p.user_id = u.id),
  'referral_code_valid', (select bool_and(p.referral_code ~ '^CT[0-9A-F]{12}$') from public.parent_profiles p where p.user_id = u.id),
  'wallets', (select count(*) from public.candy_wallets w join public.parent_profiles p on p.id = w.parent_id where p.user_id = u.id),
  'welcome_grants', (select count(*) from public.parent_welcome_credits c join public.parent_profiles p on p.id = c.parent_id where p.user_id = u.id),
  'welcome_granted_count', (select max(c.granted_count) from public.parent_welcome_credits c join public.parent_profiles p on p.id = c.parent_id where p.user_id = u.id)
)::text from public.users u where u.id = '${user}'`)

const counts = (user: string) => tgt(`select
  (select count(*) from public.users where id = '${user}') || '/' ||
  (select count(*) from public.user_identities where user_id = '${user}' or provider_subject = '${user}') || '/' ||
  (select count(*) from public.parent_profiles where user_id = '${user}') || '/' ||
  (select count(*) from public.candy_wallets w join public.parent_profiles p on p.id = w.parent_id where p.user_id = '${user}') || '/' ||
  (select count(*) from public.parent_welcome_credits c join public.parent_profiles p on p.id = c.parent_id where p.user_id = '${user}')`)
const NONE = "0/0/0/0/0"
const ONE_EACH = "1/1/1/1/1"

async function signIn(userId: string, opts: { authenticatedAt?: number; role?: string } = {}) {
  await stub?.close()
  stub = await startStubAuth({ userId, role: opts.role ?? "parent" })
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", stub.url)
  cookies.jar = cookieJar([stub.cookie({ authenticatedAt: opts.authenticatedAt })])
}
const jar = () => cookies.jar as ReturnType<typeof cookieJar>
const signedOut = () => jar().cleared(cookieName(stub!.url))

const browserSetup = (body = "{}", headers: Record<string, string> = {}) =>
  setupPOST(new Request(`${ORIGIN}/api/parent/account-setup`, {
    method: "POST",
    body,
    headers: { "content-type": "application/json", origin: ORIGIN, "sec-fetch-site": "same-origin", ...headers },
  }))
const viaBff = (async () => browserSetup()) as unknown as typeof fetch
async function json(res: Response) {
  return { status: res.status, body: await res.json() }
}
async function consentPage(): Promise<string> {
  const el = (await ParentConsentPage()) as { type: unknown; props: { initiallyGranted?: boolean; title?: string } }
  if (el.type === ParentConsentForm) return `form:${el.props.initiallyGranted}`
  if ((el.type as { name?: string }).name === "SetupIncomplete") return "setup_incomplete"
  return `notice:${el.props.title}`
}
async function loginDestination(): Promise<string> {
  const read = (async () => consentGET(new Request(`${ORIGIN}/api/parent-consent`))) as unknown as typeof fetch
  return resolveSuccessfulLoginDestination(null, (await readParentConsent(read)) === true)
}

const directProvision = (subject: string, body = "{}", url = backendUrl) =>
  fetch(`${url}${PROVISION}`, {
    method: "POST",
    body,
    headers: {
      "content-type": "application/json",
      "x-cartoona-internal-auth": signWriteAssertion({
        identity: toVerifiedIdentity({ provider: "supabase", subject }),
        authenticatedAt: Date.now() - DAY_MS,
        requestId: `pv-${randomBytes(4).toString("hex")}`,
        method: "POST",
        path: PROVISION,
        body,
        secret: Buffer.from(AUTH_SECRET, "hex"),
      }),
    },
  })

let provisionCalls = 0
function countingDb(opts: { delayAfterMs?: number; down?: boolean } = {}): () => Queryable {
  return () => ({
    query: async (text: string, values?: readonly unknown[]) => {
      if (opts.down) throw Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5433"), { code: "ECONNREFUSED" })
      const result = await getPool().query(text, values as unknown[])
      if (text.includes("provision_supabase_parent_identity")) {
        provisionCalls += 1
        // Autocommit: provisioning has COMMITTED; only the answer is late.
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
const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))]
const fmt = (xs: number[]) => `median ${pct(xs, 50).toFixed(2)} ms, p90 ${pct(xs, 90).toFixed(2)} ms`

describe.skipIf(!enabled)("V0.1.49 provisioning: Supabase subject -> PostgreSQL account (local Docker PostgreSQL 17)", () => {
  vi.setConfig({ testTimeout: 120_000, hookTimeout: 300_000 })

  beforeAll(async () => {
    env = await pgEnv()
    await buildSupabaseSource(env, SRC, path.join(root, "tests/fixtures/data-copy/supabase-source-fixture.sql"))
    await psql(env, SRC, "", path.join(root, "tests/fixtures/data-copy/parent-consent-extra.sql"))
    await migrateTarget(env, TGT)
    const copied = await runDataCopy({ sourceUrl: ownerUrl(env, SRC), targetUrl: ownerUrl(env, TGT), migrationsDir: path.join(root, "database/migrations"), env: {} })
    expect(copied.outcome).toBe("completed")
    const r = await script(env, "scripts/db/app-login-role.sh", { DATABASE_URL: `postgresql://cartoona@postgres:5432/${TGT}`, CARTOONA_APP_DB_PASSWORD: DB_PASSWORD }, [ROLE])
    expect(r.code).toBe(0)
    const roleUrl = `postgresql://${ROLE}:${DB_PASSWORD}@127.0.0.1:${env.port}/${TGT}`
    appPool = new Pool({ connectionString: roleUrl, max: 25 })
    vi.stubEnv("DATABASE_URL", roleUrl)
    vi.stubEnv("CARTOONA_INTERNAL_AUTH_SECRET", AUTH_SECRET)
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-key")
    vi.stubEnv("BACKEND_REQUEST_TIMEOUT_MS", "2000")
    vi.stubEnv("CARTOONA_APP_ORIGIN", ORIGIN)
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

  describe("1. the function (as the restricted login role)", () => {
    it("a new subject -> created: users.id = subject, identity, one profile + wallet + welcome grant, server-chosen values", async () => {
      const s = fresh()
      expect(await counts(s)).toBe(NONE)
      expect(await provisionAsApp(s)).toBe("created")
      expect(await counts(s)).toBe(ONE_EACH)
      expect(await tgt(`select u.role || '|' || coalesce(u.email, '-') || '|' || coalesce(u.sessions_not_before::text, '-') || '|' || (u.deleted_at is null)
        || '|' || coalesce(p.full_name, '-') || '|' || p.consent_granted || '|' || coalesce(p.consent_granted_at::text, '-') || '|' || (p.referral_code ~ '^CT[0-9A-F]{12}$')
        || '|' || w.balance || '|' || c.granted_count || '/' || c.used_count
        from public.users u join public.parent_profiles p on p.user_id = u.id join public.candy_wallets w on w.parent_id = p.id
        join public.parent_welcome_credits c on c.parent_id = p.id where u.id = '${s}'`)).toBe("parent|-|-|true|-|false|-|true|0|3/0")
      expect(await tgt(`select provider || '|' || provider_subject || '|' || (id = md5('cartoona-identity:supabase:${s}')::uuid) from public.user_identities where user_id = '${s}'`)).toBe(`supabase|${s}|true`)
    })

    it("idempotent: a second and third call -> existing, every row byte-identical", async () => {
      const s = fresh()
      await provisionAsApp(s)
      const before = await rowsOf(s)
      expect(await provisionAsApp(s)).toBe("existing")
      expect(await provisionAsApp(s)).toBe("existing")
      expect(await rowsOf(s)).toBe(before)
    })

    it("existing COPIED parents are an exact no-op: role, profile id, referral code, wallet, welcome credits, consent, sessions_not_before", async () => {
      // Give one copied parent a cut-off so "unchanged" covers a non-null value too.
      await tgt(`update public.users set sessions_not_before = '2026-09-01T00:00:00Z' where id = '${COPIED.d}'`)
      for (const u of [COPIED.a, COPIED.b, COPIED.d]) {
        const before = await rowsOf(u)
        expect(JSON.parse(before).length).toBe(5)
        expect(await provisionAsApp(u)).toBe("existing")
        expect(await rowsOf(u), u).toBe(before)
      }
      await tgt(`update public.users set sessions_not_before = null where id = '${COPIED.d}'`)
    })

    it("admin / super_admin -> not_parent; soft-deleted -> account_deleted; nothing written", async () => {
      for (const [u, outcome] of [[COPIED.admin, "not_parent"], [COPIED.superAdmin, "not_parent"], [COPIED.deleted, "account_deleted"]]) {
        const before = await rowsOf(u)
        expect(await provisionAsApp(u)).toBe(outcome)
        expect(await rowsOf(u), u).toBe(before)
      }
      expect(await tgt(`select count(*) from public.parent_profiles where user_id in ('${COPIED.admin}', '${COPIED.superAdmin}')`)).toBe("0")
    })

    it("identity conflicts are refused, never remapped", async () => {
      const subject = fresh(), other = fresh(), userWithOtherSubject = fresh(), futureOnly = fresh()
      // (a) the subject is already linked to ANOTHER user
      await tgt(`insert into public.users (id, role) values ('${other}', 'parent');
        insert into public.user_identities (user_id, provider, provider_subject) values ('${other}', 'supabase', '${subject}')`)
      // (b) the user (id = subject) is linked to a DIFFERENT Supabase subject
      await tgt(`insert into public.users (id, role) values ('${userWithOtherSubject}', 'parent');
        insert into public.user_identities (user_id, provider, provider_subject) values ('${userWithOtherSubject}', 'supabase', '${fresh()}')`)
      // (c) the user only has another provider's identity: backfill is not provably safe
      await tgt(`insert into public.users (id, role) values ('${futureOnly}', 'parent');
        insert into public.user_identities (user_id, provider, provider_subject) values ('${futureOnly}', 'future_idp', 'opaque-1')`)
      const all = await tgt("select count(*) || '/' || (select count(*) from public.user_identities) || '/' || (select count(*) from public.parent_profiles) from public.users")
      for (const s of [subject, userWithOtherSubject, futureOnly]) expect(await provisionAsApp(s), s).toBe("identity_conflict")
      expect(await tgt("select count(*) || '/' || (select count(*) from public.user_identities) || '/' || (select count(*) from public.parent_profiles) from public.users")).toBe(all)
      expect(await tgt(`select user_id from public.user_identities where provider_subject = '${subject}'`)).toBe(other)
    })

    it("the one safe backfill: a user row id = subject with NO identity at all -> identity_backfilled (+ profile); a linked parent without a profile -> profile_created", async () => {
      const orphan = fresh(), noProfile = fresh()
      await tgt(`insert into public.users (id, role, created_at) values ('${orphan}', 'parent', '2026-08-15T10:00:00Z'), ('${noProfile}', 'parent', now());
        insert into public.user_identities (user_id, provider, provider_subject) values ('${noProfile}', 'supabase', '${noProfile}')`)
      expect(await provisionAsApp(orphan)).toBe("identity_backfilled")
      expect(await shapeOf(orphan)).toBe(await shapeOf(COPIED.a))
      expect(await provisionAsApp(noProfile)).toBe("profile_created")
      expect(await counts(noProfile)).toBe(ONE_EACH)
      expect(await provisionAsApp(orphan)).toBe("existing")
    })

    it("atomic: a failure after the user/identity/profile inserts rolls EVERYTHING back; a retry then succeeds", async () => {
      const s = fresh()
      await tgt(`create function public.pv_fail_${id}() returns trigger language plpgsql as $$ begin
          if exists (select 1 from public.parent_profiles p where p.id = new.parent_id and p.user_id = '${s}') then raise exception 'pv_injected_failure'; end if;
          return new; end $$;
        create trigger pv_fail_${id} before insert on public.parent_welcome_credits for each row execute function public.pv_fail_${id}()`)
      try {
        const err = await provisionAsApp(s).then(() => null, (e: { message?: string }) => e.message)
        expect(err).toMatch(/pv_injected_failure/)
        expect(await counts(s)).toBe(NONE)
        // And through Fastify: a safe 503, no detail.
        const res = await directProvision(s)
        expect([res.status, await res.json()]).toEqual([503, { error: "service_unavailable" }])
        expect(await counts(s)).toBe(NONE)
      } finally {
        await tgt(`drop trigger pv_fail_${id} on public.parent_welcome_credits; drop function public.pv_fail_${id}()`)
      }
      expect(await provisionAsApp(s)).toBe("created")
      expect(await counts(s)).toBe(ONE_EACH)
    })

    it("NULL / malformed subject is refused", async () => {
      expect(await sqlState("select public.provision_supabase_parent_identity(null)")).toBe("22023")
      expect(await sqlState("select public.provision_supabase_parent_identity('not-a-uuid')")).toBe("22P02")
    })
  })

  describe("2. concurrency: 20 simultaneous provisioning calls for ONE new subject", () => {
    it("SQL, 20 pooled connections: one created, 19 existing, exactly one of everything, no error", async () => {
      const s = fresh()
      const outcomes = await Promise.all(Array.from({ length: 20 }, () => provisionAsApp(s)))
      expect(outcomes.filter((o) => o === "created")).toHaveLength(1)
      expect(outcomes.filter((o) => o === "existing")).toHaveLength(19)
      expect(await counts(s)).toBe(ONE_EACH)
    })

    it("HTTP, 20 distinct assertions through Fastify: all 200, one account", async () => {
      const s = fresh()
      const t0 = performance.now()
      const res = await Promise.all(Array.from({ length: 20 }, () => directProvision(s)))
      const wall = performance.now() - t0
      expect(res.map((r) => r.status)).toEqual(Array(20).fill(200))
      expect(await Promise.all(res.map((r) => r.json()))).toEqual(Array(20).fill({ provisioned: true }))
      expect(await counts(s)).toBe(ONE_EACH)
      process.stderr.write(`[provisioning concurrency] 20 concurrent same-subject calls via Fastify: wall ${wall.toFixed(1)} ms\n`)
    })

    it("through the Next BFF, 20 concurrent account-setup requests of one signed-in new parent: all ready, one account", async () => {
      const s = fresh()
      await signIn(s)
      const res = await Promise.all(Array.from({ length: 20 }, () => browserSetup()))
      expect(res.map((r) => r.status)).toEqual(Array(20).fill(200))
      expect(await counts(s)).toBe(ONE_EACH)
    })
  })

  describe("3. privileges: the app role can EXECUTE the function and write nothing directly", () => {
    it.each([
      ["INSERT users", `insert into public.users (id, role) values ('${randomUUID()}', 'parent')`],
      ["INSERT user_identities", `insert into public.user_identities (user_id, provider, provider_subject) values ('a1000000-0000-4000-8000-000000000001', 'supabase', '${randomUUID()}')`],
      ["INSERT parent_profiles", `insert into public.parent_profiles (user_id) values ('a1000000-0000-4000-8000-000000000003')`],
      ["INSERT candy_wallets", `insert into public.candy_wallets (parent_id, balance) values ('b1000000-0000-4000-8000-000000000001', 5)`],
      ["INSERT parent_welcome_credits", `insert into public.parent_welcome_credits (parent_id, granted_count) values ('b1000000-0000-4000-8000-000000000001', 3)`],
      ["UPDATE users.role", `update public.users set role = 'super_admin' where id = 'a1000000-0000-4000-8000-000000000001'`],
      ["UPDATE candy_wallets", `update public.candy_wallets set balance = 999`],
      ["DELETE user_identities", `delete from public.user_identities`],
      ["the referral-code generator directly", `select public.generate_parent_referral_code()`],
    ])("%s -> 42501", async (_l, sql) => {
      expect(await sqlState(sql)).toBe("42501")
    })

    it("EXECUTE is granted to cartoona_app only (not PUBLIC), SECURITY DEFINER, empty search_path", async () => {
      expect(await tgt(`select p.prosecdef || '|' || array_to_string(p.proconfig, ',') || '|' || has_function_privilege('public', p.oid, 'execute') || '|' || has_function_privilege('cartoona_app', p.oid, 'execute')
        from pg_proc p where p.proname = 'provision_supabase_parent_identity'`)).toBe('true|search_path=""|false|true')
    })
  })

  describe("4. data-copy population vs provisioned population: the same essential row shape", () => {
    it("every copied active parent and a freshly provisioned parent have identical invariants", async () => {
      const s = fresh()
      await provisionAsApp(s)
      const provisioned = await shapeOf(s)
      expect(JSON.parse(provisioned)).toEqual({
        role: "parent", deleted: false, sessions_not_before: null,
        identities: 1, identity_is_supabase_subject: true, identity_id_deterministic: true, identity_created_with_user: true,
        profiles: 1, referral_code_valid: true, wallets: 1, welcome_grants: 1, welcome_granted_count: 3,
      })
      const copiedParents = (await tgt(`select string_agg(u.id::text, ',') from public.users u
        where u.role = 'parent' and u.deleted_at is null and u.id::text like 'a1000000-%'
          and exists (select 1 from public.parent_profiles p where p.user_id = u.id)`)).split(",")
      expect(copiedParents.length).toBeGreaterThanOrEqual(3)
      for (const u of copiedParents) expect(await shapeOf(u), u).toBe(provisioned)
    })

    it("re-running the copy after provisioning REFUSES (validation_failed) and writes nothing", async () => {
      const before = await tgt("select count(*) || '/' || (select count(*) from public.user_identities) || '/' || (select count(*) from public.parent_profiles) from public.users")
      const err = await runDataCopy({ sourceUrl: ownerUrl(env, SRC), targetUrl: ownerUrl(env, TGT), migrationsDir: path.join(root, "database/migrations"), env: {} })
        .then(() => null, (e: { code?: string }) => e.code)
      expect(err).toBe("validation_failed")
      expect(await tgt("select count(*) || '/' || (select count(*) from public.user_identities) || '/' || (select count(*) from public.parent_profiles) from public.users")).toBe(before)
    })
  })

  describe("5. new user, end to end: stub Supabase Auth -> Next -> Fastify -> PostgreSQL", () => {
    const NEW = fresh()

    it("before provisioning every migrated surface fails SAFELY (no crash, no fake account, no sign-out)", async () => {
      await signIn(NEW)
      expect(await json(await meGET(new Request(`${ORIGIN}/api/auth/backend-me`)))).toMatchObject({ status: 403, body: { error: "identity_not_linked" } })
      expect(await json(await summaryGET(new Request(`${ORIGIN}/api/parent/account-summary`)))).toMatchObject({ status: 403, body: { code: "identity_not_linked" } })
      expect(await json(await consentGET(new Request(`${ORIGIN}/api/parent-consent`)))).toMatchObject({ status: 403, body: { code: "identity_not_linked" } })
      expect(await consentPage()).toBe("setup_incomplete")
      expect(await counts(NEW)).toBe(NONE)
      expect(signedOut()).toBe(false)
    })

    it("the real post-auth bootstrap (browser helper -> BFF) provisions the account", async () => {
      expect(await ensureParentAccountSetup(viaBff)).toEqual({ status: "ready" })
      expect(await counts(NEW)).toBe(ONE_EACH)
      expect(await shapeOf(NEW)).toBe(await shapeOf(COPIED.a))
    })

    it("Fastify requireAuth now resolves the identity: users.id = Supabase subject, role parent", async () => {
      expect(await json(await meGET(new Request(`${ORIGIN}/api/auth/backend-me`)))).toEqual({ status: 200, body: { authenticated: true, userId: NEW, role: "parent" } })
    })

    it("parent account reads work: zero balance, 3 welcome credits", async () => {
      expect(await json(await summaryGET(new Request(`${ORIGIN}/api/parent/account-summary`)))).toEqual({ status: 200, body: { wallet: { balance: 0 }, welcomeImageCreditsRemaining: 3 } })
    })

    it("consent: page shows the form, the write grants it, every read agrees, login goes to the dashboard", async () => {
      expect(await consentPage()).toBe("form:false")
      expect(await loginDestination()).toBe("/parent-consent")
      const write = await json(await consentPOST(new Request(`${ORIGIN}/api/parent-consent`, {
        method: "POST", body: '{"consentGranted":true}',
        headers: { "content-type": "application/json", origin: ORIGIN, "sec-fetch-site": "same-origin" },
      })))
      expect(write).toMatchObject({ status: 200, body: { success: true, consentGranted: true } })
      expect((await json(await consentGET(new Request(`${ORIGIN}/api/parent-consent`)))).body).toEqual({ consentGranted: true })
      expect(await consentPage()).toBe("form:true")
      expect(await loginDestination()).toBe(PARENT_PORTAL_HOME)
    })

    it("re-login (new session) + re-provision: no duplicate, nothing changed (consent kept)", async () => {
      const before = await rowsOf(NEW)
      await signIn(NEW)
      expect(await json(await browserSetup())).toEqual({ status: 200, body: { ready: true } })
      await signIn(NEW)
      expect(await ensureParentAccountSetup(viaBff)).toEqual({ status: "ready" })
      expect(await rowsOf(NEW)).toBe(before)
      expect(await counts(NEW)).toBe(ONE_EACH)
    })
  })

  describe("6. the BFF boundary", () => {
    it.each([
      ["hostile Origin", { origin: "https://evil.example" }, 403, "csrf_rejected"],
      ["missing Origin", { origin: "" }, 403, "csrf_rejected"],
      ["form post", { "content-type": "application/x-www-form-urlencoded" }, 415, "unsupported_media_type"],
    ])("%s -> %i %s, nothing provisioned", async (_l, headers, status, code) => {
      const s = fresh()
      await signIn(s)
      const h = { ...headers } as Record<string, string>
      const req = new Request(`${ORIGIN}/api/parent/account-setup`, {
        method: "POST", body: "{}",
        headers: Object.fromEntries(Object.entries({ "content-type": "application/json", origin: ORIGIN, "sec-fetch-site": "same-origin", ...h }).filter(([, v]) => v !== "")),
      })
      expect(await json(await setupPOST(req))).toMatchObject({ status, body: { code } })
      expect(await counts(s)).toBe(NONE)
    })

    it.each([
      [`{"userId":"${COPIED.a}"}`], ['{"role":"super_admin"}'], [`{"parentProfileId":"b1000000-0000-4000-8000-000000000001"}`], ['{"subject":"x"}'],
    ])("browser-chosen identity fields %s -> 422, nothing provisioned for anyone", async (body) => {
      const s = fresh()
      await signIn(s)
      const before = await rowsOf(COPIED.a)
      expect((await browserSetup(body)).status).toBe(422)
      expect(await counts(s)).toBe(NONE)
      expect(await rowsOf(COPIED.a)).toBe(before)
    })

    it("signed out -> 401; a 31-day-old session -> 401 PARENT_SESSION_EXPIRED + sign-out; nothing provisioned", async () => {
      cookies.jar = cookieJar([])
      expect((await browserSetup()).status).toBe(401)
      const s = fresh()
      await signIn(s, { authenticatedAt: Date.now() - 31 * DAY_MS })
      expect(await json(await browserSetup())).toMatchObject({ status: 401, body: { code: "PARENT_SESSION_EXPIRED" } })
      expect(signedOut()).toBe(true)
      expect(await counts(s)).toBe(NONE)
    })

    it("admin -> 403 forbidden; deleted -> 403 forbidden; no rows change, no sign-out", async () => {
      for (const [u, role] of [[COPIED.admin, "admin"], [COPIED.deleted, "parent"]]) {
        const before = await rowsOf(u)
        await signIn(u, { role })
        expect(await json(await browserSetup())).toMatchObject({ status: 403, body: { code: "forbidden" } })
        expect(await rowsOf(u)).toBe(before)
        expect(signedOut()).toBe(false)
      }
    })

    it("identity conflict -> 409 account_setup_conflict; the browser helper reports it as blocked (no retry loop)", async () => {
      const s = fresh(), other = fresh()
      await tgt(`insert into public.users (id, role) values ('${other}', 'parent');
        insert into public.user_identities (user_id, provider, provider_subject) values ('${other}', 'supabase', '${s}')`)
      await signIn(s)
      expect(await json(await browserSetup())).toMatchObject({ status: 409, body: { code: "account_setup_conflict" } })
      expect((await ensureParentAccountSetup(viaBff)).status).toBe("blocked")
    })
  })

  describe("7. partial failure", () => {
    it("Auth OK, PostgreSQL unavailable: 503 account_setup_incomplete (the Persian retry text), still signed in, no rows; retry works", async () => {
      const s = fresh()
      await signIn(s)
      const down = await startBackend(countingDb({ down: true }))
      try {
        const res = await withBackend(down.url, "2000", async () => json(await browserSetup()))
        expect(res).toEqual({ status: 503, body: { error: ACCOUNT_SETUP_INCOMPLETE, code: "account_setup_incomplete" } })
        expect(await withBackend(down.url, "2000", () => ensureParentAccountSetup(viaBff))).toEqual({ status: "retry", message: ACCOUNT_SETUP_INCOMPLETE })
      } finally {
        await down.app.close()
      }
      expect(signedOut()).toBe(false)
      expect(await counts(s)).toBe(NONE)
      expect(await json(await browserSetup())).toEqual({ status: 200, body: { ready: true } })
      expect(await counts(s)).toBe(ONE_EACH)
    })

    it("backend unreachable: 503 account_setup_incomplete, still signed in", async () => {
      const s = fresh()
      await signIn(s)
      const res = await withBackend("http://127.0.0.1:9", "500", async () => json(await browserSetup()))
      expect(res).toMatchObject({ status: 503, body: { code: "account_setup_incomplete" } })
      expect(signedOut()).toBe(false)
      expect(await counts(s)).toBe(NONE)
    })

    it("response lost AFTER commit (outcomeUnknown): the BFF confirms with a fresh read -> ready; exactly one account; a re-run is a no-op", async () => {
      const s = fresh()
      await signIn(s)
      const slow = await startBackend(countingDb({ delayAfterMs: 1500 }))
      const callsBefore = provisionCalls
      try {
        const res = await withBackend(slow.url, "600", async () => json(await browserSetup()))
        expect(res).toEqual({ status: 200, body: { ready: true } })
      } finally {
        await slow.app.close()
      }
      expect(provisionCalls - callsBefore).toBe(1) // the write was sent ONCE, never re-sent
      expect(await counts(s)).toBe(ONE_EACH)
      expect(await json(await browserSetup())).toEqual({ status: 200, body: { ready: true } })
      expect(await counts(s)).toBe(ONE_EACH)
    })
  })

  describe("8. local timings (not a production estimate)", () => {
    it("first provisioning, idempotent provisioning, the BFF bootstrap", async () => {
      const first: number[] = [], again: number[] = [], bffFirst: number[] = [], bffAgain: number[] = []
      for (let i = 0; i < 30; i += 1) {
        const s = fresh()
        let t = performance.now()
        expect((await directProvision(s)).status).toBe(200)
        first.push(performance.now() - t)
        t = performance.now()
        expect((await directProvision(s)).status).toBe(200)
        again.push(performance.now() - t)
      }
      for (let i = 0; i < 15; i += 1) {
        await signIn(fresh())
        let t = performance.now()
        expect((await browserSetup()).status).toBe(200)
        bffFirst.push(performance.now() - t)
        t = performance.now()
        expect((await browserSetup()).status).toBe(200)
        bffAgain.push(performance.now() - t)
      }
      process.stderr.write([
        "[provisioning timings, local Docker PostgreSQL 17 + in-process stub provider]",
        `  Fastify direct, first (creates 5 rows + 3 triggers):  ${fmt(first)}  (n=30)`,
        `  Fastify direct, idempotent (no write):               ${fmt(again)}  (n=30)`,
        `  Next BFF bootstrap, first (CSRF, provider, v3):       ${fmt(bffFirst)}  (n=15)`,
        `  Next BFF bootstrap, existing account (login cost):    ${fmt(bffAgain)}  (n=15)`,
      ].join("\n") + "\n")
    })
  })
})
