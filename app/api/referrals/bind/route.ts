import { NextResponse } from "next/server"
import { rejectUnsafeBrowserWrite } from "@/lib/security/csrf"
import { createServerSupabaseClient } from "@/lib/supabase/server"
import { checkParentSessionLifetime } from "@/lib/auth/parent-session-lifetime"
import { createParentSessionFailureResponse } from "@/lib/auth/expired-parent-session-response"

const MAX_BODY_BYTES = 1024

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

function jsonError(message: string, status: number, code?: string): NextResponse {
  return NextResponse.json(
    code ? { error: message, code } : { error: message },
    { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } },
  )
}

export async function POST(request: Request) {
  // Shared browser-write CSRF guard (V0.1.49, was an ad-hoc Origin check that
  // accepted a missing Origin and any localhost port): JSON content type,
  // Sec-Fetch-Site, and an Origin equal to CARTOONA_APP_ORIGIN. Same 415/403
  // messages as before. lib/security/csrf.ts.
  const rejected = rejectUnsafeBrowserWrite(request)
  if (rejected) return rejected

  // Pre-check content-length
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

  const { data: userRow, error: roleError } = await supabase
    .from("users")
    .select("role")
    .eq("id", user.id)
    .maybeSingle()

  if (roleError || !userRow || userRow.role !== "parent") {
    return jsonError("شما مجوز انجام این عملیات را ندارید.", 403)
  }

  const lifetime = await checkParentSessionLifetime(supabase, user.id)
  if (!lifetime.valid) {
    return createParentSessionFailureResponse(supabase, lifetime)
  }

  // Parse body with size limit
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

  // Validate exact shape
  const keys = Object.keys(body)
  if (keys.length !== 1 || keys[0] !== "code") {
    return jsonError("فیلدهای ناشناخته در درخواست وجود دارد.", 400)
  }

  const code: unknown = body.code
  if (typeof code !== "string" || code.trim().length === 0) {
    return jsonError("کد معرف نامعتبر است.", 400)
  }

  const { data: rpcData, error: rpcError } = await supabase
    .rpc("bind_current_parent_referral_code", { p_code: code })

  if (rpcError) {
    return jsonError("ثبت کد معرف با خطا مواجه شد.", 500)
  }

  const row = (Array.isArray(rpcData) ? rpcData[0] : rpcData) as Record<string, unknown> | null
  if (!row || typeof row.status !== "string") {
    return jsonError("ثبت کد معرف با خطا مواجه شد.", 500)
  }

  const status = row.status

  switch (status) {
    case "bound":
      return NextResponse.json(
        { status: "bound", message: "کد معرف با موفقیت ثبت شد." },
        { status: 200, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } },
      )

    case "already_bound_same":
      return NextResponse.json(
        { status: "already_bound", message: "کد معرف قبلاً ثبت شده است." },
        { status: 200, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } },
      )

    case "already_bound_other":
      return jsonError("کد معرف این حساب قبلاً ثبت شده است.", 409, "REFERRAL_ALREADY_BOUND")

    case "invalid_code":
      return jsonError("کد معرف نامعتبر است.", 422, "REFERRAL_CODE_INVALID")

    case "program_disabled":
      return jsonError("برنامه معرفی در حال حاضر فعال نیست.", 409, "REFERRAL_PROGRAM_DISABLED")

    case "rate_limited":
      return NextResponse.json(
        { error: "تعداد تلاش‌ها زیاد است. کمی بعد دوباره امتحان کنید.", code: "REFERRAL_RATE_LIMITED" },
        {
          status: 429,
          headers: {
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
            "Retry-After": "60",
          },
        },
      )

    case "profile_not_found":
      return jsonError("پروفایل والد کامل نشده است.", 409, "PARENT_PROFILE_NOT_FOUND")

    case "session_expired":
      return jsonError("برای ادامه دوباره وارد حساب خود شوید.", 401, "PARENT_SESSION_EXPIRED")

    default:
      return jsonError("ثبت کد معرف با خطا مواجه شد.", 500)
  }
}
