import { describe, it, expect, afterEach } from "vitest"
import type { FastifyInstance } from "fastify"
import { buildBackendApp } from "@/backend/src/app"
import { signAssertion, signWriteAssertion } from "@/lib/identity/assertion"
import { toVerifiedIdentity } from "@/lib/identity/types"
import type { Queryable } from "@/lib/db/types"
import { setLogSink, type LogRecord } from "@/lib/observability/logger"

/**
 * V0.1.48 consent routes in-process with a fake database:
 * GET /v1/parent/consent (v2) and POST /v1/parent/consent (v3, nonce).
 * Caller from the assertion only, parent-only, exact body, version
 * separation, replay, error mapping and headers. Real PostgreSQL and the full
 * browser -> Next -> Fastify chain: consent-cutover-db.test.ts (opt-in).
 */

const SECRET = Buffer.from("46".repeat(32), "hex")
const SUBJECT = "6f1c2e7a-3b4d-4c5e-8f9a-0b1c2d3e4f51"
const USER = "11111111-2222-4333-8444-555555555556"
const OTHER = "99999999-2222-4333-8444-555555555556"
const PATH = "/v1/parent/consent"
const DAY = 86_400_000
const GRANTED_AT = new Date("2026-10-01T10:00:00.000Z")

interface World {
  role?: string
  deleted?: boolean
  profile?: boolean
  granted?: boolean
  readDown?: boolean
  writeDown?: boolean
  nonceDown?: boolean
}

