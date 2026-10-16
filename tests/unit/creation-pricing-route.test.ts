import { describe, it, expect, vi, afterEach, beforeEach } from "vitest"
import fs from "node:fs"
import { GET } from "@/app/api/creation-pricing/route"
import { parseCreationPricesPayload } from "@/lib/pricing/creation-prices"
import { setLogSink, type LogRecord } from "@/lib/observability/logger"

/**
 * GET /api/creation-pricing after the V0.1.41 cutover: the Next route proxies
 * the Fastify backend. fetch is replaced globally; any call that is not to the
 * backend (for example Supabase) fails the test.
 */

const INTERNAL = "http://backend.internal.test:4000"
const SECRET = "Route-Secret-Token-5520"
const PUBLIC_503 = { error: "قیمت‌ها در حال حاضر در دسترس نیستند.", code: "CREATION_PRICING_UNAVAILABLE" }
const PRICES = {
  "image.default": 12,
  "image.reference_file": 3,
  "video.short": 40,
  "video.medium": 60,
  "video.long": 90,
  "video.reference_file": 5,
  "drawing_animation.short": 35,
  "drawing_animation.medium": 50,
  "drawing_animation.long": 75,
}

type Handler = (url: string, init: RequestInit) => Promise<Response> | Response
let calls: Array<{ url: string; init: RequestInit }> = []
let logs: LogRecord[] = []
let restoreSink: (() => void) | null = null

function backend(handler: Handler) {
  calls = []
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input)
    calls.push({ url, init })
    if (!url.startsWith(INTERNAL)) throw new Error(`unexpected non-backend fetch: ${url}`)
    return handler(url, init)
  })
}

