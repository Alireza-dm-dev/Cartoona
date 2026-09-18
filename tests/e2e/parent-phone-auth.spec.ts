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
//
// Covers the phone-only signup contract: no name, no password, OTP creates the
// account, the parent stays signed in, and a password is something they may
// add later rather than something signup demanded of them.

loadTestEnv()

const _guard = assertSafeDatabaseTarget()
if (!_guard.ok) throw new Error(`Guard blocked: ${_guard.reason}`)

const SUPABASE_URL = guardedSupabaseUrl()
const BASE = process.env.CARTOONA_TEST_BASE_URL || "http://localhost:3000"
const KEY = process.env.SUPABASE_SECRET_KEY || ""
const HDR = { "Content-Type": "application/json", apikey: KEY, Authorization: `Bearer ${KEY}` }

const TS = String(Date.now()).slice(-8)
const PHONE = `0936${TS.slice(0, 7)}`
/** A number that is never signed up, used for the enumeration probe. */
const UNKNOWN_PHONE = `0937${TS.slice(0, 7)}`
const CHOSEN_PASSWORD = "ParentChosen123!"

function devEmailFor(phone: string): string {
  return `parent-98${phone.replace(/^0/, "")}@dev.cartoona.example`
}

interface ApiResult {
  status: number
  json: Record<string, unknown>
  cookies: string[]
}

async function api(body: unknown): Promise<ApiResult> {
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

async function readProfiles(
  userId: string,
): Promise<Array<{ id: string; full_name: string | null; consent_granted: boolean }>> {
  const resp = await fetch(
    `${SUPABASE_URL}/rest/v1/parent_profiles?user_id=eq.${userId}&select=id,full_name,consent_granted`,
    { headers: HDR },
  )
  return resp.json()
}

/** The session cookies the dev route set, folded into a Cookie header. */
function cookieHeaderFrom(setCookies: string[]): string {
  return setCookies.map((c) => c.split(";")[0]).join("; ")
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

// Carried between the serial tests below.
let signupCookies: string[] = []
let userId = ""

test("1-5 — phone-only signup: a code is issued, and the code alone creates the account", async () => {
  // Only a phone number is sent. No name, no password.
  const request = await api({ action: "signup_request_code", phone: PHONE })
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
  // Consent has not been granted yet, so the parent is routed there.
  expect(verify.json.next).toBe("/parent-consent")

  // A session was established without any password ever existing.
  expect(verify.cookies.length).toBeGreaterThan(0)
  signupCookies = verify.cookies

  const found = await findUserId(devEmailFor(PHONE))
  expect(found).toBeTruthy()
  userId = found!
  cleanup.push(userId)

  // Exactly one profile, and it carries no invented name.
  const profiles = await readProfiles(userId)
  expect(profiles).toHaveLength(1)
  expect(profiles[0].full_name).toBeNull()
  expect(profiles[0].consent_granted).toBe(false)
})

test("4b — signup refuses a name or a password as unsupported fields", async () => {
  // A stale client must fail loudly rather than half-work against the new
  // contract.
  const withName = await api({
    action: "signup_request_code",
    phone: `0938${TS.slice(0, 7)}`,
    fullName: "والد تست",
  })
  expect(withName.status).toBe(400)

  const withPassword = await api({
    action: "signup_request_code",
    phone: `0938${TS.slice(0, 7)}`,
    password: CHOSEN_PASSWORD,
  })
  expect(withPassword.status).toBe(400)
})

test("6 — consent succeeds for a parent with no name", async () => {
  const resp = await fetch(`${BASE}/api/parent-consent`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: cookieHeaderFrom(signupCookies),
    },
    body: JSON.stringify({ consentGranted: true }),
  })

  expect(resp.status).toBe(200)
  const body = await resp.json()
  expect(body.consentGranted).toBe(true)

  const profiles = await readProfiles(userId)
  expect(profiles[0].consent_granted).toBe(true)
  // Consent must not have invented a name along the way.
  expect(profiles[0].full_name).toBeNull()
})

test("14 — the session survives navigation across public and portal routes", async ({ page, context }) => {
  await context.addCookies(
    signupCookies.map((c) => {
      const [pair] = c.split(";")
      const eq = pair.indexOf("=")
      return {
        name: pair.slice(0, eq),
        value: pair.slice(eq + 1),
        domain: "localhost",
        path: "/",
      }
    }),
  )

  // A public route, a creation route, then the portal. The portal is the proof:
  // middleware redirects an unauthenticated visitor away from /dashboard.
  await page.goto(`${BASE}/`)
  await page.goto(`${BASE}/create-image`)
  await page.goto(`${BASE}/dashboard`)

  await expect(page).toHaveURL(/\/dashboard/)
})

