import { describe, it, expect, vi, beforeEach } from "vitest"

const m = vi.hoisted(() => ({
  verify: vi.fn(),
  write: vi.fn(),
  read: vi.fn(),
  endSession: vi.fn(async () => {}),
}))

vi.mock("@/lib/auth/supabase-identity-adapter", () => ({ verifySupabaseIdentity: m.verify }))
vi.mock("@/lib/auth/end-parent-session", () => ({ endParentSession: m.endSession }))
vi.mock("@/lib/backend/client", () => ({ backendGetJson: m.read, backendWriteJson: m.write }))

import { BackendClientError } from "@/lib/backend/errors"
import { GET, POST } from "@/app/api/parent-consent/route"
import { grantParentConsent, fetchParentConsent } from "@/lib/parent/consent/backend-consent"
import { parseBackendConsent } from "@/lib/parent/consent/consent-response"
import { setLogSink, type LogRecord } from "@/lib/observability/logger"

/**
 * V0.1.48 Next consent route + the shared consent loader, with the identity
 * provider and the backend client mocked. The mocked client still runs the
 * REAL response parser the loader passes it, so contract checks are real.
 * End to end on real services: consent-cutover-db.test.ts (opt-in).
 */

const CONTEXT = { identity: { provider: "supabase", subject: "6f1c2e7a-3b4d-4c5e-8f9a-0b1c2d3e4f52" }, authenticatedAt: Date.now() - 3_600_000 }
const AT = "2026-10-22T08:00:00.000Z"
const ORIGIN = "http://localhost:3000"

type Answer = { status: number; json: unknown } | BackendClientError

/** Feed answers to the mocked client; each call runs the caller's own parse(). */
function answer(fn: typeof m.write, ...answers: Answer[]) {
  for (const a of answers) {
    fn.mockImplementationOnce(async (req: { parse: (j: unknown, s: number) => unknown }) => {
      if (a instanceof BackendClientError) throw a
      let data
      try {
        data = req.parse(a.json, a.status)
      } catch {
        throw new BackendClientError("invalid_response", a.status, fn === m.write)
      }
      return { status: a.status, data, backendRequestId: null, durationMs: 1 }
    })
  }
}

const post = (body: string, headers: Record<string, string> = {}) =>
  POST(new Request(`${ORIGIN}/api/parent-consent`, {
    method: "POST",
    body,
    headers: { "content-type": "application/json", origin: ORIGIN, "sec-fetch-site": "same-origin", ...headers },
  }))
const GRANT = '{"consentGranted":true}'

let logs: LogRecord[] = []
beforeEach(() => {
  m.verify.mockReset().mockResolvedValue({ ok: true, context: CONTEXT })
  m.write.mockReset()
  m.read.mockReset()
  m.endSession.mockClear()
  logs = []
  setLogSink((r) => logs.push(r))
})

describe("POST /api/parent-consent: CSRF runs first", () => {
  it.each([
    ["hostile Origin", { origin: "https://evil.example" }, 403],
    ["missing Origin", { origin: "" }, 403],
    ["cross-site fetch", { "sec-fetch-site": "cross-site" }, 403],
    ["form post", { "content-type": "application/x-www-form-urlencoded" }, 415],
    ["text/plain", { "content-type": "text/plain" }, 415],
  ])("%s -> %i before any provider or backend call", async (_l, headers, status) => {
    const h: Record<string, string> = { ...headers }
    const res = await POST(new Request(`${ORIGIN}/api/parent-consent`, {
      method: "POST",
      body: GRANT,
      headers: Object.fromEntries(Object.entries({ "content-type": "application/json", origin: ORIGIN, "sec-fetch-site": "same-origin", ...h }).filter(([, v]) => v !== "")),
    }))
    expect(res.status).toBe(status)
    expect(m.verify).not.toHaveBeenCalled()
    expect(m.write).not.toHaveBeenCalled()
  })

  it("application/json; charset=utf-8 is accepted", async () => {
    answer(m.write, { status: 200, json: { consentGranted: true, consentGrantedAt: AT } })
    expect((await post(GRANT, { "content-type": "application/json; charset=utf-8" })).status).toBe(200)
  })
})

