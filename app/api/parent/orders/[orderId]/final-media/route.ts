import { NextResponse } from "next/server"
import { enforceRateLimit, RATE_LIMIT_POLICIES } from "@/lib/rate-limit"
import { endParentSession } from "@/lib/auth/end-parent-session"
import { SESSION_CHECK_UNAVAILABLE_BODY } from "@/lib/auth/expired-parent-session-response"
import { rejectUnsafeBrowserWrite } from "@/lib/security/csrf"
import { isValidOrderId } from "@/lib/parent/orders/detail-queries"
import { verifyParentCaller } from "@/lib/parent/backend-caller"
import { authorizeFinalMedia, recordFinalMediaAccess } from "@/lib/parent/backend-media"
import {
  parseFinalMediaAction,
  mapOwnershipFailure,
  toFinalMediaSignedResponse,
  FINAL_NOT_READY_ERROR,
  INVALID_ACTION_ERROR,
  SIGNING_FAILED_ERROR,
  type ParentFinalMediaError,
} from "@/lib/parent/orders/final-media-response"
import { PRIVATE_MEDIA_SIGNED_URL_TTL_SECONDS } from "@/lib/storage/private-signed-url"
import { signFinalDeliverable } from "@/lib/storage/final-deliverables"
import { FINAL_DELIVERABLES_BUCKET } from "@/lib/admin/requests/media-validation"
import { withObservability, log } from "@/lib/observability/request-context"

/**
 * POST /api/parent/orders/[orderId]/final-media (V0.1.52)
 *
 * Mints a short-lived signed URL for the parent's own order's current final
 * deliverable. Body: { action?: "view" | "download" }, default "view".
 *
 *   CSRF guard -> Supabase Auth verification (identity only)
 *   -> backend GET /v1/parent/orders/:id/final-media   PostgreSQL decides: the order is the
 *        caller's AND the asset is final + approved + parent-visible. The key comes from
 *        that row; nothing the browser sends names an object.
 *   -> per-parent rate limit
 *   -> Storage signs that key (service credential, bytes only)
 *   -> backend POST .../final-media/access   the audit row (best-effort, logged)
 *
 * Never gates on order.status. Authorization is NOT delegated to Storage
 * policies. Foreign, missing and not-yet-approved all read as 404. If Storage
 * is down the answer is a retryable 500 SIGNING_FAILED and nobody is signed out.
 */

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

const JSON_HEADERS = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } as const

function errorResponse(err: ParentFinalMediaError): NextResponse {
  return NextResponse.json({ error: err.error, code: err.code }, { status: err.status, headers: JSON_HEADERS })
}

export const POST = withObservability(
  "POST /api/parent/orders/[orderId]/final-media",
  handlePost,
)

async function handlePost(
  request: Request,
  { params }: { params: Promise<{ orderId: string }> },
) {
  const rejected = rejectUnsafeBrowserWrite(request)
  if (rejected) return rejected

  const { orderId } = await params
  if (!isValidOrderId(orderId)) {
    return errorResponse(mapOwnershipFailure("not_found"))
  }

  const caller = await verifyParentCaller()
  if (!caller.ok) {
    if (caller.reason === "unauthenticated") return errorResponse(mapOwnershipFailure("unauthenticated"))
    if (caller.reason === "session_expired") {
      await endParentSession()
      return NextResponse.json({ error: "برای ادامه دوباره وارد حساب شوید.", code: "PARENT_SESSION_EXPIRED" }, { status: 401, headers: JSON_HEADERS })
    }
    return NextResponse.json(SESSION_CHECK_UNAVAILABLE_BODY, { status: 503, headers: { ...JSON_HEADERS, "Retry-After": "2" } })
  }

  const authorized = await authorizeFinalMedia(caller.context, orderId.trim())
  if (!authorized.ok) {
    if (authorized.kind === "auth") {
      if (authorized.reason === "session_expired" || authorized.reason === "session_invalidated") {
        await endParentSession()
        return NextResponse.json({ error: "برای ادامه دوباره وارد حساب شوید.", code: "PARENT_SESSION_EXPIRED" }, { status: 401, headers: JSON_HEADERS })
      }
      if (authorized.reason === "service_unavailable") return errorResponse(SIGNING_FAILED_ERROR)
      // not a parent / no profile: indistinguishable from a missing order
      return errorResponse(mapOwnershipFailure("not_parent"))
    }
    if (authorized.kind === "unavailable" || authorized.kind === "invalid") return errorResponse(SIGNING_FAILED_ERROR)
    // 404 covers a foreign order, an unknown order and "no approved final yet".
    return errorResponse(FINAL_NOT_READY_ERROR)
  }

  // Per parent, AFTER ownership is proven (the limiter learns nothing about
  // orders the caller does not own) and BEFORE signing and the audit write.
  const limited = await enforceRateLimit(caller.context.identity.subject, RATE_LIMIT_POLICIES.finalMediaSign)
  if (limited) return limited

  let body: unknown = null
  const contentType = request.headers.get("content-type") || ""
  if (contentType.startsWith("application/json")) {
    try {
      const text = await request.text()
      body = text.trim().length > 0 ? JSON.parse(text) : null
    } catch {
      return errorResponse(INVALID_ACTION_ERROR)
    }
  }

  const parsedAction = parseFinalMediaAction(body)
  if (!parsedAction.ok) {
    return errorResponse(INVALID_ACTION_ERROR)
  }
  const { action } = parsedAction

  const url = await signFinalDeliverable(
    authorized.path,
    PRIVATE_MEDIA_SIGNED_URL_TTL_SECONDS,
    action === "download" ? (authorized.fileName ?? true) : undefined,
  )

  if (!url) {
    log("error", "FINAL_MEDIA_SIGN_FAILED", {
      subsystem: "storage",
      operation: action === "download" ? "final_media_download" : "final_media_view",
      bucket: FINAL_DELIVERABLES_BUCKET,
      orderId,
      mediaAssetId: authorized.assetId,
      mediaType: authorized.mimeType ?? undefined,
      errorCode: "STORAGE_UNAVAILABLE",
    })
    return errorResponse(SIGNING_FAILED_ERROR)
  }

  // Awaited (a detached write can be lost when a serverless instance freezes).
  // A failed audit write is logged and never fails the response.
  const audited = await recordFinalMediaAccess(caller.context, orderId.trim(), authorized.assetId, action)
  if (!audited.ok) {
    log("error", "AUDIT_WRITE_FAILED", {
      subsystem: "audit",
      operation: action === "download" ? "final_media_download" : "final_media_view",
      orderId,
      mediaAssetId: authorized.assetId,
      errorCode: "DATABASE_UNAVAILABLE",
    })
  }

  const success = toFinalMediaSignedResponse({
    url,
    ttlSeconds: PRIVATE_MEDIA_SIGNED_URL_TTL_SECONDS,
    mediaType: authorized.mimeType,
    fileName: authorized.fileName,
  })

  return NextResponse.json(success, { headers: JSON_HEADERS })
}
