import { test, expect } from "@playwright/test"
import * as fs from "fs"
import * as path from "path"
import {
  assertSafeDatabaseTarget,
  guardedProjectRef,
  guardedSupabaseUrl,
} from "../helpers/assert-safe-database-target"

// ⚠️ Stateful signup-completion tests. They create real auth identities and
// parent profiles, so they run against a disposable/local target ONLY, never
// the production main project. assertSafeDatabaseTarget() gates the whole file
// and both the Supabase URL and the auth cookie name are derived from the same
// environment the guard inspected, so its verdict binds every request here.

function loadEnv(): void {
  try {
    const content = fs.readFileSync(path.resolve(__dirname, "../../.env.local"), "utf-8")
    for (const line of content.split("\n")) {
      const t = line.trim()
      if (!t || t.startsWith("#")) continue
      const eq = t.indexOf("=")
      if (eq === -1) continue
      process.env[t.slice(0, eq)] = t.slice(eq + 1)
    }
  } catch { /* ignore */ }
}

loadEnv()

const _guard = assertSafeDatabaseTarget()
if (!_guard.ok) throw new Error(`Guard blocked: ${_guard.reason}`)

const SUPABASE_URL = guardedSupabaseUrl()
const PROJECT_REF = guardedProjectRef()
const BASE = process.env.CARTOONA_TEST_BASE_URL || "http://localhost:3000"
const KEY = process.env.SUPABASE_SECRET_KEY || ""
const HDR = { "Content-Type": "application/json", apikey: KEY, Authorization: `Bearer ${KEY}` }

const TS = String(Date.now()).slice(-8)
const PASSWORD = "TestPass999!"
const FULL_NAME = "والد تولیدی"

function buildCookie(at: string): string {
  return "base64-" + Buffer.from(JSON.stringify({
    access_token: at, refresh_token: "", expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600, token_type: "bearer",
  })).toString("base64url")
}

function cookieHeader(token: string): string {
  return `sb-${PROJECT_REF}-auth-token=${buildCookie(token)}`
}

const createdUserIds: string[] = []

/**
 * Builds the state a production signup leaves behind: a confirmed auth user
 * carrying full_name metadata, a `users` row from the signup trigger, and
 * deliberately NO parent_profiles row — the gap this feature closes.
 */
async function createVerifiedUserWithoutProfile(
  tag: string,
  role: "parent" | "admin" = "parent",
): Promise<{ userId: string; email: string; token: string }> {
  const email = `signup-${tag}-${TS}@example.com`

  const created = await (await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: "POST",
    headers: HDR,
    body: JSON.stringify({
      email,
      password: PASSWORD,
      email_confirm: true,
      user_metadata: { full_name: FULL_NAME },
    }),
  })).json()
  if (!created.id) throw new Error(`create ${email}: ${JSON.stringify(created)}`)
  createdUserIds.push(created.id)

  if (role !== "parent") {
    await fetch(`${SUPABASE_URL}/rest/v1/users?id=eq.${created.id}`, {
      method: "PATCH",
      headers: HDR,
      body: JSON.stringify({ role }),
    })
  }

  const login = await (await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: HDR,
    body: JSON.stringify({ email, password: PASSWORD }),
  })).json()
  if (!login.access_token) throw new Error(`login ${email}: ${JSON.stringify(login)}`)

  return { userId: created.id, email, token: login.access_token }
}

async function profilesFor(userId: string): Promise<Array<Record<string, unknown>>> {
  const resp = await fetch(
    `${SUPABASE_URL}/rest/v1/parent_profiles?user_id=eq.${userId}&select=id,full_name,consent_granted,consent_granted_at`,
    { headers: HDR },
  )
  return resp.json()
}

async function completeSignup(token?: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const resp = await fetch(`${BASE}/api/parent/complete-signup`, {
    method: "POST",
    headers: token ? { Cookie: cookieHeader(token) } : {},
  })
  return { status: resp.status, body: await resp.json().catch(() => ({})) }
}