describe("POST /api/parent-consent: the write", () => {
  it("one v3 write: constant method/path, body exactly { consentGranted: true }, the verified context; stored time returned", async () => {
    answer(m.write, { status: 200, json: { consentGranted: true, consentGrantedAt: AT } })
    const res = await post(GRANT)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, consentGranted: true, consentGrantedAt: AT })
    expect(res.headers.get("cache-control")).toBe("no-store")
    expect(m.write).toHaveBeenCalledTimes(1)
    const call = m.write.mock.calls[0][0]
    expect([call.method, call.path, call.body, call.auth]).toEqual(["POST", "/v1/parent/consent", { consentGranted: true }, CONTEXT])
    expect(m.read).not.toHaveBeenCalled()
  })

  it.each([
    ["a user id", `{"consentGranted":true,"userId":"x"}`, 422],
    ["a profile id", `{"consentGranted":true,"parentProfileId":"x"}`, 422],
    ["revocation", `{"consentGranted":false}`, 422],
    ["a string", `{"consentGranted":"yes"}`, 422],
    ["malformed JSON", `{"consentGranted":`, 400],
    ["an array", `[true]`, 400],
    ["an oversized body", JSON.stringify({ consentGranted: true, pad: "x".repeat(2000) }), 413],
  ])("%s in the browser body -> %i, nothing sent to the backend", async (_l, body, status) => {
    expect((await post(body)).status).toBe(status)
    expect(m.write).not.toHaveBeenCalled()
  })

  it("no parent profile -> 403 no_parent_profile (V0.1.48 no longer creates one)", async () => {
    answer(m.write, { status: 404, json: { error: "parent_profile_not_found" } })
    const res = await post(GRANT)
    expect([res.status, (await res.json()).code]).toEqual([403, "no_parent_profile"])
  })

  it.each([
    ["session_expired", 401, "session_expired"],
    ["session_invalidated", 401, "session_invalidated"],
  ])("backend %s -> 401 PARENT_SESSION_EXPIRED with a local sign-out", async (_l, status, error) => {
    answer(m.write, { status, json: { error } })
    const res = await post(GRANT)
    expect([res.status, (await res.json()).code]).toEqual([401, "PARENT_SESSION_EXPIRED"])
    expect(m.endSession).toHaveBeenCalledTimes(1)
  })

  it.each([["identity_not_linked"], ["forbidden"]])("backend 403 %s -> 403, no sign-out", async (error) => {
    answer(m.write, { status: 403, json: { error } })
    const res = await post(GRANT)
    expect([res.status, (await res.json()).code]).toEqual([403, error])
    expect(m.endSession).not.toHaveBeenCalled()
  })

  it("provider down -> 503 SESSION_CHECK_UNAVAILABLE; no backend call, no sign-out", async () => {
    m.verify.mockResolvedValue({ ok: false, reason: "auth_unavailable" })
    const res = await post(GRANT)
    expect([res.status, (await res.json()).code]).toEqual([503, "SESSION_CHECK_UNAVAILABLE"])
    expect(m.write).not.toHaveBeenCalled()
    expect(m.endSession).not.toHaveBeenCalled()
  })

  it("signed out -> 401 unauthenticated", async () => {
    m.verify.mockResolvedValue({ ok: false, reason: "no_session" })
    expect((await (await post(GRANT)).json()).code).toBe("unauthenticated")
  })

  it("backend not configured (never sent) -> 503 service_unavailable: definitely not written, no re-read", async () => {
    answer(m.write, new BackendClientError("not_configured", null, false))
    const res = await post(GRANT)
    expect([res.status, (await res.json()).code]).toEqual([503, "service_unavailable"])
    expect(m.read).not.toHaveBeenCalled()
  })
})

describe("outcomeUnknown (19)", () => {
  const uncertain = [
    ["timeout", new BackendClientError("timeout", null, true)],
    ["connection reset", new BackendClientError("unavailable", null, true)],
    ["backend 503 (database down after the nonce)", new BackendClientError("bad_status", 503, true)],
    ["unreadable 2xx", { status: 200, json: { consentGranted: "yes" } }],
    ["409: its own nonce was already consumed", { status: 409, json: { error: "replayed_request" } }],
  ] as const

  it.each(uncertain)("%s, then a fresh read finds consent granted -> 200 success (no replay)", async (_l, first) => {
    answer(m.write, first as Answer)
    answer(m.read, { status: 200, json: { consentGranted: true, consentGrantedAt: AT } })
    const res = await post(GRANT)
    expect([res.status, await res.json()]).toEqual([200, { success: true, consentGranted: true, consentGrantedAt: AT }])
    expect(m.write).toHaveBeenCalledTimes(1)
    expect(m.read).toHaveBeenCalledTimes(1)
    expect(m.read.mock.calls[0][0].path).toBe("/v1/parent/consent")
    expect(logs.some((l) => l.event === "CONSENT_CONFIRMED_AFTER_UNCERTAIN_WRITE")).toBe(true)
  })

  it.each([
    ["the read says not granted", { status: 200, json: { consentGranted: false, consentGrantedAt: null } }],
    ["the read fails too", new BackendClientError("unavailable", null, false)],
    ["the read says no profile", { status: 404, json: { error: "parent_profile_not_found" } }],
  ] as const)("timeout, then %s -> 503 consent_outcome_unknown (never 'failed'), no sign-out, no replay", async (_l, readAnswer) => {
    answer(m.write, new BackendClientError("timeout", null, true))
    answer(m.read, readAnswer as Answer)
    const res = await post(GRANT)
    const body = await res.json()
    expect([res.status, body.code]).toEqual([503, "consent_outcome_unknown"])
    expect(body.error).toMatch(/نتوانستیم تأیید کنیم/)
    expect(body.error).not.toMatch(/انجام نشد/)
    expect(m.write).toHaveBeenCalledTimes(1)
    expect(m.endSession).not.toHaveBeenCalled()
    expect(logs.find((l) => l.event === "CONSENT_OUTCOME_UNKNOWN")?.outcomeUnknown).toBe(true)
  })

  it("a user retry after an unknown outcome is a NEW write call (new nonce is signed inside the client)", async () => {
    answer(m.write, new BackendClientError("timeout", null, true), { status: 200, json: { consentGranted: true, consentGrantedAt: AT } })
    answer(m.read, { status: 200, json: { consentGranted: false, consentGrantedAt: null } })
    expect((await post(GRANT)).status).toBe(503)
    expect((await post(GRANT)).status).toBe(200)
    expect(m.write).toHaveBeenCalledTimes(2)
  })
})