test("7-8 — logout ends the session, and the passwordless parent logs back in with a code", async () => {
  const logout = await fetch(`${BASE}/api/logout`, {
    method: "POST",
    headers: { Cookie: cookieHeaderFrom(signupCookies) },
    redirect: "manual",
  })
  expect([302, 303, 307]).toContain(logout.status)

  // No password was ever set, so the code route is the only way back in — and
  // it works.
  const request = await api({ action: "login_request_code", phone: PHONE })
  expect(request.status).toBe(200)
  expect(request.json.developmentCode).toMatch(/^\d{6}$/)

  const verify = await api({
    action: "login_verify_code",
    phone: PHONE,
    code: request.json.developmentCode,
    challengeToken: request.json.challengeToken,
  })
  expect(verify.status).toBe(200)
  expect(verify.json.success).toBe(true)
  // Consent is granted by now, so the parent lands in the portal.
  expect(verify.json.next).toBe("/dashboard")
  signupCookies = verify.cookies
})

test("9 — a password can be set later from Settings", async () => {
  const resp = await fetch(`${BASE}/api/parent/password`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: cookieHeaderFrom(signupCookies),
    },
    body: JSON.stringify({
      password: CHOSEN_PASSWORD,
      confirmPassword: CHOSEN_PASSWORD,
    }),
  })

  expect(resp.status).toBe(200)
  expect((await resp.json()).success).toBe(true)
})

test("10-11 — after logout the same parent logs in with the password they chose", async () => {
  await fetch(`${BASE}/api/logout`, {
    method: "POST",
    headers: { Cookie: cookieHeaderFrom(signupCookies) },
    redirect: "manual",
  }).catch(() => {})

  const login = await api({
    action: "password_login",
    phone: PHONE,
    password: CHOSEN_PASSWORD,
  })

  expect(login.status).toBe(200)
  expect(login.json.success).toBe(true)
  expect(login.json.next).toBe("/dashboard")
})

test("11b — a wrong password is refused", async () => {
  const login = await api({
    action: "password_login",
    phone: PHONE,
    password: "DefinitelyWrong999!",
  })
  expect(login.status).toBe(401)
})

test("12 — code login still works for a parent who now has a password", async () => {
  // Setting a password adds a way in; it must never remove one.
  const request = await api({ action: "login_request_code", phone: PHONE })
  expect(request.status).toBe(200)

  const verify = await api({
    action: "login_verify_code",
    phone: PHONE,
    code: request.json.developmentCode,
    challengeToken: request.json.challengeToken,
  })
  expect(verify.status).toBe(200)
  expect(verify.json.success).toBe(true)
})

test("13 — password login tells an unknown phone nothing an account would not hear", async () => {
  // The three failures a password attempt can have — no account, wrong
  // password, and (before a password was set) no credential at all — must be
  // indistinguishable, or this endpoint becomes a membership oracle.
  const unknown = await api({
    action: "password_login",
    phone: UNKNOWN_PHONE,
    password: CHOSEN_PASSWORD,
  })
  const wrongPassword = await api({
    action: "password_login",
    phone: PHONE,
    password: "DefinitelyWrong999!",
  })

  expect(unknown.status).toBe(wrongPassword.status)
  expect(unknown.json.error).toBe(wrongPassword.json.error)
  // And the message points at the route that does work.
  expect(String(unknown.json.error)).toContain("ورود با کد")

  // The probe must not have created anything.
  expect(await findUserId(devEmailFor(UNKNOWN_PHONE))).toBeNull()
})

test("13b — a passwordless account answers password login exactly as an unknown phone does", async () => {
  // A second account that never sets a password, checked against the same
  // neutral answer.
  const freshPhone = `0939${TS.slice(0, 7)}`

  const request = await api({ action: "signup_request_code", phone: freshPhone })
  expect(request.status).toBe(200)
  const verify = await api({
    action: "signup_verify_code",
    phone: freshPhone,
    code: request.json.developmentCode,
    challengeToken: request.json.challengeToken,
  })
  expect(verify.status).toBe(200)

  const freshId = await findUserId(devEmailFor(freshPhone))
  expect(freshId).toBeTruthy()
  cleanup.push(freshId!)

  const passwordless = await api({
    action: "password_login",
    phone: freshPhone,
    password: CHOSEN_PASSWORD,
  })
  const unknown = await api({
    action: "password_login",
    phone: UNKNOWN_PHONE,
    password: CHOSEN_PASSWORD,
  })

  expect(passwordless.status).toBe(unknown.status)
  expect(passwordless.json.error).toBe(unknown.json.error)
})
