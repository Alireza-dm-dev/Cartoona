import { test, expect } from "@playwright/test"
import {
  assertSafeDatabaseTarget,
  guardedSupabaseUrl,
} from "../helpers/assert-safe-database-target"
import { loadTestEnv } from "../helpers/load-test-env"

// ⚠️ Stateful parent-auth tests. They create real auth identities and parent
// profiles, so they run against a disposable/local target ONLY, never the
// production main project. assertSafeDatabaseTarget() gates the whole file and
// the Supabase URL is derived from the same environment the guard inspected,
// so the guard's verdict is binding on every request made here.

loadTestEnv()

const _guard = assertSafeDatabaseTarget()
if (!_guard.ok) throw new Error(`Guard blocked: ${_guard.reason}`)

const SUPABASE_URL = guardedSupabaseUrl()
const BASE = process.env.CARTOONA_TEST_BASE_URL || "http://localhost:3000"
const KEY = process.env.SUPABASE_SECRET_KEY || ""
const HDR = { "Content-Type": "application/json", apikey: KEY, Authorization: `Bearer ${KEY}` }

const TS = String(Date.now()).slice(-8)
const PHONE = `0935${TS.slice(0, 7)}`
const PASSWORD = "ParentPass123!"
const WRONG_PASSWORD = "WrongPass123!"

function devEmailFor(phone: string): string {
  return `parent-98${phone.replace(/^0/, "")}@dev.cartoona.example`
}

async function api(
  body: unknown,
): Promise<{ status: number; json: Record<string, unknown>; cookies: string[] }> {
  const resp = await fetch(`${BASE}/api/dev/parent-auth`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  return {
    status: resp.status,
    json: await resp.json(),
    cookies: resp.headers.getSetCookie?.() ?? [],
  }
}

async function adminUsers(): Promise<Array<{ id: string; email: string }>> {
  const resp = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?per_page=200`, { headers: HDR })
  const data = await resp.json()
  return data.users || []
}

async function findUserId(email: string): Promise<string | null> {
  const user = (await adminUsers()).find((u) => u.email === email)
  return user?.id ?? null
}

async function countProfiles(userId: string): Promise<number> {
  const resp = await fetch(
    `${SUPABASE_URL}/rest/v1/parent_profiles?user_id=eq.${userId}&select=id`,
    { headers: HDR },
  )
  return ((await resp.json()) as unknown[]).length
}

const cleanup: string[] = []

test.afterAll(async () => {
  for (const id of cleanup) {
    await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${id}`, {
      method: "DELETE",
      headers: HDR,
    }).catch(() => {})
  }
})

test.describe.configure({ mode: "serial" })

test("1-5 — phone-only signup verifies with the issued code and creates one parent", async () => {
  const request = await api({
    action: "signup_request_code",
    phone: PHONE,
  })
  expect(request.status).toBe(200)
  expect(request.json.developmentCode).toMatch(/^\d{6}$/)
  expect(request.json.challengeToken).toBeTruthy()
  expect(request.json.expiresInSeconds).toBe(300)

  const verify = await api({
    action: "signup_verify_code",
    phone: PHONE,
    code: request.json.developmentCode,
    challengeToken: request.json.challengeToken,
  })
  expect(verify.status).toBe(200)
  expect(verify.json.success).toBe(true)
  expect(verify.json.next).toBe("/parent-consent")

  const userId = await findUserId(devEmailFor(PHONE))
  expect(userId).toBeTruthy()
  cleanup.push(userId!)

  expect(await countProfiles(userId!)).toBe(1)
})

/**
 * Signup no longer creates a credential, so the password these tests use has
 * to be chosen the way a real parent chooses one: from Settings, against an
 * authenticated session.
 */
test("6-pre — the parent sets a password from Settings", async () => {
  const request = await api({ action: "login_request_code", phone: PHONE })
  const verify = await api({
    action: "login_verify_code",
    phone: PHONE,
    code: request.json.developmentCode,
    challengeToken: request.json.challengeToken,
  })
  expect(verify.status).toBe(200)

  const cookie = (verify.cookies ?? []).map((c) => c.split(";")[0]).join("; ")
  const resp = await fetch(`${BASE}/api/parent/password`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ password: PASSWORD, confirmPassword: PASSWORD }),
  })
  expect(resp.status).toBe(200)
})

test("6 — phone + password login works once a password has been set", async () => {
  const login = await api({ action: "password_login", phone: PHONE, password: PASSWORD })
  expect(login.status).toBe(200)
  expect(login.json.success).toBe(true)
})

test("6b — every supported phone form logs into the same account", async () => {
  const digits = PHONE.replace(/^0/, "")
  for (const form of [PHONE, `+98${digits}`, `98${digits}`, digits]) {
    const login = await api({ action: "password_login", phone: form, password: PASSWORD })
    expect(login.status, form).toBe(200)
  }
})

