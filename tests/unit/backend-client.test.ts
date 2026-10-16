import { describe, it, expect, vi, afterEach } from "vitest"
import { backendGetJson, BACKEND_MAX_BODY_CHARS } from "@/lib/backend/client"
import { BackendClientError } from "@/lib/backend/errors"
import { readBackendClientConfig, BackendConfigError } from "@/lib/backend/config"
import { setLogSink, type LogRecord } from "@/lib/observability/logger"

/**
 * The server-to-server backend client: URL safety, the single bounded attempt,
 * request-id propagation, safe errors and safe logs. fetch is always injected.
 */

const BASE = "http://backend:4000"
const INTERNAL_HOST = "internal-backend.corp.example"
const SECRET = "Bearer-Secret-Token-8841"
const ENV = { BACKEND_INTERNAL_URL: BASE }
const GOOD_ID = "abcd1234-ef56-4789-9abc-def012345678"

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init })

const parse = (value: unknown) => value as { ok: boolean }

let logs: LogRecord[] = []
let restore: (() => void) | null = null
function capture() {
  logs = []
  restore = setLogSink((r) => logs.push(r))
}
afterEach(() => {
  restore?.()
  restore = null
  vi.useRealTimers()
})

async function thrown(promise: Promise<unknown>): Promise<BackendClientError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  )
  expect(error).toBeInstanceOf(BackendClientError)
  return error as BackendClientError
}

describe("config: BACKEND_INTERNAL_URL", () => {
  it("accepts http(s) origins and normalises a trailing slash", () => {
    expect(readBackendClientConfig({ BACKEND_INTERNAL_URL: "http://backend:4000" }).baseUrl).toBe("http://backend:4000")
    expect(readBackendClientConfig({ BACKEND_INTERNAL_URL: "http://127.0.0.1:4000/" }).baseUrl).toBe("http://127.0.0.1:4000")
    expect(readBackendClientConfig({ BACKEND_INTERNAL_URL: "https://api.internal" }).baseUrl).toBe("https://api.internal")
  })

  it.each([
    ["missing", undefined],
    ["blank", "   "],
    ["no scheme", "backend:4000"],
    ["ftp", "ftp://backend:4000"],
    ["javascript", "javascript:alert(1)"],
    ["credentials", `http://user:${SECRET}@backend:4000`],
    ["username only", "http://user@backend:4000"],
    ["query", "http://backend:4000?x=1"],
    ["empty query", "http://backend:4000/?"],
    ["fragment", "http://backend:4000#frag"],
    ["path", "http://backend:4000/v1"],
    ["path + slash", "http://backend:4000/api/"],
    ["whitespace inside", "http://back end:4000"],
    ["backslash", "http:\\\\backend:4000"],
    ["not a URL", "%%%"],
    ["no host", "http://"],
  ])("rejects %s without echoing the value", (_label, value) => {
    let message = ""
    try {
      readBackendClientConfig({ BACKEND_INTERNAL_URL: value })
    } catch (error) {
      expect(error).toBeInstanceOf(BackendConfigError)
      message = (error as Error).message
    }
    expect(message).toMatch(/BACKEND_INTERNAL_URL/)
    if (value && value.trim()) {
      expect(message).not.toContain(value)
      expect(message).not.toContain(SECRET)
    }
  })

  it("timeout: default 3000, bounded 250-15000", () => {
    expect(readBackendClientConfig(ENV).timeoutMs).toBe(3000)
    expect(readBackendClientConfig({ ...ENV, BACKEND_REQUEST_TIMEOUT_MS: "1500" }).timeoutMs).toBe(1500)
    for (const bad of ["0", "249", "15001", "-5", "1e3", "abc", "3000ms", "9999999"]) {
      expect(() => readBackendClientConfig({ ...ENV, BACKEND_REQUEST_TIMEOUT_MS: bad })).toThrow(/BACKEND_REQUEST_TIMEOUT_MS/)
    }
  })
})

