import "server-only"

import { NextResponse } from "next/server"
import { endParentSession } from "@/lib/auth/end-parent-session"
import { SESSION_CHECK_UNAVAILABLE_BODY } from "@/lib/auth/expired-parent-session-response"
import type { ParentBackendFailure } from "@/lib/parent/backend-caller"
import type { PurchaseCallFailure } from "./backend-purchases"

/** Shared answers of the V0.1.51 purchase BFF routes (Persian texts unchanged from the Supabase routes). */

export const NO_STORE = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } as const
const RETRY = { ...NO_STORE, "Retry-After": "2" } as const

/** Old routes answered `{ error: string }` (create/history) or `{ error: { code, message } }` (coupon/complete). */
export type ErrorShape = "flat" | "coded"

export function errorJson(shape: ErrorShape, code: string, message: string, status: number, headers: Record<string, string> = NO_STORE) {
  return NextResponse.json(shape === "flat" ? { error: message, code } : { error: { code, message } }, { status, headers })
}

export async function callerFailure(
  shape: ErrorShape,
  reason: ParentBackendFailure | "unauthenticated" | "auth_unavailable",
): Promise<NextResponse> {
  switch (reason) {
    case "unauthenticated":
      return errorJson(shape, "UNAUTHENTICATED", "لطفاً ابتدا وارد حساب خود شوید.", 401)
    case "session_expired":
    case "session_invalidated":
      await endParentSession()
      return errorJson(shape, "PARENT_SESSION_EXPIRED", "برای ادامه دوباره وارد حساب شوید.", 401)
    case "identity_not_linked":
    case "forbidden":
      return errorJson(shape, "FORBIDDEN", "شما مجوز انجام این عملیات را ندارید.", 403)
    case "no_parent_profile":
      return errorJson(shape, "PARENT_PROFILE_NOT_FOUND", "پروفایل والد یافت نشد.", 400)
    case "auth_unavailable":
      return NextResponse.json(SESSION_CHECK_UNAVAILABLE_BODY, { status: 503, headers: RETRY })
    case "service_unavailable":
      return errorJson(shape, "SERVICE_UNAVAILABLE", "این عملیات موقتاً ممکن نیست. لطفاً چند لحظه بعد دوباره تلاش کنید.", 503, RETRY)
  }
}

/** A backend failure that is not a business refusal (refusals are mapped per route). */
export async function backendFailure(shape: ErrorShape, failure: Exclude<PurchaseCallFailure, { kind: "refused" }>): Promise<NextResponse> {
  if (failure.kind === "auth") return callerFailure(shape, failure.reason)
  // No money moves on these calls, so even an uncertain outcome is "try again".
  return errorJson(shape, failure.outcomeUnknown ? "OUTCOME_UNKNOWN" : "SERVICE_UNAVAILABLE", "این عملیات موقتاً ممکن نیست. لطفاً چند لحظه بعد دوباره تلاش کنید.", 503, RETRY)
}

/** Body of a guarded browser JSON write, capped. Null = already answered. */
export async function readJsonBody(request: Request, maxBytes: number, shape: ErrorShape): Promise<Record<string, unknown> | NextResponse> {
  const declared = request.headers.get("content-length")
  if (declared !== null && !(/^\d+$/.test(declared.trim()) && Number(declared) <= maxBytes)) {
    return errorJson(shape, "REQUEST_TOO_LARGE", "حجم درخواست بیش از حد مجاز است.", 413)
  }
  const text = await request.text()
  if (text.length > maxBytes) return errorJson(shape, "REQUEST_TOO_LARGE", "حجم درخواست بیش از حد مجاز است.", 413)
  if (text.length === 0) return {}
  try {
    const body = JSON.parse(text)
    if (body === null || typeof body !== "object" || Array.isArray(body)) return errorJson(shape, "INVALID_JSON", "فرمت JSON نامعتبر است.", 400)
    return body as Record<string, unknown>
  } catch {
    return errorJson(shape, "INVALID_JSON", "فرمت JSON نامعتبر است.", 400)
  }
}
