import { NextResponse } from "next/server"
import { createServerClient } from "@supabase/ssr"
import { getSupabaseEnv } from "@/lib/supabase/env"
import { createAdminSupabaseClient } from "@/lib/supabase/admin"
import {
  normalizeIranPhone,
  isValidIranPhone,
  deriveDevEmail,
  isDevAuthEnabled,
  isLocalhost,
  isValidFullName,
  generateOtpChallenge,
  verifyOtpChallenge,
  generateRandomPassword,
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
  signup_request_code: new Set(["action", "phone", "fullName"]),
  signup_verify_code: new Set(["action", "phone", "fullName", "code", "challengeToken"]),
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
  if (!raw || !raw.trim()) throw new Error("invalid_phone")
  const normalized = normalizeIranPhone(raw)
  if (!isValidIranPhone(normalized)) throw new Error("invalid_phone")
  return normalized
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

async function handleSignupRequestCode(body: Record<string, unknown>) {
  const phone = normalizeAndValidatePhone(body.phone as string)

  const fullName = (body.fullName as string || "").trim()
  if (!fullName || !isValidFullName(fullName)) {
    return jsonError("نام والد باید بین ۲ تا ۱۰۰ کاراکتر باشد.", 400)
  }

  const devEmail = deriveDevEmail(phone)
  const existing = await findUserByPhone(phone, devEmail)
  if (existing) {
    return jsonError("برای این شماره حسابی وجود دارد. از صفحه ورود استفاده کنید.", 409)
  }

  const challenge = generateOtpChallenge("signup", phone, fullName)

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

async function handleSignupVerifyCode(
  body: Record<string, unknown>,
  env: { NEXT_PUBLIC_SUPABASE_URL: string; NEXT_PUBLIC_SUPABASE_ANON_KEY: string },
) {
  const phone = normalizeAndValidatePhone(body.phone as string)

  const fullName = (body.fullName as string || "").trim()
  if (!fullName || !isValidFullName(fullName)) {
    return jsonError("نام والد باید بین ۲ تا ۱۰۰ کاراکتر باشد.", 400)
  }

  const code = typeof body.code === "string" ? body.code.trim() : ""
  if (!/^\d{6}$/.test(code)) {
    return jsonError("کد تأیید نامعتبر است.", 400)
  }

  const challengeToken = typeof body.challengeToken === "string" ? body.challengeToken : ""
  if (!challengeToken) {
    return jsonError("درخواست نامعتبر است.", 400)
  }

  if (!verifyOtpChallenge(challengeToken, "signup", phone, code, fullName)) {
    return jsonError("کد تأیید نامعتبر یا منقضی شده است.", 401)
  }

  const devEmail = deriveDevEmail(phone)
  const existing = await findUserByPhone(phone, devEmail)
  if (existing) {
    return jsonError("برای این شماره حسابی وجود دارد. از صفحه ورود استفاده کنید.", 409)
  }

  const internalPassword = generateRandomPassword()

  let createdUser
  try {
    createdUser = await apiCreateUser({
      email: devEmail,
      email_confirm: true,
      password: internalPassword,
      user_metadata: {
        full_name: fullName,
        normalized_phone: phone,
        dev_parent: true,
        password_enabled: false,
      },
    })
  } catch {
    return jsonError("ثبت‌نام انجام نشد. لطفاً دوباره تلاش کنید.", 500)
  }

  const userId = createdUser.id

  const admin = createAdminSupabaseClient()
  const { error: profileError } = await admin.from("parent_profiles").insert({
    user_id: userId,
    full_name: fullName,
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
    return jsonError("شماره موبایل یا کد ورود صحیح نیست.", 401)
  }

  const challengeToken = typeof body.challengeToken === "string" ? body.challengeToken : ""
  if (!challengeToken) {
    return jsonError("درخواست نامعتبر است.", 400)
  }

  if (!verifyOtpChallenge(challengeToken, "login", phone, code)) {
    return jsonError("شماره موبایل یا کد ورود صحیح نیست.", 401)
  }

  const devEmail = deriveDevEmail(phone)
  const user = await findUserByPhone(phone, devEmail)
  if (!user) {
    return jsonError("شماره موبایل یا کد ورود صحیح نیست.", 401)
  }

  const admin = createAdminSupabaseClient()
  const { data: roleRow } = await admin
    .from("users")
    .select("role")
    .eq("id", user.id)
    .maybeSingle()
  if (!roleRow || roleRow.role !== "parent") {
    return jsonError("شماره موبایل یا کد ورود صحیح نیست.", 401)
  }

  const actualEmail = user.email
  if (!actualEmail || !user.email_confirmed_at) {
    return jsonError("شماره موبایل یا کد ورود صحیح نیست.", 401)
  }

  const sessionResponse = await createSessionViaMagicLink(actualEmail, env)
  if (!sessionResponse) {
    return jsonError("شماره موبایل یا کد ورود صحیح نیست.", 401)
  }

  return sessionResponse
}

async function handlePasswordLogin(
  body: Record<string, unknown>,
  env: { NEXT_PUBLIC_SUPABASE_URL: string; NEXT_PUBLIC_SUPABASE_ANON_KEY: string },
) {
  const phone = normalizeAndValidatePhone(body.phone as string)

  const password = typeof body.password === "string" ? body.password : ""
  if (!password) {
    return jsonError("شماره موبایل یا رمز عبور صحیح نیست.", 401)
  }

  const devEmail = deriveDevEmail(phone)
  const user = await findUserByPhone(phone, devEmail)
  if (!user) {
    return jsonError("شماره موبایل یا رمز عبور صحیح نیست.", 401)
  }

  const admin = createAdminSupabaseClient()
  const { data: roleRow } = await admin
    .from("users")
    .select("role")
    .eq("id", user.id)
    .maybeSingle()
  if (!roleRow || roleRow.role !== "parent") {
    return jsonError("شماره موبایل یا رمز عبور صحیح نیست.", 401)
  }

  const actualEmail = user.email
  if (!actualEmail) {
    return jsonError("شماره موبایل یا رمز عبور صحیح نیست.", 401)
  }

  const sessionResponse = await createSessionViaPassword(actualEmail, password, env)
  if (!sessionResponse) {
    return jsonError("شماره موبایل یا رمز عبور صحیح نیست.", 401)
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
  } catch {
    return jsonError("خطایی رخ داد. لطفاً دوباره تلاش کنید.", 500)
  }
}