describe("backendGetJson: request", () => {
  it("calls the server-side base URL + path with GET, JSON accept, no-store and no redirects", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => json({ ok: true }))
    await backendGetJson({ operation: "creation_pricing", path: "/v1/creation-pricing", requestId: GOOD_ID, parse }, { env: ENV, fetchImpl })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe("http://backend:4000/v1/creation-pricing")
    expect(init).toMatchObject({ method: "GET", cache: "no-store", redirect: "error" })
    expect(new Headers(init.headers).get("accept")).toBe("application/json")
    expect(init.body).toBeUndefined()
  })

  it("forwards a safe request id", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => json({ ok: true }))
    await backendGetJson({ operation: "creation_pricing", path: "/v1/creation-pricing", requestId: GOOD_ID, parse }, { env: ENV, fetchImpl })
    const init = fetchImpl.mock.calls[0][1] as RequestInit
    expect(new Headers(init.headers).get("x-request-id")).toBe(GOOD_ID)
  })

  it.each([undefined, "", "short", "x".repeat(65), "has spaces in it", "<script>alert(1)</script>", "id\r\nX-Evil: 1", "../../etc/passwd"])(
    "replaces a missing or unsafe request id (%j) with a fresh UUID",
    async (bad) => {
      const fetchImpl = vi.fn<typeof fetch>(async () => json({ ok: true }))
      await backendGetJson({ operation: "creation_pricing", path: "/v1/creation-pricing", requestId: bad, parse }, { env: ENV, fetchImpl })
      const sent = new Headers((fetchImpl.mock.calls[0][1] as RequestInit).headers).get("x-request-id")
      expect(sent).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
      expect(sent).not.toBe(bad)
    },
  )

  it("returns the validated data, the status and the echoed backend request id", async () => {
    const fetchImpl = vi.fn(async () => json({ ok: true }, { headers: { "x-request-id": GOOD_ID } }))
    const result = await backendGetJson({ operation: "creation_pricing", path: "/v1/creation-pricing", requestId: GOOD_ID, parse }, { env: ENV, fetchImpl })
    expect(result).toMatchObject({ status: 200, data: { ok: true }, backendRequestId: GOOD_ID })
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })

  it.each(["v1/x", "/v1/x?y=1", "/v1/../x", "http://evil/x", "//evil/x", "/v1/x#f", "/v1/ x"])("rejects the path %j as a programming error", async (path) => {
    const fetchImpl = vi.fn()
    await expect(backendGetJson({ operation: "creation_pricing", path, parse }, { env: ENV, fetchImpl })).rejects.toBeInstanceOf(TypeError)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe("backendGetJson: failures are safe categories", () => {
  it("missing or malformed config -> not_configured, with no network attempt", async () => {
    capture()
    const fetchImpl = vi.fn()
    for (const env of [{}, { BACKEND_INTERNAL_URL: "not a url" }, { BACKEND_INTERNAL_URL: "http://u:p@backend:4000" }]) {
      const error = await thrown(backendGetJson({ operation: "creation_pricing", path: "/v1/creation-pricing", parse }, { env, fetchImpl }))
      expect(error.kind).toBe("not_configured")
    }
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(logs.every((l) => l.event === "BACKEND_NOT_CONFIGURED")).toBe(true)
  })

  it("network failure -> unavailable, and the raw exception is dropped", async () => {
    capture()
    const fetchImpl = vi.fn(async () => {
      throw Object.assign(new TypeError(`fetch failed: connect ECONNREFUSED ${INTERNAL_HOST}:4000 ${SECRET}`), { cause: { code: "ECONNREFUSED" } })
    })
    const error = await thrown(backendGetJson({ operation: "creation_pricing", path: "/v1/creation-pricing", requestId: GOOD_ID, parse }, { env: { BACKEND_INTERNAL_URL: `http://${INTERNAL_HOST}:4000` }, fetchImpl }))
    expect(error.kind).toBe("unavailable")
    expect(error.message).toBe("backend request failed: unavailable")
    expect(error.cause).toBeUndefined()
    const everything = JSON.stringify([error.message, error.status, logs])
    for (const leak of [INTERNAL_HOST, "ECONNREFUSED", SECRET, "fetch failed", ":4000"]) expect(everything).not.toContain(leak)
    expect(logs).toEqual([expect.objectContaining({ level: "warn", event: "BACKEND_UNAVAILABLE", requestId: GOOD_ID, operation: "creation_pricing", subsystem: "backend", errorCode: "BACKEND_UNAVAILABLE" })])
  })

  it.each([400, 404, 500, 502, 503, 504])("a %s from the backend -> bad_status carrying only the status", async (status) => {
    capture()
    const fetchImpl = vi.fn(async () => json({ error: `raw backend message ${SECRET}` }, { status }))
    const error = await thrown(backendGetJson({ operation: "creation_pricing", path: "/v1/creation-pricing", parse }, { env: ENV, fetchImpl }))
    expect(error).toMatchObject({ kind: "bad_status", status })
    expect(JSON.stringify([error.message, logs])).not.toContain(SECRET)
    expect(logs[0]).toMatchObject({ status, errorCode: "BACKEND_BAD_STATUS" })
  })

  it("a redirect is refused (redirect: error) and reported as unavailable", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("redirect mode is set to error")
    })
    expect((await thrown(backendGetJson({ operation: "creation_pricing", path: "/v1/creation-pricing", parse }, { env: ENV, fetchImpl }))).kind).toBe("unavailable")
  })

  it.each([
    ["not JSON", () => new Response("<html>oops</html>", { status: 200 })],
    ["empty body", () => new Response("", { status: 200 })],
    ["rejected by the validator", () => json({ ok: false, __reject: true })],
    ["too large", () => new Response(JSON.stringify({ ok: true, pad: "x".repeat(BACKEND_MAX_BODY_CHARS) }), { status: 200 })],
  ])("2xx with %s -> invalid_response", async (_label, make) => {
    capture()
    const fetchImpl = vi.fn(async () => make())
    const strict = (value: unknown) => {
      if ((value as { __reject?: boolean }).__reject) throw new Error(`rejected ${SECRET}`)
      return value as { ok: boolean }
    }
    const error = await thrown(backendGetJson({ operation: "creation_pricing", path: "/v1/creation-pricing", requestId: GOOD_ID, parse: strict }, { env: ENV, fetchImpl }))
    expect(error.kind).toBe("invalid_response")
    expect(logs[0]).toMatchObject({ level: "error", event: "BACKEND_INVALID_RESPONSE", errorCode: "BACKEND_INVALID_RESPONSE" })
    expect(JSON.stringify([error.message, logs])).not.toContain(SECRET)
  })
})

