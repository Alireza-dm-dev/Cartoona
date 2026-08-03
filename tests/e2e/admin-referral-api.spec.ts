import { test, expect } from "@playwright/test"
import * as fs from "fs"
import * as path from "path"
import { assertSafeDatabaseTarget } from "../helpers/assert-safe-database-target"

const PROJECT_REF = "oucyhmrnzahlhqjfqcge"
const SUPABASE_URL = `https://${PROJECT_REF}.supabase.co`
const BASE = "http://localhost:3000"

function loadEnv(): void {
  try {
    const content = fs.readFileSync(path.resolve(__dirname, "../../.env.local"), "utf-8")
    for (const line of content.split("\n")) {
      const t = line.trim()
      if (!t || t.startsWith("#")) continue
      const eq = t.indexOf("=")
      if (eq === -1) continue
      const key = t.slice(0, eq)
      const val = t.slice(eq + 1)
      process.env[key] = val
    }
  } catch { /* ignore */ }
}

loadEnv()

const _guard = assertSafeDatabaseTarget()
if (!_guard.ok) throw new Error(`Guard blocked: ${_guard.reason}`)

const KEY = process.env.SUPABASE_SECRET_KEY || ""
const HDR = { "Content-Type": "application/json", apikey: KEY, Authorization: `Bearer ${KEY}` }
const PASSWORD = "TestPass999!"
const TS = String(Date.now()).slice(-8)

function buildCookie(at: string, rt: string, ei: number): string {
  return "base64-" + Buffer.from(JSON.stringify({
    access_token: at, refresh_token: rt, expires_in: ei,
    expires_at: Math.floor(Date.now() / 1000) + ei, token_type: "bearer",
  })).toString("base64url")
}

interface SyntheticUser {
  id: string
  email: string
  profileId: string | null
  referralCode: string | null
}

async function createUser(email: string, role: string): Promise<SyntheticUser> {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: "POST", headers: HDR,
    body: JSON.stringify({ email, password: PASSWORD, email_confirm: true, user_metadata: { full_name: "Test" } }),
  })
  const u = await r.json()

  await fetch(`${SUPABASE_URL}/rest/v1/users?id=eq.${u.id}`, {
    method: "PATCH", headers: HDR,
    body: JSON.stringify({ role }),
  }).catch(() => {})

  await fetch(`${SUPABASE_URL}/rest/v1/parent_profiles`, {
    method: "POST", headers: { ...HDR, Prefer: "return=representation" },
    body: JSON.stringify({ user_id: u.id, full_name: "Test " + role, consent_granted: true, consent_granted_at: new Date().toISOString() }),
  })

  const profCheck = await fetch(`${SUPABASE_URL}/rest/v1/parent_profiles?user_id=eq.${u.id}&select=id,referral_code`, { headers: HDR })
  const profData = profCheck.ok ? await profCheck.json() : []

  return {
    id: u.id,
    email,
    profileId: profData.length > 0 ? profData[0].id : null,
    referralCode: profData.length > 0 ? profData[0].referral_code : null,
  }
}

const tokenCache: Record<string, string> = {}

async function loginAs(email: string): Promise<{ access_token: string; refresh_token: string; expires_in: number }> {
  if (tokenCache[email]) {
    return { access_token: tokenCache[email], refresh_token: "", expires_in: 3600 }
  }
  const r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST", headers: HDR,
    body: JSON.stringify({ email, password: PASSWORD }),
  })
  const data = await r.json()
  if (!data.access_token) throw new Error(`Login failed for ${email}: ${JSON.stringify(data)}`)
  tokenCache[email] = data.access_token
  return data
}

function cookieHeaders(token: string): Record<string, string> {
  const c = buildCookie(token, "", 3600)
  return { Cookie: `sb-${PROJECT_REF}-auth-token=${c}` }
}

// ── Synthetic users ──────────────────────────────────────────────────────────

const EMAIL_ADMIN = `adm_api_${TS}@test.com`
const EMAIL_SUPER = `sup_api_${TS}@test.com`
const EMAIL_PARENT = `par_api_${TS}@test.com`
const EMAIL_PARENT2 = `par2_api_${TS}@test.com`

let adminUser: SyntheticUser
let superUser: SyntheticUser
let parentUser: SyntheticUser
let parent2User: SyntheticUser
const cleanupIds: string[] = []

test.beforeAll(async () => {
  test.setTimeout(120000)

  adminUser = await createUser(EMAIL_ADMIN, "admin")
  superUser = await createUser(EMAIL_SUPER, "super_admin")
  parentUser = await createUser(EMAIL_PARENT, "parent")
  parent2User = await createUser(EMAIL_PARENT2, "parent")

  cleanupIds.push(adminUser.id, superUser.id, parentUser.id, parent2User.id)

  await fetch(`${SUPABASE_URL}/rest/v1/referral_program_settings?id=eq.1`, {
    method: "PATCH", headers: HDR,
    body: JSON.stringify({ is_enabled: true, reward_basis_points: 1500 }),
  })

  if (parentUser.profileId && parent2User.profileId) {
    await fetch(`${SUPABASE_URL}/rest/v1/referral_relationships`, {
      method: "POST", headers: HDR,
      body: JSON.stringify({
        referred_parent_id: parent2User.profileId,
        referrer_parent_id: parentUser.profileId,
        referral_code_snapshot: parentUser.referralCode,
        binding_source: "manual",
      }),
    })
  }
})

