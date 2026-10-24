import { describe, it, expect, afterEach } from "vitest"
import type { FastifyInstance } from "fastify"
import { buildBackendApp } from "@/backend/src/app"
import { signAssertion, signWriteAssertion } from "@/lib/identity/assertion"
import { toVerifiedIdentity } from "@/lib/identity/types"
import type { Queryable } from "@/lib/db/types"
import { setLogSink, type LogRecord } from "@/lib/observability/logger"

/**
 * V0.1.49 POST /v1/auth/provision in-process with a fake database:
 * requireProvisioningAuth (v3, body digest, nonce; identity may be unlinked)
 * and the route's mapping of the provisioning outcomes. The subject comes from
 * the assertion ONLY. Real PostgreSQL (the function itself, concurrency,
 * privileges) and the browser -> Next -> Fastify chain: provisioning-db.test.ts.
 */

const SECRET = Buffer.from("47".repeat(32), "hex")
const NEW = "6f1c2e7a-3b4d-4c5e-8f9a-0b1c2d3e4f51" // not linked yet
const LINKED = "11111111-2222-4333-8444-555555555556"
const OTHER = "99999999-2222-4333-8444-555555555556"
const PATH = "/v1/auth/provision"
const DAY = 86_400_000

interface World {
  linked?: { role?: string; deleted?: boolean; sessionsNotBeforeMs?: number | null }
  outcome?: string
  identityDown?: boolean
  provisionDown?: boolean
  nonceDown?: boolean
}

function fakeDb(w: World = {}) {
  const calls: Array<{ text: string; values: readonly unknown[] }> = []
  const seen = new Set<string>()
  const db: Queryable = {
    async query(text: string, values: readonly unknown[] = []) {
      calls.push({ text, values })
      let rows: unknown[] = []
      const down = () => { throw Object.assign(new Error("terminating connection: password=hunter2"), { code: "57P01" }) }
      if (text.includes("provision_supabase_parent_identity")) {
        if (w.provisionDown) down()
        rows = [{ outcome: w.outcome ?? (w.linked ? "existing" : "created") }]
      } else if (text.includes("user_identities")) {
        if (w.identityDown) down()
        rows = w.linked && values[1] === LINKED
          ? [{ user_id: LINKED, role: w.linked.role ?? "parent", deleted: w.linked.deleted ?? false, sessions_not_before_ms: w.linked.sessionsNotBeforeMs ?? null }]
          : []
      } else if (text.includes("consume_internal_write_nonce")) {
        if (w.nonceDown) down()
        const fresh = !seen.has(values[0] as string)
        seen.add(values[0] as string)
        rows = [{ consumed: fresh }]
      }
      return { rows, rowCount: rows.length, command: "SELECT", oid: 0, fields: [] } as never
    },
  }
  const provisionCalls = () => calls.filter((c) => c.text.includes("provision_supabase_parent_identity"))
  const nonceCalls = () => calls.filter((c) => c.text.includes("consume_internal_write_nonce"))
  return { db, calls, provisionCalls, nonceCalls }
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
  restore = null
})

const token = (subject: string, body = "{}", over: { path?: string; method?: string; authenticatedAt?: number; now?: number; secret?: Buffer } = {}) =>
  signWriteAssertion({
    identity: toVerifiedIdentity({ provider: "supabase", subject }),
    authenticatedAt: over.authenticatedAt ?? Date.now() - DAY,
    requestId: "provision-test-01",
    method: over.method ?? "POST",
    path: over.path ?? PATH,
    body,
    secret: over.secret ?? SECRET,
    ...(over.now ? { now: over.now } : {}),
  })
const post = (body: string, tok?: string, url = PATH, headers: Record<string, string> = {}) =>
  app!.inject({ method: "POST", url, payload: body, headers: { "content-type": "application/json", ...(tok ? { "x-cartoona-internal-auth": tok } : {}), ...headers } })
const res2 = async (r: Awaited<ReturnType<typeof post>>) => [r.statusCode, r.json()]

describe("success", () => {
  it("a NEW (unlinked) subject is provisioned: 200 { provisioned: true } only, no-store, subject from the assertion", async () => {
    const fake = build()
    const r = await post("{}", token(NEW))
    expect(await res2(r)).toEqual([200, { provisioned: true }])
    expect(r.headers["cache-control"]).toBe("no-store")
    expect(fake.provisionCalls().map((c) => c.values)).toEqual([[NEW]])
    expect(fake.nonceCalls()).toHaveLength(1)
    expect(logs.find((l) => l.event === "PROVISION_COMPLETED")?.reason).toBe("created")
  })

  it("an already-linked parent: 200, the function is still the only write (idempotent no-op)", async () => {
    const fake = build({ linked: {} })
    expect(await res2(await post("{}", token(LINKED)))).toEqual([200, { provisioned: true }])
    expect(fake.provisionCalls().map((c) => c.values)).toEqual([[LINKED]])
  })

  it.each(["created", "existing", "profile_created", "identity_backfilled"])("outcome %s -> 200", async (outcome) => {
    build({ outcome })
    expect(await res2(await post("{}", token(NEW)))).toEqual([200, { provisioned: true }])
  })

  it("no user id, profile id, role or outcome is returned", async () => {
    build()
    const text = (await post("{}", token(NEW))).body
    expect(text).toBe('{"provisioned":true}')
    expect(text).not.toContain(NEW)
  })
})

