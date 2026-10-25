import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { NextResponse } from "next/server"
import { logEvent, setLogSink, sanitizeFields, type LogRecord } from "@/lib/observability/logger"
import { resolveRequestId, REQUEST_ID_HEADER, isSafeRequestId } from "@/lib/observability/request-id"
import { categorizeError, ERROR_CATEGORIES } from "@/lib/observability/errors"
import { FetchTimeoutError } from "@/lib/http/fetch-with-timeout"
import { withObservability, log } from "@/lib/observability/request-context"
import { createPrivateSignedUrl, createPrivateSignedUrls } from "@/lib/storage/private-signed-url"
import { AuthRetryableFetchError } from "@supabase/supabase-js"
import { logAuthLookup } from "@/lib/observability/auth-events"

let records: LogRecord[]
let restore: () => void
beforeEach(() => {
  records = []
  restore = setLogSink((r) => records.push(r))
})
afterEach(() => {
  restore()
  vi.restoreAllMocks()
})

const UUID = "123e4567-e89b-42d3-a456-426614174000"
const req = (headers: Record<string, string> = {}, method = "POST") =>
  new Request("http://x/api/thing?token=abc", { method, headers })

describe("request id", () => {
  it("is generated when absent", () => {
    const id = resolveRequestId(new Headers())
    expect(id).toMatch(/^[0-9a-f-]{36}$/)
    expect(resolveRequestId(new Headers())).not.toBe(id)
  })
  it("preserves a valid incoming id", () => {
    expect(resolveRequestId(new Headers({ "x-request-id": "req_abc-123.XYZ" }))).toBe("req_abc-123.XYZ")
  })
  it.each(["short", "a".repeat(65), "has space in it", "inject\\nline", "<script>alert(1)</script>", "emoji-😀-12345"])(
    "replaces malformed/huge id %j",
    (bad) => {
      expect(isSafeRequestId(bad)).toBe(false)
      const id = resolveRequestId({ get: () => bad })
      expect(id).not.toBe(bad)
      expect(id).toMatch(/^[0-9a-f-]{36}$/)
    },
  )
})

