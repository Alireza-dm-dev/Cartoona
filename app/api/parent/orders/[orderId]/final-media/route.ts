import { NextResponse } from "next/server"
import { enforceRateLimit, RATE_LIMIT_POLICIES } from "@/lib/rate-limit"
import { createServerSupabaseClient } from "@/lib/supabase/server"
import { checkCurrentParentSessionLifetime } from "@/lib/auth/parent-session-lifetime"
import { createParentSessionFailureResponse } from "@/lib/auth/expired-parent-session-response"
import { isValidOrderId } from "@/lib/parent/orders/detail-queries"
import {
  resolveParentOwnsOrder,
  resolveCurrentParentFinalMedia,
} from "@/lib/parent/orders/final-media-queries"
import {
  parseFinalMediaAction,
  mapOwnershipFailure,
  toFinalMediaSignedResponse,
  FINAL_NOT_READY_ERROR,
  INVALID_ACTION_ERROR,
  SIGNING_FAILED_ERROR,
  type ParentFinalMediaError,
} from "@/lib/parent/orders/final-media-response"
import { createPrivateSignedUrl, PRIVATE_MEDIA_SIGNED_URL_TTL_SECONDS } from "@/lib/storage/private-signed-url"
import { FINAL_DELIVERABLES_BUCKET } from "@/lib/admin/requests/media-validation"
import { recordFinalMediaAudit } from "@/lib/audit/final-media-audit"
import { withObservability, log } from "@/lib/observability/request-context"

/**
 * POST /api/parent/orders/[orderId]/final-media
 *
 * Mints a short-lived signed URL for the parent's own order's current final
 * deliverable. Body: { action?: "view" | "download" }, default "view".
 *
 * Never gates on order.status: the only authorization this route trusts is
 * `resolveCurrentParentFinalMedia`, which requires asset_role=final,
 * delivery_status=approved and parent_visible=true — the same predicate the
 * `final-deliverables` storage RLS policy enforces independently. A signed
 * URL is generated fresh on every call and never persisted.
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
  const { orderId } = await params
  if (!isValidOrderId(orderId)) {
    return errorResponse(mapOwnershipFailure("not_found"))
  }

  const supabase = await createServerSupabaseClient()

  const ownership = await resolveParentOwnsOrder(supabase, orderId)
  if (!ownership.ok) {
    if (ownership.reason === "unauthenticated") {
      return errorResponse(mapOwnershipFailure("unauthenticated"))
    }
    return errorResponse(mapOwnershipFailure(ownership.reason))
  }

  const lifetime = await checkCurrentParentSessionLifetime(supabase)
  if (!lifetime.valid) {
    return createParentSessionFailureResponse(supabase, lifetime)
  }

  // Per parent, AFTER ownership and session checks (so the limiter learns nothing
  // about orders the caller does not own) and BEFORE the body parse, the
  // eligibility query, URL signing and the audit write. A limited request mints
  // no URL.
  const limited = await enforceRateLimit(ownership.userId, RATE_LIMIT_POLICIES.finalMediaSign)
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

  const final = await resolveCurrentParentFinalMedia(supabase, orderId)
  if (!final) {
    return errorResponse(FINAL_NOT_READY_ERROR)
  }

  const url = await createPrivateSignedUrl(
    supabase,
    final.path,
    PRIVATE_MEDIA_SIGNED_URL_TTL_SECONDS,
    FINAL_DELIVERABLES_BUCKET,
    action === "download" ? (final.fileName ?? true) : undefined,
  )

  if (!url) {
    log("error", "FINAL_MEDIA_SIGN_FAILED", {
      subsystem: "storage",
      operation: action === "download" ? "final_media_download" : "final_media_view",
      bucket: FINAL_DELIVERABLES_BUCKET,
      orderId,
      mediaAssetId: final.id,
      mediaType: final.mimeType ?? undefined,
      errorCode: "STORAGE_UNAVAILABLE",
    })
    return errorResponse(SIGNING_FAILED_ERROR)
  }

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (user) {
    // Awaited: a fire-and-forget write can be lost when a serverless instance
    // freezes after the response. A failed write is logged and never fails the
    // response (see recordFinalMediaAudit).
    await recordFinalMediaAudit({
      actorUserId: user.id,
      orderId,
      mediaAssetId: final.id,
      action: action === "download" ? "final_media_download" : "final_media_view",
    })
  }

  const success = toFinalMediaSignedResponse({
    url,
    ttlSeconds: PRIVATE_MEDIA_SIGNED_URL_TTL_SECONDS,
    mediaType: final.mimeType,
    fileName: final.fileName,
  })

  return NextResponse.json(success, { headers: JSON_HEADERS })
}
