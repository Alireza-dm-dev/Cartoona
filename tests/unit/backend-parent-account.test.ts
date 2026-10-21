import { describe, it, expect, afterEach } from "vitest"
import type { FastifyInstance } from "fastify"
import { buildBackendApp } from "@/backend/src/app"
import { signAssertion } from "@/lib/identity/assertion"
import { toVerifiedIdentity } from "@/lib/identity/types"
import type { Queryable } from "@/lib/db/types"
import { setLogSink, type LogRecord } from "@/lib/observability/logger"

/**
 * The V0.1.46 parent account reads in-process with a fake database:
 * GET /v1/parent/profile, /candy-balance, /welcome-credits. Who the caller is
 * (assertion only), parent-only, profile resolved server-side, no parameters,
 * error mapping and cache headers. Real PostgreSQL and the full Next -> Fastify
 * chain: parent-account-cutover-db.test.ts (opt-in).
 */

const SECRET = Buffer.from("45".repeat(32), "hex")
const SUBJECT = "6f1c2e7a-3b4d-4c5e-8f9a-0b1c2d3e4f50"
const USER = "11111111-2222-4333-8444-555555555555"
const PROFILE = "22222222-3333-4444-8555-666666666666"
const OTHER_PROFILE = "33333333-4444-4555-8666-777777777777"
const DAY = 86_400_000

const PROFILE_PATH = "/v1/parent/profile"
const BALANCE_PATH = "/v1/parent/candy-balance"
const CREDITS_PATH = "/v1/parent/welcome-credits"
const PATHS = [PROFILE_PATH, BALANCE_PATH, CREDITS_PATH]

interface Call { text: string; values: readonly unknown[] }
interface World {
  role?: string
  deleted?: boolean
  profile?: boolean
  fullName?: string | null
  wallet?: number | null
  credits?: { granted_count: number; used_count: number } | null
  readDown?: boolean
}

function fakeDb(w: World = {}) {
  const calls: Call[] = []
  const db: Queryable = {
    async query(text: string, values: readonly unknown[] = []) {
      calls.push({ text, values })
      let rows: unknown[] = []
      const down = () => { throw Object.assign(new Error("terminating connection: password=hunter2"), { code: "57P01" }) }
      if (text.includes("user_identities")) {
        rows = values[1] === SUBJECT ? [{ user_id: USER, role: w.role ?? "parent", deleted: w.deleted ?? false, sessions_not_before_ms: null }] : []
      } else if (text.includes("FROM public.parent_profiles")) {
        if (w.readDown && text.includes("full_name")) down()
        if (w.profile === false || values[0] !== USER) rows = []
        else rows = text.includes("full_name") ? [{ full_name: w.fullName === undefined ? "Parent A" : w.fullName }] : [{ id: PROFILE }]
      } else if (text.includes("FROM public.candy_wallets")) {
        if (w.readDown) down()
        // Only the authenticated parent's profile id ever reaches this query.
        rows = values[0] === PROFILE && w.wallet !== null ? [{ balance: w.wallet ?? 42 }] : []
      } else if (text.includes("FROM public.parent_welcome_credits")) {
        if (w.readDown) down()
        rows = values[0] === PROFILE && w.credits !== null ? [w.credits ?? { granted_count: 3, used_count: 1 }] : []
      }
      return { rows, rowCount: rows.length, command: "SELECT", oid: 0, fields: [] } as never
    },
  }
  return { db, calls }
}

let app: FastifyInstance | null = null
let logs: LogRecord[] = []
let restore: (() => void) | null = null

function build(w: World = {}) {
  const fake = fakeDb(w)
  logs = []
  restore = setLogSink((r) => logs.push(r))
  app = buildBackendApp({ db: () => fake.db, closeDb: async () => {}, authSecret: () => SECRET })
  return fake
}

afterEach(async () => {
  await app?.close()
  app = null
  restore?.()
})

const sign = (path: string, over: { subject?: string; secret?: Buffer; authenticatedAt?: number } = {}) =>
  signAssertion({
    identity: toVerifiedIdentity({ provider: "supabase", subject: over.subject ?? SUBJECT }),
    authenticatedAt: over.authenticatedAt ?? Date.now() - DAY,
    requestId: "req-account-000001",
    method: "GET",
    path,
    secret: over.secret ?? SECRET,
  })

const get = (url: string, headers: Record<string, string> = {}) =>
  app!.inject({ method: "GET", url, headers: { "x-cartoona-internal-auth": sign(url.split("?")[0]), ...headers } })

