import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { setRateLimitStore, InMemoryRateLimitStore } from "@/lib/rate-limit"
import { setLogSink, type LogRecord } from "@/lib/observability/logger"
import { REQUEST_ID_HEADER } from "@/lib/observability/request-id"

const OID = "123e4567-e89b-42d3-a456-426614174000"
const KEY = "11111111-1111-4111-8111-111111111111"
const SECRET_TITLE = "Sara birthday secret story"

const m = vi.hoisted(() => ({
  serverClient: vi.fn(),
  upload: vi.fn(),
  copy: vi.fn(),
  rpc: vi.fn(),
  existingOrder: null as unknown,
  audit: vi.fn(),
  finalClient: null as unknown,
}))

vi.mock("@/lib/supabase/server", () => ({ createServerSupabaseClient: m.serverClient }))
vi.mock("@/lib/supabase/admin", () => ({ createAdminSupabaseClient: () => ({ rpc: m.rpc }) }))
vi.mock("@/lib/requests/resolve-character", () => ({ resolveCharacterId: async () => ({ ok: true, characterId: null }) }))
vi.mock("@/lib/parent/gallery/source-asset", async (orig) => ({
  ...(await orig<typeof import("@/lib/parent/gallery/source-asset")>()),
  resolveOwnedSourceAsset: async () => ({
    ok: true,
    asset: { id: OID, path: "u/secret/path.png", originalFilename: "sara-private.png", mimeType: "image/png" },
  }),
  sourceAssetCopyName: () => "copy.png",
}))
vi.mock("@/lib/requests/request-submission", () => ({
  parseAndValidateDraft: () => ({
    ok: true,
    data: {
      type: "image", title: SECRET_TITLE, description: "free text prompt", characterId: null, durationKey: null,
      durationChoice: null, videoScript: null, videoStyle: null, animationStyle: null,
      charactersSpeak: null, fileName: null, childName: "Sara",
    },
  }),
}))
vi.mock("@/lib/audit/final-media-audit", () => ({ recordFinalMediaAudit: m.audit }))

let records: LogRecord[]
let restore: () => void

const chain = (data: unknown) => ({
  select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: m.existingOrder, error: null }) }), maybeSingle: async () => ({ data, error: null }) }) }),
})
function healthyClient() {
  return {
    auth: { getUser: async () => ({ data: { user: { id: "u1" } }, error: null }), signOut: vi.fn() },
    rpc: async () => ({ data: [{ is_valid: true, session_started_at: "2026-01-01T00:00:00Z", expires_at: "2026-01-31T00:00:00Z" }], error: null }),
    from: (t: string) => t === "users" ? chain({ role: "parent" }) : t === "parent_profiles" ? chain({ id: "p1", consent_granted: true }) : chain(null),
    storage: { from: () => ({ upload: m.upload, copy: m.copy, remove: async () => ({ error: null }) }) },
  }
}
function post(file: unknown, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  const r = new Request("http://x/api/requests", { method: "POST", headers: { "content-type": "multipart/form-data; boundary=x", ...headers }, body: "x" })
  const fields: Record<string, unknown> = { draft: "{}", submissionKey: KEY, file, sourceAssetId: null, ...extra }
  ;(r as unknown as { formData: unknown }).formData = async () => ({ get: (k: string) => fields[k] ?? null })
  return r
}
const png = { size: 100, type: "image/png", name: "sara-birthday.png" }
const events = () => records.map((r) => r.event)

beforeEach(() => {
  setRateLimitStore(new InMemoryRateLimitStore()) // fresh counters per test
  records = []
  restore = setLogSink((r) => records.push(r))
  m.existingOrder = null
  m.serverClient.mockReset().mockImplementation(async () => healthyClient())
  m.upload.mockReset().mockResolvedValue({ error: null })
  m.copy.mockReset().mockResolvedValue({ error: null })
  m.rpc.mockReset().mockResolvedValue({ data: [{ id: OID, type: "image", status: "pending", candy_cost: 1, replayed: false }], error: null })
  m.audit.mockReset().mockResolvedValue(undefined)
})
afterEach(() => restore())

// vi.resetModules() builds a fresh logger module; point it at the same capture.
async function reattachSink() {
  restore()
  const fresh = await import("@/lib/observability/logger")
  restore = fresh.setLogSink((r) => records.push(r))
}

const POST = async () => (await import("@/app/api/requests/route")).POST

