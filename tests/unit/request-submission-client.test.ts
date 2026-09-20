import { describe, it, expect } from "vitest"
import {
  MAX_UPLOAD_BYTES,
  buildRequestFormData,
  checkUploadFile,
  classifySubmissionError,
  readCreatedOrderId,
  shouldClearDraft,
} from "@/lib/requests/submission-client"

/**
 * The decisions /complete-request makes around a submission.
 *
 * The draft rule is the one that matters most: clearing it on anything other
 * than a confirmed creation loses work the parent cannot get back.
 */

const draft = {
  version: 1,
  type: "image",
  selectedCharacterId: "داینو دودو",
  childName: "آریا",
}

describe("building the request body", () => {
  it("sends the draft alone when there is no source file", () => {
    const built = buildRequestFormData(draft)
    expect(built.ok).toBe(true)
    if (!built.ok) return
    expect(built.formData.get("draft")).toBe(JSON.stringify(draft))
    expect(built.formData.get("file")).toBeNull()
    expect(built.formData.get("sourceAssetId")).toBeNull()
  })

  it("attaches an uploaded file", () => {
    const file = new File(["x"], "photo.png", { type: "image/png" })
    const built = buildRequestFormData(draft, { file })
    expect(built.ok).toBe(true)
    if (!built.ok) return
    expect(built.formData.get("file")).toBe(file)
    expect(built.formData.get("sourceAssetId")).toBeNull()
  })

  it("sends only the asset id for a gallery reuse, never a path", () => {
    const built = buildRequestFormData(draft, {
      galleryAssetId: "11111111-1111-4111-8111-111111111111",
    })
    expect(built.ok).toBe(true)
    if (!built.ok) return
    expect(built.formData.get("sourceAssetId")).toBe("11111111-1111-4111-8111-111111111111")
    expect(built.formData.get("file")).toBeNull()

    // There is no field in the body that could carry a storage path.
    const keys = [...built.formData.keys()]
    expect(keys.sort()).toEqual(["draft", "sourceAssetId"])
  })

  it("refuses both source modes at once rather than choosing one", () => {
    const file = new File(["x"], "photo.png", { type: "image/png" })
    const built = buildRequestFormData(draft, {
      file,
      galleryAssetId: "11111111-1111-4111-8111-111111111111",
    })
    expect(built.ok).toBe(false)
    if (built.ok) return
    expect(built.reason).toBe("ambiguous_source")
  })

  it("treats a blank gallery id as no selection", () => {
    for (const id of ["", "   ", null, undefined]) {
      const built = buildRequestFormData(draft, { galleryAssetId: id })
      expect(built.ok).toBe(true)
      if (!built.ok) return
      expect(built.formData.get("sourceAssetId")).toBeNull()
    }
  })
})

describe("file pre-checks", () => {
  const accepted = ["image/png", "image/jpeg", "image/webp"]

  it("accepts an allowed type within the size limit", () => {
    const file = new File(["x"], "a.png", { type: "image/png" })
    expect(checkUploadFile(file, accepted).ok).toBe(true)
  })

  it("rejects a disallowed type with Persian text", () => {
    const file = new File(["x"], "a.gif", { type: "image/gif" })
    const result = checkUploadFile(file, accepted)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.message).toContain("فرمت")
  })

  it("rejects a file over the limit", () => {
    const file = new File(["x"], "big.png", { type: "image/png" })
    Object.defineProperty(file, "size", { value: MAX_UPLOAD_BYTES + 1 })
    const result = checkUploadFile(file, accepted)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.message).toContain("۱۰ مگابایت")
  })
})

describe("classifying a failure", () => {
  it("reads insufficient candy from the status alone", () => {
    expect(classifySubmissionError(402, undefined)).toBe("insufficient_candy")
    expect(classifySubmissionError(402, "anything")).toBe("insufficient_candy")
  })

  it("reads a pricing outage from the status alone", () => {
    expect(classifySubmissionError(503, "CREATION_PRICING_UNAVAILABLE")).toBe("pricing")
  })

  it("separates upload failures from gallery failures", () => {
    for (const code of ["invalid_file_type", "file_too_large", "upload_failed", "storage_permission_denied"]) {
      expect(classifySubmissionError(422, code), code).toBe("upload")
    }
    for (const code of ["source_asset_unavailable", "source_asset_copy_failed"]) {
      expect(classifySubmissionError(422, code), code).toBe("gallery")
    }
  })

  it("treats an ambiguous source as a validation problem", () => {
    expect(classifySubmissionError(422, "ambiguous_source")).toBe("validation")
    expect(classifySubmissionError(422, "validation_error")).toBe("validation")
  })

  it("degrades an unknown code to a plain retry", () => {
    expect(classifySubmissionError(500, "something_new")).toBe("request")
    expect(classifySubmissionError(409, undefined)).toBe("request")
    // A 422 with no code is still a validation problem.
    expect(classifySubmissionError(422, undefined)).toBe("validation")
  })
})

describe("reading the created order", () => {
  it("returns the canonical id", () => {
    expect(readCreatedOrderId({ orderId: "abc" })).toBe("abc")
  })

  it("returns null for anything unusable", () => {
    for (const body of [null, undefined, {}, { orderId: "" }, { orderId: 7 }, "abc", { id: "abc" }]) {
      expect(readCreatedOrderId(body)).toBeNull()
    }
  })
})

describe("whether the draft may be cleared", () => {
  it("clears only on a confirmed creation", () => {
    expect(shouldClearDraft({ ok: true, body: { orderId: "abc" } })).toBe(true)
  })

  it("keeps the draft on every failure", () => {
    // Each of these would otherwise cost the parent the whole form.
    const failures = [
      { ok: false, body: { error: "موجودی کافی نیست", code: "INSUFFICIENT_CANDIES" } },
      { ok: false, body: { error: "فایل در دسترس نیست", code: "source_asset_unavailable" } },
      { ok: false, body: { error: "خطا", code: "upload_failed" } },
      { ok: false, body: undefined },
    ]
    for (const outcome of failures) {
      expect(shouldClearDraft(outcome)).toBe(false)
    }
  })

  it("keeps the draft when a 200 carries no order id", () => {
    // Ambiguous: the order may exist, but nothing here proves it did.
    expect(shouldClearDraft({ ok: true, body: {} })).toBe(false)
    expect(shouldClearDraft({ ok: true, body: { success: true } })).toBe(false)
  })
})
