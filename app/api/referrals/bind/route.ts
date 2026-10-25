import { NextResponse } from "next/server"
import { rejectUnsafeBrowserWrite } from "@/lib/security/csrf"
import { withObservability } from "@/lib/observability/request-context"
import { callFailureResponse, flatError, NO_STORE, verifiedCaller } from "@/lib/http/backend-route-responses"
import { bindReferralCode } from "@/lib/referrals/backend-referrals"

const MAX_BODY_BYTES = 1024

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * POST /api/referrals/bind { code } (V0.1.53: PostgreSQL through the backend).
 *
 *   shared CSRF guard -> Supabase Auth verification -> v3 assertion (body digest +
 *   nonce) -> Fastify POST /v1/parent/referrals/bind -> bind_parent_referral_code_trusted
 *
 * The function does everything that matters: parent role, profile lock, program
 * enabled, existing binding (same code = idempotent, other = refused), the
 * 5-per-minute limit, code normalisation, self/unknown = invalid_code, the
 * insert. The browser supplies the code and nothing else. Same statuses and
 * Persian messages as the Supabase route it replaces.
 */
export const POST = withObservability("POST /api/referrals/bind", handlePost)

async function handlePost(request: Request) {
  const rejected = rejectUnsafeBrowserWrite(request)
  if (rejected) return rejected

  const contentLength = request.headers.get("content-length")
  if (contentLength !== null) {
    const len = parseInt(contentLength, 10)
    if (isNaN(len) || len < 0) return flatError("درخواست نامعتبر است.", 400)
    if (len > MAX_BODY_BYTES) return flatError("حجم درخواست بیش از حد مجاز است.", 413)
  }

  const caller = await verifiedCaller()
  if (!caller.ok) return caller.response

  let body: Record<string, unknown>
  try {
    const text = await request.text()
    if (text.length > MAX_BODY_BYTES) return flatError("حجم درخواست بیش از حد مجاز است.", 413)
    body = JSON.parse(text)
  } catch {
    return flatError("فرمت JSON نامعتبر است.", 400)
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) return flatError("فرمت JSON نامعتبر است.", 400)

  const keys = Object.keys(body)
  if (keys.length !== 1 || keys[0] !== "code") return flatError("فیلدهای ناشناخته در درخواست وجود دارد.", 400)
  const code: unknown = body.code
  if (typeof code !== "string" || code.trim().length === 0 || code.length > 100) return flatError("کد معرف نامعتبر است.", 400)

  const result = await bindReferralCode(caller.context, code)
  if (!result.ok) {
    if (result.kind === "refused") return flatError("ثبت کد معرف با خطا مواجه شد.", 500)
    return callFailureResponse(result, "ثبت کد معرف با خطا مواجه شد.")
  }

  switch (result.status) {
    case "bound":
      return NextResponse.json({ status: "bound", message: "کد معرف با موفقیت ثبت شد." }, { status: 200, headers: NO_STORE })
    case "already_bound_same":
      return NextResponse.json({ status: "already_bound", message: "کد معرف قبلاً ثبت شده است." }, { status: 200, headers: NO_STORE })
    case "already_bound_other":
      return flatError("کد معرف این حساب قبلاً ثبت شده است.", 409, "REFERRAL_ALREADY_BOUND")
    case "invalid_code":
      return flatError("کد معرف نامعتبر است.", 422, "REFERRAL_CODE_INVALID")
    case "program_disabled":
      return flatError("برنامه معرفی در حال حاضر فعال نیست.", 409, "REFERRAL_PROGRAM_DISABLED")
    case "rate_limited":
      return flatError("تعداد تلاش‌ها زیاد است. کمی بعد دوباره امتحان کنید.", 429, "REFERRAL_RATE_LIMITED", { ...NO_STORE, "Retry-After": "60" })
    case "profile_not_found":
      return flatError("پروفایل والد کامل نشده است.", 409, "PARENT_PROFILE_NOT_FOUND")
    case "session_expired":
      return flatError("برای ادامه دوباره وارد حساب خود شوید.", 401, "PARENT_SESSION_EXPIRED")
    default:
      return flatError("ثبت کد معرف با خطا مواجه شد.", 500)
  }
}