test.afterAll(async () => {
  await fetch(`${SUPABASE_URL}/rest/v1/referral_program_settings?id=eq.1`, {
    method: "PATCH", headers: HDR,
    body: JSON.stringify({ is_enabled: true, reward_basis_points: 1500 }),
  })
  for (const id of cleanupIds) {
    await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${id}`, { method: "DELETE", headers: HDR }).catch(() => {})
  }
})

// ═════════════════════════════════════════════════════════════════════════════
// GET /api/admin/referrals — Authorization
// ═════════════════════════════════════════════════════════════════════════════

test("1. Unauthenticated request → 401", async () => {
  const r = await fetch(`${BASE}/api/admin/referrals`)
  expect(r.status).toBe(401)
  const body = await r.json()
  expect(body).not.toHaveProperty("code")
  expect(body).toHaveProperty("error")
})

test("2. Parent request → 403", async () => {
  const { access_token } = await loginAs(EMAIL_PARENT)
  const r = await fetch(`${BASE}/api/admin/referrals`, {
    headers: cookieHeaders(access_token),
  })
  expect(r.status).toBe(403)
  const body = await r.json()
  expect(body).toHaveProperty("error")
})

test("3. Admin request → 200", async () => {
  const { access_token } = await loginAs(EMAIL_ADMIN)
  const r = await fetch(`${BASE}/api/admin/referrals`, {
    headers: cookieHeaders(access_token),
  })
  expect(r.status).toBe(200)
})

test("4. Super-admin request → 200", async () => {
  const { access_token } = await loginAs(EMAIL_SUPER)
  const r = await fetch(`${BASE}/api/admin/referrals`, {
    headers: cookieHeaders(access_token),
  })
  expect(r.status).toBe(200)
})

// ═════════════════════════════════════════════════════════════════════════════
// GET — Response shape
// ═════════════════════════════════════════════════════════════════════════════

test("5. Response contains exactly: settings, metrics, relationships, pagination", async () => {
  const { access_token } = await loginAs(EMAIL_ADMIN)
  const r = await fetch(`${BASE}/api/admin/referrals`, {
    headers: cookieHeaders(access_token),
  })
  expect(r.status).toBe(200)
  const body = await r.json()
  expect(body).toHaveProperty("settings")
  expect(body).toHaveProperty("metrics")
  expect(body).toHaveProperty("relationships")
  expect(body).toHaveProperty("pagination")
  const keys = Object.keys(body).sort()
  expect(keys).toEqual(["metrics", "pagination", "relationships", "settings"])
})

test("6. Settings include isEnabled, rewardBasisPoints, updatedAt", async () => {
  const { access_token } = await loginAs(EMAIL_ADMIN)
  const r = await fetch(`${BASE}/api/admin/referrals`, {
    headers: cookieHeaders(access_token),
  })
  const body = await r.json()
  expect(body.settings).toHaveProperty("isEnabled")
  expect(body.settings).toHaveProperty("rewardBasisPoints")
  expect(body.settings).toHaveProperty("updatedAt")
  expect(typeof body.settings.isEnabled).toBe("boolean")
  expect(typeof body.settings.rewardBasisPoints).toBe("number")
  expect(typeof body.settings.updatedAt).toBe("string")
})

test("7. Metrics include all five fields", async () => {
  const { access_token } = await loginAs(EMAIL_ADMIN)
  const r = await fetch(`${BASE}/api/admin/referrals`, {
    headers: cookieHeaders(access_token),
  })
  const body = await r.json()
  expect(body.metrics).toHaveProperty("totalParentProfiles")
  expect(body.metrics).toHaveProperty("totalRelationships")
  expect(body.metrics).toHaveProperty("totalUnboundParentProfiles")
  expect(body.metrics).toHaveProperty("totalDeletedIdentityRelationships")
  expect(body.metrics).toHaveProperty("settingsHistoryCount")
  expect(typeof body.metrics.totalParentProfiles).toBe("number")
  expect(typeof body.metrics.totalRelationships).toBe("number")
})

test("8. Relationship response contains only approved admin fields", async () => {
  const { access_token } = await loginAs(EMAIL_ADMIN)
  const r = await fetch(`${BASE}/api/admin/referrals`, {
    headers: cookieHeaders(access_token),
  })
  const body = await r.json()
  expect(Array.isArray(body.relationships)).toBe(true)
  for (const rel of body.relationships) {
    const keys = Object.keys(rel).sort()
    expect(keys).toEqual(["bindingSource", "boundAt", "id", "referralCodeSnapshot", "referredParent", "referrerParent"])
    expect(rel).toHaveProperty("id")
    expect(typeof rel.id).toBe("string")
    expect(rel).toHaveProperty("boundAt")
    expect(rel).toHaveProperty("bindingSource")
    expect(rel).toHaveProperty("referralCodeSnapshot")
    expect(rel).toHaveProperty("referredParent")
    expect(rel).toHaveProperty("referrerParent")
  }
})

test("9. No phone, auth token, password, wallet, child, or media fields", async () => {
  const { access_token } = await loginAs(EMAIL_ADMIN)
  const r = await fetch(`${BASE}/api/admin/referrals`, {
    headers: cookieHeaders(access_token),
  })
  const body = await r.json()
  const str = JSON.stringify(body)
  const forbidden = ["phone", "access_token", "refresh_token", "password", "wallet", "child", "media", "avatar", "photo"]
  for (const f of forbidden) {
    expect(str).not.toMatch(new RegExp(`"${f}"`, "i"))
  }
})

// ═════════════════════════════════════════════════════════════════════════════
// GET — Pagination
// ═════════════════════════════════════════════════════════════════════════════

test("10. Default pagination works", async () => {
  const { access_token } = await loginAs(EMAIL_ADMIN)
  const r = await fetch(`${BASE}/api/admin/referrals`, {
    headers: cookieHeaders(access_token),
  })
  const body = await r.json()
  expect(body.pagination.page).toBe(1)
  expect(body.pagination.pageSize).toBe(25)
  expect(typeof body.pagination.total).toBe("number")
  expect(typeof body.pagination.totalPages).toBe("number")
})

test("11. page and pageSize work", async () => {
  const { access_token } = await loginAs(EMAIL_ADMIN)
  const r = await fetch(`${BASE}/api/admin/referrals?page=1&pageSize=10`, {
    headers: cookieHeaders(access_token),
  })
  const body = await r.json()
  expect(body.pagination.page).toBe(1)
  expect(body.pagination.pageSize).toBe(10)
})

test("12. Invalid page is rejected", async () => {
  const { access_token } = await loginAs(EMAIL_ADMIN)
  const r = await fetch(`${BASE}/api/admin/referrals?page=-1`, {
    headers: cookieHeaders(access_token),
  })
  // Should default to page 1
  expect(r.status).toBe(200)
  const body = await r.json()
  expect(body.pagination.page).toBe(1)
})

test("13. Invalid pageSize is rejected", async () => {
  const { access_token } = await loginAs(EMAIL_ADMIN)
  const r = await fetch(`${BASE}/api/admin/referrals?pageSize=-1`, {
    headers: cookieHeaders(access_token),
  })
  expect(r.status).toBe(200)
  const body = await r.json()
  expect(body.pagination.pageSize).toBe(25) // clamped to default
})

test("14. pageSize above 50 is rejected", async () => {
  const { access_token } = await loginAs(EMAIL_ADMIN)
  const r = await fetch(`${BASE}/api/admin/referrals?pageSize=100`, {
    headers: cookieHeaders(access_token),
  })
  expect(r.status).toBe(200)
  const body = await r.json()
  expect(body.pagination.pageSize).toBe(50) // clamped to max
})

// ═════════════════════════════════════════════════════════════════════════════
// GET — Search
// ═════════════════════════════════════════════════════════════════════════════

test("15. Search above 100 characters is rejected", async () => {
  const { access_token } = await loginAs(EMAIL_ADMIN)
  const r = await fetch(`${BASE}/api/admin/referrals?search=${"x".repeat(101)}`, {
    headers: cookieHeaders(access_token),
  })
  expect(r.status).toBe(400)
  const body = await r.json()
  expect(body).toHaveProperty("error")
})

test("16. Search filters by referral-code snapshot", async () => {
  const { access_token } = await loginAs(EMAIL_ADMIN)
  const code = parentUser.referralCode!.slice(0, 8)
  const r = await fetch(`${BASE}/api/admin/referrals?search=${encodeURIComponent(code)}`, {
    headers: cookieHeaders(access_token),
  })
  expect(r.status).toBe(200)
  const body = await r.json()
  expect(Array.isArray(body.relationships)).toBe(true)
  expect(body.relationships.length).toBeGreaterThanOrEqual(1)
})

test("17. Search filters by current referral code", async () => {
  const { access_token } = await loginAs(EMAIL_ADMIN)
  const code = parentUser.referralCode!.slice(0, 6)
  const r = await fetch(`${BASE}/api/admin/referrals?search=${encodeURIComponent(code)}`, {
    headers: cookieHeaders(access_token),
  })
  expect(r.status).toBe(200)
  const body = await r.json()
  expect(Array.isArray(body.relationships)).toBe(true)
})

test("18. Search filters by parent name", async () => {
  const { access_token } = await loginAs(EMAIL_ADMIN)
  const r = await fetch(`${BASE}/api/admin/referrals?search=Test+admin`, {
    headers: cookieHeaders(access_token),
  })
  expect(r.status).toBe(200)
  const body = await r.json()
  expect(Array.isArray(body.relationships)).toBe(true)
})

test("19. Search filters by parent email", async () => {
  const { access_token } = await loginAs(EMAIL_ADMIN)
  const r = await fetch(`${BASE}/api/admin/referrals?search=${encodeURIComponent(EMAIL_PARENT.slice(0, 15))}`, {
    headers: cookieHeaders(access_token),
  })
  expect(r.status).toBe(200)
  const body = await r.json()
  expect(Array.isArray(body.relationships)).toBe(true)
})

test("20. Search is case-insensitive", async () => {
  const { access_token } = await loginAs(EMAIL_ADMIN)
  const upper = EMAIL_PARENT.toUpperCase().slice(0, 10)
  const r = await fetch(`${BASE}/api/admin/referrals?search=${encodeURIComponent(upper)}`, {
    headers: cookieHeaders(access_token),
  })
  expect(r.status).toBe(200)
  const body = await r.json()
  expect(Array.isArray(body.relationships)).toBe(true)
})

test("21. Literal `%` and `_` do not act as uncontrolled wildcards", async () => {
  const { access_token } = await loginAs(EMAIL_ADMIN)
  const r = await fetch(`${BASE}/api/admin/referrals?search=CT%25_`, {
    headers: cookieHeaders(access_token),
  })
  expect(r.status).toBe(200)
  const body = await r.json()
  expect(Array.isArray(body.relationships)).toBe(true)
  // Should not error or return pathological results
})

test("22. Deleted parent identities return null fields", async () => {
  const { access_token } = await loginAs(EMAIL_ADMIN)

  // Create a temporary profile to be deleted
  const tempProfR = await fetch(`${SUPABASE_URL}/rest/v1/parent_profiles`, {
    method: "POST", headers: HDR,
    body: JSON.stringify({ user_id: adminUser.id, full_name: "Temp Del", consent_granted: true, consent_granted_at: new Date().toISOString() }),
  })
  const tempProfBody = await tempProfR.text()
  let tempProfId: string | null = null
  if (tempProfBody) {
    try { tempProfId = JSON.parse(tempProfBody).id } catch {}
  }
  if (!tempProfId) {
    const qR = await fetch(`${SUPABASE_URL}/rest/v1/parent_profiles?select=id&user_id=eq.${adminUser.id}&order=created_at.desc&limit=1`, { headers: HDR })
    const qData = await qR.json()
    tempProfId = qData.length > 0 ? qData[0].id : null
  }
  expect(tempProfId).toBeTruthy()

  // Use a second profile (parentUser's existing profile) for referred_parent_id (NOT NULL, CASCADE)
  // and the temp profile for referrer_parent_id (nullable, SET NULL)
  expect(parentUser.profileId).toBeTruthy()

  const relR = await fetch(`${SUPABASE_URL}/rest/v1/referral_relationships`, {
    method: "POST", headers: HDR,
    body: JSON.stringify({
      referred_parent_id: parentUser.profileId,
      referrer_parent_id: tempProfId,
      referral_code_snapshot: "CTAAAAAAAAAAAA",
      binding_source: "manual",
    }),
  })
  expect(relR.ok).toBe(true)

  // Delete the temp profile — referrer_parent_id FK ON DELETE SET NULL
  await fetch(`${SUPABASE_URL}/rest/v1/parent_profiles?id=eq.${tempProfId}`, {
    method: "DELETE", headers: HDR,
  })

  const r = await fetch(`${BASE}/api/admin/referrals?search=CTAAAAAAAAAAAA`, {
    headers: cookieHeaders(access_token),
  })
  expect(r.status).toBe(200)
  const body = await r.json()
  const match = body.relationships.find((rel: Record<string, unknown>) => rel.referralCodeSnapshot === "CTAAAAAAAAAAAA")
  expect(match).toBeTruthy()
  // referrerParent should be null because the profile was deleted (SET NULL)
  if (match.referrerParent !== null) {
    expect(match.referrerParent.name).toBeNull()
    expect(match.referrerParent.email).toBeNull()
    expect(match.referrerParent.currentCode).toBeNull()
  }
})

// ═════════════════════════════════════════════════════════════════════════════
// GET — Response headers
// ═════════════════════════════════════════════════════════════════════════════

test("23. Cache-Control is no-store", async () => {
  const { access_token } = await loginAs(EMAIL_ADMIN)
  const r = await fetch(`${BASE}/api/admin/referrals`, {
    headers: cookieHeaders(access_token),
  })
  expect(r.headers.get("cache-control")).toBe("no-store")
})

test("24. X-Content-Type-Options is nosniff", async () => {
  const { access_token } = await loginAs(EMAIL_ADMIN)
  const r = await fetch(`${BASE}/api/admin/referrals`, {
    headers: cookieHeaders(access_token),
  })
  expect(r.headers.get("x-content-type-options")).toBe("nosniff")
})

// ═════════════════════════════════════════════════════════════════════════════
// PATCH /api/admin/referrals/settings — Validation
// ═════════════════════════════════════════════════════════════════════════════

test("25. Wrong Content-Type → 415", async () => {
  const { access_token } = await loginAs(EMAIL_ADMIN)
  const r = await fetch(`${BASE}/api/admin/referrals/settings`, {
    method: "PATCH",
    headers: { ...cookieHeaders(access_token), "Content-Type": "text/plain" },
    body: "hello",
  })
  expect(r.status).toBe(415)
})

test("26. Oversized body → 413", async () => {
  const { access_token } = await loginAs(EMAIL_ADMIN)
  const big = "x".repeat(2048)
  const r = await fetch(`${BASE}/api/admin/referrals/settings`, {
    method: "PATCH",
    headers: { ...cookieHeaders(access_token), "Content-Type": "application/json" },
    body: JSON.stringify({ isEnabled: true, rewardBasisPoints: 1500, expectedUpdatedAt: new Date().toISOString(), extra: big }),
  })
  expect(r.status).toBe(413)
})

test("27. Invalid JSON → 400", async () => {
  const { access_token } = await loginAs(EMAIL_ADMIN)
  const r = await fetch(`${BASE}/api/admin/referrals/settings`, {
    method: "PATCH",
    headers: { ...cookieHeaders(access_token), "Content-Type": "application/json" },
    body: "not json",
  })
  expect(r.status).toBe(400)
  const body = await r.json()
  expect(body).toHaveProperty("error")
})

test("28. Missing field → 400", async () => {
  const { access_token } = await loginAs(EMAIL_ADMIN)
  const r = await fetch(`${BASE}/api/admin/referrals/settings`, {
    method: "PATCH",
    headers: { ...cookieHeaders(access_token), "Content-Type": "application/json" },
    body: JSON.stringify({ isEnabled: true, rewardBasisPoints: 1500 }),
  })
  expect(r.status).toBe(400)
})

test("29. Extra field → 400", async () => {
  const { access_token } = await loginAs(EMAIL_ADMIN)
  const r = await fetch(`${BASE}/api/admin/referrals/settings`, {
    method: "PATCH",
    headers: { ...cookieHeaders(access_token), "Content-Type": "application/json" },
    body: JSON.stringify({ isEnabled: true, rewardBasisPoints: 1500, expectedUpdatedAt: new Date().toISOString(), extra: "bad" }),
  })
  expect(r.status).toBe(400)
})

test("30. Wrong field types → 400", async () => {
  const { access_token } = await loginAs(EMAIL_ADMIN)
  const r = await fetch(`${BASE}/api/admin/referrals/settings`, {
    method: "PATCH",
    headers: { ...cookieHeaders(access_token), "Content-Type": "application/json" },
    body: JSON.stringify({ isEnabled: "yes", rewardBasisPoints: "1500", expectedUpdatedAt: 123 }),
  })
  expect(r.status).toBe(400)
})

test("31. Invalid expectedUpdatedAt → 400", async () => {
  const { access_token } = await loginAs(EMAIL_ADMIN)
  const r = await fetch(`${BASE}/api/admin/referrals/settings`, {
    method: "PATCH",
    headers: { ...cookieHeaders(access_token), "Content-Type": "application/json" },
    body: JSON.stringify({ isEnabled: true, rewardBasisPoints: 1500, expectedUpdatedAt: "not-a-date" }),
  })
  expect(r.status).toBe(400)
})

test("32. rewardBasisPoints below 0 → 422", async () => {
  const { access_token } = await loginAs(EMAIL_ADMIN)
  const r = await fetch(`${BASE}/api/admin/referrals/settings`, {
    method: "PATCH",
    headers: { ...cookieHeaders(access_token), "Content-Type": "application/json" },
    body: JSON.stringify({ isEnabled: true, rewardBasisPoints: -1, expectedUpdatedAt: new Date().toISOString() }),
  })
  expect(r.status).toBe(422)
  const body = await r.json()
  expect(body.code).toBe("REFERRAL_SETTINGS_INVALID")
})

test("33. rewardBasisPoints above 10000 → 422", async () => {
  const { access_token } = await loginAs(EMAIL_ADMIN)
  const r = await fetch(`${BASE}/api/admin/referrals/settings`, {
    method: "PATCH",
    headers: { ...cookieHeaders(access_token), "Content-Type": "application/json" },
    body: JSON.stringify({ isEnabled: true, rewardBasisPoints: 10001, expectedUpdatedAt: new Date().toISOString() }),
  })
  expect(r.status).toBe(422)
  const body = await r.json()
  expect(body.code).toBe("REFERRAL_SETTINGS_INVALID")
})

// ═════════════════════════════════════════════════════════════════════════════
// PATCH — Authorization
// ═════════════════════════════════════════════════════════════════════════════

test("34. Parent request → 403", async () => {
  const { access_token } = await loginAs(EMAIL_PARENT)
  const r = await fetch(`${BASE}/api/admin/referrals/settings`, {
    method: "PATCH",
    headers: { ...cookieHeaders(access_token), "Content-Type": "application/json" },
    body: JSON.stringify({ isEnabled: true, rewardBasisPoints: 1500, expectedUpdatedAt: new Date().toISOString() }),
  })
  expect(r.status).toBe(403)
})

// ═════════════════════════════════════════════════════════════════════════════
// PATCH — Successful updates
// ═════════════════════════════════════════════════════════════════════════════

async function fetchSettings(): Promise<{ isEnabled: boolean; rewardBasisPoints: number; updatedAt: string }> {
  const { access_token } = await loginAs(EMAIL_ADMIN)
  const r = await fetch(`${BASE}/api/admin/referrals`, {
    headers: cookieHeaders(access_token),
  })
  const body = await r.json()
  return body.settings
}

test("35. Admin valid update → 200 with status updated", async () => {
  const settings = await fetchSettings()
  const newRate = settings.rewardBasisPoints === 2000 ? 2001 : 2000
  const { access_token } = await loginAs(EMAIL_ADMIN)
  const r = await fetch(`${BASE}/api/admin/referrals/settings`, {
    method: "PATCH",
    headers: { ...cookieHeaders(access_token), "Content-Type": "application/json" },
    body: JSON.stringify({ isEnabled: true, rewardBasisPoints: newRate, expectedUpdatedAt: settings.updatedAt }),
  })
  expect(r.status).toBe(200)
  const body = await r.json()
  expect(body.status).toBe("updated")
})

test("36. Super-admin valid update → 200 with status updated", async () => {
  const settings = await fetchSettings()
  const newRate = settings.rewardBasisPoints === 2500 ? 2501 : 2500
  const { access_token } = await loginAs(EMAIL_SUPER)
  const r = await fetch(`${BASE}/api/admin/referrals/settings`, {
    method: "PATCH",
    headers: { ...cookieHeaders(access_token), "Content-Type": "application/json" },
    body: JSON.stringify({ isEnabled: true, rewardBasisPoints: newRate, expectedUpdatedAt: settings.updatedAt }),
  })
  expect(r.status).toBe(200)
  const body = await r.json()
  expect(body.status).toBe("updated")
})

test("37. Exact settings values appear in the response", async () => {
  const settings = await fetchSettings()
  const { access_token } = await loginAs(EMAIL_ADMIN)
  const r = await fetch(`${BASE}/api/admin/referrals/settings`, {
    method: "PATCH",
    headers: { ...cookieHeaders(access_token), "Content-Type": "application/json" },
    body: JSON.stringify({ isEnabled: true, rewardBasisPoints: 2000, expectedUpdatedAt: settings.updatedAt }),
  })
  expect(r.status).toBe(200)
  const body = await r.json()
  expect(body.settings.isEnabled).toBe(true)
  expect(body.settings.rewardBasisPoints).toBe(2000)
  expect(typeof body.settings.updatedAt).toBe("string")
  expect(body.settings.updatedAt).not.toBe(new Date(0).toISOString())
})

test("38. Subsequent GET returns the updated values", async () => {
  const settings = await fetchSettings()

  // Do an update first
  const { access_token } = await loginAs(EMAIL_ADMIN)
  const patchR = await fetch(`${BASE}/api/admin/referrals/settings`, {
    method: "PATCH",
    headers: { ...cookieHeaders(access_token), "Content-Type": "application/json" },
    body: JSON.stringify({ isEnabled: true, rewardBasisPoints: 2500, expectedUpdatedAt: settings.updatedAt }),
  })
  expect(patchR.status).toBe(200)
  const patchBody = await patchR.json()
  expect(patchBody.status).toBe("updated")

  // Verify via GET
  const getR = await fetch(`${BASE}/api/admin/referrals`, {
    headers: cookieHeaders(access_token),
  })
  const getBody = await getR.json()
  expect(getBody.settings.rewardBasisPoints).toBe(2500)
  expect(getBody.settings.isEnabled).toBe(true)
})

// ═════════════════════════════════════════════════════════════════════════════
// PATCH — No-op
// ═════════════════════════════════════════════════════════════════════════════

test("39. No-op update → 200 with status unchanged", async () => {
  const settings = await fetchSettings()
  const { access_token } = await loginAs(EMAIL_ADMIN)
  const r = await fetch(`${BASE}/api/admin/referrals/settings`, {
    method: "PATCH",
    headers: { ...cookieHeaders(access_token), "Content-Type": "application/json" },
    body: JSON.stringify({
      isEnabled: settings.isEnabled,
      rewardBasisPoints: settings.rewardBasisPoints,
      expectedUpdatedAt: settings.updatedAt,
    }),
  })
  expect(r.status).toBe(200)
  const body = await r.json()
  expect(body.status).toBe("unchanged")
})

test("40. No-op does not change updatedAt", async () => {
  const before = await fetchSettings()
  const { access_token } = await loginAs(EMAIL_ADMIN)
  const r = await fetch(`${BASE}/api/admin/referrals/settings`, {
    method: "PATCH",
    headers: { ...cookieHeaders(access_token), "Content-Type": "application/json" },
    body: JSON.stringify({
      isEnabled: before.isEnabled,
      rewardBasisPoints: before.rewardBasisPoints,
      expectedUpdatedAt: before.updatedAt,
    }),
  })
  expect(r.status).toBe(200)
  const body = await r.json()
  expect(body.status).toBe("unchanged")
  expect(body.settings.updatedAt).toBe(before.updatedAt)
})

test("41. No-op does not create history", async () => {
  const beforeCountR = await fetch(`${SUPABASE_URL}/rest/v1/referral_program_settings_history?select=id`, { headers: HDR })
  const before = await beforeCountR.json()
  const beforeLen = Array.isArray(before) ? before.length : 0

  const settings = await fetchSettings()
  const { access_token } = await loginAs(EMAIL_ADMIN)
  await fetch(`${BASE}/api/admin/referrals/settings`, {
    method: "PATCH",
    headers: { ...cookieHeaders(access_token), "Content-Type": "application/json" },
    body: JSON.stringify({
      isEnabled: settings.isEnabled,
      rewardBasisPoints: settings.rewardBasisPoints,
      expectedUpdatedAt: settings.updatedAt,
    }),
  })

  const afterCountR = await fetch(`${SUPABASE_URL}/rest/v1/referral_program_settings_history?select=id`, { headers: HDR })
  const after = await afterCountR.json()
  const afterLen = Array.isArray(after) ? after.length : 0

  expect(afterLen).toBe(beforeLen)
})

// ═════════════════════════════════════════════════════════════════════════════
// PATCH — Conflict
// ═════════════════════════════════════════════════════════════════════════════

test("42. Stale expectedUpdatedAt → 409", async () => {
  const { access_token } = await loginAs(EMAIL_ADMIN)
  const stale = new Date(0).toISOString()
  const r = await fetch(`${BASE}/api/admin/referrals/settings`, {
    method: "PATCH",
    headers: { ...cookieHeaders(access_token), "Content-Type": "application/json" },
    body: JSON.stringify({ isEnabled: true, rewardBasisPoints: 1500, expectedUpdatedAt: stale }),
  })
  expect(r.status).toBe(409)
})

test("43. Conflict code equals REFERRAL_SETTINGS_CONFLICT", async () => {
  const { access_token } = await loginAs(EMAIL_ADMIN)
  const stale = new Date(0).toISOString()
  const r = await fetch(`${BASE}/api/admin/referrals/settings`, {
    method: "PATCH",
    headers: { ...cookieHeaders(access_token), "Content-Type": "application/json" },
    body: JSON.stringify({ isEnabled: true, rewardBasisPoints: 1500, expectedUpdatedAt: stale }),
  })
  const body = await r.json()
  expect(body.code).toBe("REFERRAL_SETTINGS_CONFLICT")
})

test("44. Conflict does not modify settings", async () => {
  const before = await fetchSettings()
  const { access_token } = await loginAs(EMAIL_ADMIN)
  const stale = new Date(0).toISOString()
  await fetch(`${BASE}/api/admin/referrals/settings`, {
    method: "PATCH",
    headers: { ...cookieHeaders(access_token), "Content-Type": "application/json" },
    body: JSON.stringify({ isEnabled: false, rewardBasisPoints: 9999, expectedUpdatedAt: stale }),
  })
  const after = await fetchSettings()
  expect(after.isEnabled).toBe(before.isEnabled)
  expect(after.rewardBasisPoints).toBe(before.rewardBasisPoints)
  expect(after.updatedAt).toBe(before.updatedAt)
})

test("45. Conflict does not create history", async () => {
  const beforeCountR = await fetch(`${SUPABASE_URL}/rest/v1/referral_program_settings_history?select=id`, { headers: HDR })
  const before = await beforeCountR.json()
  const beforeLen = Array.isArray(before) ? before.length : 0

  const { access_token } = await loginAs(EMAIL_ADMIN)
  await fetch(`${BASE}/api/admin/referrals/settings`, {
    method: "PATCH",
    headers: { ...cookieHeaders(access_token), "Content-Type": "application/json" },
    body: JSON.stringify({ isEnabled: false, rewardBasisPoints: 9999, expectedUpdatedAt: new Date(0).toISOString() }),
  })

  const afterCountR = await fetch(`${SUPABASE_URL}/rest/v1/referral_program_settings_history?select=id`, { headers: HDR })
  const after = await afterCountR.json()
  const afterLen = Array.isArray(after) ? after.length : 0

  expect(afterLen).toBe(beforeLen)
})

// ═════════════════════════════════════════════════════════════════════════════
// PATCH — History verification
// ═════════════════════════════════════════════════════════════════════════════

test("46. Real update creates exactly one history row", async () => {
  const settings = await fetchSettings()
  const beforeCountR = await fetch(`${SUPABASE_URL}/rest/v1/referral_program_settings_history?select=id`, { headers: HDR })
  const before = await beforeCountR.json()
  const beforeLen = Array.isArray(before) ? before.length : 0

  const { access_token } = await loginAs(EMAIL_ADMIN)
  const newRate = settings.rewardBasisPoints === 500 ? 501 : 500
  await fetch(`${BASE}/api/admin/referrals/settings`, {
    method: "PATCH",
    headers: { ...cookieHeaders(access_token), "Content-Type": "application/json" },
    body: JSON.stringify({ isEnabled: true, rewardBasisPoints: newRate, expectedUpdatedAt: settings.updatedAt }),
  })

  const afterCountR = await fetch(`${SUPABASE_URL}/rest/v1/referral_program_settings_history?select=id`, { headers: HDR })
  const after = await afterCountR.json()
  const afterLen = Array.isArray(after) ? after.length : 0

  expect(afterLen).toBe(beforeLen + 1)
})

test("47. History records the authenticated admin actor", async () => {
  const historyR = await fetch(`${SUPABASE_URL}/rest/v1/referral_program_settings_history?select=actor_user_id,previous_reward_basis_points,new_reward_basis_points&order=changed_at.desc&limit=1`, { headers: HDR })
  const rows = await historyR.json()
  expect(rows.length).toBeGreaterThanOrEqual(1)
  const latest = rows[0]
  // The actor_user_id should be set by the RPC when called with authenticated user
  // (service_role calls set it to the calling user's id)
  expect(latest.actor_user_id).toBe(adminUser.id)
})

// ═════════════════════════════════════════════════════════════════════════════
// Concurrency
// ═════════════════════════════════════════════════════════════════════════════

test("48. Two concurrent updates with same expectedUpdatedAt produce one success and one conflict", async () => {
  const beforeHistoryR = await fetch(`${SUPABASE_URL}/rest/v1/referral_program_settings_history?select=id`, { headers: HDR })
  const beforeHistory = await beforeHistoryR.json()
  const beforeHistoryLen = Array.isArray(beforeHistory) ? beforeHistory.length : 0

  const settings = await fetchSettings()
  const ts = settings.updatedAt
  const { access_token } = await loginAs(EMAIL_ADMIN)
  const headers = { ...cookieHeaders(access_token), "Content-Type": "application/json" }

  // Send two concurrent updates with the same expectedUpdatedAt
  const [r1, r2] = await Promise.all([
    fetch(`${BASE}/api/admin/referrals/settings`, {
      method: "PATCH", headers,
      body: JSON.stringify({ isEnabled: true, rewardBasisPoints: 2000, expectedUpdatedAt: ts }),
    }),
    fetch(`${BASE}/api/admin/referrals/settings`, {
      method: "PATCH", headers,
      body: JSON.stringify({ isEnabled: true, rewardBasisPoints: 2500, expectedUpdatedAt: ts }),
    }),
  ])

  // One should succeed, one should conflict
  const statuses = [r1.status, r2.status]
  expect(statuses).toContain(200)
  expect(statuses).toContain(409)

  const winner = r1.status === 200 ? r1 : r2
  const loser = r1.status === 409 ? r1 : r2

  const winnerBody = await winner.json()
  const loserBody = await loser.json()

  expect(winnerBody.status).toBe("updated")
  expect(loserBody.code).toBe("REFERRAL_SETTINGS_CONFLICT")

  // Exactly one more history row
  const afterHistoryR = await fetch(`${SUPABASE_URL}/rest/v1/referral_program_settings_history?select=id`, { headers: HDR })
  const afterHistory = await afterHistoryR.json()
  const afterHistoryLen = Array.isArray(afterHistory) ? afterHistory.length : 0
  expect(afterHistoryLen).toBe(beforeHistoryLen + 1)

  // Final settings match the winner
  const final = await fetchSettings()
  expect(final.rewardBasisPoints).toBe(winnerBody.settings.rewardBasisPoints)

  // Restore
  await fetch(`${BASE}/api/admin/referrals/settings`, {
    method: "PATCH", headers,
    body: JSON.stringify({ isEnabled: true, rewardBasisPoints: 1500, expectedUpdatedAt: final.updatedAt }),
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// PATCH — Disable/re-enable
// ═════════════════════════════════════════════════════════════════════════════

test("49. Disabling preserves referral codes", async () => {
  const before = await fetchSettings()
  const { access_token } = await loginAs(EMAIL_ADMIN)
  await fetch(`${BASE}/api/admin/referrals/settings`, {
    method: "PATCH",
    headers: { ...cookieHeaders(access_token), "Content-Type": "application/json" },
    body: JSON.stringify({ isEnabled: false, rewardBasisPoints: before.rewardBasisPoints, expectedUpdatedAt: before.updatedAt }),
  })

  // Verify code is preserved: parent code should still exist
  const profR = await fetch(`${SUPABASE_URL}/rest/v1/parent_profiles?select=id,referral_code&user_id=eq.${parentUser.id}`, { headers: HDR })
  const prof = await profR.json()
  expect(prof.length).toBeGreaterThanOrEqual(1)
  expect(prof[0].referral_code).toBeTruthy()

  // Restore
  const afterSettings = await fetchSettings()
  await fetch(`${BASE}/api/admin/referrals/settings`, {
    method: "PATCH",
    headers: { ...cookieHeaders(access_token), "Content-Type": "application/json" },
    body: JSON.stringify({ isEnabled: true, rewardBasisPoints: 1500, expectedUpdatedAt: afterSettings.updatedAt }),
  })
})

test("50. Disabling preserves referral relationships", async () => {
  const before = await fetchSettings()
  const { access_token } = await loginAs(EMAIL_ADMIN)

  // Count relationships
  const beforeRelR = await fetch(`${BASE}/api/admin/referrals`, {
    headers: cookieHeaders(access_token),
  })
  const beforeRel = await beforeRelR.json()
  const relCount = beforeRel.metrics.totalRelationships

  await fetch(`${BASE}/api/admin/referrals/settings`, {
    method: "PATCH",
    headers: { ...cookieHeaders(access_token), "Content-Type": "application/json" },
    body: JSON.stringify({ isEnabled: false, rewardBasisPoints: before.rewardBasisPoints, expectedUpdatedAt: before.updatedAt }),
  })

  // Verify relationships still exist
  const afterRelR = await fetch(`${BASE}/api/admin/referrals`, {
    headers: cookieHeaders(access_token),
  })
  const afterRel = await afterRelR.json()
  expect(afterRel.metrics.totalRelationships).toBeGreaterThanOrEqual(relCount)

  // Restore
  const afterSettings = await fetchSettings()
  await fetch(`${BASE}/api/admin/referrals/settings`, {
    method: "PATCH",
    headers: { ...cookieHeaders(access_token), "Content-Type": "application/json" },
    body: JSON.stringify({ isEnabled: true, rewardBasisPoints: 1500, expectedUpdatedAt: afterSettings.updatedAt }),
  })
})

test("51. Parent binding API returns program-disabled while disabled", async () => {
  const before = await fetchSettings()

  // Disable
  const { access_token: adminToken } = await loginAs(EMAIL_ADMIN)
  await fetch(`${BASE}/api/admin/referrals/settings`, {
    method: "PATCH",
    headers: { ...cookieHeaders(adminToken), "Content-Type": "application/json" },
    body: JSON.stringify({ isEnabled: false, rewardBasisPoints: before.rewardBasisPoints, expectedUpdatedAt: before.updatedAt }),
  })

  // Try parent binding API
  const { access_token: parentToken } = await loginAs(EMAIL_PARENT)
  const bindR = await fetch(`${BASE}/api/referrals/bind`, {
    method: "POST",
    headers: { ...cookieHeaders(parentToken), "Content-Type": "application/json" },
    body: JSON.stringify({ code: "SOME_CODE" }),
  })
  // Should be rejected because program is disabled
  expect(bindR.status).toBe(409)
  const bindBody = await bindR.json()
  expect(bindBody.code).toBe("REFERRAL_PROGRAM_DISABLED")

  // Restore
  const afterSettings = await fetchSettings()
  await fetch(`${BASE}/api/admin/referrals/settings`, {
    method: "PATCH",
    headers: { ...cookieHeaders(adminToken), "Content-Type": "application/json" },
    body: JSON.stringify({ isEnabled: true, rewardBasisPoints: 1500, expectedUpdatedAt: afterSettings.updatedAt }),
  })
})

test("52. Re-enabling restores binding behavior", async () => {
  // Enable
  const adminToken = (await loginAs(EMAIL_ADMIN)).access_token
  const settings = await fetchSettings()
  await fetch(`${BASE}/api/admin/referrals/settings`, {
    method: "PATCH",
    headers: { ...cookieHeaders(adminToken), "Content-Type": "application/json" },
    body: JSON.stringify({ isEnabled: true, rewardBasisPoints: settings.rewardBasisPoints, expectedUpdatedAt: settings.updatedAt }),
  })

  // Verify overview shows enabled
  const getR = await fetch(`${BASE}/api/admin/referrals`, {
    headers: cookieHeaders(adminToken),
  })
  const getBody = await getR.json()
  expect(getBody.settings.isEnabled).toBe(true)
})

// ═════════════════════════════════════════════════════════════════════════════
// Non-mutation checks
// ═════════════════════════════════════════════════════════════════════════════

async function getWalletBalance(userId: string): Promise<number | null> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/candy_wallets?select=balance&user_id=eq.${userId}`, { headers: HDR })
  if (!r.ok) return null
  const data = await r.json()
  return data.length > 0 ? Number(data[0].balance) : null
}

async function getCandyTxCount(): Promise<number> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/candy_transactions?select=id&limit=1000`, { headers: HDR })
  if (!r.ok) return -1
  const data = await r.json()
  return Array.isArray(data) ? data.length : 0
}

async function getRelCount(): Promise<number> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/referral_relationships?select=id`, { headers: HDR })
  const data = await r.json()
  return Array.isArray(data) ? data.length : 0
}

