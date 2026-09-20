/**
 * The decisions the /complete-request page makes around a submission.
 *
 * Kept out of the component so they can be tested directly: which of the two
 * source modes is being sent, what an error status means for the parent, and —
 * the one that costs real work if it is wrong — whether the draft may be
 * discarded. A draft cleared on a failure is a form the parent has to fill in
 * again from memory, so that rule lives here with a test on it rather than
 * inside a click handler.
 *
 * No pricing and no ownership logic appears here. Both belong to the server,
 * and duplicating either would let the page disagree with what actually
 * happened.
 */

/** Mirrors the server's own limit so an oversized file never leaves the device. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024

export type SubmitErrorKind =
  | "validation"
  | "insufficient_candy"
  | "upload"
  | "gallery"
  | "pricing"
  | "request"

/**
 * Translate an API failure into the state the UI distinguishes.
 *
 * Status comes first: 402 and 503 are unambiguous whatever code accompanies
 * them. Everything else is decided by the route's own error code, and an
 * unrecognised code degrades to a plain retry rather than to a guess.
 */
export function classifySubmissionError(status: number, code: unknown): SubmitErrorKind {
  if (status === 402) return "insufficient_candy"
  if (status === 503) return "pricing"

  switch (code) {
    case "invalid_file_type":
    case "file_too_large":
    case "upload_failed":
    case "storage_permission_denied":
      return "upload"
    case "source_asset_unavailable":
    case "source_asset_copy_failed":
      return "gallery"
    case "validation_error":
    case "ambiguous_source":
      return "validation"
    default:
      return status === 422 ? "validation" : "request"
  }
}

export interface SubmissionSource {
  /** A file chosen from the device. */
  file?: File | null
  /** The id of a media asset already in the parent's private gallery. */
  galleryAssetId?: string | null
}

export type BuildFormDataResult =
  | { ok: true; formData: FormData }
  | { ok: false; reason: "ambiguous_source" }

/**
 * Build the multipart body for POST /api/requests.
 *
 * At most one source is attached. Two at once is refused here rather than
 * resolved: the server refuses it too, and silently preferring one would make
 * the request disagree with what the parent selected on screen.
 *
 * For a gallery reuse only the asset id is sent. The storage path is not
 * available to the browser and must never be, which is why there is no
 * parameter for one.
 */
export function buildRequestFormData(
  draft: unknown,
  source: SubmissionSource = {},
): BuildFormDataResult {
  const file = source.file ?? null
  const galleryAssetId =
    typeof source.galleryAssetId === "string" && source.galleryAssetId.trim().length > 0
      ? source.galleryAssetId.trim()
      : null

  if (file && galleryAssetId) return { ok: false, reason: "ambiguous_source" }

  const formData = new FormData()
  formData.set("draft", JSON.stringify(draft))

  if (file) {
    formData.set("file", file)
  } else if (galleryAssetId) {
    formData.set("sourceAssetId", galleryAssetId)
  }

  return { ok: true, formData }
}

/**
 * Whether a file the parent picked can be sent at all.
 *
 * A courtesy check only — the server enforces both rules again against the
 * bytes it actually receives, and the RPC re-derives the MIME type from
 * storage rather than trusting what the browser reported.
 */
export function checkUploadFile(
  file: File,
  acceptedMimeTypes: readonly string[],
): { ok: true } | { ok: false; message: string } {
  if (!acceptedMimeTypes.includes(file.type)) {
    return { ok: false, message: "فرمت این فایل پشتیبانی نمی‌شود. لطفاً یک فایل مجاز انتخاب کنید." }
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return { ok: false, message: "حجم فایل نباید بیشتر از ۱۰ مگابایت باشد." }
  }
  return { ok: true }
}

/**
 * The canonical order id from a success body, or null.
 *
 * Null means the submission cannot be treated as complete even if the HTTP
 * status said 200: without an id there is nowhere to send the parent, and —
 * critically — no basis for discarding their draft.
 */
export function readCreatedOrderId(body: unknown): string | null {
  if (!body || typeof body !== "object") return null
  const id = (body as { orderId?: unknown }).orderId
  return typeof id === "string" && id.length > 0 ? id : null
}

/**
 * Whether the parent's draft may be cleared.
 *
 * True only for a confirmed creation carrying an order id. Every failure, and
 * every ambiguous success, keeps the draft: re-submitting costs the parent a
 * click, whereas a lost draft costs them the whole form.
 */
export function shouldClearDraft(outcome: {
  ok: boolean
  body?: unknown
}): boolean {
  if (!outcome.ok) return false
  return readCreatedOrderId(outcome.body) !== null
}