test.afterAll(async () => {
  for (const id of createdUserIds) {
    await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${id}`, {
      method: "DELETE",
      headers: HDR,
    }).catch(() => {})
  }
})

test.describe.configure({ mode: "serial" })

test("a production-style verified user starts with no parent profile", async () => {
  const user = await createVerifiedUserWithoutProfile("baseline")
  expect(await profilesFor(user.userId)).toHaveLength(0)
})

test("completing signup creates exactly one parent profile", async () => {
  const user = await createVerifiedUserWithoutProfile("create")

  const result = await completeSignup(user.token)
  expect(result.status).toBe(200)
  expect(result.body.success).toBe(true)
  expect(result.body.created).toBe(true)
  expect(result.body.next).toBe("/parent-consent")

  const profiles = await profilesFor(user.userId)
  expect(profiles).toHaveLength(1)
  expect(profiles[0].full_name).toBe(FULL_NAME)
  // Signup must never imply consent.
  expect(profiles[0].consent_granted).toBe(false)
  expect(profiles[0].consent_granted_at).toBeNull()
})

test("retrying signup completion keeps exactly one profile", async () => {
  const user = await createVerifiedUserWithoutProfile("retry")

  const first = await completeSignup(user.token)
  expect(first.body.created).toBe(true)

  for (let i = 0; i < 3; i++) {
    const again = await completeSignup(user.token)
    expect(again.status).toBe(200)
    expect(again.body.created).toBe(false)
  }

  expect(await profilesFor(user.userId)).toHaveLength(1)
})

test("concurrent completions still produce one profile", async () => {
  const user = await createVerifiedUserWithoutProfile("concurrent")

  const results = await Promise.all([
    completeSignup(user.token),
    completeSignup(user.token),
    completeSignup(user.token),
    completeSignup(user.token),
  ])

  for (const r of results) expect(r.status).toBe(200)
  expect(await profilesFor(user.userId)).toHaveLength(1)
})

test("an existing profile is not duplicated and its consent is preserved", async () => {
  const user = await createVerifiedUserWithoutProfile("existing")

  await completeSignup(user.token)

  // Grant consent the way /parent-consent does.
  const consent = await fetch(`${BASE}/api/parent-consent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookieHeader(user.token) },
    body: JSON.stringify({ consentGranted: true }),
  })
  expect(consent.status).toBe(200)

  let profiles = await profilesFor(user.userId)
  expect(profiles).toHaveLength(1)
  expect(profiles[0].consent_granted).toBe(true)

  // Completing signup again must neither duplicate nor revoke consent.
  const again = await completeSignup(user.token)
  expect(again.status).toBe(200)
  expect(again.body.created).toBe(false)

  profiles = await profilesFor(user.userId)
  expect(profiles).toHaveLength(1)
  expect(profiles[0].consent_granted).toBe(true)
})

test("an unauthenticated caller cannot create a profile", async () => {
  const result = await completeSignup()
  expect(result.status).toBe(401)
})

test("an admin identity is refused and gets no parent profile", async () => {
  const admin = await createVerifiedUserWithoutProfile("admin", "admin")

  const result = await completeSignup(admin.token)
  expect(result.status).toBe(403)
  expect(await profilesFor(admin.userId)).toHaveLength(0)
})

test("failures surface a safe message with no database detail", async () => {
  // A parent whose account carries no full_name cannot have a profile built.
  const email = `signup-noname-${TS}@example.com`
  const created = await (await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: "POST",
    headers: HDR,
    body: JSON.stringify({ email, password: PASSWORD, email_confirm: true }),
  })).json()
  createdUserIds.push(created.id)

  const login = await (await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: HDR,
    body: JSON.stringify({ email, password: PASSWORD }),
  })).json()

  const result = await completeSignup(login.access_token)
  expect(result.status).toBe(422)

  const message = String(result.body.error ?? "")
  expect(message.length).toBeGreaterThan(0)
  for (const leak of ["parent_profiles", "constraint", "violates", "23505", "postgres", "supabase"]) {
    expect(message.toLowerCase(), leak).not.toContain(leak)
  }

  expect(await profilesFor(created.id)).toHaveLength(0)
})

test("a parent can open /dashboard/orders after signup completion", async ({ page }) => {
  const user = await createVerifiedUserWithoutProfile("dashboard")

  await completeSignup(user.token)
  await fetch(`${BASE}/api/parent-consent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookieHeader(user.token) },
    body: JSON.stringify({ consentGranted: true }),
  })

  await page.context().addCookies([{
    name: `sb-${PROJECT_REF}-auth-token`,
    value: buildCookie(user.token),
    url: BASE,
  }])

  const resp = await page.goto(`${BASE}/dashboard/orders`)
  expect(resp?.status()).toBe(200)
  expect(page.url()).toContain("/dashboard/orders")
  // The empty-state renders rather than a profile-missing failure.
  await expect(page.locator("body")).toBeVisible()
})

test("the dev signup flow still produces exactly one profile", async () => {
  const phone = `0937${TS.slice(0, 7)}`

  const request = await (await fetch(`${BASE}/api/dev/parent-auth`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "signup_request_code",
      phone,
      fullName: FULL_NAME,
      password: "ParentPass123!",
    }),
  })).json()
  expect(request.developmentCode).toMatch(/^\d{6}$/)

  const verify = await fetch(`${BASE}/api/dev/parent-auth`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "signup_verify_code",
      phone,
      fullName: FULL_NAME,
      password: "ParentPass123!",
      code: request.developmentCode,
      challengeToken: request.challengeToken,
    }),
  })
  expect(verify.status).toBe(200)

  const devEmail = `parent-98${phone.replace(/^0/, "")}@dev.cartoona.example`
  const users = await (await fetch(
    `${SUPABASE_URL}/auth/v1/admin/users?per_page=200`,
    { headers: HDR },
  )).json()
  const devUser = (users.users || []).find((u: { email: string }) => u.email === devEmail)
  expect(devUser).toBeTruthy()
  createdUserIds.push(devUser.id)

  expect(await profilesFor(devUser.id)).toHaveLength(1)
})