describe("GET /api/parent-consent", () => {
  it.each([
    [{ consentGranted: true, consentGrantedAt: AT }, 200, true],
    [{ consentGranted: false, consentGrantedAt: null }, 200, false],
  ])("returns only the flag", async (json, status, granted) => {
    answer(m.read, { status, json })
    const res = await GET(new Request(`${ORIGIN}/api/parent-consent`))
    expect([res.status, await res.json()]).toEqual([200, { consentGranted: granted }])
  })

  it("a parent without a profile reads false (as before V0.1.48)", async () => {
    answer(m.read, { status: 404, json: { error: "parent_profile_not_found" } })
    expect(await (await GET(new Request(`${ORIGIN}/api/parent-consent`))).json()).toEqual({ consentGranted: false })
  })

  it("could not determine -> 503 service_unavailable, NOT false; no sign-out", async () => {
    answer(m.read, new BackendClientError("timeout"))
    const res = await GET(new Request(`${ORIGIN}/api/parent-consent`))
    expect([res.status, (await res.json()).code]).toEqual([503, "service_unavailable"])
    expect(m.endSession).not.toHaveBeenCalled()
  })

  it("is not CSRF-guarded (no side effect): a cross-site GET just reads", async () => {
    answer(m.read, { status: 200, json: { consentGranted: true, consentGrantedAt: AT } })
    const res = await GET(new Request(`${ORIGIN}/api/parent-consent`, { headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site" } }))
    expect(res.status).toBe(200)
  })
})

describe("the loader and parser", () => {
  it("fetchParentConsent distinguishes not granted, no profile and could-not-determine", async () => {
    answer(m.read, { status: 200, json: { consentGranted: false, consentGrantedAt: null } })
    expect(await fetchParentConsent(CONTEXT as never)).toEqual({ ok: true, status: "not_granted", consentGrantedAt: null })
    answer(m.read, { status: 404, json: { error: "parent_profile_not_found" } })
    expect(await fetchParentConsent(CONTEXT as never)).toEqual({ ok: true, status: "no_profile", consentGrantedAt: null })
    answer(m.read, new BackendClientError("bad_status", 503))
    expect(await fetchParentConsent(CONTEXT as never)).toEqual({ ok: false, reason: "service_unavailable" })
  })

  it("a backend 401 unauthenticated (our assertion rejected) is an outage, not the visitor's session", async () => {
    answer(m.read, { status: 401, json: { error: "unauthenticated" } })
    expect(await fetchParentConsent(CONTEXT as never)).toEqual({ ok: false, reason: "service_unavailable" })
  })

  it("grantParentConsent sends no identity of its own: only the verified context", async () => {
    answer(m.write, { status: 200, json: { consentGranted: true, consentGrantedAt: AT } })
    await grantParentConsent(CONTEXT as never)
    expect(Object.keys(m.write.mock.calls[0][0].body)).toEqual(["consentGranted"])
  })

  it.each([
    [{ consentGranted: true, consentGrantedAt: AT, userId: "x" }, { consentGranted: true, consentGrantedAt: AT }],
  ])("the parser drops extra fields", (json, expected) => {
    expect(parseBackendConsent(json, 200)).toEqual({ kind: "value", value: expected })
  })

  it.each([
    [{ consentGranted: 1, consentGrantedAt: null }, 200],
    [{ consentGranted: true, consentGrantedAt: "yesterday" }, 200],
    [{ error: "something_else" }, 403],
    [{ error: "replayed_request" }, 401],
    [{}, 500],
  ])("the parser refuses %j (%i)", (json, status) => {
    expect(() => parseBackendConsent(json, status)).toThrow()
  })
})
