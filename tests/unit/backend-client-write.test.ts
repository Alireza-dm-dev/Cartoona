import { describe, it, expect, afterEach } from "vitest"
import { backendWriteJson, backendGetJson } from "@/lib/backend/client"
import { BackendClientError } from "@/lib/backend/errors"
import { bodyDigest, verifyAssertion } from "@/lib/identity/assertion"
import { toVerifiedIdentity } from "@/lib/identity/types"
import { setLogSink, type LogRecord } from "@/lib/observability/logger"

/**
 * V0.1.47 backendWriteJson: the Next server's ONLY way to send a write to
 * Fastify. One fetch, never retried; a v3 assertion signed over the exact
 * bytes sent, with a fresh nonce; uncertain outcomes flagged. fetch is injected.
 */

const SECRET_HEX = "ab".repeat(32)
const ENV = { BACKEND_INTERNAL_URL: "http://backend:4000", BACKEND_REQUEST_TIMEOUT_MS: "250", CARTOONA_INTERNAL_AUTH_SECRET: SECRET_HEX }
const SUBJECT = "6f1c2e7a-3b4d-4c5e-8f9a-0b1c2d3e4f50"
const AUTH = { identity: toVerifiedIdentity({ provider: "supabase", subject: SUBJECT }), authenticatedAt: Date.now() - 86_400_000 }
const RID = "abcd1234-ef56-4789-9abc-def012345678"

interface Seen { url: string; method: string; headers: Record<string, string>; body: Uint8Array | null }

function recorder(answer: (seen: Seen, signal: AbortSignal | null | undefined) => Promise<Response>) {
  const calls: Seen[] = []
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const seen: Seen = { url, method: init.method ?? "GET", headers: init.headers as Record<string, string>, body: (init.body as Uint8Array) ?? null }
    calls.push(seen)
    return answer(seen, init.signal)
  }) as unknown as typeof fetch
  return { calls, fetchImpl }
}

const ok = (body: unknown) => async () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })
const parse = (json: unknown) => json as { fullName: string | null }

const write = (fetchImpl: typeof fetch, over: Partial<Parameters<typeof backendWriteJson>[0]> = {}) =>
  backendWriteJson(
    { operation: "parent_profile_update", method: "PATCH", path: "/v1/parent/profile", body: { fullName: "Parent A" }, requestId: RID, parse, auth: AUTH, ...over },
    { env: ENV, fetchImpl },
  )

let logs: LogRecord[] = []
let restore: (() => void) | null = null
afterEach(() => restore?.())
function capture() {
  logs = []
  restore = setLogSink((r) => logs.push(r))
}

async function thrown(p: Promise<unknown>): Promise<BackendClientError> {
  const e = await p.then(() => null, (x: unknown) => x)
  expect(e).toBeInstanceOf(BackendClientError)
  return e as BackendClientError
}

describe("what is sent", () => {
  it("one PATCH with the JSON bytes, content-type, request id and a v3 assertion bound to those exact bytes", async () => {
    const { calls, fetchImpl } = recorder(ok({ fullName: "Parent A" }))
    const res = await write(fetchImpl)
    expect(res.data).toEqual({ fullName: "Parent A" })
    expect(calls).toHaveLength(1)
    const [c] = calls
    expect([c.url, c.method]).toEqual(["http://backend:4000/v1/parent/profile", "PATCH"])
    expect(c.headers["content-type"]).toBe("application/json")
    expect(c.headers["X-Request-Id"] ?? c.headers["x-request-id"]).toBe(RID)
    const token = c.headers["X-Cartoona-Internal-Auth"]
    expect(token.startsWith("v3.")).toBe(true)
    expect(new TextDecoder().decode(c.body!)).toBe('{"fullName":"Parent A"}')
    const verified = verifyAssertion({ token, secret: Buffer.from(SECRET_HEX, "hex"), method: "PATCH", path: "/v1/parent/profile", kind: "write", body: c.body! })
    expect(verified.ok).toBe(true)
    expect(verified.ok && verified.claims.bodyDigest).toBe(bodyDigest(c.body!))
    expect(verified.ok && verified.claims.requestId).toBe(RID)
  })

  it("every call gets a new nonce", async () => {
    const { calls, fetchImpl } = recorder(ok({ fullName: "Parent A" }))
    await write(fetchImpl)
    await write(fetchImpl)
    const nonce = (t: string) => JSON.parse(Buffer.from(t.split(".")[1], "base64url").toString()).nce
    expect(nonce(calls[0].headers["X-Cartoona-Internal-Auth"])).not.toBe(nonce(calls[1].headers["X-Cartoona-Internal-Auth"]))
  })

  it("reads still sign v2 and send no body", async () => {
    const { calls, fetchImpl } = recorder(ok({ fullName: "x" }))
    await backendGetJson({ operation: "p", path: "/v1/parent/profile", parse, auth: AUTH }, { env: ENV, fetchImpl })
    expect(calls[0].method).toBe("GET")
    expect(calls[0].body).toBeNull()
    expect(calls[0].headers["X-Cartoona-Internal-Auth"].startsWith("v2.")).toBe(true)
  })

  it("refuses GET/unknown methods, unsafe paths, unauthenticated writes and unserializable bodies before any fetch", async () => {
    const { calls, fetchImpl } = recorder(ok({}))
    await expect(write(fetchImpl, { method: "GET" as never })).rejects.toThrow(TypeError)
    await expect(write(fetchImpl, { method: "TRACE" as never })).rejects.toThrow(TypeError)
    await expect(write(fetchImpl, { path: "/v1/parent/profile?x=1" })).rejects.toThrow(TypeError)
    await expect(write(fetchImpl, { path: "/v1/../admin" })).rejects.toThrow(TypeError)
    await expect(write(fetchImpl, { auth: undefined as never })).rejects.toThrow(TypeError)
    await expect(write(fetchImpl, { body: undefined })).rejects.toThrow(TypeError)
    expect(calls).toHaveLength(0)
  })
})

