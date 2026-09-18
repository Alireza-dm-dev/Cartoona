import { NextResponse } from "next/server"
import { createServerClient } from "@supabase/ssr"
import { getSupabaseEnv } from "@/lib/supabase/env"
import { createAdminSupabaseClient } from "@/lib/supabase/admin"
import {
  toCanonicalIranPhone,
  deriveDevEmail,
  isDevAuthEnabled,
  isLocalhost,
  generateOtpChallenge,
  consumeOtpChallenge,
  type OtpFailureReason,
} from "@/lib/auth/dev-parent-auth"
import {
  listUsers as apiListUsers,
  createUser as apiCreateUser,
  deleteUser as apiDeleteUser,
  generateMagicLinkToken,
} from "@/lib/auth/dev-auth-admin"

const ALLOWED_ACTIONS = new Set([
  "signup_request_code",
  "signup_verify_code",
  "login_request_code",
  "login_verify_code",
  "password_login",
])

const ACTION_FIELDS: Record<string, Set<string>> = {
  // Signup is phone + code only. A name or a password sent here is an
  // unsupported field and is rejected rather than quietly ignored, so a stale
  // client cannot half-work against the new contract.
  signup_request_code: new Set(["action", "phone"]),
  signup_verify_code: new Set(["action", "phone", "code", "challengeToken"]),
  login_request_code: new Set(["action", "phone"]),
  login_verify_code: new Set(["action", "phone", "code", "challengeToken"]),
  password_login: new Set(["action", "phone", "password"]),
}

function getHost(request: Request): string {
  return request.headers.get("host") || request.headers.get("x-forwarded-host") || ""
}

function jsonError(message: string, status: number): NextResponse {
  return NextResponse.json(
    { error: message },
    { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } },
  )
}

function validateBody(body: Record<string, unknown>, allowedFields: Set<string>): void {
  const extraKeys = Object.keys(body).filter((k) => !allowedFields.has(k))
  if (extraKeys.length > 0) {
    throw new Error("unsupported_fields")
  }
}

function normalizeAndValidatePhone(raw: string): string {
  const canonical = toCanonicalIranPhone(raw)
  if (!canonical) throw new Error("invalid_phone")
  return canonical
}

const INVALID_PHONE_MESSAGE =
  "شماره موبایل وارد شده معتبر نیست. لطفاً یک شماره موبایل ایران (مثلاً 09123456789) وارد کنید."

/**
 * The only answer password login ever gives on failure.
 *
 * It is deliberately identical for a wrong password, an unknown phone, and an
 * account that has no password at all. Saying "this account has no password"
 * would be more helpful, but it would also turn this endpoint into an oracle
 * for whether any given phone number has an account. The OTP alternative is
 * named in the same breath, which is the help a parent in that state actually
 * needs.
 */
const PASSWORD_LOGIN_FAILED_MESSAGE =
  "شماره موبایل یا رمز عبور صحیح نیست. اگر برای این حساب رمز عبور تنظیم نکرده‌اید، با «ورود با کد» وارد شوید."


/**
 * Maps an OTP failure to a message that is honest about the code itself.
 *
 * The previous handler answered every failure — including "no account for this
 * phone" — with the same "wrong phone or code" string, which is why a correct
 * displayed code looked rejected. Code-specific failures now say so, and
 * account-state failures are reported separately by the caller.
 */
function otpErrorMessage(reason: OtpFailureReason): string {
  switch (reason) {
    case "expired":
      return "کد تأیید منقضی شده است. لطفاً کد جدید درخواست کنید."
    case "already_used":
      return "این کد قبلاً استفاده شده است. لطفاً کد جدید درخواست کنید."
    case "too_many_attempts":
      return "تعداد تلاش‌های نادرست بیش از حد مجاز بود. لطفاً کد جدید درخواست کنید."
    default:
      return "کد تأیید نادرست است. لطفاً دوباره تلاش کنید."
  }
}

async function findUserByPhone(
  normalizedPhone: string,
  devEmail: string,
) {
  const users = await apiListUsers()
  const cleanPhone = normalizedPhone.replace(/^\+/, "")

  for (const u of users) {
    if (u.email === devEmail) return u
    const userPhone = (u.phone || "").replace(/^\+?/, "")
    if (userPhone === cleanPhone) return u
    if (u.user_metadata?.normalized_phone === normalizedPhone) return u
  }

  return null
}

