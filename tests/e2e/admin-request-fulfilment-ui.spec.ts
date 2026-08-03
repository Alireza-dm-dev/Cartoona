import { test, expect, type Page } from "@playwright/test"
import * as fs from "fs"
import * as path from "path"
import { assertSafeDatabaseTarget } from "../helpers/assert-safe-database-target"

/**
 * Admin request-fulfilment UI spec. Renders the real queue + detail pages
 * (SSR, against a disposable/local Supabase target with fixtures) and mocks
 * only the client-component mutation endpoints so client behavior (payload,
 * error rendering, dialogs) is deterministic. Requires a dev server on
 * localhost:3000 and a disposable target; the guard refuses the main project
 * and the migration-test project.
 */

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
      process.env[trimmed.slice(0, eqIdx)] = trimmed.slice(eqIdx + 1)
    }
  } catch { /* fallback */ }
}

loadEnv()

const _guard = assertSafeDatabaseTarget()
if (!_guard.ok) throw new Error(`Guard blocked: ${_guard.reason}`)

const KEY = process.env.SUPABASE_SECRET_KEY || ""
const HDR = { "Content-Type": "application/json", apikey: KEY, Authorization: `Bearer ${KEY}` }
const PASSWORD = "TestPass999!"
const TS = String(Date.now()).slice(-8)
const EMAIL_ADMIN = `ful_ui_admin_${TS}@test.com`

const COOKIE_NAME = `sb-${PROJECT_REF}-auth-token`

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

let adminCookie = ""
let orderId = ""

async function navigateWithAuth(page: Page, url: string): Promise<void> {
  await page.evaluate(() => { try { localStorage.clear(); sessionStorage.clear() } catch {} }).catch(() => {})
  await page.context().clearCookies()
  await page.context().addCookies([
    { name: COOKIE_NAME, value: adminCookie, domain: "localhost", path: "/", httpOnly: false, secure: false, sameSite: "Lax" as const },
  ])
  await page.goto(url, { waitUntil: "load", timeout: 15000 })
}

test.beforeAll(async () => {
  test.setTimeout(120000)

  const createResp = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: "POST",
    headers: HDR,
    body: JSON.stringify({ email: EMAIL_ADMIN, password: PASSWORD, email_confirm: true, user_metadata: { full_name: "UI Admin" } }),
  })
  const admin = await createResp.json()
  if (!admin.id) throw new Error(`Create admin: ${JSON.stringify(admin)}`)
  await fetch(`${SUPABASE_URL}/rest/v1/users`, {
    method: "POST",
    headers: { ...HDR, Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({ id: admin.id, email: EMAIL_ADMIN, role: "admin" }),
  }).catch(() => {})

  const login = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: HDR,
    body: JSON.stringify({ email: EMAIL_ADMIN, password: PASSWORD }),
  })
  const loginData = await login.json()
  adminCookie = buildCookie(loginData.access_token, loginData.refresh_token, loginData.expires_in)

  const parent = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: "POST",
    headers: HDR,
    body: JSON.stringify({ email: `ful_ui_par_${TS}@test.com`, password: PASSWORD, email_confirm: true }),
  })
  const parentUser = await parent.json()
  await fetch(`${SUPABASE_URL}/rest/v1/users`, {
    method: "POST",
    headers: { ...HDR, Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({ id: parentUser.id, email: `ful_ui_par_${TS}@test.com`, role: "parent" }),
  }).catch(() => {})

  const pp = await fetch(`${SUPABASE_URL}/rest/v1/parent_profiles`, {
    method: "POST",
    headers: { ...HDR, Prefer: "return=representation" },
    body: JSON.stringify({
      user_id: parentUser.id,
      full_name: "والد UI",
      consent_granted: true,
      consent_granted_at: new Date().toISOString(),
    }),
  })
  const profile = await pp.json()
  const parentProfileId = profile?.id
  if (!parentProfileId) throw new Error("parent profile not created")

  const order = await fetch(`${SUPABASE_URL}/rest/v1/orders`, {
    method: "POST",
    headers: { ...HDR, Prefer: "return=representation" },
    body: JSON.stringify({
      parent_id: parentProfileId,
      type: "image",
      status: "pending_review",
      title: "درخواست تست UI",
      description: null,
      candy_cost: 15,
      moderation_status: "passed",
    }),
  })
  const orderRows = await order.json()
  orderId = Array.isArray(orderRows) ? orderRows[0]?.id : orderRows?.id
})

test.afterAll(async () => {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?email=${EMAIL_ADMIN}`, { headers: HDR })
  const users = await r.json()
  if (Array.isArray(users)) {
    for (const u of users) {
      await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${u.id}`, { method: "DELETE", headers: HDR }).catch(() => {})
    }
  }
})

// ── Queue page ──────────────────────────────────────────────────────────────

test("1. queue shows one h1 and the status legend", async ({ page }) => {
  await navigateWithAuth(page, `${BASE}/admin/requests`)
  await expect(page.locator("h1")).toHaveCount(1)
  await expect(page.locator("h1")).toHaveText("صف درخواست‌ها")
  await expect(page.getByText("در انتظار بررسی")).toBeVisible()
  await expect(page.getByText("در حال تولید")).toBeVisible()
  await expect(page.getByText("آماده / تحویل شده")).toBeVisible()
})