describe("withObservability", () => {
  it("response carries X-Request-Id, and the incoming valid id is reused in the log", async () => {
    const h = withObservability("POST /api/thing", async () => NextResponse.json({ ok: true }))
    const res = await h(req({ "x-request-id": "client-req-0001" }))
    expect(res.headers.get(REQUEST_ID_HEADER)).toBe("client-req-0001")
    expect(records[0].requestId).toBe("client-req-0001")
  })

  it("generates an id when absent and returns it", async () => {
    const h = withObservability("POST /api/thing", async () => NextResponse.json({}))
    const res = await h(req())
    expect(res.headers.get(REQUEST_ID_HEADER)).toBe(records[0].requestId)
  })

  it("logs REQUEST_COMPLETED with stable fields, status and monotonic duration", async () => {
    const now = vi.spyOn(performance, "now").mockReturnValueOnce(1000).mockReturnValueOnce(1042.5)
    const h = withObservability("POST /api/thing", async () => NextResponse.json({}, { status: 201 }))
    await h(req())
    now.mockRestore()
    expect(records).toHaveLength(1)
    expect(Object.keys(records[0])).toEqual([
      "timestamp", "level", "event", "requestId", "route", "method", "status", "durationMs",
    ])
    expect(records[0]).toMatchObject({
      level: "info", event: "REQUEST_COMPLETED", route: "POST /api/thing",
      method: "POST", status: 201, durationMs: 42.5,
    })
    expect(new Date(records[0].timestamp).toISOString()).toBe(records[0].timestamp)
  })

  it("never logs the query string, URL or headers", async () => {
    const h = withObservability("POST /api/thing", async () => NextResponse.json({}))
    await h(req({ cookie: "sb-access-token=SECRET", authorization: "Bearer SECRET" }))
    expect(JSON.stringify(records)).not.toMatch(/SECRET|token=abc|cookie|authorization/i)
  })

  it("an unexpected throw logs exactly one safe REQUEST_FAILED and a generic 500", async () => {
    const h = withObservability("POST /api/thing", async () => {
      throw new Error("password=hunter2 connect ECONNREFUSED 10.0.0.5:5432 at /Users/mac/app.ts:1")
    })
    const res = await h(req())
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      level: "error", event: "REQUEST_FAILED", status: 500, subsystem: "request", errorCode: "INTERNAL_ERROR",
    })
    expect(records.some((r) => r.event === "REQUEST_COMPLETED")).toBe(false)
    expect(JSON.stringify(records)).not.toMatch(/hunter2|ECONNREFUSED|10\.0\.0\.5|\/Users|stack/)
    const body = await res.json()
    expect(res.status).toBe(500)
    expect(res.headers.get("Cache-Control")).toBe("no-store")
    expect(body.requestId).toBe(res.headers.get(REQUEST_ID_HEADER))
    expect(JSON.stringify(body)).not.toMatch(/hunter2|ECONNREFUSED|stack|at /)
  })

  it("a thrown timeout is categorized REQUEST_TIMEOUT", async () => {
    const h = withObservability("GET /api/thing", async () => { throw new FetchTimeoutError(10_000) })
    await h(req({}, "GET"))
    expect(records[0].errorCode).toBe("REQUEST_TIMEOUT")
  })

  it("expected validation errors are quiet: info level, no error event, no stack", async () => {
    const h = withObservability("POST /api/thing", async () =>
      NextResponse.json({ error: "bad", code: "validation_error" }, { status: 422 }))
    await h(req())
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ level: "info", event: "REQUEST_COMPLETED", status: 422 })
    expect(Object.keys(records[0])).not.toContain("stack")
    expect(Object.keys(records[0])).not.toContain("errorCode")
  })

  it("levels: 401 info, 503 warn, 500 error", async () => {
    for (const status of [401, 503, 500]) {
      await withObservability("GET /api/t", async () => new Response(null, { status }))(req({}, "GET"))
    }
    expect(records.map((r) => r.level)).toEqual(["info", "warn", "error"])
  })

  it("works with immutable-header responses (redirect)", async () => {
    const h = withObservability("POST /api/logout", async () => Response.redirect("http://x/login", 307))
    const res = await h(req())
    expect(res.status).toBe(307)
    expect(res.headers.get(REQUEST_ID_HEADER)).toBeTruthy()
  })

  it("log() inside a handler is tagged with the request's id and route", async () => {
    const h = withObservability("POST /api/thing", async () => {
      log("warn", "SOMETHING_HAPPENED", { subsystem: "storage" })
      return NextResponse.json({})
    })
    const res = await h(req())
    expect(records[0]).toMatchObject({
      event: "SOMETHING_HAPPENED", route: "POST /api/thing", requestId: res.headers.get(REQUEST_ID_HEADER),
    })
  })
})

describe("logger allow-list", () => {
  it("drops secrets, tokens, PII and free text even when passed", () => {
    logEvent("info", "SOME_EVENT", {
      accessToken: "eyJhbGciOi.secret.jwt", refresh_token: "rt-secret", cookie: "sb=secret",
      password: "hunter2", otp: "123456", serviceRoleKey: "sb_secret_abc",
      email: "mom@example.com", phone: "+989121234567", childName: "Sara",
      description: "my free text prompt", body: "{\"draft\":1}", storagePath: "u/o/photo.png",
      signedUrl: "https://x.supabase.co/object/sign/b/p?token=abc", submissionKey: UUID, fileName: "sara-birthday.png",
      orderId: UUID,
    })
    const out = JSON.stringify(records)
    expect(out).not.toMatch(/secret|eyJ|hunter2|123456|mom@|989121|Sara|prompt|draft|photo|token=|sara-birthday/i)
    expect(records[0].orderId).toBe(UUID)
  })

  it("rejects PII smuggled through allowed keys", () => {
    const cleaned = sanitizeFields({
      errorCode: "mom@example.com", reason: "https://evil/x?token=abc", operation: "has spaces here",
      orderId: "not-a-uuid", mediaAssetId: "u/o/photo.png", bucket: "../etc", mediaType: "text/plain; secret",
      route: "POST /api/x?token=abc", requestId: "bad id", userRole: "mom@example.com", status: 99999, durationMs: -1,
    })
    expect(cleaned).toEqual({})
  })

  it("never throws, and never emits a bad event name", () => {
    restore()
    restore = setLogSink(() => { throw new Error("sink down") })
    expect(() => logEvent("error", "OK_EVENT")).not.toThrow()
    restore()
    restore = setLogSink((r) => records.push(r))
    logEvent("info", "lower case; drop table")
    expect(records[0].event).toBe("INVALID_EVENT_NAME")
  })

  it("debug is suppressed at the default level", () => {
    logEvent("debug", "NOISY_EVENT")
    expect(records).toHaveLength(0)
  })
})

