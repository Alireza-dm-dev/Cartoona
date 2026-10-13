import { describe, it, expect } from "vitest"
import { toSubmissionSuccess } from "@/lib/requests/submission-response"
import { parseAndValidateDraft } from "@/lib/requests/request-submission"

/**
 * What a completed submission hands back to the browser.
 *
 * The private-media design depends on the storage path never reaching the
 * client, so the serializer is an allow-list rather than a projection: these
 * tests pin that a widened database row cannot widen the response.
 */

describe("submission success serializer", () => {
  const row = {
    id: "11111111-1111-4111-8111-111111111111",
    type: "image",
    status: "pending_review",
    candy_cost: 12,
  }

  it("returns the canonical order id and nothing structural besides", () => {
    const result = toSubmissionSuccess(row)
    expect(result).toEqual({
      success: true,
      orderId: "11111111-1111-4111-8111-111111111111",
      type: "image",
      status: "pending_review",
      candyCost: 12,
      replayed: false,
      // Added in V0.1.34. A row with no payment_source (predates the column) is candy.
      paymentSource: "candy",
    })
  })

  it("drops any extra column the row happens to carry", () => {
    // The row is what the RPC returns today; a later column must not ride out
    // to the browser just because someone added it to the RETURNS TABLE.
    const widened = {
      ...row,
      file_url: "8f3c/orders/secret-child-photo.png",
      parent_id: "22222222-2222-4222-8222-222222222222",
      assigned_admin_id: "33333333-3333-4333-8333-333333333333",
      moderation_status: "pending",
      internal_note: "do not show",
    }

    const result = toSubmissionSuccess(widened)
    const serialized = JSON.stringify(result)

    expect(Object.keys(result!).sort()).toEqual(
      ["candyCost", "orderId", "paymentSource", "replayed", "status", "success", "type"].sort(),
    )
    for (const leak of ["file_url", "secret-child-photo", "parent_id", "assigned_admin", "internal_note", "parent-uploads"]) {
      expect(serialized).not.toContain(leak)
    }
  })

  it("reports whether the row is a replay of an earlier attempt", () => {
    expect(toSubmissionSuccess({ ...row, replayed: true })?.replayed).toBe(true)
    expect(toSubmissionSuccess({ ...row, replayed: false })?.replayed).toBe(false)
    // Only a literal boolean true counts; anything else defaults to false
    // rather than being coerced.
    expect(toSubmissionSuccess({ ...row, replayed: "true" })?.replayed).toBe(false)
    expect(toSubmissionSuccess(row)?.replayed).toBe(false)
  })

  it("refuses a row with no usable id rather than half-succeeding", () => {
    // A client that redirects to /dashboard/orders/undefined is worse than an
    // honest failure.
    for (const bad of [null, undefined, {}, { id: "" }, { id: 42 }, "nope"]) {
      expect(toSubmissionSuccess(bad)).toBeNull()
    }
  })

  it("keeps a missing optional field null instead of inventing one", () => {
    const result = toSubmissionSuccess({ id: row.id })
    expect(result?.orderId).toBe(row.id)
    expect(result?.type).toBeNull()
    expect(result?.status).toBeNull()
    expect(result?.candyCost).toBeNull()
  })

  it("rejects a non-finite candy cost", () => {
    expect(toSubmissionSuccess({ ...row, candy_cost: NaN })?.candyCost).toBeNull()
    expect(toSubmissionSuccess({ ...row, candy_cost: "12" })?.candyCost).toBeNull()
  })
})

/**
 * The draft→RPC mapping for each request type, checked at the boundary the
 * route actually calls. The price itself is never computed here — that is the
 * RPC's job and is asserted in the guarded stateful spec.
 */

const imageDraft = {
  version: 1,
  createdAt: "2026-09-18T00:00:00.000Z",
  estimatedCandyCost: 12,
  type: "image",
  selectedCharacterId: "داینو دودو",
  sceneDescription: "یک جنگل پر از پروانه",
  style: "کارتونی نرم",
  occasion: "",
  parentNote: "",
  referenceFileName: "photo.png",
  childName: "آریا",
}