function fakeDb(w: World = {}) {
  const calls: Array<{ text: string; values: readonly unknown[] }> = []
  const seen = new Set<string>()
  const state = { granted: w.granted ?? false, at: w.granted ? GRANTED_AT : null as Date | null }
  const db: Queryable = {
    async query(text: string, values: readonly unknown[] = []) {
      calls.push({ text, values })
      let rows: unknown[] = []
      const down = () => { throw Object.assign(new Error("terminating connection: password=hunter2"), { code: "57P01" }) }
      if (text.includes("user_identities")) {
        rows = values[1] === SUBJECT ? [{ user_id: USER, role: w.role ?? "parent", deleted: w.deleted ?? false, sessions_not_before_ms: null }] : []
      } else if (text.includes("consume_internal_write_nonce")) {
        if (w.nonceDown) down()
        const fresh = !seen.has(values[0] as string)
        seen.add(values[0] as string)
        rows = [{ consumed: fresh }]
      } else if (text.includes("record_parent_consent_trusted")) {
        if (w.writeDown) down()
        if (w.profile !== false && values[0] === USER) {
          if (!state.granted) { state.granted = true; state.at = new Date("2026-10-22T08:00:00.000Z") }
          rows = [{ consent_granted: state.granted, consent_granted_at: state.at }]
        }
      } else if (text.includes("FROM public.parent_profiles")) {
        if (w.readDown) down()
        rows = w.profile !== false && values[0] === USER ? [{ consent_granted: state.granted, consent_granted_at: state.at }] : []
      }
      return { rows, rowCount: rows.length, command: "SELECT", oid: 0, fields: [] } as never
    },
  }
  return { db, calls, state }
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

const ident = () => toVerifiedIdentity({ provider: "supabase", subject: SUBJECT })
const readToken = (over: { path?: string } = {}) =>
  signAssertion({ identity: ident(), authenticatedAt: Date.now() - DAY, requestId: "consent-read-0001", method: "GET", path: over.path ?? PATH, secret: SECRET })
const writeToken = (body: string, over: { path?: string; method?: string } = {}) =>
  signWriteAssertion({ identity: ident(), authenticatedAt: Date.now() - DAY, requestId: "consent-write-001", method: over.method ?? "POST", path: over.path ?? PATH, body, secret: SECRET })

const GRANT = '{"consentGranted":true}'
const get = (token?: string, url = PATH, headers: Record<string, string> = {}) =>
  app!.inject({ method: "GET", url, headers: { ...(token ? { "x-cartoona-internal-auth": token } : {}), ...headers } })
const post = (body: string, token?: string, url = PATH, headers: Record<string, string> = {}) =>
  app!.inject({ method: "POST", url, payload: body, headers: { "content-type": "application/json", ...(token ? { "x-cartoona-internal-auth": token } : {}), ...headers } })

describe("GET /v1/parent/consent (v2 read)", () => {
  it("returns exactly the two consent fields, no-store", async () => {
    build({ granted: true })
    const res = await get(readToken())
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ consentGranted: true, consentGrantedAt: GRANTED_AT.toISOString() })
    expect(res.headers["cache-control"]).toBe("no-store")
  })

  it("not consented -> false and null time", async () => {
    build()
    expect((await get(readToken())).json()).toEqual({ consentGranted: false, consentGrantedAt: null })
  })

  it("the profile is selected by principal.userId only; no profile -> 404", async () => {
    const { calls } = build({ profile: false })
    const res = await get(readToken())
    expect([res.statusCode, res.json()]).toEqual([404, { error: "parent_profile_not_found" }])
    const q = calls.find((c) => c.text.includes("parent_profiles"))!
    expect(q.values).toEqual([USER])
    expect(q.text).toMatch(/SELECT p\.consent_granted, p\.consent_granted_at\s+FROM public\.parent_profiles p\s+WHERE p\.user_id = \$1/)
  })

  it.each(["?userId=" + OTHER, "?parentProfileId=" + OTHER, "?x=1"])("any query parameter -> 400 (%s), nothing read", async (qs) => {
    const { calls } = build()
    const res = await get(readToken(), PATH + qs)
    expect([res.statusCode, res.json()]).toEqual([400, { error: "invalid_request" }])
    expect(calls.some((c) => c.text.includes("parent_profiles"))).toBe(false)
  })

  it("forged identity headers are ignored", async () => {
    const { calls } = build({ granted: true })
    const res = await get(readToken(), PATH, { "x-user-id": OTHER, "x-role": "super_admin", "x-parent-profile-id": OTHER })
    expect(res.statusCode).toBe(200)
    expect(calls.find((c) => c.text.includes("parent_profiles"))!.values).toEqual([USER])
  })

  it.each([
    ["admin", { role: "admin" }, 403, "forbidden"],
    ["super_admin", { role: "super_admin" }, 403, "forbidden"],
    ["deleted user", { deleted: true }, 403, "forbidden"],
  ] as const)("%s -> %i %s", async (_l, w, status, error) => {
    build(w)
    const res = await get(readToken())
    expect([res.statusCode, res.json()]).toEqual([status, { error }])
  })

  it("no assertion -> 401; a v3 (write) assertion on the read -> 401; wrong-path v2 -> 401", async () => {
    build({ granted: true })
    expect((await get()).statusCode).toBe(401)
    expect((await get(writeToken(""))).statusCode).toBe(401)
    expect((await get(readToken({ path: "/v1/parent/profile" }))).statusCode).toBe(401)
    expect((await get("v2.garbage.token")).statusCode).toBe(401)
  })

  it("database down -> 503 service_unavailable; no detail leaks", async () => {
    build({ readDown: true })
    const res = await get(readToken())
    expect([res.statusCode, res.json()]).toEqual([503, { error: "service_unavailable" }])
    expect(JSON.stringify(logs)).not.toContain("hunter2")
    expect(logs.some((l) => l.event === "CONSENT_READ_FAILED" && l.errorCode === "DATABASE_UNAVAILABLE")).toBe(true)
  })
})

