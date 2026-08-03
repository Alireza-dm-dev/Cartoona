import { NextResponse } from "next/server"
import { createServerSupabaseClient } from "@/lib/supabase/server"
import { checkCurrentParentSessionLifetime } from "@/lib/auth/parent-session-lifetime"
import { createExpiredParentSessionResponse } from "@/lib/auth/expired-parent-session-response"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const MAX_BODY_BYTES = 4096

function jsonError(message: string, status: number): NextResponse {
  return NextResponse.json(
    { error: message },
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

export async function POST(request: Request) {
  const contentType = request.headers.get("content-type") || ""
  if (!contentType.startsWith("application/json")) {
    return jsonError("فرمت درخواست باید JSON باشد.", 415)
  }

  if (!validateOrigin(request)) {
    return jsonError("درخواست از مبدأ نامعتبر.", 403)
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

  let supabase
  try {
    supabase = await createServerSupabaseClient()
  } catch {
    return jsonError("خطای احراز هویت رخ داد.", 500)
  }

  const { data: { user }, error: userError } = await supabase.auth.getUser()
  if (userError || !user) {
    return jsonError("لطفاً ابتدا وارد حساب خود شوید.", 401)
  }

  const { data: roleRow, error: roleError } = await supabase
    .from("users")
    .select("role")
    .eq("id", user.id)
    .maybeSingle()

  if (roleError || !roleRow || roleRow.role !== "parent") {
    return jsonError("شما مجوز انجام این عملیات را ندارید.", 403)
  }

  const lifetime = await checkCurrentParentSessionLifetime(supabase)
  if (!lifetime.valid) {
    return createExpiredParentSessionResponse(supabase)
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

  const { error: updateError } = await supabase.auth.updateUser({ password })

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
