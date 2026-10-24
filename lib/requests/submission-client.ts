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
   * The answer was lost and the server could not say whether the order exists
   * (code request_outcome_unknown, or the network dropped). NOT a failure: the
   * UI offers a status check and a retry with the SAME submission key.
   */
  | "uncertain"
  /** The server looked and found no order for the key: a retry is safe (same key). */
  | "not_created"
  /** The request could not be sent at all (backend not reachable / not configured). Retry. */
  | "unavailable"

/**
 * Translate an API failure into the state the UI distinguishes.
 *
 * Status comes first: 402 and 503 are unambiguous whatever code accompanies
 * them. Everything else is decided by the route's own error code, and an
 * unrecognised code degrades to a plain retry rather than to a guess.
 */
export function classifySubmissionError(status: number, code: unknown): SubmitErrorKind {
  if (status === 402) return "insufficient_candy"
  if (code === "request_outcome_unknown") return "uncertain"
  if (code === "request_not_created") return "not_created"
  if (code === "request_unavailable" || code === "SESSION_CHECK_UNAVAILABLE") return "unavailable"
  if (status === 503) return "pricing"

  switch (code) {
    case "invalid_file_type":
    case "file_too_large":
    case "request_too_large":
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
 *
 * `submissionKey` is required: it is the idempotency key for this logical
 * submit attempt, stable across a retry of the same attempt. The caller is
 * responsible for keeping the same key across retries and minting a new one
 * only for a genuinely new logical submission.
 */
export function buildRequestFormData(
  draft: unknown,
  submissionKey: string,
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
  formData.set("submissionKey", submissionKey)

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
 * Whether a failed attempt left NO order behind, so its submission key can be
 * forgotten. Only an answer that PROVES nothing was created qualifies: our own
 * 4xx refusals (validation, consent, insufficient candy, ...). Everything else
 * - a network error, a 5xx, an unreadable body, request_outcome_unknown,
 * request_not_created (the order may still be in flight) - keeps the key.
 */
export function failureProvesNothingCreated(status: number, code: unknown): boolean {
  if (code === "request_outcome_unknown" || code === "request_not_created" || code === "request_unavailable") return false
  return status >= 400 && status < 500
}

export type StatusCheck =
  | { kind: "found"; orderId: string }
  | { kind: "absent" }
  | { kind: "unknown" }

/**
 * Ask the server whether this submission key created an order
 * (GET /api/requests/by-submission-key). One request, never cached, never
 * retried here. Anything but a clear answer is `unknown`, which the UI reports
 * as "could not confirm" - never as "not registered".
 */
export async function checkSubmissionStatus(
  submissionKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<StatusCheck> {
  try {
    const response = await fetchImpl(`/api/requests/by-submission-key?submissionKey=${encodeURIComponent(submissionKey)}`, {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-store",
      credentials: "same-origin",
    })
    if (!response.ok) return { kind: "unknown" }
    const body = (await response.json()) as { found?: unknown; orderId?: unknown }
    if (body.found === false) return { kind: "absent" }
    if (body.found === true && typeof body.orderId === "string" && body.orderId.length > 0) {
      return { kind: "found", orderId: body.orderId }
    }
    return { kind: "unknown" }
  } catch {
    return { kind: "unknown" }
  }
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
