import { NextResponse } from "next/server"
import { createServerSupabaseClient } from "@/lib/supabase/server"
import { isAdminRole } from "@/lib/auth/admin-role"
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

function isLocalhostOrigin(origin: string): boolean {
  try {
    const u = new URL(origin)
    return u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]"
  } catch {
    return false
  }
}

function getAllowedOrigins(): string[] {
  const origins: string[] = []
  const envUrl = process.env.NEXT_PUBLIC_SITE_URL
  if (envUrl) {
    origins.push(envUrl.replace(/\/+$/, ""))
  }
  origins.push("http://localhost:3000")
  origins.push("http://localhost:3001")
  return origins
}

function validateOrigin(request: Request): boolean {
  const origin = request.headers.get("origin")
  if (!origin) return true
  const allowed = getAllowedOrigins()
  if (allowed.includes(origin)) return true
  if (isLocalhostOrigin(origin)) return true
  return false
}

export async function PATCH(request: Request) {
  const contentType = request.headers.get("content-type") || ""
  if (!contentType.startsWith("application/json")) {
    return jsonError("فرمت درخواست باید JSON باشد.", 415)
  }

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

  if (!validateOrigin(request)) {
    return jsonError("درخواست از مبدأ نامعتبر.", 403)
  }

  let supabase
  try {
    supabase = await createServerSupabaseClient()
  } catch {
    return jsonError("خطای احراز هویت رخ داد.", 500)
  }

  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) {
    return jsonError("لطفاً ابتدا وارد حساب خود شوید.", 401)
  }

  const { data: roleRow, error: roleError } = await supabase
    .from("users")
    .select("role")
    .eq("id", user.id)
    .maybeSingle()

  if (roleError || !roleRow || !isAdminRole(roleRow.role)) {
    return jsonError("شما مجوز انجام این عملیات را ندارید.", 403)
  }

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

  const { data: rpcData, error: rpcError } = await supabase
    .rpc("update_admin_referral_program_settings", {
      p_is_enabled: req.isEnabled,
      p_reward_basis_points: req.rewardBasisPoints,
      p_expected_updated_at: req.expectedUpdatedAt,
    })

  if (rpcError) {
    return jsonError("خطا در به‌روزرسانی تنظیمات.", 500)
  }

  const row = (Array.isArray(rpcData) ? rpcData[0] : rpcData) as Record<string, unknown> | null
  if (!row || typeof row.status !== "string") {
    return jsonError("خطا در به‌روزرسانی تنظیمات.", 500)
  }

  const status = row.status

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