async function createSessionViaMagicLink(
  email: string,
  env: { NEXT_PUBLIC_SUPABASE_URL: string; NEXT_PUBLIC_SUPABASE_ANON_KEY: string },
): Promise<NextResponse | null> {
  const responseCookies: Array<{ name: string; value: string; options: Record<string, unknown> }> = []

  const supabase = createServerClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll() {
          return []
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => {
            responseCookies.push({ name, value, options })
          })
        },
      },
    },
  )

  const { hashedToken } = await generateMagicLinkToken(email)

  const { data, error } = await supabase.auth.verifyOtp({
    token_hash: hashedToken,
    type: "email",
  })

  if (error || !data.user) return null

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null

  const { data: roleRow } = await supabase
    .from("users")
    .select("role")
    .eq("id", user.id)
    .maybeSingle()
  const role = roleRow?.role

  if (role !== "parent") return null

  const { data: profileRow } = await supabase
    .from("parent_profiles")
    .select("consent_granted")
    .eq("user_id", user.id)
    .maybeSingle()
  const consentGranted = profileRow?.consent_granted ?? false

  const next = consentGranted ? "/dashboard" : "/parent-consent"

  const response = NextResponse.json(
    { success: true, next },
    { headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } },
  )

  for (const cookie of responseCookies) {
    response.cookies.set(cookie.name, cookie.value, cookie.options)
  }

  return response
}

async function createSessionViaPassword(
  email: string,
  password: string,
  env: { NEXT_PUBLIC_SUPABASE_URL: string; NEXT_PUBLIC_SUPABASE_ANON_KEY: string },
): Promise<NextResponse | null> {
  const responseCookies: Array<{ name: string; value: string; options: Record<string, unknown> }> = []

  const supabase = createServerClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll() {
          return []
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => {
            responseCookies.push({ name, value, options })
          })
        },
      },
    },
  )

  const { error } = await supabase.auth.signInWithPassword({ email, password })
  if (error) return null

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null

  const { data: roleRow } = await supabase
    .from("users")
    .select("role")
    .eq("id", user.id)
    .maybeSingle()
  const role = roleRow?.role

  if (role !== "parent") return null

  const { data: profileRow } = await supabase
    .from("parent_profiles")
    .select("consent_granted")
    .eq("user_id", user.id)
    .maybeSingle()
  const consentGranted = profileRow?.consent_granted ?? false

  const next = consentGranted ? "/dashboard" : "/parent-consent"

  const response = NextResponse.json(
    { success: true, next },
    { headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } },
  )

  for (const cookie of responseCookies) {
    response.cookies.set(cookie.name, cookie.value, cookie.options)
  }

  return response
}

function readPassword(body: Record<string, unknown>): string {
  return typeof body.password === "string" ? body.password : ""
}

/**
 * Issue a signup code for a phone number that does not yet have an account.
 *
 * Phone is the only input. The "already registered" answer here is not an
 * enumeration leak the way it would be on the password path: this is the
 * signup form, where the parent is asserting the number is theirs and needs to
 * be told to log in instead of being sent in a circle.
 */
async function handleSignupRequestCode(body: Record<string, unknown>) {
  const phone = normalizeAndValidatePhone(body.phone as string)

  const devEmail = deriveDevEmail(phone)
  const existing = await findUserByPhone(phone, devEmail)
  if (existing) {
    return jsonError("برای این شماره حسابی وجود دارد. از صفحه ورود استفاده کنید.", 409)
  }

  const challenge = generateOtpChallenge("signup", phone)

  return NextResponse.json(
    {
      success: true,
      challengeToken: challenge.challengeToken,
      developmentCode: challenge.developmentCode,
      expiresInSeconds: challenge.expiresInSeconds,
    },
    { headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } },
  )
}

/**
 * Verify the signup code and create the parent account.
 *
 * The account is created with no password at all. Supabase is happy to hold a
 * passwordless identity, and the parent can add one later from Settings; what
 * must not happen is this route inventing a password on their behalf, because
 * a credential the parent never chose is one they can neither use nor revoke.
 *
 * With no password to sign in with, the session comes from the magic-link
 * mechanism the login path has always used — the same code path, so signup and
 * OTP login now establish a session identically.
 */
