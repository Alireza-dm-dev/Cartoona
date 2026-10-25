import { describe, it, expect, vi, beforeEach } from "vitest"
import { setRateLimitStore, InMemoryRateLimitStore } from "@/lib/rate-limit"

// POST /api/requests must refuse an oversized body from Content-Length alone,
// BEFORE request.formData() buffers it. No real large buffers are allocated:
// formData() is a spy and file objects are stubs with a declared size.
const MiB = 1024 * 1024
const FILE_LIMIT = 10 * MiB
const BODY_CAP = FILE_LIMIT + 256 * 1024

const m = vi.hoisted(() => ({
  createServerClient: vi.fn(),
  upload: vi.fn(),
  create: vi.fn(),
  lookup: vi.fn(),
  verify: vi.fn(),
}))

vi.mock("@/lib/storage/parent-uploads", () => ({
  uploadParentSource: async (...a: unknown[]) => (await m.upload(...a)).error,
  copyParentSource: async () => null,
  removeParentSource: async () => null,
}))
// V0.1.50: identity, consent, the idempotency lookup and the write all go
// through the backend; these tests cover the upload-size guards in front of it.
vi.mock("@/lib/parent/backend-caller", () => ({ verifyParentCaller: m.verify }))
vi.mock("@/lib/parent/consent/backend-consent", () => ({
  fetchParentConsent: async () => ({ ok: true, status: "granted", consentGrantedAt: "2026-01-01T00:00:00.000Z" }),
}))
vi.mock("@/lib/requests/backend-request", () => ({
  createRequestViaBackend: m.create,
  lookupRequestBySubmissionKey: m.lookup,
}))
vi.mock("@/lib/requests/request-submission", () => ({
  parseAndValidateDraft: () => ({
    ok: true,
    data: {
      type: "image", title: null, description: "", characterId: null, durationKey: null,
      durationChoice: null, videoScript: null, videoStyle: null, animationStyle: null,
      charactersSpeak: null, fileName: null, childName: null,
    },
  }),
}))

const KEY = "11111111-1111-4111-8111-111111111111"

function healthyClient() {
  return { storage: { from: () => ({ upload: m.upload, remove: async () => ({}) }) } }
}

function fakeForm(file: unknown) {
  const fields: Record<string, unknown> = { draft: "{}", submissionKey: KEY, file, sourceAssetId: null }
  return { get: (k: string) => fields[k] ?? null }
}

function post(headers: Record<string, string> = {}) {
  const req = new Request("http://x/api/requests", {
    method: "POST",
    headers: { "content-type": "multipart/form-data; boundary=x", origin: "http://localhost:3000", ...headers },
    body: "x",
  })
  const formData = vi.fn()
  ;(req as unknown as { formData: unknown }).formData = formData
  return { req, formData }
}

async function route() {
  return (await import("@/app/api/requests/route")).POST
}

beforeEach(() => {
  setRateLimitStore(new InMemoryRateLimitStore()) // fresh counters per test
  m.createServerClient.mockReset().mockImplementation(async () => healthyClient())
  m.upload.mockReset().mockResolvedValue({ error: null })
  m.verify.mockReset().mockResolvedValue({ ok: true, context: { identity: { provider: "supabase", subject: "u1" }, authenticatedAt: 1 } })
  m.lookup.mockReset().mockResolvedValue({ ok: true, found: false })
  m.create.mockReset().mockResolvedValue({
    ok: true,
    confirmedBy: "write",
    order: { orderId: "11111111-2222-4333-8444-555555555555", type: "image", status: "pending_review", candyCost: 1, paymentSource: "candy", replayed: false },
  })
})

