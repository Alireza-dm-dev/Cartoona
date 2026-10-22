import { describe, it, expect, afterEach } from "vitest"
import type { FastifyInstance } from "fastify"
import { buildBackendApp } from "@/backend/src/app"
import { InternalAuthConfigError, signAssertion, signWriteAssertion } from "@/lib/identity/assertion"
import { toVerifiedIdentity } from "@/lib/identity/types"
import type { Queryable } from "@/lib/db/types"
import { setLogSink, type LogRecord } from "@/lib/observability/logger"

/**
 * V0.1.47 write security, in-process with a fake database:
 * requireWriteAuth (v3 only, body digest over the received bytes, identity,
 * session policy, role, then the nonce - last) and the proof write
 * PATCH /v1/parent/profile. Real PostgreSQL (nonce races, grants, the
 * restricted role, timeouts): write-security-db.test.ts (opt-in).
 */

const SECRET = Buffer.from("45".repeat(32), "hex")
const SUBJECT = "6f1c2e7a-3b4d-4c5e-8f9a-0b1c2d3e4f50"
const USER = "11111111-2222-4333-8444-555555555555"
const OTHER_USER = "99999999-2222-4333-8444-555555555555"
const DAY = 86_400_000
const PATH = "/v1/parent/profile"
const AUTH = "x-cartoona-internal-auth"

interface World {
  role?: string
  deleted?: boolean
  linked?: boolean
  profile?: boolean
  sessionsNotBeforeMs?: number | null
  nonceDown?: boolean
  writeDown?: boolean
}

function fakeDb(w: World = {}) {
  const calls: string[] = []
  const consumed = new Set<string>()
  const names = new Map<string, string | null>([[USER, "Old"], [OTHER_USER, "Other parent"]])
  const db: Queryable = {
    async query(text: string, values: readonly unknown[] = []) {
      let rows: unknown[] = []
      const down = () => { throw Object.assign(new Error("terminating connection: password=hunter2"), { code: "57P01" }) }
      if (text.includes("user_identities")) {
        calls.push("identity")
        rows = values[1] === SUBJECT && w.linked !== false
          ? [{ user_id: USER, role: w.role ?? "parent", deleted: w.deleted ?? false, sessions_not_before_ms: w.sessionsNotBeforeMs ?? null }]
          : []
      } else if (text.includes("consume_internal_write_nonce")) {
        calls.push("nonce")
        if (w.nonceDown) down()
        const fresh = !consumed.has(values[0] as string)
        consumed.add(values[0] as string)
        rows = [{ consumed: fresh }]
      } else if (text.includes("UPDATE public.parent_profiles")) {
        calls.push("update")
        if (w.writeDown) down()
        if (w.profile !== false && names.has(values[0] as string)) {
          names.set(values[0] as string, values[1] as string | null)
          rows = [{ full_name: values[1] }]
        }
      } else {
        calls.push("other")
      }
      return { rows, rowCount: rows.length, command: "SELECT", oid: 0, fields: [] } as never
    },
  }
  return { db, calls, consumed, names }
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

const NAME_BODY = '{"fullName":"  Parent   New "}'

const signWrite = (over: { body?: string; method?: string; path?: string; nonce?: string; authenticatedAt?: number; secret?: Buffer; now?: number } = {}) =>
  signWriteAssertion({
    identity: toVerifiedIdentity({ provider: "supabase", subject: SUBJECT }),
    authenticatedAt: over.authenticatedAt ?? Date.now() - DAY,
    requestId: "req-write-0000001",
    method: over.method ?? "PATCH",
    path: over.path ?? PATH,
    body: over.body ?? NAME_BODY,
    ...(over.nonce ? { nonce: over.nonce } : {}),
    secret: over.secret ?? SECRET,
    now: over.now,
  })

const patch = (body: string, headers: Record<string, string | string[]> = {}, url = PATH) =>
  app!.inject({ method: "PATCH", url, payload: body, headers: { "content-type": "application/json", ...headers } })

describe("happy path", () => {
  it("v3 + parent + fresh nonce -> 200 with the normalized stored name; nonce consumed last, then the UPDATE", async () => {
    const fake = build()
    const res = await patch(NAME_BODY, { [AUTH]: signWrite() })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ fullName: "Parent New" })
    expect(res.headers["cache-control"]).toBe("no-store")
    expect(fake.calls).toEqual(["identity", "nonce", "update"])
    expect(fake.names.get(USER)).toBe("Parent New")
    expect(fake.names.get(OTHER_USER)).toBe("Other parent")
  })

  it("null and whitespace clear the name", async () => {
    const fake = build()
    for (const body of ['{"fullName":null}', '{"fullName":"   "}']) {
      const res = await patch(body, { [AUTH]: signWrite({ body }) })
      expect([res.statusCode, res.json()]).toEqual([200, { fullName: null }])
    }
    expect(fake.names.get(USER)).toBeNull()
  })
})

