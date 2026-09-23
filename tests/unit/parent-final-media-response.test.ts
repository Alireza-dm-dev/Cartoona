import { describe, it, expect } from "vitest"
import {
  parseFinalMediaAction,
  mapOwnershipFailure,
  toFinalMediaSignedResponse,
  FINAL_NOT_READY_ERROR,
  INVALID_ACTION_ERROR,
  SIGNING_FAILED_ERROR,
} from "@/lib/parent/orders/final-media-response"

/**
 * Pure request/response shaping for the parent final-media signed-URL
 * endpoint. No Supabase client involved — these are the rules the route
 * delegates to for parsing the body and shaping every response it can send.
 */

describe("parseFinalMediaAction", () => {
  it("defaults to view when the body is missing or empty", () => {
    expect(parseFinalMediaAction(null)).toEqual({ ok: true, action: "view" })
    expect(parseFinalMediaAction(undefined)).toEqual({ ok: true, action: "view" })
    expect(parseFinalMediaAction({})).toEqual({ ok: true, action: "view" })
  })

  it("accepts an explicit view or download action", () => {
    expect(parseFinalMediaAction({ action: "view" })).toEqual({ ok: true, action: "view" })
    expect(parseFinalMediaAction({ action: "download" })).toEqual({ ok: true, action: "download" })
  })

  it("rejects anything else, including near-misses", () => {
    for (const bad of [
      { action: "delete" },
      { action: "VIEW" },
      { action: 1 },
      { action: null },
      { action: ["view"] },
      "view",
      42,
      ["view"],
    ]) {
      expect(parseFinalMediaAction(bad).ok, JSON.stringify(bad)).toBe(false)
    }
  })
})

describe("mapOwnershipFailure", () => {
  it("maps unauthenticated to 401", () => {
    const err = mapOwnershipFailure("unauthenticated")
    expect(err.status).toBe(401)
    expect(err.code).toBe("UNAUTHENTICATED")
  })

  it("maps every ownership-mismatch reason to the identical 404 shape", () => {
    // Ownership mismatch must be indistinguishable from an order that never
    // existed, so a parent probing another parent's order id learns nothing.
    const notParent = mapOwnershipFailure("not_parent")
    const noProfile = mapOwnershipFailure("no_parent_profile")
    const notFound = mapOwnershipFailure("not_found")
    expect(notParent).toEqual(noProfile)
    expect(noProfile).toEqual(notFound)
    expect(notFound.status).toBe(404)
    expect(notFound.code).toBe("ORDER_NOT_FOUND")
  })
})

describe("static error shapes", () => {
  it("never leak internal detail in their message", () => {
    for (const err of [FINAL_NOT_READY_ERROR, INVALID_ACTION_ERROR, SIGNING_FAILED_ERROR]) {
      expect(err.error).not.toMatch(/[a-z_]{4,}/) // no raw db/internal code, Persian only
      expect(err.error).not.toContain("storage")
      expect(err.error).not.toContain("bucket")
    }
  })

  it("uses distinct codes and sensible statuses", () => {
    expect(FINAL_NOT_READY_ERROR.status).toBe(404)
    expect(INVALID_ACTION_ERROR.status).toBe(422)
    expect(SIGNING_FAILED_ERROR.status).toBe(500)
  })
})

describe("toFinalMediaSignedResponse", () => {
  it("returns exactly url, expiresAt, mediaType and fileName", () => {
    const result = toFinalMediaSignedResponse({
      url: "https://example.supabase.co/storage/v1/object/sign/final-deliverables/orders/x/final/y.png?token=abc",
      ttlSeconds: 300,
      mediaType: "image/png",
      fileName: "کارتون-آریا.png",
    })
    expect(Object.keys(result).sort()).toEqual(["expiresAt", "fileName", "mediaType", "url"])
    expect(result.mediaType).toBe("image/png")
    expect(result.fileName).toBe("کارتون-آریا.png")
  })

  it("expiresAt is ttlSeconds from now, not from some other epoch", () => {
    const before = Date.now()
    const result = toFinalMediaSignedResponse({
      url: "https://example.test/x",
      ttlSeconds: 300,
      mediaType: null,
      fileName: null,
    })
    const expiresMs = new Date(result.expiresAt).getTime()
    const after = Date.now()
    expect(expiresMs).toBeGreaterThanOrEqual(before + 300_000)
    expect(expiresMs).toBeLessThanOrEqual(after + 300_000)
  })

  it("keeps mediaType/fileName null rather than inventing one", () => {
    const result = toFinalMediaSignedResponse({
      url: "https://example.test/x",
      ttlSeconds: 300,
      mediaType: null,
      fileName: null,
    })
    expect(result.mediaType).toBeNull()
    expect(result.fileName).toBeNull()
  })

  it("never carries a storage path, bucket name or asset id", () => {
    const result = toFinalMediaSignedResponse({
      url: "https://example.test/x?token=secret",
      ttlSeconds: 300,
      mediaType: "video/mp4",
      fileName: "video.mp4",
    })
    const serialized = JSON.stringify(result)
    for (const leak of ["bucket", "final-deliverables", "assetId", "asset_id", "storagePath", "file_url"]) {
      expect(serialized).not.toContain(leak)
    }
  })
})