describe("POST /api/requests observability", () => {
  it("new submission -> SUBMISSION_ACCEPTED + REQUEST_COMPLETED, X-Request-Id header", async () => {
    const res = await (await POST())(post(png))
    expect(res.status).toBe(200)
    expect(res.headers.get(REQUEST_ID_HEADER)).toBeTruthy()
    expect(events()).toEqual(["SUBMISSION_ACCEPTED", "REQUEST_COMPLETED"])
    expect(records[0]).toMatchObject({ orderId: OID, replayed: false, operation: "upload", route: "POST /api/requests" })
    expect(records[1]).toMatchObject({ status: 200, route: "POST /api/requests" })
    expect(records[0].requestId).toBe(records[1].requestId)
  })

  it("idempotent replay is distinguishable from a new submission (fast path and RPC race)", async () => {
    m.existingOrder = { id: OID, type: "image", status: "pending", candy_cost: 1 }
    await (await POST())(post(png))
    expect(events()).toEqual(["SUBMISSION_REPLAYED", "REQUEST_COMPLETED"])
    expect(records[0]).toMatchObject({ replayed: true, reason: "idempotency_fast_path", orderId: OID })
    expect(m.upload).not.toHaveBeenCalled()

    records.length = 0
    m.existingOrder = null
    m.rpc.mockResolvedValue({ data: [{ id: OID, type: "image", status: "pending", candy_cost: 1, replayed: true }], error: null })
    await (await POST())(post(png))
    expect(events()).toContain("SUBMISSION_REPLAYED")
    expect(events()).not.toContain("SUBMISSION_ACCEPTED")
  })

  it("insufficient candies -> info SUBMISSION_INSUFFICIENT_CANDIES, no error noise", async () => {
    m.rpc.mockResolvedValue({ data: null, error: { message: "INSUFFICIENT_CANDIES" } })
    const res = await (await POST())(post(png))
    expect(res.status).toBe(402)
    expect(records.find((r) => r.event === "SUBMISSION_INSUFFICIENT_CANDIES")).toMatchObject({ level: "info" })
    expect(records.some((r) => r.level === "error")).toBe(false)
    expect(events()).not.toContain("SUBMISSION_RPC_FAILED")
  })

  it("trusted RPC failure -> SUBMISSION_RPC_FAILED with our code, never the database text", async () => {
    m.rpc.mockResolvedValue({ data: null, error: { message: 'invalid input syntax for type uuid: "Robo Bobo" (host 10.0.0.5)' } })
    await (await POST())(post(png))
    const rec = records.find((r) => r.event === "SUBMISSION_RPC_FAILED")!
    expect(rec).toMatchObject({ subsystem: "database", reason: "request_failed", errorCode: "DATABASE_UNAVAILABLE" })
    expect(JSON.stringify(records)).not.toMatch(/Robo|10\.0\.0\.5|invalid input/)
  })

  it("RPC timeout is categorized REQUEST_TIMEOUT", async () => {
    m.rpc.mockResolvedValue({ data: null, error: { message: "FetchTimeoutError: Request timed out after 10000ms" } })
    await (await POST())(post(png))
    expect(records.find((r) => r.event === "SUBMISSION_RPC_FAILED")!.errorCode).toBe("REQUEST_TIMEOUT")
  })

  it("storage upload failure -> SUBMISSION_STORAGE_FAILED (safe category, no path/filename)", async () => {
    m.upload.mockResolvedValue({ error: { message: "row-level security violation for u1/o/sara-birthday.png" } })
    const res = await (await POST())(post(png))
    expect(res.status).toBe(403)
    expect(records.find((r) => r.event === "SUBMISSION_STORAGE_FAILED")).toMatchObject({
      level: "error", operation: "upload", bucket: "parent-uploads", mediaType: "image/png", errorCode: "STORAGE_UNAVAILABLE",
    })
    expect(m.rpc).not.toHaveBeenCalled()
  })

  it("gallery copy failure -> SUBMISSION_STORAGE_FAILED operation=copy", async () => {
    m.copy.mockResolvedValue({ error: { message: "Request timed out after 25000ms" } })
    await (await POST())(post(null, { sourceAssetId: OID }))
    expect(records.find((r) => r.event === "SUBMISSION_STORAGE_FAILED")).toMatchObject({ operation: "copy", errorCode: "REQUEST_TIMEOUT" })
  })

  it("upload rejected -> info SUBMISSION_UPLOAD_REJECTED with a reason, no stack", async () => {
    await (await POST())(post({ size: 11 * 1024 * 1024, type: "image/png", name: "big.png" }))
    await (await POST())(post({ size: 5, type: "application/pdf", name: "a.pdf" }))
    await (await POST())(post(png, {}, { "content-length": String(60 * 1024 * 1024) }))
    const rejected = records.filter((r) => r.event === "SUBMISSION_UPLOAD_REJECTED")
    expect(rejected.map((r) => r.reason)).toEqual(["file_too_large", "invalid_file_type", "request_too_large"])
    expect(rejected.every((r) => r.level === "info")).toBe(true)
  })

  it("unexpected throw inside the submit path -> one REQUEST_FAILED, generic 500 with request id", async () => {
    m.rpc.mockImplementation(() => { throw new Error(`boom ${SECRET_TITLE}`) })
    const res = await (await POST())(post(png))
    expect(res.status).toBe(500)
    expect(records.filter((r) => r.event === "REQUEST_FAILED")).toHaveLength(1)
    expect(events()).not.toContain("REQUEST_COMPLETED")
    expect(JSON.stringify(await res.json())).not.toContain("boom")
  })

  it("transient getUser failure logs a warn and keeps the 401 contract", async () => {
    const { AuthRetryableFetchError } = await import("@supabase/supabase-js")
    m.serverClient.mockImplementation(async () => ({
      ...healthyClient(),
      auth: { getUser: async () => ({ data: { user: null }, error: new AuthRetryableFetchError("Request timed out after 10000ms", 0) }) },
    }))
    const res = await (await POST())(post(png))
    expect(res.status).toBe(401)
    expect(records.find((r) => r.event === "AUTH_USER_LOOKUP_FAILED")).toMatchObject({ level: "warn", errorCode: "REQUEST_TIMEOUT" })
  })

  it("no prompt, child name, title, filename, path, submission key or token is ever logged", async () => {
    m.upload.mockResolvedValue({ error: { message: "bad u1/o/sara-birthday.png" } })
    await (await POST())(post(png))
    await (await POST())(post(null, { sourceAssetId: OID }))
    m.rpc.mockResolvedValue({ data: null, error: { message: "boom Sara free text prompt" } })
    await (await POST())(post(png))
    const out = JSON.stringify(records)
    expect(out).not.toMatch(/Sara|sara|prompt|birthday|secret|path\.png|\.png|\.jpg|u1\/|11111111-1111/i)
  })
})

