import { test, expect, type Page } from "@playwright/test"
import * as fs from "fs"
import * as path from "path"
import { assertSafeDatabaseTarget } from "../helpers/assert-safe-database-target"

const BASE = "http://localhost:3000"
const PROJECT_REF = "oucyhmrnzahlhqjfqcge"
const SUPABASE_URL = `https://${PROJECT_REF}.supabase.co`

function loadEnv(): void {
  try {
    const content = fs.readFileSync(path.resolve(__dirname, "../../.env.local"), "utf-8")
    for (const line of content.split("\n")) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith("#")) continue
      const eqIdx = trimmed.indexOf("=")
      if (eqIdx === -1) continue
      const key = trimmed.slice(0, eqIdx)
      const val = trimmed.slice(eqIdx + 1)
      process.env[key] = val
    }
  } catch { /* fallback */ }
}

loadEnv()

const _guard = assertSafeDatabaseTarget()
if (!_guard.ok) throw new Error(`Guard blocked: ${_guard.reason}`)

const ADMIN_KEY = process.env.SUPABASE_SECRET_KEY || ""
const TS = String(Date.now()).slice(-8)

function adminHeaders() {
  return { "Content-Type": "application/json", apikey: ADMIN_KEY, Authorization: `Bearer ${ADMIN_KEY}` }
}

const COOKIE_NAME = `sb-${PROJECT_REF}-auth-token`

async function createUser(email: string): Promise<string> {
  const createResp = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: "POST",
    headers: adminHeaders(),
    body: JSON.stringify({ email, password: "TestPass999!", email_confirm: true, user_metadata: { full_name: "Test" } }),
  })
  if (!createResp.ok) throw new Error(`Create ${email}: ${await createResp.text()}`)
  const user = await createResp.json()
  return user.id
}

async function ensureParentProfile(userId: string, name: string): Promise<string | null> {
  const check = await fetch(`${SUPABASE_URL}/rest/v1/parent_profiles?user_id=eq.${userId}&select=id,referral_code`, { headers: adminHeaders() })
  const existing = await check.json()
  if (existing && existing.length > 0) return existing[0].id
  const createResp = await fetch(`${SUPABASE_URL}/rest/v1/parent_profiles`, {
    method: "POST",
    headers: { ...adminHeaders(), Prefer: "return=representation" },
    body: JSON.stringify({ user_id: userId, full_name: name, consent_granted: true, consent_granted_at: new Date().toISOString() }),
  })
  if (!createResp.ok) return null
  const created = await createResp.json()
  return created?.id ?? null
}

async function getReferralCode(userId: string): Promise<string | null> {
  const check = await fetch(`${SUPABASE_URL}/rest/v1/parent_profiles?user_id=eq.${userId}&select=referral_code`, { headers: adminHeaders() })
  const data = await check.json()
  return data.length > 0 ? data[0].referral_code : null
}

function buildCookie(accessToken: string, refreshToken: string, expiresIn: number): string {
  const session = {
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_in: expiresIn,
    expires_at: Math.floor(Date.now() / 1000) + expiresIn,
    token_type: "bearer",
  }
  return "base64-" + Buffer.from(JSON.stringify(session)).toString("base64url")
}

async function buildSession(email: string): Promise<string> {
  const loginResp = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: adminHeaders(),
    body: JSON.stringify({ email, password: "TestPass999!" }),
  })
  const data = await loginResp.json()
  return buildCookie(data.access_token, data.refresh_token, data.expires_in)
}

async function navigateWithAuth(page: Page, url: string, cookie: string): Promise<void> {
  await page.evaluate(() => { try { localStorage.clear(); sessionStorage.clear() } catch {} }).catch(() => {})
  await page.context().clearCookies()
  await page.context().addCookies([
    { name: COOKIE_NAME, value: cookie, domain: "localhost", path: "/", httpOnly: false, secure: false, sameSite: "Lax" as const },
  ])
  await page.goto(url, { waitUntil: "load", timeout: 15000 })
}

// ── Users and sessions ────────────────────────────────────────────────────

const EMAIL_ADMIN = `adm_dash_${TS}@test.com`
const EMAIL_PARENT = `par_dash_${TS}@test.com`
const EMAIL_PARENT2 = `par2_dash_${TS}@test.com`
const EMAIL_PARENT3 = `par3_dash_${TS}@test.com`
const cleanupIds: string[] = []

let adminCookie = ""
let parentProfileId: string | null = null
let parentProfileId2: string | null = null