const videoDraft = {
  version: 1,
  createdAt: "2026-09-18T00:00:00.000Z",
  estimatedCandyCost: 40,
  type: "video",
  selectedCharacterId: "داینو دودو",
  storyDescription: "ماجرای شب مهتابی",
  duration: "5_10",
  charactersSpeak: true,
  occasion: "",
  parentNote: "",
  referenceFileName: "",
  childName: "آریا",
}

const drawingDraft = {
  version: 1,
  createdAt: "2026-09-18T00:00:00.000Z",
  estimatedCandyCost: 30,
  type: "drawing",
  drawingFileName: "naghashi.png",
  title: "نقاشی من",
  movementType: "پرواز آرام",
  animationDescription: "پرنده پرواز کند",
  backgroundScene: "آسمان آبی",
  duration: "کوتاه",
  parentNote: "",
}

const parse = (d: unknown) => parseAndValidateDraft(JSON.stringify(d))

describe("submit mapping by request type", () => {
  it("maps an image draft onto the RPC arguments", () => {
    const r = parse(imageDraft)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data.type).toBe("image")
    expect(r.data.characterId).toBe("داینو دودو")
    expect(r.data.childName).toBe("آریا")
    // Image carries no duration, script or animation style.
    expect(r.data.durationKey).toBeNull()
    expect(r.data.durationChoice).toBeNull()
    expect(r.data.videoScript).toBeNull()
    expect(r.data.animationStyle).toBeNull()
    expect(r.data.charactersSpeak).toBeNull()
    expect(r.data.title).toBeNull()
  })

  it("maps a video draft onto the RPC arguments", () => {
    const r = parse(videoDraft)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data.type).toBe("video")
    expect(r.data.durationChoice).toBe("5_10")
    expect(r.data.durationKey).toBe("short")
    expect(r.data.charactersSpeak).toBe(true)
    expect(r.data.videoScript).toBe("ماجرای شب مهتابی")
    expect(r.data.childName).toBe("آریا")
  })

  it("maps a drawing draft onto the RPC arguments", () => {
    const r = parse(drawingDraft)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data.type).toBe("drawing_animation")
    expect(r.data.animationStyle).toBe("پرواز آرام")
    expect(r.data.durationKey).toBe("short")
    expect(r.data.title).toBe("نقاشی من")
    expect(r.data.characterId).toBeNull()
    // The drawing form does not collect a child name in this phase, and the
    // parser must not invent one.
    expect(r.data.childName).toBeNull()
  })

  it("carries the child name structurally, never folded into the description", () => {
    for (const draft of [imageDraft, videoDraft]) {
      const r = parse(draft)
      expect(r.ok).toBe(true)
      if (!r.ok) return
      expect(r.data.childName).toBe("آریا")
      expect(r.data.description).not.toContain("آریا")
    }
  })

  it("rejects an unsupported request type", () => {
    const r = parse({ ...imageDraft, type: "hologram" })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors[0].field).toBe("type")
  })

  it("rejects an unsupported draft version", () => {
    const r = parse({ ...imageDraft, version: 2 })
    expect(r.ok).toBe(false)
  })

  it("ignores a client-supplied price entirely", () => {
    // estimatedCandyCost is a display value from the public form. Nothing the
    // browser says about money survives into the RPC arguments.
    const tampered = parse({ ...imageDraft, estimatedCandyCost: 0 })
    const honest = parse(imageDraft)
    expect(tampered.ok && honest.ok).toBe(true)
    if (!tampered.ok || !honest.ok) return
    expect(tampered.data).toEqual(honest.data)
    expect(JSON.stringify(tampered.data)).not.toContain("estimatedCandyCost")
    expect(Object.keys(tampered.data)).not.toContain("candyCost")
  })

  it("ignores a client-supplied storage path", () => {
    // A draft field naming a path must not become one: the route derives the
    // path from the authenticated user id and the new order id.
    const r = parse({ ...imageDraft, referenceFileName: "../../other-user/secret.png" })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    // fileName is a display label only; it is never used to build a path.
    expect(r.data.fileName).toBe("../../other-user/secret.png")
    expect(Object.keys(r.data)).not.toContain("filePath")
    expect(Object.keys(r.data)).not.toContain("storagePath")
  })
})