describe("GET /v1/parent/{profile,candy-balance,welcome-credits}: the values", () => {
  it("profile: only the name", async () => {
    build()
    const res = await get(PROFILE_PATH)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ fullName: "Parent A" })
    expect(res.headers["cache-control"]).toBe("no-store")
  })

  it("profile: a profile with no name -> fullName null", async () => {
    build({ fullName: null })
    expect((await get(PROFILE_PATH)).json()).toEqual({ fullName: null })
  })

  it("candy balance: the wallet balance; no wallet row reads 0 (the value billing always showed)", async () => {
    build({ wallet: 37 })
    expect((await get(BALANCE_PATH)).json()).toEqual({ balance: 37 })
    await app!.close()
    build({ wallet: null })
    expect((await get(BALANCE_PATH)).json()).toEqual({ balance: 0 })
  })

  it("welcome credits: max(granted - used, 0); no grant row -> 0", async () => {
    build({ credits: { granted_count: 3, used_count: 1 } })
    expect((await get(CREDITS_PATH)).json()).toEqual({ welcomeImageCreditsRemaining: 2 })
    await app!.close()
    build({ credits: { granted_count: 3, used_count: 3 } })
    expect((await get(CREDITS_PATH)).json()).toEqual({ welcomeImageCreditsRemaining: 0 })
    await app!.close()
    build({ credits: null })
    expect((await get(CREDITS_PATH)).json()).toEqual({ welcomeImageCreditsRemaining: 0 })
  })

  it("the profile is resolved from the principal only; every query is parameterised and scoped to it", async () => {
    for (const path of PATHS) {
      const fake = build()
      expect((await get(path)).statusCode, path).toBe(200)
      const reads = fake.calls.filter((c) => !c.text.includes("user_identities"))
      // profile: one query by user id; balance/credits: profile id, then one read by profile id.
      expect(reads[0].values, path).toEqual([USER])
      for (const c of reads.slice(1)) expect(c.values, path).toEqual([PROFILE])
      expect(fake.calls.length, path).toBe(path === PROFILE_PATH ? 2 : 3)
      for (const c of fake.calls) expect(c.text, path).not.toContain(USER)
      await app!.close()
    }
  })

  it("never returns an id, ledger row, consent flag or referral code", async () => {
    build()
    for (const path of PATHS) {
      const body = JSON.stringify((await get(path)).json())
      expect(body).not.toMatch(new RegExp(`${USER}|${PROFILE}|granted|used_count|referral|consent|parent_id`))
    }
  })
})

describe("caller identity: the assertion, nothing else", () => {
  it("no assertion -> 401; an assertion signed for another path -> 401", async () => {
    build()
    for (const path of PATHS) {
      expect((await app!.inject({ method: "GET", url: path })).statusCode, path).toBe(401)
      const other = await app!.inject({ method: "GET", url: path, headers: { "x-cartoona-internal-auth": sign("/v1/parent/orders") } })
      expect([other.statusCode, other.json()], path).toEqual([401, { error: "unauthenticated" }])
    }
  })

  it("parentProfileId, userId or any other query parameter -> 400, before any read", async () => {
    for (const path of PATHS) {
      const fake = build()
      for (const qs of [`?parentProfileId=${OTHER_PROFILE}`, `?userId=${USER}`, "?x=1"]) {
        const res = await get(path + qs)
        expect([res.statusCode, res.json()], path + qs).toEqual([400, { error: "invalid_request" }])
      }
      expect(fake.calls.some((c) => !c.text.includes("user_identities")), path).toBe(false)
      await app!.close()
    }
  })

  it("X-User-Id, X-Role, X-Parent-Profile-Id and cookies are ignored", async () => {
    const fake = build()
    const res = await get(BALANCE_PATH, { "x-user-id": "99999999-9999-4999-8999-999999999999", "x-role": "parent", "x-parent-profile-id": OTHER_PROFILE, cookie: `profile=${OTHER_PROFILE}` })
    expect(res.json()).toEqual({ balance: 42 })
    expect(fake.calls.flatMap((c) => c.values)).not.toContain(OTHER_PROFILE)
  })

  it("admin, super_admin and deleted accounts -> 403 forbidden, no account read", async () => {
    for (const w of [{ role: "admin" }, { role: "super_admin" }, { deleted: true }] as World[]) {
      for (const path of PATHS) {
        const fake = build(w)
        const res = await get(path, { "x-role": "parent" })
        expect([res.statusCode, res.json()], `${JSON.stringify(w)} ${path}`).toEqual([403, { error: "forbidden" }])
        expect(fake.calls.filter((c) => !c.text.includes("user_identities"))).toEqual([])
        await app!.close()
      }
    }
  })

  it("unlinked identity -> 403 identity_not_linked; expired session -> 401 session_expired", async () => {
    build()
    for (const path of PATHS) {
      const unlinked = await app!.inject({ method: "GET", url: path, headers: { "x-cartoona-internal-auth": sign(path, { subject: "a1000000-0000-4000-8000-0000000000ee" }) } })
      expect([unlinked.statusCode, unlinked.json()]).toEqual([403, { error: "identity_not_linked" }])
      const expired = await app!.inject({ method: "GET", url: path, headers: { "x-cartoona-internal-auth": sign(path, { authenticatedAt: Date.now() - 31 * DAY }) } })
      expect([expired.statusCode, expired.json()]).toEqual([401, { error: "session_expired" }])
    }
  })
})

describe("missing profile and failures", () => {
  it("a parent without a profile -> 404 parent_profile_not_found on every route", async () => {
    build({ profile: false })
    for (const path of PATHS) {
      const res = await get(path)
      expect([res.statusCode, res.json(), res.headers["cache-control"]], path).toEqual([404, { error: "parent_profile_not_found" }, "no-store"])
    }
  })

  it("a database failure -> 503 service_unavailable; the log carries a category, never the driver text", async () => {
    build({ readDown: true })
    for (const path of PATHS) {
      const res = await get(path)
      expect([res.statusCode, res.json(), res.headers["cache-control"]], path).toEqual([503, { error: "service_unavailable" }, "no-store"])
    }
    const failed = logs.filter((l) => l.event === "ACCOUNT_READ_FAILED")
    expect(failed.map((l) => l.operation)).toEqual(["parent_profile", "parent_candy_balance", "parent_welcome_credits"])
    expect(JSON.stringify(logs)).not.toMatch(/hunter2|terminating|11111111-2222|22222222-3333|6f1c2e7a/)
  })

  it("the request id is echoed", async () => {
    build()
    const res = await get(CREDITS_PATH, { "x-request-id": "req-account-000001" })
    expect(res.headers["x-request-id"]).toBe("req-account-000001")
  })
})