describe("backendGetJson: one bounded attempt", () => {
  it("makes exactly one request per call, on success and on every failure (no retry)", async () => {
    for (const impl of [
      async () => json({ ok: true }),
      async () => json({}, { status: 503 }),
      async () => new Response("nope", { status: 200 }),
      async (): Promise<Response> => {
        throw new TypeError("fetch failed")
      },
    ]) {
      const fetchImpl = vi.fn(impl)
      await backendGetJson({ operation: "creation_pricing", path: "/v1/creation-pricing", parse }, { env: ENV, fetchImpl }).catch(() => {})
      expect(fetchImpl).toHaveBeenCalledTimes(1)
    }
  })

  it("a stalled backend becomes a timeout at the configured bound, not later", async () => {
    capture()
    vi.useFakeTimers()
    const fetchImpl = vi.fn((_url: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason ?? new Error("aborted")))
      }),
    )
    const pending = thrown(backendGetJson({ operation: "creation_pricing", path: "/v1/creation-pricing", requestId: GOOD_ID, parse }, { env: { ...ENV, BACKEND_REQUEST_TIMEOUT_MS: "1200" }, fetchImpl: fetchImpl as unknown as typeof fetch }))
    await vi.advanceTimersByTimeAsync(1199)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    let settled = false
    void pending.then(() => (settled = true))
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    const error = await pending
    expect(error.kind).toBe("timeout")
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(logs).toEqual([expect.objectContaining({ level: "warn", event: "BACKEND_TIMEOUT", errorCode: "REQUEST_TIMEOUT" })])
  })

  it("the default bound is 3000 ms", async () => {
    vi.useFakeTimers()
    const fetchImpl = vi.fn((_url: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason))
      }),
    )
    const pending = thrown(backendGetJson({ operation: "creation_pricing", path: "/v1/creation-pricing", parse }, { env: ENV, fetchImpl }))
    await vi.advanceTimersByTimeAsync(2999)
    await vi.advanceTimersByTimeAsync(1)
    expect((await pending).kind).toBe("timeout")
  })
})

describe("backendGetJson: logging", () => {
  it("success logs request id, operation, status, duration - and nothing from the exchange", async () => {
    capture()
    const fetchImpl = vi.fn(async () => json({ ok: true, secretField: SECRET }, { headers: { "set-cookie": `s=${SECRET}`, authorization: SECRET } }))
    await backendGetJson({ operation: "creation_pricing", path: "/v1/creation-pricing", requestId: GOOD_ID, parse }, { env: { BACKEND_INTERNAL_URL: `http://${INTERNAL_HOST}:4000` }, fetchImpl })
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatchObject({ level: "info", event: "BACKEND_REQUEST_COMPLETED", requestId: GOOD_ID, operation: "creation_pricing", subsystem: "backend", status: 200 })
    expect(logs[0].durationMs).toBeGreaterThanOrEqual(0)
    const text = JSON.stringify(logs)
    for (const leak of [SECRET, INTERNAL_HOST, "http://", "/v1/creation-pricing"]) expect(text).not.toContain(leak)
  })
})
