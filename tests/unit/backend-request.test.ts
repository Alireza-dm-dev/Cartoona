import { describe, it, expect, vi, beforeEach } from "vitest"

/**
 * The BFF's decision table for the request write (V0.1.50), with the backend
 * client mocked: what each answer - or silence - means for the parent. The
 * database behaviour behind it is proven in request-cutover-db.test.ts.
 */

const m = vi.hoisted(() => ({ write: vi.fn(), read: vi.fn() }))
vi.mock("@/lib/backend/client", () => ({ backendWriteJson: m.write, backendGetJson: m.read }))
vi.mock("@/lib/observability/request-context", () => ({ currentRequestId: () => "req-0000001", log: vi.fn() }))

import { BackendClientError } from "@/lib/backend/errors"
import { createRequestViaBackend, lookupRequestBySubmissionKey, type BackendRequestPayload } from "@/lib/requests/backend-request"
import { parseBackendRequestLookup, parseBackendRequestWrite } from "@/lib/requests/backend-request-response"

const ctx = { identity: { provider: "supabase", subject: "u1" }, authenticatedAt: 1 } as never
const OID = "123e4567-e89b-42d3-a456-426614174000"
const KEY = "11111111-1111-4111-8111-111111111111"
const payload: BackendRequestPayload = {
  submissionKey: KEY, orderId: OID, type: "image", title: null, description: null, character: "Captain Candy", durationKey: null,
  durationChoice: null, videoScript: null, videoStyle: null, animationStyle: null, charactersSpeak: null, childName: null, file: null,
}
const order = { orderId: OID, type: "image", status: "pending_review", candyCost: 12, paymentSource: "candy" as const }

beforeEach(() => {
  m.write.mockReset()
  m.read.mockReset()
})

describe("createRequestViaBackend", () => {
  it("success: the order, confirmed by the write", async () => {
    m.write.mockResolvedValue({ data: { kind: "created", value: { ...order, replayed: false } } })
    expect(await createRequestViaBackend(ctx, payload)).toEqual({ ok: true, order: { ...order, replayed: false }, confirmedBy: "write" })
    expect(m.write).toHaveBeenCalledTimes(1)
    expect(m.write.mock.calls[0][0]).toMatchObject({ method: "POST", path: "/v1/parent/requests", operation: "parent_request_create" })
  })

  it("is ONE attempt: a timeout never re-sends the write (only a read follows)", async () => {
    m.write.mockRejectedValue(new BackendClientError("timeout", null, true))
    m.read.mockResolvedValue({ data: { kind: "absent" } })
    await createRequestViaBackend(ctx, payload)
    expect(m.write).toHaveBeenCalledTimes(1)
    expect(m.read).toHaveBeenCalledTimes(1)
  })

  it.each([
    ["timeout", new BackendClientError("timeout", null, true)],
    ["connection reset", new BackendClientError("unavailable", null, true)],
    ["5xx", new BackendClientError("bad_status", 502, true)],
    ["unreadable 2xx", new BackendClientError("invalid_response", 200, true)],
  ])("%s -> the order is looked up; found = SUCCESS (never 'failed')", async (_l, error) => {
    m.write.mockRejectedValue(error)
    m.read.mockResolvedValue({ data: { kind: "found", value: order } })
    expect(await createRequestViaBackend(ctx, payload)).toEqual({ ok: true, order: { ...order, replayed: false }, confirmedBy: "lookup" })
    expect(m.read.mock.calls[0][0]).toMatchObject({ path: "/v1/parent/requests/by-submission-key", query: { submissionKey: KEY } })
  })

  it("lost answer + lookup says absent -> not_created (retry is safe: same key)", async () => {
    m.write.mockRejectedValue(new BackendClientError("timeout", null, true))
    m.read.mockResolvedValue({ data: { kind: "absent" } })
    expect(await createRequestViaBackend(ctx, payload)).toEqual({ ok: false, reason: "not_created" })
  })

  it("lost answer + lookup fails -> outcome_unknown", async () => {
    m.write.mockRejectedValue(new BackendClientError("timeout", null, true))
    m.read.mockRejectedValue(new BackendClientError("timeout"))
    expect(await createRequestViaBackend(ctx, payload)).toEqual({ ok: false, reason: "outcome_unknown" })
  })

  it("409 replayed_request (this assertion's nonce was used) is treated as 'may have written' and resolved by lookup", async () => {
    m.write.mockResolvedValue({ data: { kind: "rejected", status: 409, error: "replayed_request" } })
    m.read.mockResolvedValue({ data: { kind: "found", value: order } })
    expect(await createRequestViaBackend(ctx, payload)).toMatchObject({ ok: true, confirmedBy: "lookup" })
  })

  it("503 service_unavailable from the write is 'may have written'; 503 CREATION_PRICING_UNAVAILABLE is a definite refusal", async () => {
    m.write.mockResolvedValue({ data: { kind: "rejected", status: 503, error: "service_unavailable" } })
    m.read.mockResolvedValue({ data: { kind: "absent" } })
    expect(await createRequestViaBackend(ctx, payload)).toEqual({ ok: false, reason: "not_created" })
    m.write.mockResolvedValue({ data: { kind: "rejected", status: 503, error: "CREATION_PRICING_UNAVAILABLE" } })
    expect(await createRequestViaBackend(ctx, payload)).toEqual({ ok: false, reason: "refused", error: "CREATION_PRICING_UNAVAILABLE" })
  })

  it("definite refusals carry only the safe token and trigger NO lookup", async () => {
    m.write.mockResolvedValue({ data: { kind: "rejected", status: 402, error: "INSUFFICIENT_CANDIES" } })
    expect(await createRequestViaBackend(ctx, payload)).toEqual({ ok: false, reason: "refused", error: "INSUFFICIENT_CANDIES" })
    m.write.mockResolvedValue({ data: { kind: "rejected", status: 403, error: "request_consent_required" } })
    expect(await createRequestViaBackend(ctx, payload)).toEqual({ ok: false, reason: "refused", error: "request_consent_required" })
    expect(m.read).not.toHaveBeenCalled()
  })

  it("not configured = never sent = definite 'unavailable' (no lookup)", async () => {
    m.write.mockRejectedValue(new BackendClientError("not_configured"))
    expect(await createRequestViaBackend(ctx, payload)).toEqual({ ok: false, reason: "unavailable" })
    expect(m.read).not.toHaveBeenCalled()
  })

  it("session and ownership answers map to the shared reasons", async () => {
    m.write.mockResolvedValue({ data: { kind: "rejected", status: 401, error: "session_expired" } })
    expect(await createRequestViaBackend(ctx, payload)).toEqual({ ok: false, reason: "session_expired" })
    m.write.mockResolvedValue({ data: { kind: "rejected", status: 403, error: "identity_not_linked" } })
    expect(await createRequestViaBackend(ctx, payload)).toEqual({ ok: false, reason: "identity_not_linked" })
    m.write.mockResolvedValue({ data: { kind: "rejected", status: 404, error: "parent_profile_not_found" } })
    expect(await createRequestViaBackend(ctx, payload)).toEqual({ ok: false, reason: "no_parent_profile" })
    // The backend refusing an assertion we just signed is OUR misconfiguration: never a sign-out.
    m.write.mockResolvedValue({ data: { kind: "rejected", status: 401, error: "unauthenticated" } })
    expect(await createRequestViaBackend(ctx, payload)).toEqual({ ok: false, reason: "service_unavailable" })
  })

  it("a programming error is not swallowed", async () => {
    m.write.mockRejectedValue(new TypeError("bug"))
    await expect(createRequestViaBackend(ctx, payload)).rejects.toThrow("bug")
  })
})