describe("final-media audit decision: awaited, failures logged", () => {
  const final = { id: OID, path: "o/final.mp4", fileName: "final.mp4", mimeType: "video/mp4" }

  async function finalRoute(sign: string | null) {
    vi.resetModules()
    await reattachSink()
    vi.doMock("@/lib/parent/orders/final-media-queries", () => ({
      resolveParentOwnsOrder: async () => ({ ok: true, userId: "u1" }),
      resolveCurrentParentFinalMedia: async () => final,
    }))
    vi.doMock("@/lib/storage/private-signed-url", () => ({
      PRIVATE_MEDIA_SIGNED_URL_TTL_SECONDS: 300,
      createPrivateSignedUrl: async () => sign,
    }))
    return (await import("@/app/api/parent/orders/[orderId]/final-media/route")).POST
  }
  const call = (POST: Awaited<ReturnType<typeof finalRoute>>) =>
    POST(new Request("http://x", { method: "POST" }), { params: Promise.resolve({ orderId: OID }) })

  it("the response waits for the audit write (not fire-and-forget)", async () => {
    const POST = await finalRoute("https://s/signed?token=abc")
    let release!: () => void
    m.audit.mockReturnValue(new Promise<void>((r) => { release = r }))
    let settled = false
    const pending = call(POST).then((r) => { settled = true; return r })
    await new Promise((r) => setTimeout(r, 20))
    expect(m.audit).toHaveBeenCalledTimes(1)
    expect(settled).toBe(false)
    release()
    const res = await pending
    expect(res.status).toBe(200)
    expect(JSON.stringify(records)).not.toMatch(/token=abc/)
  })

  it("mint failure -> FINAL_MEDIA_SIGN_FAILED with ids only, 5xx completion logged", async () => {
    const POST = await finalRoute(null)
    const res = await call(POST)
    expect(res.status).toBeGreaterThanOrEqual(500)
    expect(records.find((r) => r.event === "FINAL_MEDIA_SIGN_FAILED")).toMatchObject({
      subsystem: "storage", orderId: OID, mediaAssetId: OID, mediaType: "video/mp4", bucket: "final-deliverables",
    })
    expect(JSON.stringify(records)).not.toContain("final.mp4")
    expect(m.audit).not.toHaveBeenCalled()
  })
})

describe("recordFinalMediaAudit never fails silently", () => {
  const input = { actorUserId: "u1", orderId: OID, mediaAssetId: OID, action: "final_media_view" as const }
  async function realAudit(insert: () => Promise<unknown>) {
    vi.resetModules()
    await reattachSink()
    vi.doUnmock("@/lib/audit/final-media-audit")
    vi.doMock("@/lib/supabase/admin", () => ({ createAdminSupabaseClient: () => ({ from: () => ({ insert }) }) }))
    const mod = await vi.importActual<typeof import("@/lib/audit/final-media-audit")>("@/lib/audit/final-media-audit")
    return mod.recordFinalMediaAudit
  }

  it("a returned {error} is logged (previously ignored)", async () => {
    const run = await realAudit(async () => ({ error: { message: "permission denied for table audit_logs" } }))
    await expect(run(input)).resolves.toBeUndefined()
    expect(records[0]).toMatchObject({ level: "error", event: "AUDIT_WRITE_FAILED", subsystem: "audit", operation: "final_media_view", orderId: OID, mediaAssetId: OID, errorCode: "DATABASE_UNAVAILABLE" })
    expect(JSON.stringify(records)).not.toContain("permission denied")
  })
  it("a throw (e.g. timeout) is logged and does not propagate", async () => {
    const { FetchTimeoutError } = await import("@/lib/http/fetch-with-timeout")
    const run = await realAudit(async () => { throw new FetchTimeoutError(10_000) })
    await expect(run(input)).resolves.toBeUndefined()
    expect(records[0]).toMatchObject({ event: "AUDIT_WRITE_FAILED", errorCode: "REQUEST_TIMEOUT" })
  })
  it("success logs nothing", async () => {
    const run = await realAudit(async () => ({ error: null }))
    await run(input)
    expect(records).toHaveLength(0)
  })
})