describe("replay (5/19/21)", () => {
  it("the same assertion twice: 200 then 409 replayed_request, ONE write", async () => {
    const fake = build()
    const token = signWrite()
    expect((await patch(NAME_BODY, { [AUTH]: token })).statusCode).toBe(200)
    const again = await patch(NAME_BODY, { [AUTH]: token })
    expect([again.statusCode, again.json()]).toEqual([409, { error: "replayed_request" }])
    expect(again.headers["cache-control"]).toBe("no-store")
    expect(fake.calls.filter((c) => c === "update")).toHaveLength(1)
    expect(logs.find((l) => l.event === "AUTH_REJECTED" && l.errorCode === "NONCE_REPLAYED")).toBeTruthy()
  })

  it("a legitimate user retry (new assertion, new nonce, same value) succeeds and ends in the same state", async () => {
    const fake = build()
    expect((await patch(NAME_BODY, { [AUTH]: signWrite() })).statusCode).toBe(200)
    expect((await patch(NAME_BODY, { [AUTH]: signWrite() })).statusCode).toBe(200)
    expect(fake.names.get(USER)).toBe("Parent New")
  })

  it("a forged nonce (valid format, wrong MAC) never reaches the nonce store", async () => {
    const fake = build()
    const token = signWrite()
    const [v, payload] = token.split(".")
    const p = JSON.parse(Buffer.from(payload, "base64url").toString())
    p.nce = "Z".repeat(43)
    const forged = `${v}.${Buffer.from(JSON.stringify(p)).toString("base64url")}.${token.split(".")[2]}`
    expect((await patch(NAME_BODY, { [AUTH]: forged })).statusCode).toBe(401)
    expect(fake.calls).toEqual([])
  })
})

describe("401 before any state change (the nonce stays unused)", () => {
  it.each([
    ["missing assertion", () => ({})],
    ["garbage", () => ({ [AUTH]: "v3.nope.nope" })],
    ["a v2 read assertion", () => ({ [AUTH]: signAssertion({ identity: toVerifiedIdentity({ provider: "supabase", subject: SUBJECT }), authenticatedAt: Date.now() - DAY, requestId: "req-write-0000001", method: "GET", path: PATH, secret: SECRET }) })],
    ["wrong secret", () => ({ [AUTH]: signWrite({ secret: Buffer.from("46".repeat(32), "hex") }) })],
    ["expired", () => ({ [AUTH]: signWrite({ now: Date.now() - 120_000, authenticatedAt: Date.now() - DAY - 120_000 }) })],
    ["signed for another path", () => ({ [AUTH]: signWrite({ path: "/v1/parent/orders" }) })],
    ["signed for another method", () => ({ [AUTH]: signWrite({ method: "POST" }) })],
    ["signed for another body", () => ({ [AUTH]: signWrite({ body: '{"fullName":"Someone Else"}' }) })],
    ["two assertion headers", () => ({ [AUTH]: [signWrite(), signWrite()] })],
  ])("%s -> 401 unauthenticated, no database call", async (_label, headers) => {
    const fake = build()
    const res = await patch(NAME_BODY, headers())
    expect([res.statusCode, res.json()]).toEqual([401, { error: "unauthenticated" }])
    expect(fake.calls).toEqual([])
    expect(fake.names.get(USER)).toBe("Old")
  })

  it("body modified in transit (same assertion, different bytes) -> 401 body_mismatch", async () => {
    build()
    const res = await patch('{"fullName":"Tampered"}', { [AUTH]: signWrite() })
    expect(res.statusCode).toBe(401)
    expect(logs.find((l) => l.event === "AUTH_REJECTED")).toMatchObject({ reason: "body_mismatch" })
  })

  it("re-serialized but equal JSON (whitespace) is a different body -> 401", async () => {
    build()
    expect((await patch('{ "fullName": "  Parent   New " }', { [AUTH]: signWrite() })).statusCode).toBe(401)
  })
})

