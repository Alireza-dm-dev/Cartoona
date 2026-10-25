import { NextResponse } from "next/server"
import { rejectUnsafeBrowserWrite } from "@/lib/security/csrf"
import { callFailureResponse, verifiedCaller } from "@/lib/http/backend-route-responses"
import { updateReferralSettings } from "@/lib/referrals/backend-referrals"
import type {
  AdminReferralSettingsUpdateRequest,
  AdminReferralSettingsUpdateResponse,
  AdminReferralErrorResponse,
} from "@/lib/referrals/admin-types"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

const MAX_BODY_BYTES = 1024

function jsonError(message: string, status: number, code?: string): NextResponse {
  return NextResponse.json(
    code ? { error: message, code } : { error: message },
    { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } },
  )
}

export async function PATCH(request: Request) {
  // Shared browser-write CSRF guard (V0.1.49, was an ad-hoc Origin check that
  // accepted a missing Origin and any localhost port): JSON content type,
  // Sec-Fetch-Site, and an Origin equal to CARTOONA_APP_ORIGIN. Same 415/403
  // messages as before. lib/security/csrf.ts.
  const rejected = rejectUnsafeBrowserWrite(request)
  if (rejected) return rejected

  const contentLength = request.headers.get("content-length")
  if (contentLength !== null) {
    const len = parseInt(contentLength, 10)
    if (isNaN(len) || len < 0) {
      return jsonError("درخواست نامعتبر است.", 400)
    }
    if (len > MAX_BODY_BYTES) {
      return jsonError("حجم درخواست بیش از حد مجاز است.", 413)
    }
  }

  // Admin role: enforced by the backend (403 for a parent) and inside the
  // trusted function; the verified session is the only caller identity.
  const caller = await verifiedCaller()
  if (!caller.ok) return caller.response

  let body: Record<string, unknown>
  try {
    const text = await request.text()
    if (text.length > MAX_BODY_BYTES) {
      return jsonError("حجم درخواست بیش از حد مجاز است.", 413)
    }
    body = JSON.parse(text)
  } catch {
    return jsonError("فرمت JSON نامعتبر است.", 400)
  }

  const allowedKeys = ["isEnabled", "rewardBasisPoints", "expectedUpdatedAt"]
  const bodyKeys = Object.keys(body)
  const extraKeys = bodyKeys.filter((k) => !allowedKeys.includes(k))
  if (extraKeys.length > 0) {
    return jsonError("فیلدهای ناشناخته در درخواست وجود دارد.", 400)
  }

  if (
    typeof body.isEnabled !== "boolean"
    || typeof body.rewardBasisPoints !== "number"
    || typeof body.expectedUpdatedAt !== "string"
  ) {
    return jsonError("فرمت درخواست نامعتبر است.", 400)
  }

  const req: AdminReferralSettingsUpdateRequest = {
    isEnabled: body.isEnabled,
    rewardBasisPoints: body.rewardBasisPoints,
    expectedUpdatedAt: body.expectedUpdatedAt,
  }

  if (req.rewardBasisPoints < 0 || req.rewardBasisPoints > 10000) {
    const errResp: AdminReferralErrorResponse = {
      error: "تنظیمات برنامه معرفی معتبر نیست.",
      code: "REFERRAL_SETTINGS_INVALID",
    }
    return NextResponse.json(errResp, {
      status: 422,
      headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
    })
  }

  const ts = new Date(req.expectedUpdatedAt)
  if (isNaN(ts.getTime())) {
    return jsonError("فرمت درخواست نامعتبر است.", 400)
  }

  const result = await updateReferralSettings(caller.context, {
    isEnabled: req.isEnabled,
    rewardBasisPoints: req.rewardBasisPoints,
    expectedUpdatedAt: req.expectedUpdatedAt,
  })
  if (!result.ok) {
    if (result.kind === "refused") return jsonError("خطا در به‌روزرسانی تنظیمات.", 500)
    return callFailureResponse(result, "خطا در به‌روزرسانی تنظیمات.")
  }
  const status = result.status
  const row = {
    is_enabled: result.settings.isEnabled,
    reward_basis_points: result.settings.rewardBasisPoints,
    updated_at: result.settings.updatedAt,
  }

  if (status === "conflict") {
    const errResp: AdminReferralErrorResponse = {
      error: "تنظیمات توسط مدیر دیگری تغییر کرده است. اطلاعات را دوباره بارگذاری کنید.",
      code: "REFERRAL_SETTINGS_CONFLICT",
    }
    return NextResponse.json(errResp, {
      status: 409,
      headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
    })
  }

  if (status === "invalid_settings") {
    const errResp: AdminReferralErrorResponse = {
      error: "تنظیمات برنامه معرفی معتبر نیست.",
      code: "REFERRAL_SETTINGS_INVALID",
    }
    return NextResponse.json(errResp, {
      status: 422,
      headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
    })
  }

  if (status === "unauthorized" || status === "forbidden") {
    return jsonError("شما مجوز انجام این عملیات را ندارید.", 403)
  }

  const response: AdminReferralSettingsUpdateResponse = {
    status: status as "updated" | "unchanged",
    settings: {
      isEnabled: Boolean(row.is_enabled ?? false),
      rewardBasisPoints: Number(row.reward_basis_points ?? 0),
      updatedAt: typeof row.updated_at === "string" ? row.updated_at : new Date(0).toISOString(),
    },
  }

  return NextResponse.json(response, {
    status: 200,
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  })
}