describe("no retry; uncertain outcomes (9/22)", () => {
  it("timeout: exactly one attempt, within the bound, kind timeout, outcomeUnknown", async () => {
    capture()
    const { calls, fetchImpl } = recorder((_s, signal) => new Promise((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(signal.reason))
    }))
    const started = Date.now()
    const e = await thrown(write(fetchImpl))
    expect(Date.now() - started).toBeLessThan(1500)
    expect([e.kind, e.outcomeUnknown]).toEqual(["timeout", true])
    expect(calls).toHaveLength(1)
    expect(logs.find((l) => l.event === "BACKEND_TIMEOUT")).toMatchObject({ outcomeUnknown: true })
  })

  it.each([
    ["connection failure", async () => { throw new TypeError("fetch failed") }, "unavailable", true],
    ["500", async () => new Response("{}", { status: 500 }), "bad_status", true],
    ["503", async () => new Response("{}", { status: 503 }), "bad_status", true],
    ["unreadable 200", async () => new Response("not json", { status: 200 }), "invalid_response", true],
    ["409 not accepted", async () => new Response("{}", { status: 409 }), "bad_status", false],
  ] as const)("%s -> one attempt, %s, outcomeUnknown=%s", async (_label, answer, kind, unknown) => {
    const { calls, fetchImpl } = recorder(answer)
    const e = await thrown(write(fetchImpl))
    expect([e.kind, e.outcomeUnknown]).toEqual([kind, unknown])
    expect(calls).toHaveLength(1)
  })

  it("not configured: nothing sent, outcome known", async () => {
    const { calls, fetchImpl } = recorder(ok({}))
    const e = await thrown(backendWriteJson({ operation: "x", method: "PATCH", path: "/v1/parent/profile", body: {}, parse, auth: AUTH }, { env: {}, fetchImpl }))
    expect([e.kind, e.outcomeUnknown]).toEqual(["not_configured", false])
    expect(calls).toHaveLength(0)
  })

  it("accepted statuses (e.g. 409 replay, 401) return their body instead of throwing", async () => {
    const { fetchImpl } = recorder(async () => new Response('{"error":"replayed_request"}', { status: 409 }))
    const res = await write(fetchImpl, { acceptStatuses: [409], parse: (j) => j as never })
    expect([res.status, res.data]).toEqual([409, { error: "replayed_request" }])
  })

  it("reads never report outcomeUnknown", async () => {
    const { fetchImpl } = recorder(async () => new Response("{}", { status: 500 }))
    const e = await thrown(backendGetJson({ operation: "p", path: "/v1/parent/profile", parse, auth: AUTH }, { env: ENV, fetchImpl }))
    expect(e.outcomeUnknown).toBe(false)
  })

  it("logs carry no assertion, body, nonce or secret", async () => {
    capture()
    const { calls, fetchImpl } = recorder(async () => new Response("{}", { status: 500 }))
    await thrown(write(fetchImpl))
    const text = JSON.stringify(logs)
    const token = calls[0].headers["X-Cartoona-Internal-Auth"]
    expect(text).not.toContain(token.split(".")[1])
    expect(text).not.toContain("Parent A")
    expect(text).not.toContain(SECRET_HEX)
    expect(text).not.toContain("backend:4000")
  })
})