describe("identity, session and role (nonce still unused)", () => {
  it.each([
    ["identity not linked", { linked: false }, 403, "identity_not_linked"],
    ["deleted account", { deleted: true }, 403, "forbidden"],
    ["admin", { role: "admin" }, 403, "forbidden"],
    ["super_admin", { role: "super_admin" }, 403, "forbidden"],
    ["sessions_not_before after sign-in", { sessionsNotBeforeMs: Date.now() - 1000 }, 401, "session_invalidated"],
  ] as const)("%s -> %i %s; no nonce consumed, no write", async (_label, world, status, error) => {
    const fake = build(world)
    const res = await patch(NAME_BODY, { [AUTH]: signWrite() })
    expect([res.statusCode, res.json()]).toEqual([status, { error }])
    expect(fake.calls).toEqual(["identity"])
  })

  it("session older than 30 days -> 401 session_expired", async () => {
    const fake = build()
    const res = await patch(NAME_BODY, { [AUTH]: signWrite({ authenticatedAt: Date.now() - 31 * DAY }) })
    expect([res.statusCode, res.json()]).toEqual([401, { error: "session_expired" }])
    expect(fake.calls).toEqual(["identity"])
  })
})

describe("forged caller identity is ignored or refused (8/21)", () => {
  it("X-User-Id / X-Role / X-Parent-Profile-Id headers change nothing", async () => {
    const fake = build()
    const res = await patch(NAME_BODY, { [AUTH]: signWrite(), "x-user-id": OTHER_USER, "x-role": "super_admin", "x-parent-profile-id": OTHER_USER })
    expect(res.statusCode).toBe(200)
    expect(fake.names.get(OTHER_USER)).toBe("Other parent")
    expect(fake.names.get(USER)).toBe("Parent New")
  })

  it.each([
    ['{"fullName":"X","parentProfileId":"99999999-2222-4333-8444-555555555555"}'],
    ['{"fullName":"X","userId":"99999999-2222-4333-8444-555555555555"}'],
    ['{"parentProfileId":"99999999-2222-4333-8444-555555555555"}'],
    ["{}"],
    ['["fullName"]'],
    ['"Parent"'],
  ])("body %s -> 400 invalid_request, no write", async (body) => {
    const fake = build()
    const res = await patch(body, { [AUTH]: signWrite({ body }) })
    expect([res.statusCode, res.json()]).toEqual([400, { error: "invalid_request" }])
    expect(fake.calls).not.toContain("update")
    expect(fake.names.get(OTHER_USER)).toBe("Other parent")
  })

  it("any query string -> 400 (and the assertion binds the path without it)", async () => {
    const fake = build()
    const res = await patch(NAME_BODY, { [AUTH]: signWrite() }, `${PATH}?userId=${OTHER_USER}`)
    expect(res.statusCode).toBe(400)
    expect(fake.calls).not.toContain("update")
  })
})