describe("early Content-Length guard", () => {
  it("oversized Content-Length -> 413 no-store, formData() never called, no backend work", async () => {
    const POST = await route()
    const { req, formData } = post({ "content-length": String(60 * MiB) })
    const res = await POST(req)
    expect(res.status).toBe(413)
    expect(res.headers.get("Cache-Control")).toBe("no-store")
    expect((await res.json()).code).toBe("request_too_large")
    expect(formData).not.toHaveBeenCalled()
    expect(m.createServerClient).not.toHaveBeenCalled()
    expect(m.upload).not.toHaveBeenCalled()
  })

  it("one byte over the cap is rejected; exactly the cap is allowed through to the parser", async () => {
    const POST = await route()
    const over = post({ "content-length": String(BODY_CAP + 1) })
    expect((await POST(over.req)).status).toBe(413)
    expect(over.formData).not.toHaveBeenCalled()

    const at = post({ "content-length": String(BODY_CAP) })
    at.formData.mockResolvedValue(fakeForm(null))
    await POST(at.req)
    expect(at.formData).toHaveBeenCalledTimes(1)
  })

  it("a legitimate 10 MiB file (plus multipart overhead) is not rejected by the guard", async () => {
    const POST = await route()
    const { req, formData } = post({ "content-length": String(FILE_LIMIT + 4096) })
    formData.mockResolvedValue(fakeForm({ size: FILE_LIMIT, type: "image/png", name: "a.png" }))
    const res = await POST(req)
    expect(formData).toHaveBeenCalledTimes(1)
    expect(res.status).toBe(200)
  })

  it.each(["abc", "-5", "1e9", "12.5", "", " ", "0x10", "99999999999999999999999"])(
    "malformed Content-Length %j -> safe 400, formData() not called",
    async (value) => {
      const POST = await route()
      const { req, formData } = post({ "content-length": value })
      const res = await POST(req)
      // An empty value may be dropped by the Headers implementation; only
      // assert the rejection when a header actually reached the route.
      if (req.headers.get("content-length") === null) return
      expect(res.status).toBe(400)
      expect(res.headers.get("Cache-Control")).toBe("no-store")
      expect(formData).not.toHaveBeenCalled()
    },
  )

  it("non-multipart is still 415 before anything else", async () => {
    const POST = await route()
    const req = new Request("http://x/api/requests", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
    expect((await POST(req)).status).toBe(415)
  })
})

describe("authoritative checks after parsing are unchanged", () => {
  it("missing Content-Length does not bypass the file-size check", async () => {
    const POST = await route()
    const { req, formData } = post() // no content-length
    expect(req.headers.get("content-length")).toBeNull()
    formData.mockResolvedValue(fakeForm({ size: FILE_LIMIT + 1, type: "image/png", name: "big.png" }))
    const res = await POST(req)
    expect(formData).toHaveBeenCalledTimes(1)
    expect(res.status).toBe(422)
    expect((await res.json()).code).toBe("file_too_large")
    expect(m.upload).not.toHaveBeenCalled()
  })

  it("an understated Content-Length cannot smuggle an oversized file past validation", async () => {
    const POST = await route()
    const { req, formData } = post({ "content-length": "1000" })
    formData.mockResolvedValue(fakeForm({ size: FILE_LIMIT + 1, type: "image/png", name: "big.png" }))
    const res = await POST(req)
    expect(res.status).toBe(422)
    expect(m.upload).not.toHaveBeenCalled()
  })

  it("file at the limit is accepted and uploaded; success response intact", async () => {
    const POST = await route()
    const { req, formData } = post({ "content-length": String(FILE_LIMIT + 1000) })
    formData.mockResolvedValue(fakeForm({ size: FILE_LIMIT, type: "image/png", name: "ok.png" }))
    const res = await POST(req)
    expect(res.status).toBe(200)
    expect((await res.json()).orderId).toBe("11111111-2222-4333-8444-555555555555")
    expect(m.upload).toHaveBeenCalledTimes(1)
  })

  it("MIME validation still applies", async () => {
    const POST = await route()
    const { req, formData } = post({ "content-length": "5000" })
    formData.mockResolvedValue(fakeForm({ size: 100, type: "application/pdf", name: "a.pdf" }))
    const res = await POST(req)
    expect(res.status).toBe(422)
    expect((await res.json()).code).toBe("invalid_file_type")
  })

  it("a timed-out storage upload is a single safe 500 - no retry, no internal text", async () => {
    const POST = await route()
    m.upload.mockResolvedValue({ error: { message: "Request timed out after 25000ms" } })
    const { req, formData } = post({ "content-length": "5000" })
    formData.mockResolvedValue(fakeForm({ size: 100, type: "image/png", name: "a.png" }))
    const res = await POST(req)
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toMatch(/timed out|25000/)
    expect(m.upload).toHaveBeenCalledTimes(1)
    expect(m.create).not.toHaveBeenCalled()
  })
})