const ok = (body: unknown = { prices: PRICES }, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json", ...headers } })

const call = (headers: Record<string, string> = {}) =>
  GET(new Request("http://localhost:3000/api/creation-pricing", { headers }))

beforeEach(() => {
  vi.stubEnv("BACKEND_INTERNAL_URL", INTERNAL)
  vi.stubEnv("BACKEND_REQUEST_TIMEOUT_MS", "")
  logs = []
  restoreSink = setLogSink((r) => logs.push(r))
})

afterEach(() => {
  restoreSink?.()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

describe("success: the public contract is unchanged", () => {
  it("200 { prices } with the exact values the backend served", async () => {
    backend(() => ok())
    const res = await call()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ prices: PRICES })
    expect(res.headers.get("content-type")).toMatch(/^application\/json/)
  })

  it("cache headers are owned by the Next route and exact", async () => {
    // The backend sends its own (identical) values; prove the route does not just forward them.
    backend(() => ok({ prices: PRICES }, { "cache-control": "private, max-age=999999" }))
    const res = await call()
    expect(res.headers.get("cache-control")).toBe("public, s-maxage=60, stale-while-revalidate=300")
    expect(res.headers.get("x-content-type-options")).toBe("nosniff")
  })

  it("rebuilds the catalog from validated entries: unknown top-level fields are not passed through", async () => {
    backend(() => ok({ prices: { "image.default": 12 }, debug: { dbHost: "pg.internal" }, stack: "at x" }))
    const body = await (await call()).json()
    expect(body).toEqual({ prices: { "image.default": 12 } })
    expect(JSON.stringify(body)).not.toMatch(/pg\.internal|stack/)
  })

  it("is the same body and status the pre-cutover route produced for the same catalog", async () => {
    backend(() => ok())
    const res = await call()
    const text = await res.text()
    // Pre-cutover: NextResponse.json({ prices }) with prices in catalog order.
    expect(text).toBe(JSON.stringify({ prices: PRICES }))
  })
})

describe("one request, one backend attempt, server-side only", () => {
  it("calls the internal backend exactly once, with GET and no-store", async () => {
    backend(() => ok())
    await call()
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(`${INTERNAL}/v1/creation-pricing`)
    expect(calls[0].init).toMatchObject({ method: "GET", cache: "no-store" })
  })

  it.each([
    ["503 from the backend", () => new Response(JSON.stringify(PUBLIC_503), { status: 503 })],
    ["500 from the backend", () => new Response("boom", { status: 500 })],
    ["network failure", () => Promise.reject(new TypeError("fetch failed"))],
    ["malformed JSON", () => new Response("{not json", { status: 200 })],
  ])("does not retry after %s", async (_label, respond) => {
    backend(respond as Handler)
    await call()
    expect(calls).toHaveLength(1)
  })
})

describe("request id", () => {
  const GOOD = "abcd1234-ef56-4789-9abc-def012345678"

  it("forwards a safe inbound X-Request-Id to the backend and returns it", async () => {
    backend(() => ok())
    const res = await call({ "x-request-id": GOOD })
    expect(new Headers(calls[0].init.headers).get("x-request-id")).toBe(GOOD)
    expect(res.headers.get("x-request-id")).toBe(GOOD)
  })

  it("without one, a single generated id is used for the backend call AND the response", async () => {
    backend(() => ok())
    const res = await call()
    const sent = new Headers(calls[0].init.headers).get("x-request-id")
    expect(sent).toMatch(/^[0-9a-f-]{36}$/)
    expect(res.headers.get("x-request-id")).toBe(sent)
  })

  it.each(["short", "bad id with spaces", "<script>x</script>", "x".repeat(80)])("replaces the unsafe id %j everywhere", async (bad) => {
    backend(() => ok())
    const res = await call({ "x-request-id": bad })
    const sent = new Headers(calls[0].init.headers).get("x-request-id")
    expect(sent).not.toBe(bad)
    expect(sent).toMatch(/^[0-9a-f-]{36}$/)
    expect(res.headers.get("x-request-id")).toBe(sent)
  })

  it("the failure response carries the id too", async () => {
    backend(() => new Response("x", { status: 500 }))
    const res = await call({ "x-request-id": GOOD })
    expect(res.status).toBe(503)
    expect(res.headers.get("x-request-id")).toBe(GOOD)
  })
})

describe("failure policy: the public 503, never another source", () => {
  async function expectPublic503(res: Response) {
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual(PUBLIC_503)
    expect(res.headers.get("cache-control")).toBe("no-store")
    expect(res.headers.get("x-content-type-options")).toBe("nosniff")
  }

  it("backend 503 -> public 503", async () => {
    backend(() => new Response(JSON.stringify({ error: "قیمت‌ها", code: "CREATION_PRICING_UNAVAILABLE" }), { status: 503 }))
    await expectPublic503(await call())
  })

  it.each([400, 404, 429, 500, 502, 504])("backend %s -> public 503", async (status) => {
    backend(() => new Response("x", { status }))
    await expectPublic503(await call())
  })

  it("network failure -> public 503", async () => {
    backend(() => Promise.reject(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } })))
    await expectPublic503(await call())
  })

  it("timeout -> public 503, at the bounded deadline", async () => {
    vi.useFakeTimers()
    vi.stubEnv("BACKEND_REQUEST_TIMEOUT_MS", "800")
    backend((_url, init) => new Promise<Response>((_res, rej) => init.signal?.addEventListener("abort", () => rej(init.signal?.reason))))
    const pending = call()
    await vi.advanceTimersByTimeAsync(799)
    expect(logs.find((l) => l.event === "BACKEND_TIMEOUT")).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
    await expectPublic503(await pending)
    expect(logs.find((l) => l.event === "BACKEND_TIMEOUT")).toBeTruthy()
  })

  it.each([
    ["not JSON", () => new Response("<html>", { status: 200 })],
    ["JSON null", () => ok(null)],
    ["array", () => ok([1, 2])],
    ["no prices", () => ok({})],
    ["prices is an array", () => ok({ prices: [12] })],
    ["empty prices", () => ok({ prices: {} })],
    ["zero cost", () => ok({ prices: { "image.default": 0 } })],
    ["negative cost", () => ok({ prices: { "image.default": -1 } })],
    ["fractional cost", () => ok({ prices: { "image.default": 1.5 } })],
    ["string cost", () => ok({ prices: { "image.default": "12" } })],
    ["null cost", () => ok({ prices: { "image.default": null } })],
    ["blank key", () => ok({ prices: { " ": 12 } })],
    ["huge cost", () => ok({ prices: { "image.default": 1e300 } })],
    ["one bad entry among good ones", () => ok({ prices: { ...PRICES, "video.short": 0 } })],
  ])("malformed backend payload (%s) -> public 503, nothing passed through", async (_label, respond) => {
    backend(respond as Handler)
    await expectPublic503(await call())
  })

  it("not configured -> public 503, with no network call", async () => {
    vi.stubEnv("BACKEND_INTERNAL_URL", "")
    backend(() => ok())
    await expectPublic503(await call())
    expect(calls).toHaveLength(0)
  })

  it("malformed BACKEND_INTERNAL_URL -> public 503, with no network call", async () => {
    vi.stubEnv("BACKEND_INTERNAL_URL", `http://user:${SECRET}@backend:4000/path?x=1`)
    backend(() => ok())
    const res = await call()
    await expectPublic503(res)
    expect(calls).toHaveLength(0)
  })

  it("never falls back: every failure mode contacts only the backend", async () => {
    for (const respond of [
      () => new Response("x", { status: 500 }),
      () => Promise.reject(new TypeError("fetch failed")),
      () => new Response("{", { status: 200 }),
    ]) {
      backend(respond as Handler)
      await call()
      expect(calls.every((c) => c.url.startsWith(INTERNAL))).toBe(true)
      expect(calls.some((c) => /supabase/i.test(c.url))).toBe(false)
    }
  })
})

