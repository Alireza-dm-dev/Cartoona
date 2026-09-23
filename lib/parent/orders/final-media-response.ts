/**
 * Pure request/response shaping for POST /api/parent/orders/[orderId]/final-media.
 *
 * Kept out of the route so the safe-error mapping and the safe-response shape
 * can be tested without a Supabase client: what a raw ownership/eligibility
 * failure becomes on the wire, and what is — and deliberately is not —
 * included in a successful body.
 */

export type FinalMediaAction = "view" | "download"

export type ParentFinalMediaErrorCode =
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "ORDER_NOT_FOUND"
  | "FINAL_NOT_READY"
  | "INVALID_ACTION"
  | "SIGNING_FAILED"

export interface ParentFinalMediaError {
  status: number
  code: ParentFinalMediaErrorCode
  error: string
}

/**
 * Parses `{ action?: "view" | "download" }` from an already-JSON-parsed body.
 * Missing action defaults to "view" — a preview is the safer default; a
 * download is only ever triggered by an explicit request.
 */
export type ParseActionResult =
  | { ok: true; action: FinalMediaAction }
  | { ok: false }

export function parseFinalMediaAction(body: unknown): ParseActionResult {
  if (body === null || body === undefined) return { ok: true, action: "view" }
  if (typeof body !== "object" || Array.isArray(body)) return { ok: false }
  const raw = (body as Record<string, unknown>).action
  if (raw === undefined) return { ok: true, action: "view" }
  if (raw === "view" || raw === "download") return { ok: true, action: raw }
  return { ok: false }
}

/**
 * Maps an ownership/eligibility failure onto a safe HTTP response.
 *
 * `not_parent`, `no_parent_profile` and `not_found` all become the identical
 * 404 "ORDER_NOT_FOUND" — an ownership mismatch must be indistinguishable
 * from an order that never existed, so this is the one place that rule is
 * enforced for this endpoint.
 */
export function mapOwnershipFailure(
  reason: "unauthenticated" | "not_parent" | "no_parent_profile" | "not_found",
): ParentFinalMediaError {
  if (reason === "unauthenticated") {
    return { status: 401, code: "UNAUTHENTICATED", error: "لطفاً ابتدا وارد حساب خود شوید." }
  }
  // not_parent / no_parent_profile / not_found: identical shape, on purpose.
  return { status: 404, code: "ORDER_NOT_FOUND", error: "سفارش مورد نظر یافت نشد." }
}

export const FINAL_NOT_READY_ERROR: ParentFinalMediaError = {
  status: 404,
  code: "FINAL_NOT_READY",
  error: "فایل نهایی این سفارش هنوز آماده نیست.",
}

export const INVALID_ACTION_ERROR: ParentFinalMediaError = {
  status: 422,
  code: "INVALID_ACTION",
  error: "درخواست نامعتبر است.",
}

export const SIGNING_FAILED_ERROR: ParentFinalMediaError = {
  status: 500,
  code: "SIGNING_FAILED",
  error: "دسترسی به فایل در حال حاضر ممکن نیست. لطفاً دوباره تلاش کنید.",
}

export interface FinalMediaSignedResponse {
  url: string
  expiresAt: string
  mediaType: string | null
  fileName: string | null
}

/**
 * Builds the exact safe body returned on success — url, expiry, mime type and
 * a display file name. Nothing else: no storage path, no bucket name, no
 * asset id, no admin metadata. A field added to the row upstream cannot widen
 * this response, because this function is the only constructor of it.
 */
export function toFinalMediaSignedResponse(input: {
  url: string
  ttlSeconds: number
  mediaType: string | null
  fileName: string | null
}): FinalMediaSignedResponse {
  return {
    url: input.url,
    expiresAt: new Date(Date.now() + input.ttlSeconds * 1000).toISOString(),
    mediaType: input.mediaType,
    fileName: input.fileName,
  }
}