describe("lookupRequestBySubmissionKey", () => {
  it("absent, found, and 'could not determine' are three different answers", async () => {
    m.read.mockResolvedValue({ data: { kind: "absent" } })
    expect(await lookupRequestBySubmissionKey(ctx, KEY)).toEqual({ ok: true, found: false })
    m.read.mockResolvedValue({ data: { kind: "found", value: order } })
    expect(await lookupRequestBySubmissionKey(ctx, KEY)).toEqual({ ok: true, found: true, order })
    m.read.mockRejectedValue(new BackendClientError("unavailable"))
    expect(await lookupRequestBySubmissionKey(ctx, KEY)).toEqual({ ok: false, reason: "service_unavailable" })
  })
})

describe("the response validators fail closed", () => {
  it("accept exactly the documented bodies, rebuilt field by field", () => {
    expect(parseBackendRequestWrite({ orderId: OID, type: "image", status: "s", candyCost: 12, replayed: false, paymentSource: "candy", extra: "x", profile: "p" }, 200)).toEqual({
      kind: "created", value: { orderId: OID, type: "image", status: "s", candyCost: 12, paymentSource: "candy", replayed: false },
    })
    expect(parseBackendRequestLookup({ found: false }, 200)).toEqual({ kind: "absent" })
  })

  it.each([
    [{ orderId: "not-a-uuid", type: "i", status: "s", candyCost: 1, replayed: false, paymentSource: "candy" }],
    [{ orderId: OID, type: "i", status: "s", candyCost: -1, replayed: false, paymentSource: "candy" }],
    [{ orderId: OID, type: "i", status: "s", candyCost: 1.5, replayed: false, paymentSource: "candy" }],
    [{ orderId: OID, type: "i", status: "s", candyCost: 1, replayed: "no", paymentSource: "candy" }],
    [null], [[]], ["x"],
  ])("a malformed 200 body is rejected (so the write is 'uncertain', never a guessed success): %j", (body) => {
    expect(() => parseBackendRequestWrite(body, 200)).toThrow()
  })

  it("an unexpected status/error pair is rejected, never echoed", () => {
    expect(() => parseBackendRequestWrite({ error: "boom with 10.0.0.5" }, 422)).toThrow()
    expect(() => parseBackendRequestWrite({ error: "INSUFFICIENT_CANDIES" }, 500)).toThrow()
    expect(() => parseBackendRequestWrite({ error: "replayed_request" }, 402)).toThrow()
    expect(() => parseBackendRequestLookup({ found: "yes" }, 200)).toThrow()
    expect(() => parseBackendRequestLookup({ error: "parent_profile_not_found" }, 500)).toThrow()
  })
})