describe("nothing internal leaks", () => {
  it("neither the backend address nor raw errors reach a failure response, header or log", async () => {
    backend(() => Promise.reject(Object.assign(new TypeError(`connect ECONNREFUSED backend.internal.test:4000 ${SECRET}`), { cause: { code: "ECONNREFUSED" } })))
    const res = await call({ cookie: `sb=${SECRET}`, authorization: `Bearer ${SECRET}` })
    const surface = JSON.stringify([await res.text(), [...res.headers.entries()], logs])
    for (const leak of ["backend.internal.test", "4000", "ECONNREFUSED", SECRET, "fetch failed", "connect"]) {
      expect(surface).not.toContain(leak)
    }
  })

  it("a backend error body is never relayed", async () => {
    backend(() => new Response(JSON.stringify({ error: `pg: password authentication failed ${SECRET}`, stack: "at server.cjs" }), { status: 500 }))
    const res = await call()
    expect(JSON.stringify([await res.text(), logs])).not.toMatch(new RegExp(`${SECRET}|password authentication|server\\.cjs`))
  })

  it("logs the outcome with safe fields, and no prices", async () => {
    backend(() => ok())
    await call({ "x-request-id": "abcd1234-ef56-4789-9abc-def012345678" })
    const backendLog = logs.find((l) => l.event === "BACKEND_REQUEST_COMPLETED")
    expect(backendLog).toMatchObject({ level: "info", requestId: "abcd1234-ef56-4789-9abc-def012345678", operation: "creation_pricing", subsystem: "backend", status: 200 })
    expect(logs.find((l) => l.event === "REQUEST_COMPLETED")).toMatchObject({ route: "GET /api/creation-pricing", status: 200 })
    expect(JSON.stringify(logs)).not.toMatch(/"image\.default"|"video\.short"|\b12\b.*\b40\b/)
  })
})

describe("route source: no Supabase, no direct database", () => {
  const src = fs.readFileSync("app/api/creation-pricing/route.ts", "utf8")
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")

  it("imports no Supabase client, pg, repository or lib/db module", () => {
    const imports = [...code.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1])
    expect(imports.sort()).toEqual(
      ["@/lib/backend/client", "@/lib/backend/errors", "@/lib/observability/request-context", "@/lib/pricing/creation-prices", "next/server"].sort(),
    )
    expect(code).not.toMatch(/supabase|createServerSupabaseClient|\.from\(|cookies\(|@\/lib\/(db|repositories)|from "pg"/i)
  })

  it("stays dynamic and declares the node runtime", () => {
    expect(code).toMatch(/export const dynamic = "force-dynamic"/)
    expect(code).toMatch(/export const runtime = "nodejs"/)
  })

  it("keeps the public contract strings", () => {
    expect(code).toContain('"public, s-maxage=60, stale-while-revalidate=300"')
    expect(code).toContain("قیمت‌ها در حال حاضر در دسترس نیستند.")
    expect(code).toContain("CREATION_PRICING_UNAVAILABLE")
  })
})

describe("parseCreationPricesPayload", () => {
  it("accepts a valid catalog and returns a fresh object", () => {
    const parsed = parseCreationPricesPayload({ prices: PRICES })
    expect(parsed).toEqual(PRICES)
    expect(parsed).not.toBe(PRICES)
  })

  it("a __proto__ key is an own property, never a prototype mutation", () => {
    const payload = JSON.parse('{"prices":{"__proto__":12,"image.default":12}}')
    const parsed = parseCreationPricesPayload(payload)
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype)
    expect(Object.keys(parsed).sort()).toEqual(["__proto__", "image.default"])
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it("rejects too many entries and over-long keys", () => {
    const many = Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`k${i}`, 1]))
    expect(() => parseCreationPricesPayload({ prices: many })).toThrow()
    expect(() => parseCreationPricesPayload({ prices: { ["k".repeat(101)]: 1 } })).toThrow()
  })
})