async function handleSignupVerifyCode(
  body: Record<string, unknown>,
  env: { NEXT_PUBLIC_SUPABASE_URL: string; NEXT_PUBLIC_SUPABASE_ANON_KEY: string },
) {
  const phone = normalizeAndValidatePhone(body.phone as string)

  const code = typeof body.code === "string" ? body.code.trim() : ""
  if (!/^\d{6}$/.test(code)) {
    return jsonError("کد تأیید نادرست است. لطفاً دوباره تلاش کنید.", 400)
  }

  const challengeToken = typeof body.challengeToken === "string" ? body.challengeToken : ""
  if (!challengeToken) {
    return jsonError("درخواست نامعتبر است.", 400)
  }

  const verification = consumeOtpChallenge(challengeToken, "signup", phone, code)
  if (!verification.ok) {
    return jsonError(otpErrorMessage(verification.reason), 401)
  }

  const devEmail = deriveDevEmail(phone)
  const existing = await findUserByPhone(phone, devEmail)
  if (existing) {
    // Retrying a consumed signup must not produce a second identity or a second
    // profile row; the parent is sent to login instead.
    return jsonError("برای این شماره حسابی وجود دارد. از صفحه ورود استفاده کنید.", 409)
  }

  let createdUser
  try {
    createdUser = await apiCreateUser({
      email: devEmail,
      email_confirm: true,
      // No `password` key: the identity is created without one. `password_set`
      // records that fact for the account UI; /api/parent/password flips it
      // when the parent chooses a password later.
      user_metadata: {
        normalized_phone: phone,
        dev_parent: true,
        password_set: false,
      },
    })
  } catch {
    return jsonError("ثبت‌نام انجام نشد. لطفاً دوباره تلاش کنید.", 500)
  }

  const userId = createdUser.id

  const admin = createAdminSupabaseClient()
  // full_name is omitted, not blanked: signup never asks for a name, and the
  // column is nullable precisely so no placeholder has to be invented here.
  const { error: profileError } = await admin.from("parent_profiles").insert({
    user_id: userId,
    consent_granted: false,
    consent_granted_at: null,
  })

  if (profileError) {
    await apiDeleteUser(userId).catch(() => {})
    return jsonError("ثبت‌نام انجام نشد. لطفاً دوباره تلاش کنید.", 500)
  }

  const sessionResponse = await createSessionViaMagicLink(devEmail, env)
  if (!sessionResponse) {
    await apiDeleteUser(userId).catch(() => {})
    return jsonError("ورود به حساب انجام نشد. لطفاً دوباره تلاش کنید.", 500)
  }

  return sessionResponse
}

async function handleLoginRequestCode(body: Record<string, unknown>) {
  const phone = normalizeAndValidatePhone(body.phone as string)

  // A code is only issued for a phone that can actually complete the login.
  // Issuing one for an unknown phone is what made a correct displayed code look
  // rejected at the verify step.
  const devEmail = deriveDevEmail(phone)
  const user = await findUserByPhone(phone, devEmail)
  if (!user) {
    return jsonError("برای این شماره حسابی ثبت نشده است. لطفاً ابتدا ثبت‌نام کنید.", 404)
  }

  const challenge = generateOtpChallenge("login", phone)

  return NextResponse.json(
    {
      success: true,
      challengeToken: challenge.challengeToken,
      developmentCode: challenge.developmentCode,
      expiresInSeconds: challenge.expiresInSeconds,
    },
    { headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } },
  )
}

async function handleLoginVerifyCode(
  body: Record<string, unknown>,
  env: { NEXT_PUBLIC_SUPABASE_URL: string; NEXT_PUBLIC_SUPABASE_ANON_KEY: string },
) {
  const phone = normalizeAndValidatePhone(body.phone as string)

  const code = typeof body.code === "string" ? body.code.trim() : ""
  if (!/^\d{6}$/.test(code)) {
    return jsonError("کد تأیید نادرست است. لطفاً دوباره تلاش کنید.", 401)
  }

  const challengeToken = typeof body.challengeToken === "string" ? body.challengeToken : ""
  if (!challengeToken) {
    return jsonError("درخواست نامعتبر است.", 400)
  }

  const verification = consumeOtpChallenge(challengeToken, "login", phone, code)
  if (!verification.ok) {
    return jsonError(otpErrorMessage(verification.reason), 401)
  }

  const devEmail = deriveDevEmail(phone)
  const user = await findUserByPhone(phone, devEmail)
  if (!user) {
    return jsonError("برای این شماره حسابی ثبت نشده است. لطفاً ابتدا ثبت‌نام کنید.", 404)
  }

  const admin = createAdminSupabaseClient()
  const { data: roleRow } = await admin
    .from("users")
    .select("role")
    .eq("id", user.id)
    .maybeSingle()
  if (!roleRow || roleRow.role !== "parent") {
    return jsonError("این حساب دسترسی والدین ندارد.", 403)
  }

  const actualEmail = user.email
  if (!actualEmail || !user.email_confirmed_at) {
    return jsonError("این حساب هنوز فعال نشده است.", 403)
  }

  const sessionResponse = await createSessionViaMagicLink(actualEmail, env)
  if (!sessionResponse) {
    return jsonError("ورود به حساب انجام نشد. لطفاً دوباره تلاش کنید.", 500)
  }

  return sessionResponse
}

