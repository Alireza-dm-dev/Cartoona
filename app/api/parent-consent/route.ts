import { NextResponse } from "next/server"
import { endParentSession } from "@/lib/auth/end-parent-session"
import { SESSION_CHECK_UNAVAILABLE_BODY } from "@/lib/auth/expired-parent-session-response"
import { verifyParentCaller } from "@/lib/parent/backend-caller"
import { grantParentConsent, loadParentConsent, type ParentConsentFailure } from "@/lib/parent/consent/backend-consent"
import { withObservability } from "@/lib/observability/request-context"
import { rejectUnsafeBrowserWrite } from "@/lib/security/csrf"

/**
 * The parent's consent (V0.1.48: PostgreSQL only; Supabase is the identity
 * provider and nothing else here).
 *
 * POST - the first browser-facing write on the new architecture:
 *
 *   browser -> rejectUnsafeBrowserWrite (CSRF: JSON, Origin, Sec-Fetch-Site)
 *   -> Supabase Auth verification (amr sign-in time, 30 days)
 *   -> v3 assertion (body digest + one-time nonce) -> Fastify POST /v1/parent/consent
 *   -> record_parent_consent_trusted() in PostgreSQL
 *
 *   body exactly { consentGranted: true }   (unchanged contract)
 *   200 { success: true, consentGranted: true, consentGrantedAt }   STORED time of the first grant
 *   400 malformed JSON / 413 body over 1 KiB / 422 other keys or value (unchanged)
 *   401 code unauthenticated | PARENT_SESSION_EXPIRED (local sign-out)
 *   403 code csrf_rejected | identity_not_linked | forbidden | no_parent_profile
 *   415 code unsupported_media_type
 *   503 code consent_outcome_unknown   the write may have committed; a fresh
 *                                       read did not confirm it. NOT "failed".
 *   503 code SESSION_CHECK_UNAVAILABLE | service_unavailable   definitely not written
 *
 * GET - the caller's consent, for the /login decision and the "check again"
 * step after an uncertain write. No CSRF check (no side effect).
 *
 *   200 { consentGranted: boolean }    a parent without a profile reads false (as before)
 *   401 / 403 / 503 as above; 503 code service_unavailable = could not determine.
 *
 * No user or profile id is accepted from the browser anywhere; the backend
 * derives the parent from the assertion. Nothing is retried automatically.
 */
export const dynamic = "force-dynamic"
export const runtime = "nodejs"

const NO_STORE = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } as const
const RETRY = { ...NO_STORE, "Retry-After": "2" } as const
const MAX_BODY_BYTES = 1024
const SUPPORTED_FIELDS = new Set(["consentGranted"])

const LOGIN = "لطفاً ابتدا وارد حساب خود شوید."
const SIGN_IN_AGAIN = "برای ادامه دوباره وارد حساب شوید."
const NOT_ALLOWED = "شما مجوز انجام این عملیات را ندارید."
const NO_PROFILE = "پروفایل والد یافت نشد. لطفاً با پشتیبانی تماس بگیرید."
const UNAVAILABLE = "این عملیات موقتاً ممکن نیست. لطفاً چند لحظه بعد دوباره تلاش کنید."
const OUTCOME_UNKNOWN = "نتوانستیم تأیید کنیم که رضایت شما ثبت شده است یا نه. لطفاً وضعیت را بررسی کنید و در صورت نیاز دوباره تلاش کنید."

const json = (body: unknown, status: number, headers: Record<string, string> = NO_STORE) =>
  NextResponse.json(body, { status, headers })

async function failure(reason: ParentConsentFailure): Promise<NextResponse> {
  switch (reason) {
    case "unauthenticated":
      return json({ error: LOGIN, code: "unauthenticated" }, 401)
    case "session_expired":
    case "session_invalidated":
      await endParentSession()
      return json({ error: SIGN_IN_AGAIN, code: "PARENT_SESSION_EXPIRED" }, 401)
    case "identity_not_linked":
    case "forbidden":
      return json({ error: NOT_ALLOWED, code: reason }, 403)
    case "auth_unavailable":
      return json(SESSION_CHECK_UNAVAILABLE_BODY, 503, RETRY)
    case "service_unavailable":
      return json({ error: UNAVAILABLE, code: "service_unavailable" }, 503, RETRY)
  }
}

async function handlePost(request: Request) {
  const rejected = rejectUnsafeBrowserWrite(request)
  if (rejected) return rejected

  const caller = await verifyParentCaller()
  if (!caller.ok) return failure(caller.reason)

  const declared = request.headers.get("content-length")
  if (declared !== null && !(/^\d+$/.test(declared.trim()) && Number(declared) <= MAX_BODY_BYTES)) {
    return json({ error: "Request body too large" }, 413)
  }
  const raw = await request.text()
  if (raw.length > MAX_BODY_BYTES) return json({ error: "Request body too large" }, 413)

  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    return json({ error: "Malformed request body" }, 400)
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return json({ error: "Malformed request body" }, 400)
  }
  if (Object.keys(body).some((k) => !SUPPORTED_FIELDS.has(k))) {
    return json({ error: "Unsupported fields" }, 422)
  }
  if ((body as { consentGranted?: unknown }).consentGranted !== true) {
    return json({ error: "Invalid consent value" }, 422)
  }

  const result = await grantParentConsent(caller.context)
  if (result.ok) {
    return json({ success: true, consentGranted: true, consentGrantedAt: result.consentGrantedAt }, 200)
  }
  switch (result.reason) {
    case "outcome_unknown":
      return json({ error: OUTCOME_UNKNOWN, code: "consent_outcome_unknown" }, 503, NO_STORE)
    case "no_parent_profile":
      return json({ error: NO_PROFILE, code: "no_parent_profile" }, 403)
    default:
      return failure(result.reason)
  }
}

async function handleGet() {
  const result = await loadParentConsent()
  if (!result.ok) return failure(result.reason)
  return json({ consentGranted: result.status === "granted" }, 200)
}

export const POST = withObservability("POST /api/parent-consent", handlePost)
export const GET = withObservability("GET /api/parent-consent", handleGet)