test("7 — wrong password is rejected without disclosing the account", async () => {
  const login = await api({ action: "password_login", phone: PHONE, password: WRONG_PASSWORD })
  expect(login.status).toBe(401)
  // The message stays neutral about which half was wrong, and points at the
  // code route, which is the way in that always works.
  expect(String(login.json.error)).toContain("شماره موبایل یا رمز عبور صحیح نیست")
  expect(String(login.json.error)).toContain("ورود با کد")

  const unknown = await api({
    action: "password_login",
    phone: "09000000000",
    password: PASSWORD,
  })
  expect(unknown.status).toBe(401)
  // Unknown phone and wrong password are indistinguishable.
  expect(unknown.json.error).toBe(login.json.error)
})

test("8 — wrong OTP is rejected and 9 — the issued OTP cannot be reused", async () => {
  const request = await api({ action: "login_request_code", phone: PHONE })
  expect(request.status).toBe(200)
  const code = request.json.developmentCode as string
  const challengeToken = request.json.challengeToken as string

  const wrong = code === "000000" ? "111111" : "000000"
  const bad = await api({ action: "login_verify_code", phone: PHONE, code: wrong, challengeToken })
  expect(bad.status).toBe(401)
  expect(bad.json.error).toBe("کد تأیید نادرست است. لطفاً دوباره تلاش کنید.")

  // A wrong guess must not burn the displayed code.
  const good = await api({ action: "login_verify_code", phone: PHONE, code, challengeToken })
  expect(good.status).toBe(200)
  expect(good.json.success).toBe(true)

  const replay = await api({ action: "login_verify_code", phone: PHONE, code, challengeToken })
  expect(replay.status).toBe(401)
  expect(replay.json.error).toBe("این کد قبلاً استفاده شده است. لطفاً کد جدید درخواست کنید.")
})

test("a valid code bound to another phone is rejected", async () => {
  const request = await api({ action: "login_request_code", phone: PHONE })
  const other = await api({
    action: "login_verify_code",
    phone: "09121111111",
    code: request.json.developmentCode,
    challengeToken: request.json.challengeToken,
  })
  expect(other.status).toBeGreaterThanOrEqual(400)
  expect(other.json.success).toBeUndefined()
})

test("malformed phones are rejected before any code is issued", async () => {
  for (const bad of ["093525", "0935250000", "abc", ""]) {
    const resp = await api({ action: "login_request_code", phone: bad })
    expect(resp.status, bad).toBe(400)
    expect(resp.json.developmentCode, bad).toBeUndefined()
  }
})

test("no code is issued for a phone without an account", async () => {
  const resp = await api({ action: "login_request_code", phone: "09121234567" })
  expect(resp.status).toBe(404)
  expect(resp.json.developmentCode).toBeUndefined()
})

test("10 — authenticated parent reaches /dashboard/orders and 11 — logout ends access", async ({ page }) => {
  // Consent is required before the dashboard is reachable.
  const userId = await findUserId(devEmailFor(PHONE))
  await fetch(`${SUPABASE_URL}/rest/v1/parent_profiles?user_id=eq.${userId}`, {
    method: "PATCH",
    headers: HDR,
    body: JSON.stringify({ consent_granted: true, consent_granted_at: new Date().toISOString() }),
  })

  await page.goto(`${BASE}/login?from=/dashboard/orders`)
  await page.waitForLoadState("networkidle")

  // Code login is the default tab now, so password login is chosen explicitly.
  await page.getByRole("button", { name: "ورود با رمز عبور" }).click()

  await page.fill('input[placeholder="مثال: 09123456789"]', PHONE)
  await page.fill('input[placeholder="رمز عبور"]', PASSWORD)
  await page.getByRole("button", { name: "ورود", exact: true }).click()

  await page.waitForURL(/\/dashboard\/orders/, { timeout: 15000 })

  // The session survives a reload.
  await page.reload()
  await page.waitForLoadState("networkidle")
  expect(page.url()).toContain("/dashboard/orders")

  await page.context().clearCookies()
  await page.goto(`${BASE}/dashboard/orders`)
  await page.waitForURL(/\/login/, { timeout: 15000 })
})

test("signup cannot create a second identity for the same phone", async () => {
  const retry = await api({
    action: "signup_request_code",
    phone: PHONE,
  })
  expect(retry.status).toBe(409)

  const userId = await findUserId(devEmailFor(PHONE))
  expect(await countProfiles(userId!)).toBe(1)
})

test("signup refuses a password field outright", async () => {
  // A password is not part of signup any more, so sending one is an
  // unsupported field rather than a value to validate.
  const resp = await api({
    action: "signup_request_code",
    phone: `0934${TS.slice(0, 7)}`,
    password: "short",
  })
  expect(resp.status).toBe(400)
  expect(resp.json.developmentCode).toBeUndefined()
})