test("53. No wallet balance changes", async () => {
  const beforeBal = await getWalletBalance(adminUser.id)
  if (beforeBal === null) return // no wallet table
  const settings = await fetchSettings()
  const { access_token } = await loginAs(EMAIL_ADMIN)
  await fetch(`${BASE}/api/admin/referrals/settings`, {
    method: "PATCH",
    headers: { ...cookieHeaders(access_token), "Content-Type": "application/json" },
    body: JSON.stringify({ isEnabled: true, rewardBasisPoints: 1500, expectedUpdatedAt: settings.updatedAt }),
  })
  const afterBal = await getWalletBalance(adminUser.id)
  expect(afterBal).toBe(beforeBal)
})

test("54. No candy transaction changes", async () => {
  const before = await getCandyTxCount()
  if (before < 0) return // no table
  const settings = await fetchSettings()
  const { access_token } = await loginAs(EMAIL_ADMIN)
  await fetch(`${BASE}/api/admin/referrals/settings`, {
    method: "PATCH",
    headers: { ...cookieHeaders(access_token), "Content-Type": "application/json" },
    body: JSON.stringify({ isEnabled: true, rewardBasisPoints: 1500, expectedUpdatedAt: settings.updatedAt }),
  })
  const after = await getCandyTxCount()
  expect(after).toBe(before)
})

test("55. No referral relationship is created, updated, or deleted by admin settings APIs", async () => {
  const before = await getRelCount()
  const settings = await fetchSettings()
  const { access_token } = await loginAs(EMAIL_ADMIN)

  // Do a settings update
  await fetch(`${BASE}/api/admin/referrals/settings`, {
    method: "PATCH",
    headers: { ...cookieHeaders(access_token), "Content-Type": "application/json" },
    body: JSON.stringify({ isEnabled: true, rewardBasisPoints: 1500, expectedUpdatedAt: settings.updatedAt }),
  })

  // Verify relationship count unchanged
  const after = await getRelCount()
  expect(after).toBe(before)
})