/**
 * Phone + password login, for parents who chose a password in Settings.
 *
 * Every failure answers with the same message and the same status. A parent
 * who never set a password, a parent who mistyped one, and a phone number with
 * no account at all are indistinguishable from the outside — which is the
 * point: the honest "you have no password yet" message would double as a
 * membership oracle for any phone number someone cared to try. The message
 * itself names the OTP route, so the parent who genuinely has no password is
 * still told what to do.
 */
async function handlePasswordLogin(
  body: Record<string, unknown>,
  env: { NEXT_PUBLIC_SUPABASE_URL: string; NEXT_PUBLIC_SUPABASE_ANON_KEY: string },
) {
  const phone = normalizeAndValidatePhone(body.phone as string)

  const password = readPassword(body)
  if (!password) {
    return jsonError(PASSWORD_LOGIN_FAILED_MESSAGE, 401)
  }

  const devEmail = deriveDevEmail(phone)
  const user = await findUserByPhone(phone, devEmail)
  if (!user) {
    return jsonError(PASSWORD_LOGIN_FAILED_MESSAGE, 401)
  }

  const admin = createAdminSupabaseClient()
  const { data: roleRow } = await admin
    .from("users")
    .select("role")
    .eq("id", user.id)
    .maybeSingle()
  if (!roleRow || roleRow.role !== "parent") {
    return jsonError(PASSWORD_LOGIN_FAILED_MESSAGE, 401)
  }

  const actualEmail = user.email
  if (!actualEmail) {
    return jsonError(PASSWORD_LOGIN_FAILED_MESSAGE, 401)
  }

  // A passwordless account simply fails this sign-in, which lands on the same
  // message as a wrong password. No separate branch is needed, and adding one
  // would be the leak described above.
  const sessionResponse = await createSessionViaPassword(actualEmail, password, env)
  if (!sessionResponse) {
    return jsonError(PASSWORD_LOGIN_FAILED_MESSAGE, 401)
  }
  return sessionResponse
}

export async function POST(request: Request) {
  if (!isDevAuthEnabled()) {
    return NextResponse.json(
      { error: "Not found" },
      { status: 404, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } },
    )
  }

  const host = getHost(request)
  if (!isLocalhost(host)) {
    return NextResponse.json(
      { error: "Not found" },
      { status: 404, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } },
    )
  }

  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return jsonError("درخواست نامعتبر است.", 400)
  }

  const action = body.action as string
  if (!ALLOWED_ACTIONS.has(action)) {
    return jsonError("درخواست نامعتبر است.", 400)
  }

  const allowedFields = ACTION_FIELDS[action]
  try {
    validateBody(body, allowedFields)
  } catch {
    return jsonError("درخواست نامعتبر است.", 400)
  }

  try {
    const env = getSupabaseEnv()

    switch (action) {
      case "signup_request_code":
        return await handleSignupRequestCode(body)
      case "signup_verify_code":
        return await handleSignupVerifyCode(body, env)
      case "login_request_code":
        return await handleLoginRequestCode(body)
      case "login_verify_code":
        return await handleLoginVerifyCode(body, env)
      case "password_login":
        return await handlePasswordLogin(body, env)
      default:
        return jsonError("درخواست نامعتبر است.", 400)
    }
  } catch (err) {
    if (err instanceof Error && err.message === "invalid_phone") {
      return jsonError(INVALID_PHONE_MESSAGE, 400)
    }
    return jsonError("خطایی رخ داد. لطفاً دوباره تلاش کنید.", 500)
  }
}