describe("input validation (18)", () => {
  it.each([
    ["a number", "42"],
    ["no letter", '"12345"'],
    ["61 characters", JSON.stringify("ا".repeat(61))],
    ["a zero-width joiner", JSON.stringify("Pa‍rent")],
    ["a bidi override", JSON.stringify("Pa‮rent")],
    ["a huge string", JSON.stringify("a".repeat(5000))],
  ])("%s -> 400", async (_label, value) => {
    build()
    const body = `{"fullName":${value}}`
    expect((await patch(body, { [AUTH]: signWrite({ body }) })).statusCode).toBe(400)
  })

  it("Persian names, 60 characters exactly, NFC normalization", async () => {
    build()
    for (const [input, stored] of [["سارا محمدی", "سارا محمدی"], ["ا".repeat(60), "ا".repeat(60)], ["René", "René"]]) {
      const body = JSON.stringify({ fullName: input })
      const res = await patch(body, { [AUTH]: signWrite({ body }) })
      expect([res.statusCode, res.json()]).toEqual([200, { fullName: stored }])
    }
  })

  it("malformed JSON / non-JSON content types never reach the handler", async () => {
    build()
    expect((await patch("{not json", { [AUTH]: signWrite({ body: "{not json" }) })).statusCode).toBe(400)
    const text = await app!.inject({ method: "PATCH", url: PATH, payload: "fullName=x", headers: { "content-type": "application/x-www-form-urlencoded", [AUTH]: signWrite({ body: "fullName=x" }) } })
    expect(text.statusCode).toBe(415)
    const proto = '{"fullName":"x","__proto__":{"admin":true}}'
    expect((await patch(proto, { [AUTH]: signWrite({ body: proto }) })).statusCode).toBe(400)
  })
})

describe("failures (11)", () => {
  it("no profile -> 404, nothing written", async () => {
    build({ profile: false })
    const res = await patch(NAME_BODY, { [AUTH]: signWrite() })
    expect([res.statusCode, res.json()]).toEqual([404, { error: "parent_profile_not_found" }])
  })

  it("nonce store down -> 503, no write; the raw DB message never leaks", async () => {
    const fake = build({ nonceDown: true })
    const res = await patch(NAME_BODY, { [AUTH]: signWrite() })
    expect([res.statusCode, res.json()]).toEqual([503, { error: "service_unavailable" }])
    expect(fake.calls).not.toContain("update")
    expect(JSON.stringify(logs)).not.toMatch(/hunter2|terminating/)
  })

  it("write fails -> 503 service_unavailable; the nonce stays consumed (a retry needs a new assertion)", async () => {
    const fake = build({ writeDown: true })
    const token = signWrite()
    expect((await patch(NAME_BODY, { [AUTH]: token })).statusCode).toBe(503)
    expect(fake.consumed.size).toBe(1)
    expect((await patch(NAME_BODY, { [AUTH]: token })).statusCode).toBe(409)
    expect(JSON.stringify(logs)).not.toMatch(/hunter2|terminating/)
  })

  it("the secret missing -> 503, nothing read", async () => {
    const fake = fakeDb()
    app = buildBackendApp({ db: () => fake.db, closeDb: async () => {}, authSecret: () => { throw new InternalAuthConfigError("x") } })
    const res = await patch(NAME_BODY, { [AUTH]: signWrite() })
    expect(res.statusCode).toBe(503)
    expect(fake.calls).toEqual([])
  })
})

describe("reads are unchanged and cannot consume a nonce (27)", () => {
  it("a v3 write assertion on GET /v1/parent/profile -> 401, no nonce", async () => {
    const fake = build()
    const res = await app!.inject({ method: "GET", url: PATH, headers: { [AUTH]: signWrite() } })
    expect(res.statusCode).toBe(401)
    expect(fake.calls).toEqual([])
  })

  it("GET with a v2 assertion still works and never touches the nonce store", async () => {
    const fake = build()
    const token = signAssertion({ identity: toVerifiedIdentity({ provider: "supabase", subject: SUBJECT }), authenticatedAt: Date.now() - DAY, requestId: "req-write-0000001", method: "GET", path: PATH, secret: SECRET })
    await app!.inject({ method: "GET", url: PATH, headers: { [AUTH]: token } })
    expect(fake.calls).not.toContain("nonce")
  })

  it("no assertion/secret/nonce in any log line", async () => {
    build()
    const token = signWrite()
    await patch(NAME_BODY, { [AUTH]: token })
    await patch(NAME_BODY, { [AUTH]: token })
    const text = JSON.stringify(logs)
    expect(text).not.toContain(token.split(".")[1])
    expect(text).not.toContain(JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()).nce)
    expect(text).not.toContain(SUBJECT)
    expect(text).not.toContain(USER)
  })
})