describe("the body cannot name, rebind or shape the account", () => {
  it.each([
    ['{"userId":"' + OTHER + '"}'],
    ['{"role":"super_admin"}'],
    ['{"parentProfileId":"' + OTHER + '"}'],
    ['{"subject":"' + OTHER + '"}'],
    ['{"referralCode":"CT0123456789AB"}'],
    ['{"balance":1000}'],
    ["[]"],
    ["null"],
  ])("signed body %s -> 400, nothing provisioned (the nonce is spent)", async (body) => {
    const fake = build()
    expect(await res2(await post(body, token(NEW, body)))).toEqual([400, { error: "invalid_request" }])
    expect(fake.provisionCalls()).toHaveLength(0)
  })

  it("any query string -> 400, nothing provisioned", async () => {
    const fake = build()
    for (const qs of ["?userId=" + OTHER, "?role=admin", "?x=1"]) {
      expect((await post("{}", token(NEW), PATH + qs)).statusCode).toBe(400)
    }
    expect(fake.provisionCalls()).toHaveLength(0)
  })

  it("forged identity headers are ignored: the assertion's subject is provisioned", async () => {
    const fake = build()
    await post("{}", token(NEW), PATH, { "x-user-id": OTHER, "x-role": "super_admin", "x-provider-subject": OTHER })
    expect(fake.provisionCalls().map((c) => c.values)).toEqual([[NEW]])
  })
})

describe("assertion attacks -> 401, nothing provisioned, nonce untouched", () => {
  it.each([
    ["no assertion", () => undefined, "{}"],
    ["tampered body (signed {}, sent another)", () => token(NEW, "{}"), '{"role":"admin"}'],
    ["cross-path (signed for /v1/parent/consent)", () => token(NEW, "{}", { path: "/v1/parent/consent" }), "{}"],
    ["wrong method (signed PATCH)", () => token(NEW, "{}", { method: "PATCH" }), "{}"],
    ["expired (signed 10 minutes ago)", () => token(NEW, "{}", { now: Date.now() - 600_000, authenticatedAt: Date.now() - DAY }), "{}"],
    ["forged secret", () => token(NEW, "{}", { secret: Buffer.from("48".repeat(32), "hex") }), "{}"],
    ["a v2 READ assertion", () => signAssertion({ identity: toVerifiedIdentity({ provider: "supabase", subject: NEW }), authenticatedAt: Date.now() - DAY, requestId: "provision-test-02", method: "GET", path: PATH, secret: SECRET }), "{}"],
  ])("%s", async (_label, makeToken, body) => {
    const fake = build()
    const r = await post(body, makeToken())
    expect(await res2(r)).toEqual([401, { error: "unauthenticated" }])
    expect(fake.provisionCalls()).toHaveLength(0)
    expect(fake.nonceCalls()).toHaveLength(0)
  })

  it("a session signed in over 30 days ago -> 401 session_expired (unlinked subject included)", async () => {
    const fake = build()
    expect(await res2(await post("{}", token(NEW, "{}", { authenticatedAt: Date.now() - 31 * DAY })))).toEqual([401, { error: "session_expired" }])
    expect(fake.provisionCalls()).toHaveLength(0)
  })

  it("a linked user signed in before sessions_not_before -> 401 session_invalidated", async () => {
    const fake = build({ linked: { sessionsNotBeforeMs: Date.now() - 1000 } })
    expect(await res2(await post("{}", token(LINKED)))).toEqual([401, { error: "session_invalidated" }])
    expect(fake.provisionCalls()).toHaveLength(0)
  })

  it("replay of the same assertion -> 409 replayed_request, provisioned once", async () => {
    const fake = build()
    const tok = token(NEW)
    expect((await post("{}", tok)).statusCode).toBe(200)
    expect(await res2(await post("{}", tok))).toEqual([409, { error: "replayed_request" }])
    expect(fake.provisionCalls()).toHaveLength(1)
  })
})

describe("account state and conflicts", () => {
  it.each([
    ["linked admin", { linked: { role: "admin" } }],
    ["linked super_admin", { linked: { role: "super_admin" } }],
    ["linked deleted parent", { linked: { deleted: true } }],
  ])("%s -> 403 forbidden in the preHandler, no nonce, nothing provisioned", async (_l, w) => {
    const fake = build(w as World)
    expect(await res2(await post("{}", token(LINKED)))).toEqual([403, { error: "forbidden" }])
    expect(fake.nonceCalls()).toHaveLength(0)
    expect(fake.provisionCalls()).toHaveLength(0)
  })

  it.each([["account_deleted"], ["not_parent"]])("function outcome %s -> 403 forbidden", async (outcome) => {
    build({ outcome })
    expect(await res2(await post("{}", token(NEW)))).toEqual([403, { error: "forbidden" }])
  })

  it("function outcome identity_conflict -> 409 identity_conflict, logged as an error", async () => {
    build({ outcome: "identity_conflict" })
    expect(await res2(await post("{}", token(NEW)))).toEqual([409, { error: "identity_conflict" }])
    expect(logs.find((l) => l.event === "PROVISION_REJECTED")).toMatchObject({ level: "error", reason: "identity_conflict" })
  })
})

describe("database failures -> 503, nothing leaks", () => {
  it.each([
    ["identity lookup", { identityDown: true }],
    ["nonce store", { nonceDown: true }],
    ["provisioning", { provisionDown: true }],
  ])("%s down -> 503 service_unavailable", async (_l, w) => {
    build(w)
    const r = await post("{}", token(NEW))
    expect(await res2(r)).toEqual([503, { error: "service_unavailable" }])
    expect(r.body).not.toMatch(/hunter2|terminating|57P01/)
    expect(JSON.stringify(logs)).not.toMatch(/hunter2|terminating/)
    expect(JSON.stringify(logs)).not.toContain(NEW)
  })
})