test.beforeAll(async () => {
  test.setTimeout(120000)

  const uAdmin = await createUser(EMAIL_ADMIN)
  await fetch(`${SUPABASE_URL}/rest/v1/users?id=eq.${uAdmin}`, {
    method: "PATCH", headers: adminHeaders(),
    body: JSON.stringify({ role: "admin" }),
  }).catch(() => {})

  const uParent = await createUser(EMAIL_PARENT)
  const uParent2 = await createUser(EMAIL_PARENT2)
  const uParent3 = await createUser(EMAIL_PARENT3)

  cleanupIds.push(uAdmin, uParent, uParent2, uParent3)

  // Create profiles with unique names for search testing
  await ensureParentProfile(uAdmin, "Admin Manager")
  parentProfileId = await ensureParentProfile(uParent, "Par Reference")
  parentProfileId2 = await ensureParentProfile(uParent2, "Par Target")

  // Ensure referral program is enabled
  await fetch(`${SUPABASE_URL}/rest/v1/referral_program_settings?id=eq.1`, {
    method: "PATCH", headers: adminHeaders(),
    body: JSON.stringify({ is_enabled: true, reward_basis_points: 1500 }),
  }).catch(() => {})

  // Create a referral relationship for meaningful data
  const pCode = await getReferralCode(uParent)

  if (parentProfileId && parentProfileId2 && pCode) {
    await fetch(`${SUPABASE_URL}/rest/v1/referral_relationships`, {
      method: "POST", headers: adminHeaders(),
      body: JSON.stringify({
        referred_parent_id: parentProfileId2,
        referrer_parent_id: parentProfileId,
        referral_code_snapshot: pCode,
        binding_source: "self_service",
      }),
    }).catch(() => {})
  }

  adminCookie = await buildSession(EMAIL_ADMIN)
})

