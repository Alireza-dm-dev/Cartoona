import { NextResponse } from "next/server"
import { rejectUnsafeBrowserWrite } from "@/lib/security/csrf"
import { enforceRateLimit, RATE_LIMIT_POLICIES } from "@/lib/rate-limit"
import { createServerSupabaseClient } from "@/lib/supabase/server"
import { resolveCallerRole } from "@/lib/auth/backend-role"
import { endParentSession } from "@/lib/auth/end-parent-session"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const MAX_BODY_BYTES = 4096

function jsonError(message: string, status: number): NextResponse {
  return NextResponse.json(
    { error: message },
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

  // Who is calling, and may they use this route: Supabase Auth verifies the
  // session; the ROLE and the 30-day / sessions_not_before policy come from
  // PostgreSQL through the backend (V0.1.53; was a Supabase `users` read). The
  // password itself is only ever handled by Supabase Auth below: nothing about
  // it is sent to the backend or stored in PostgreSQL.
  const resolved = await resolveCallerRole()
  if (!resolved.ok) {
    switch (resolved.reason) {
      case "unauthenticated":
        return jsonError("لطفاً ابتدا وارد حساب خود شوید.", 401)
      case "session_expired":
        await endParentSession()
        return jsonError("برای ادامه دوباره وارد حساب خود شوید.", 401)
      case "identity_not_linked":
      case "forbidden":
        return jsonError("شما مجوز انجام این عملیات را ندارید.", 403)
      default:
        return jsonError("بررسی نشست موقتاً ممکن نیست. لطفاً چند لحظه بعد دوباره تلاش کنید.", 503)
    }
  }

  // Per parent, before the (expensive) password update.
  const limited = await enforceRateLimit(resolved.context.identity.subject, RATE_LIMIT_POLICIES.passwordChange)
  if (limited) return limited

  if (resolved.role !== "parent") {
    return jsonError("شما مجوز انجام این عملیات را ندارید.", 403)
  }

  let supabase
  try {
    supabase = await createServerSupabaseClient()
  } catch {
    return jsonError("خطای احراز هویت رخ داد.", 500)
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

  const allowedFields = new Set(["password", "confirmPassword"])
  const extraKeys = Object.keys(body).filter((k) => !allowedFields.has(k))
  if (extraKeys.length > 0) {
    return jsonError("فیلدهای ناشناخته در درخواست وجود دارد.", 400)
  }

  const password = typeof body.password === "string" ? body.password : undefined
  const confirmPassword = typeof body.confirmPassword === "string" ? body.confirmPassword : undefined

  if (!password || !confirmPassword) {
    return jsonError("لطفاً رمز عبور و تکرار آن را وارد کنید.", 400)
  }

  if (password.length < 8) {
    return jsonError("رمز عبور باید حداقل ۸ کاراکتر باشد.", 400)
  }

  if (password.length > 72) {
    return jsonError("رمز عبور نباید بیشتر از ۷۲ کاراکتر باشد.", 400)
  }

  if (password !== confirmPassword) {
    return jsonError("رمز عبور و تکرار آن یکسان نیستند.", 400)
  }

  // The flag is written in the same call as the password, so the account can
  // never be left claiming a credential it does not have. Settings reads it to
  // decide between "set a password" and "change your password"; it is a UI
  // hint only, and login still proves the credential for real.
  const { error: updateError } = await supabase.auth.updateUser({
    password,
    data: { password_set: true },
  })

  if (updateError) {
    const msg = updateError.message.toLowerCase()
    if (msg.includes("session") || msg.includes("reauth") || msg.includes("login") || msg.includes("auth")) {
      return jsonError("لطفاً مجدداً وارد حساب خود شوید و دوباره تلاش کنید.", 401)
    }
    if (msg.includes("weak") || msg.includes("same") || msg.includes("identical")) {
      return jsonError("رمز عبور جدید باید متفاوت از رمز عبور قبلی باشد.", 400)
    }
    return jsonError("تنظیم رمز عبور انجام نشد. لطفاً دوباره تلاش کنید.", 500)
  }

  return NextResponse.json(
    { success: true },
    { headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } },
  )
}