describe("error categories", () => {
  it("timeouts are REQUEST_TIMEOUT regardless of subsystem or shape", () => {
    expect(categorizeError(new FetchTimeoutError(1), "storage")).toBe("REQUEST_TIMEOUT")
    expect(categorizeError({ message: "FetchTimeoutError: Request timed out after 10000ms" }, "database")).toBe("REQUEST_TIMEOUT")
    expect(categorizeError(new AuthRetryableFetchError("Request timed out after 10000ms", 0), "auth")).toBe("REQUEST_TIMEOUT")
  })
  it("maps subsystems to stable categories without echoing messages", () => {
    expect(categorizeError({ message: "connection to 10.0.0.5 refused" }, "database")).toBe("DATABASE_UNAVAILABLE")
    expect(categorizeError({ message: "bucket x" }, "storage")).toBe("STORAGE_UNAVAILABLE")
    expect(categorizeError(new AuthRetryableFetchError("fetch failed", 0), "auth")).toBe("AUTH_UNAVAILABLE")
    expect(categorizeError({ status: 429 }, "auth")).toBe("RATE_LIMITED")
    expect(categorizeError(new Error("x"))).toBe("INTERNAL_ERROR")
    expect(categorizeError(undefined, "database")).toBe("DATABASE_UNAVAILABLE")
    for (const c of ["AUTH_UNAVAILABLE", "DATABASE_UNAVAILABLE", "STORAGE_UNAVAILABLE", "REQUEST_TIMEOUT", "VALIDATION_ERROR", "RATE_LIMITED", "INTERNAL_ERROR"]) {
      expect(ERROR_CATEGORIES).toContain(c)
    }
  })
})

describe("auth / session events", () => {
  it("transient getUser failure -> warn; plain unauthenticated -> debug (suppressed)", () => {
    logAuthLookup(new AuthRetryableFetchError("Request timed out after 10000ms", 0))
    logAuthLookup(null)
    logAuthLookup({ message: "invalid JWT: eyJsecret", status: 401 })
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ level: "warn", event: "AUTH_USER_LOOKUP_FAILED", errorCode: "REQUEST_TIMEOUT" })
    expect(JSON.stringify(records)).not.toMatch(/eyJ|invalid JWT/)
  })
})

describe("storage events", () => {
  const SECRET_PATH = "user-1/order-9/sara-birthday.png"
  const storage = (impl: object) => ({ storage: { from: () => impl } }) as never

  it("single signed-URL failure: category + bucket only, never the path or URL", async () => {
    const url = await createPrivateSignedUrl(
      storage({ createSignedUrl: async () => ({ data: null, error: { message: `Object not found ${SECRET_PATH}` } }) }),
      SECRET_PATH,
    )
    expect(url).toBeNull()
    expect(records[0]).toMatchObject({
      level: "warn", event: "STORAGE_SIGNED_URL_FAILED", subsystem: "storage",
      operation: "sign_url", bucket: "parent-uploads", errorCode: "STORAGE_UNAVAILABLE",
    })
    expect(JSON.stringify(records)).not.toContain("sara")
  })

  it("batch: whole failure and partial failure are distinguishable, counts only", async () => {
    await createPrivateSignedUrls(storage({ createSignedUrls: async () => { throw new FetchTimeoutError(25_000) } }), ["a/b.png", "c/d.png"])
    await createPrivateSignedUrls(
      storage({ createSignedUrls: async () => ({ data: [{ path: "a/b.png", signedUrl: "https://s/ok?token=1", error: null }, { path: "c/d.png", signedUrl: null, error: "nf" }], error: null }) }),
      ["a/b.png", "c/d.png"],
    )
    expect(records[0]).toMatchObject({ event: "STORAGE_SIGNED_URL_BATCH_FAILED", itemCount: 2, failedCount: 2, errorCode: "REQUEST_TIMEOUT" })
    expect(records[1]).toMatchObject({ event: "STORAGE_SIGNED_URL_BATCH_PARTIAL", itemCount: 2, failedCount: 1 })
    expect(JSON.stringify(records)).not.toMatch(/token=|a\/b|c\/d/)
  })

  it("success logs nothing", async () => {
    await createPrivateSignedUrl(storage({ createSignedUrl: async () => ({ data: { signedUrl: "https://s/ok" }, error: null }) }), "p")
    expect(records).toHaveLength(0)
  })
})