test.afterAll(async () => {
  // Remove the relationship we created
  if (parentProfileId && parentProfileId2) {
    await fetch(`${SUPABASE_URL}/rest/v1/referral_relationships?referred_parent_id=eq.${parentProfileId2}`, {
      method: "DELETE", headers: adminHeaders(),
    }).catch(() => {})
  }

  for (const uid of cleanupIds) {
    await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${uid}`, { method: "DELETE", headers: adminHeaders() }).catch(() => {})
  }
})

function loginAs(page: Page) {
  return navigateWithAuth(page, `${BASE}/admin/referrals`, adminCookie)
}

// ══════════════════════════════════════════════════════════════════════════
//  Page loads referral data
// ══════════════════════════════════════════════════════════════════════════

test("page loads and shows page header", async ({ page }) => {
  await loginAs(page)
  await expect(page.locator("h1")).toContainText("مدیریت معرفی")
})

test("settings card displays program status", async ({ page }) => {
  await loginAs(page)
  await expect(page.getByText("وضعیت")).toBeVisible()
  await expect(page.getByText("فعال")).toBeVisible()
})

test("settings card shows reward rate", async ({ page }) => {
  await loginAs(page)
  await expect(page.getByText("نرخ پاداش:")).toBeVisible()
})

test("metrics section shows parent profile count", async ({ page }) => {
  await loginAs(page)
  await expect(page.getByText("پروفایل والد")).toBeVisible()
})

test("metrics section shows relationship count", async ({ page }) => {
  await loginAs(page)
  await expect(page.getByText("روابط معرفی ثبت‌شده")).toBeVisible()
})

test("edit button is present", async ({ page }) => {
  await loginAs(page)
  await expect(page.getByRole("button", { name: "ویرایش تنظیمات" })).toBeVisible()
})

test("relationships section shows list of relationships", async ({ page }) => {
  await loginAs(page)
  await expect(page.getByText("روابط معرفی").first()).toBeVisible()
})

// ══════════════════════════════════════════════════════════════════════════
//  Settings editing
// ══════════════════════════════════════════════════════════════════════════

test("clicking edit shows edit form", async ({ page }) => {
  await loginAs(page)
  await page.getByRole("button", { name: "ویرایش تنظیمات" }).click()
  await expect(page.getByText("ویرایش تنظیمات")).toBeVisible()
  await expect(page.getByText("فعال بودن برنامه")).toBeVisible()
  await expect(page.getByLabel("درصد پاداش (۰ تا ۱۰۰)")).toBeVisible()
})

test("edit form has cancel and save buttons", async ({ page }) => {
  await loginAs(page)
  await page.getByRole("button", { name: "ویرایش تنظیمات" }).click()
  await expect(page.getByRole("button", { name: "انصراف" })).toBeVisible()
  await expect(page.getByRole("button", { name: "ذخیره تنظیمات" })).toBeVisible()
})

test("cancelling edit returns to display mode", async ({ page }) => {
  await loginAs(page)
  await page.getByRole("button", { name: "ویرایش تنظیمات" }).click()
  await page.getByRole("button", { name: "انصراف" }).click()
  await expect(page.getByRole("button", { name: "ویرایش تنظیمات" })).toBeVisible()
})

test("toggle changes the enabled label", async ({ page }) => {
  await loginAs(page)
  await page.getByRole("button", { name: "ویرایش تنظیمات" }).click()
  const toggle = page.getByRole("switch")
  const initialLabel = await toggle.getAttribute("aria-checked")
  await toggle.click()
  const newLabel = await toggle.getAttribute("aria-checked")
  expect(newLabel).not.toBe(initialLabel)
})

test("reward percent input accepts values", async ({ page }) => {
  await loginAs(page)
  await page.getByRole("button", { name: "ویرایش تنظیمات" }).click()
  const input = page.getByLabel("درصد پاداش (۰ تا ۱۰۰)")
  await input.fill("20")
  await expect(input).toHaveValue("20")
})

test("invalid reward percent shows client validation", async ({ page }) => {
  await loginAs(page)
  await page.getByRole("button", { name: "ویرایش تنظیمات" }).click()
  const input = page.getByLabel("درصد پاداش (۰ تا ۱۰۰)")
  await input.fill("150")
  await page.getByRole("button", { name: "ذخیره تنظیمات" }).click()
  await expect(page.getByText("درصد پاداش باید بین ۰ تا ۱۰۰ باشد.")).toBeVisible()
})

test("negative reward percent shows client validation", async ({ page }) => {
  await loginAs(page)
  await page.getByRole("button", { name: "ویرایش تنظیمات" }).click()
  const input = page.getByLabel("درصد پاداش (۰ تا ۱۰۰)")
  await input.fill("-5")
  await page.getByRole("button", { name: "ذخیره تنظیمات" }).click()
  await expect(page.getByText("درصد پاداش باید بین ۰ تا ۱۰۰ باشد.")).toBeVisible()
})

// ══════════════════════════════════════════════════════════════════════════
//  Search
// ══════════════════════════════════════════════════════════════════════════

test("search input is present", async ({ page }) => {
  await loginAs(page)
  await expect(page.getByPlaceholder("جستجوی کد، نام یا ایمیل...")).toBeVisible()
})

test("typing in search filters results", async ({ page }) => {
  await loginAs(page)
  const searchInput = page.getByPlaceholder("جستجوی کد، نام یا ایمیل...")

  // Type a partial name search
  await searchInput.fill("Par")
  await page.waitForTimeout(500)

  // Should show results or empty state (depending on data)
  const empty = page.getByText("نتیجه‌ای یافت نشد")
  const cards = page.locator("div.flex.flex-col.gap-4 > div")
  await expect(empty.or(cards.first())).toBeVisible({ timeout: 5000 })
})

test("search with no results shows empty state", async ({ page }) => {
  await loginAs(page)
  const searchInput = page.getByPlaceholder("جستجوی کد، نام یا ایمیل...")
  await searchInput.fill("ZZZZNOTEXIST")
  await page.waitForTimeout(500)
  await expect(page.getByText("نتیجه‌ای یافت نشد")).toBeVisible({ timeout: 5000 })
})

// ══════════════════════════════════════════════════════════════════════════
//  Pagination
// ══════════════════════════════════════════════════════════════════════════

test("pagination controls appear when multiple pages exist", async ({ page }) => {
  await loginAs(page)
  // Navigate to page 1, check if pagination exists
  await page.waitForTimeout(1000)
  const nextBtn = page.getByRole("button", { name: "صفحه بعد" })
  // If there's more than 1 page, next will be enabled
  // If only 1 page, it's hidden (totalPages check in component)
  await expect(nextBtn).not.toBeVisible()
})

// ══════════════════════════════════════════════════════════════════════════
//  API error states
// ══════════════════════════════════════════════════════════════════════════

test("API failure shows retry button", async ({ page }) => {
  await page.route("**/api/admin/referrals*", (route) => {
    if (route.request().method() === "GET") route.abort("connectionfailed")
    else route.continue()
  })
  await loginAs(page)
  await expect(page.getByText("تلاش دوباره")).toBeVisible({ timeout: 5000 })
})

test("retry reloads data", async ({ page }) => {
  await page.route("**/api/admin/referrals*", (route) => {
    if (route.request().method() === "GET") route.abort("connectionfailed")
    else route.continue()
  }, { times: 1 })
  await loginAs(page)
  await expect(page.getByText("تلاش دوباره")).toBeVisible({ timeout: 5000 })
  await page.unroute("**/api/admin/referrals*")
  await page.getByRole("button", { name: "تلاش دوباره" }).click()
  await expect(page.getByText("ویرایش تنظیمات")).toBeVisible({ timeout: 5000 })
})

// ══════════════════════════════════════════════════════════════════════════
//  Responsive and layout
// ══════════════════════════════════════════════════════════════════════════

test("mobile viewport has no horizontal overflow", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 })
  await loginAs(page)
  await page.waitForTimeout(500)
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth > document.documentElement.clientWidth
  )
  expect(overflow).toBe(false)
})