describe("POST /v1/parent/consent (v3 write)", () => {
  it("grants through the trusted function with principal.userId only, returns the stored state", async () => {
    const { calls, state } = build()
    const res = await post(GRANT, writeToken(GRANT))
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ consentGranted: true, consentGrantedAt: "2026-10-22T08:00:00.000Z" })
    expect(res.headers["cache-control"]).toBe("no-store")
    expect(state.granted).toBe(true)
    const write = calls.filter((c) => c.text.includes("record_parent_consent_trusted"))
    expect(write).toHaveLength(1)
    expect(write[0].values).toEqual([USER])
    // Nonce consumed BEFORE the write.
    expect(calls.findIndex((c) => c.text.includes("consume_internal_write_nonce"))).toBeLessThan(calls.indexOf(write[0]))
  })

  it("granting again keeps the first grant's time", async () => {
    build({ granted: true })
    const res = await post(GRANT, writeToken(GRANT))
    expect(res.json()).toEqual({ consentGranted: true, consentGrantedAt: GRANTED_AT.toISOString() })
  })

  it("the same assertion twice -> 200 then 409 replayed_request; one write", async () => {
    const { calls } = build()
    const token = writeToken(GRANT)
    expect((await post(GRANT, token)).statusCode).toBe(200)
    const again = await post(GRANT, token)
    expect([again.statusCode, again.json()]).toEqual([409, { error: "replayed_request" }])
    expect(calls.filter((c) => c.text.includes("record_parent_consent_trusted"))).toHaveLength(1)
  })

  it.each([
    ["revocation", '{"consentGranted":false}'],
    ["a string", '{"consentGranted":"true"}'],
    ["a profile id in the body", `{"consentGranted":true,"parentProfileId":"${OTHER}"}`],
    ["a user id in the body", `{"consentGranted":true,"userId":"${OTHER}"}`],
    ["no key", "{}"],
    ["an array", "[true]"],
    ["null", "null"],
  ])("%s -> 400, nothing written", async (_l, body) => {
    const { calls } = build()
    const res = await post(body, writeToken(body))
    expect([res.statusCode, res.json()]).toEqual([400, { error: "invalid_request" }])
    expect(calls.some((c) => c.text.includes("record_parent_consent_trusted"))).toBe(false)
  })

  it("hostile query parameters -> 400, nothing written", async () => {
    const { calls } = build()
    const res = await post(GRANT, writeToken(GRANT), `${PATH}?userId=${OTHER}`)
    expect(res.statusCode).toBe(400)
    expect(calls.some((c) => c.text.includes("record_parent_consent_trusted"))).toBe(false)
  })

  it("forged identity headers are ignored: the write is still for principal.userId", async () => {
    const { calls } = build()
    const res = await post(GRANT, writeToken(GRANT), PATH, { "x-user-id": OTHER, "x-role": "super_admin", origin: "https://evil.example" })
    expect(res.statusCode).toBe(200)
    expect(calls.find((c) => c.text.includes("record_parent_consent_trusted"))!.values).toEqual([USER])
  })

  it("tampered body, wrong path, wrong method, v2 used on the write, no assertion -> 401; no nonce, no write", async () => {
    const { calls } = build()
    const v2 = signAssertion({ identity: ident(), authenticatedAt: Date.now() - DAY, requestId: "consent-v2-00001", method: "GET", path: PATH, secret: SECRET })
    for (const [sent, token] of [
      ['{"consentGranted":true }', writeToken(GRANT)],
      [GRANT, writeToken(GRANT, { path: "/v1/parent/profile" })],
      [GRANT, writeToken(GRANT, { method: "PATCH" })],
      [GRANT, v2],
      [GRANT, undefined],
      [GRANT, "v3.malformed"],
    ] as const) {
      expect((await post(sent, token)).statusCode).toBe(401)
    }
    expect(calls.some((c) => /consume_internal_write_nonce|record_parent_consent_trusted/.test(c.text))).toBe(false)
  })

  it.each([
    ["admin", { role: "admin" }],
    ["super_admin", { role: "super_admin" }],
    ["deleted user", { deleted: true }],
  ] as const)("%s -> 403 before the nonce; nothing written", async (_l, w) => {
    const { calls } = build(w)
    const res = await post(GRANT, writeToken(GRANT))
    expect([res.statusCode, res.json()]).toEqual([403, { error: "forbidden" }])
    expect(calls.some((c) => /consume_internal_write_nonce|record_parent_consent_trusted/.test(c.text))).toBe(false)
  })

  it("no profile -> 404, the nonce is spent, nothing written", async () => {
    const { state } = build({ profile: false })
    const res = await post(GRANT, writeToken(GRANT))
    expect([res.statusCode, res.json()]).toEqual([404, { error: "parent_profile_not_found" }])
    expect(state.granted).toBe(false)
  })

  it("database down at the write -> 503; at the nonce store -> 503 before the write", async () => {
    build({ writeDown: true })
    expect((await post(GRANT, writeToken(GRANT))).json()).toEqual({ error: "service_unavailable" })
    await app!.close()
    const { calls } = build({ nonceDown: true })
    expect((await post(GRANT, writeToken(GRANT))).statusCode).toBe(503)
    expect(calls.some((c) => c.text.includes("record_parent_consent_trusted"))).toBe(false)
    expect(JSON.stringify(logs)).not.toContain("hunter2")
  })

  it("text/plain or form bodies are not parsed (415), so they can never be signed-and-accepted", async () => {
    build()
    const res = await app!.inject({ method: "POST", url: PATH, payload: "consentGranted=true", headers: { "content-type": "application/x-www-form-urlencoded", "x-cartoona-internal-auth": writeToken("consentGranted=true") } })
    expect(res.statusCode).toBe(415)
  })
})