test("2. queue renders the fixture order with a status dot", async ({ page }) => {
  await navigateWithAuth(page, `${BASE}/admin/requests`)
  await expect(page.getByText("درخواست تست UI")).toBeVisible()
})

test("3. queue filters by status via badge link", async ({ page }) => {
  await navigateWithAuth(page, `${BASE}/admin/requests`)
  await page.getByRole("link", { name: "در انتظار بررسی", exact: true }).first().click()
  await page.waitForURL(/status=pending_review/)
  await expect(page.getByText("درخواست تست UI")).toBeVisible()
})

// ── Detail page ─────────────────────────────────────────────────────────────

test("4. detail renders title, status, and history sections", async ({ page }) => {
  await navigateWithAuth(page, `${BASE}/admin/requests/${orderId}`)
  await expect(page.locator("h1")).toHaveText("جزئیات درخواست")
  await expect(page.getByText("درخواست تست UI")).toBeVisible()
  await expect(page.getByText("مدیریت وضعیت")).toBeVisible()
  await expect(page.getByText("فایل‌های خروجی نهایی")).toBeVisible()
  await expect(page.getByText("تاریخچه وضعیت")).toBeVisible()
})

test("5. status form shows only allowed next statuses", async ({ page }) => {
  await navigateWithAuth(page, `${BASE}/admin/requests/${orderId}`)
  await expect(page.getByRole("button", { name: "در حال انجام", exact: true })).toBeVisible()
  await expect(page.getByRole("button", { name: "رد شده", exact: true })).toBeVisible()
  await expect(page.getByRole("button", { name: "لغو شده", exact: true })).toBeVisible()
  await expect(page.getByRole("button", { name: "آماده تحویل", exact: true })).toHaveCount(0)
})

test("6. submitting sends target status + expectedUpdatedAt", async ({ page }) => {
  let payload: Record<string, unknown> | null = null
  await page.route(`**/api/admin/requests/${orderId}/status`, async (route) => {
    if (route.request().method() === "PATCH") {
      payload = route.request().postDataJSON()
      await route.fulfill({ status: 200, body: JSON.stringify({ data: { status: "in_progress" } }) })
    } else {
      await route.continue()
    }
  })
  await navigateWithAuth(page, `${BASE}/admin/requests/${orderId}`)
  await page.getByRole("button", { name: "در حال انجام", exact: true }).click()
  await page.getByRole("button", { name: "ذخیره تغییر وضعیت" }).click()
  await expect.poll(() => payload).not.toBeNull()
  const sent = payload as Record<string, unknown> | null
  expect(sent?.status).toBe("in_progress")
  expect(typeof sent?.expectedUpdatedAt).toBe("string")
})

test("7. conflict renders the reload message", async ({ page }) => {
  let payload: Record<string, unknown> | null = null
  await page.route(`**/api/admin/requests/${orderId}/status`, async (route) => {
    if (route.request().method() === "PATCH") {
      payload = route.request().postDataJSON()
      await route.fulfill({
        status: 409,
        body: JSON.stringify({
          error: "این درخواست توسط مدیر دیگری تغییر کرده است. اطلاعات جدید را دوباره بارگذاری کنید.",
          code: "REQUEST_STATUS_CONFLICT",
        }),
      })
    } else {
      await route.continue()
    }
  })
  await navigateWithAuth(page, `${BASE}/admin/requests/${orderId}`)
  await page.getByRole("button", { name: "در حال انجام", exact: true }).click()
  await page.getByRole("button", { name: "ذخیره تغییر وضعیت" }).click()
  await expect(page.getByText("این درخواست توسط مدیر دیگری تغییر کرده است.")).toBeVisible()
  expect(payload as Record<string, unknown> | null).not.toBeNull()
})

test("8. rejection requires a reason before submit", async ({ page }) => {
  await navigateWithAuth(page, `${BASE}/admin/requests/${orderId}`)
  await page.getByRole("button", { name: "رد شده", exact: true }).click()
  await page.getByRole("button", { name: "ذخیره تغییر وضعیت" }).click()
  await expect(page.getByText("برای رد درخواست، حداقل یک یادداشت (داخلی یا قابل مشاهده برای والد) وارد کنید.")).toBeVisible()
})

test("9. upload section shows the file input while uploads are allowed", async ({ page }) => {
  await navigateWithAuth(page, `${BASE}/admin/requests/${orderId}`)
  await expect(page.getByText("فایل‌های خروجی نهایی")).toBeVisible()
  await expect(page.locator('input[type="file"]')).toBeVisible()
  await expect(page.getByText("هنوز فایلی بارگذاری نشده است.")).toBeVisible()
})

test("10. history section shows the empty state when no changes exist", async ({ page }) => {
  await navigateWithAuth(page, `${BASE}/admin/requests/${orderId}`)
  await expect(page.getByText("هنوز تغییری در وضعیت درخواست ثبت نشده است.")).toBeVisible()
})
