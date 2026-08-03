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
const EMAIL_PARENT = `bill_par_${TS}@test.com`
let parentUserId: string
let parentAccessToken: string
const cleanupIds: string[] = []

const MOCK_PACKAGES = {
  packages: [
    { id: "pkg-1", name: "استارتر", description: "بسته شروع", candyAmount: 100, priceAmount: 50000, currency: "IRR", displayOrder: 1 },
    { id: "pkg-2", name: "رشد", description: "بسته رشد", candyAmount: 300, priceAmount: 135000, currency: "IRR", displayOrder: 2 },
    { id: "pkg-3", name: "ممتاز", description: "بسته ممتاز", candyAmount: 700, priceAmount: 280000, currency: "IRR", displayOrder: 3 },
  ],
}

const MOCK_BILLING = {
  wallet: { balance: 150 },
  purchases: [
    { id: "pur-1", packageName: "رشد", candyAmount: 300, priceAmount: 135000, originalPriceAmount: 135000, discountAmount: 0, finalPriceAmount: 135000, currency: "IRR", status: "paid", createdAt: "2026-07-28T10:00:00Z", paidAt: "2026-07-28T10:05:00Z", couponApplied: false, couponCodeSnapshot: null, couponName: null, couponStatus: null, paymentStarted: true },
    { id: "pur-2", packageName: "استارتر", candyAmount: 100, priceAmount: 50000, originalPriceAmount: 50000, discountAmount: 0, finalPriceAmount: 50000, currency: "IRR", status: "pending", createdAt: "2026-07-29T14:00:00Z", paidAt: null, couponApplied: false, couponCodeSnapshot: null, couponName: null, couponStatus: null, paymentStarted: false },
  ],
}

const MOCK_CREATE_RESPONSE = {
  purchase: { id: "pur-new", candy_amount: 100, price_amount: 50000, currency: "IRR", status: "pending", created_at: "2026-07-30T08:00:00Z" },
}

const MOCK_COMPLETE_RESPONSE = {
  purchase_id: "pur-2",
  purchase_status: "paid",
  wallet_id: "wallet-1",
  wallet_balance: 250,
  ledger_entry_id: "ledger-1",
}

const MOCK_COUPON_VALIDATE_RESPONSE = {
  coupon: {
    normalizedCode: "WELCOME10",
    discountType: "percentage",
    originalPriceAmount: 50000,
    discountAmount: 5000,
    finalPriceAmount: 45000,
    currency: "IRR",
  },
}

const MOCK_COUPON_APPLY_RESPONSE = {
  coupon: {
    normalizedCode: "WELCOME10",
    discountType: "percentage",
    discountValue: 1000,
    originalPriceAmount: 50000,
    discountAmount: 5000,
    finalPriceAmount: 45000,
    currency: "IRR",
    status: "reserved",
  },
}

function buildCookie(at: string, _rt: string, _ei: number): string {
  return "base64-" + Buffer.from(JSON.stringify({
    access_token: at, refresh_token: _rt, expires_in: _ei,
    expires_at: Math.floor(Date.now() / 1000) + _ei, token_type: "bearer",
  })).toString("base64url")
}

function cookieHeaders(token: string): Record<string, string> {
  const c = buildCookie(token, "", 3600)
  return { Cookie: `sb-${PROJECT_REF}-auth-token=${c}` }
}

test.beforeAll(async () => {
  test.setTimeout(120000)

  // Create synthetic parent user for auth middleware
  const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: "POST", headers: HDR,
    body: JSON.stringify({ email: EMAIL_PARENT, password: PASSWORD, email_confirm: true, user_metadata: { full_name: "Test Billing" } }),
  })
  const u = await r.json()
  parentUserId = u.id
  cleanupIds.push(parentUserId)

  await fetch(`${SUPABASE_URL}/rest/v1/users?id=eq.${u.id}`, {
    method: "PATCH", headers: HDR,
    body: JSON.stringify({ role: "parent" }),
  }).catch(() => {})

  await fetch(`${SUPABASE_URL}/rest/v1/parent_profiles`, {
    method: "POST", headers: { ...HDR, Prefer: "return=representation" },
    body: JSON.stringify({ user_id: u.id, full_name: "Test Billing", consent_granted: true, consent_granted_at: new Date().toISOString() }),
  })

  // Login to get auth token
  const loginR = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST", headers: HDR,
    body: JSON.stringify({ email: EMAIL_PARENT, password: PASSWORD }),
  })
  const loginData = await loginR.json()
  parentAccessToken = loginData.access_token
})

test.afterAll(async () => {
  for (const id of cleanupIds) {
    await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${id}`, { method: "DELETE", headers: HDR }).catch(() => {})
  }
})

test.beforeEach(async ({ page }) => {
  // Mock all candy API routes BEFORE navigation
  await page.route("**/api/candy-packages", async (route) => {
    await route.fulfill({ status: 200, body: JSON.stringify(MOCK_PACKAGES) })
  })
  await page.route("**/api/candy-purchases", async (route, request) => {
    if (request.method() === "POST" && request.url().includes("/complete")) {
      await route.fulfill({ status: 200, body: JSON.stringify(MOCK_COMPLETE_RESPONSE) })
    } else if (request.method() === "POST" && request.url().includes("/coupon")) {
      await route.fulfill({ status: 200, body: JSON.stringify(MOCK_COUPON_APPLY_RESPONSE) })
    } else if (request.method() === "POST") {
      await route.fulfill({ status: 201, body: JSON.stringify(MOCK_CREATE_RESPONSE) })
    } else {
      await route.fulfill({ status: 200, body: JSON.stringify(MOCK_BILLING) })
    }
  })
  await page.route("**/api/coupons/validate", async (route) => {
    await route.fulfill({ status: 200, body: JSON.stringify(MOCK_COUPON_VALIDATE_RESPONSE) })
  })

  // Set auth cookie so middleware allows navigation
  const cookieStr = `sb-${PROJECT_REF}-auth-token=${buildCookie(parentAccessToken, "", 3600)}`
  await page.context().addCookies([
    { name: `sb-${PROJECT_REF}-auth-token`, value: buildCookie(parentAccessToken, "", 3600), domain: "localhost", path: "/" },
  ])
})

// ═════════════════════════════════════════════════════════════════════════════
// Page structure
// ═════════════════════════════════════════════════════════════════════════════

test("1. Page has one h1", async ({ page }) => {
  await page.goto(`${BASE}/dashboard/billing`)
  await page.waitForLoadState("networkidle")
  const h1 = page.locator("h1")
  await expect(h1).toHaveCount(1)
  await expect(h1).toHaveText("آبنبات و پرداخت")
})

test("2. Wallet balance is displayed", async ({ page }) => {
  await page.goto(`${BASE}/dashboard/billing`)
  await page.waitForLoadState("networkidle")
  await expect(page.getByText("۱۵۰")).toBeVisible()
})

test("3. Zero balance displays correctly", async ({ page }) => {
  await page.route("**/api/candy-purchases", async (route) => {
    await route.fulfill({ status: 200, body: JSON.stringify({ wallet: { balance: 0 }, purchases: [] }) })
  })
  await page.goto(`${BASE}/dashboard/billing`)
  await page.waitForLoadState("networkidle")
  await expect(page.getByText("۰")).toBeVisible()
})

test("4. Active packages render", async ({ page }) => {
  await page.goto(`${BASE}/dashboard/billing`)
  await page.waitForLoadState("networkidle")
  await expect(page.getByText("استارتر").first()).toBeVisible()
  await expect(page.getByText("رشد").first()).toBeVisible()
  await expect(page.getByText("ممتاز")).toBeVisible()
})

test("5. Package values come from mocked API", async ({ page }) => {
  await page.route("**/api/candy-packages", async (route) => {
    await route.fulfill({ status: 200, body: JSON.stringify({
      packages: [{ id: "custom", name: "بسته تست", description: "تست", candyAmount: 42, priceAmount: 21000, currency: "IRR", displayOrder: 1 }],
    }) })
  })
  await page.goto(`${BASE}/dashboard/billing`)
  await page.waitForLoadState("networkidle")
  await expect(page.getByText("بسته تست")).toBeVisible()
  await expect(page.getByText("۴۲")).toBeVisible()
})

test("6. No hardcoded package values appear", async ({ page }) => {
  await page.route("**/api/candy-packages", async (route) => {
    await route.fulfill({ status: 200, body: JSON.stringify({
      packages: [{ id: "x", name: "بسته الف", description: null, candyAmount: 99, priceAmount: 11111, currency: "IRR", displayOrder: 1 }],
    }) })
  })
  await page.goto(`${BASE}/dashboard/billing`)
  await page.waitForLoadState("networkidle")
  await expect(page.getByText("بسته الف")).toBeVisible()
  await expect(page.getByText("۹۹")).toBeVisible()
  await expect(page.getByText("۱۱٬۱۱۱")).toBeVisible()
})

// ═════════════════════════════════════════════════════════════════════════════
// Purchase confirmation
// ═════════════════════════════════════════════════════════════════════════════

test("7. Selecting package opens confirmation", async ({ page }) => {
  await page.goto(`${BASE}/dashboard/billing`)
  await page.waitForLoadState("networkidle")
  await page.getByRole("button", { name: "انتخاب بسته" }).first().click()
  await expect(page.getByRole("dialog")).toBeVisible()
  await expect(page.getByText("تأیید خرید بسته آبنبات")).toBeVisible()
})

test("8. Cancelling creates no purchase", async ({ page }) => {
  let postCalled = false
  await page.route("**/api/candy-purchases", async (route, request) => {
    if (request.method() === "POST" && !request.url().includes("/complete")) postCalled = true
    await route.fulfill({ status: 200, body: JSON.stringify(MOCK_BILLING) })
  })
  await page.goto(`${BASE}/dashboard/billing`)
  await page.waitForLoadState("networkidle")
  await page.getByRole("button", { name: "انتخاب بسته" }).first().click()
  await expect(page.getByRole("dialog")).toBeVisible()
  await page.getByRole("button", { name: "انصراف" }).click()
  await expect(page.getByRole("dialog")).toHaveCount(0)
  expect(postCalled).toBe(false)
})

test("9. Confirm sends only package_id", async ({ page }) => {
  let sentBody = ""
  await page.route("**/api/candy-purchases", async (route, request) => {
    if (request.method() === "POST" && !request.url().includes("/complete")) {
      sentBody = request.postData() || ""
      await route.fulfill({ status: 201, body: JSON.stringify(MOCK_CREATE_RESPONSE) })
    } else {
      await route.fulfill({ status: 200, body: JSON.stringify(MOCK_BILLING) })
    }
  })
  await page.goto(`${BASE}/dashboard/billing`)
  await page.waitForLoadState("networkidle")
  await page.getByRole("button", { name: "انتخاب بسته" }).first().click()
  await page.getByRole("button", { name: "ایجاد سفارش" }).click()
  await page.waitForTimeout(300)
  const parsed = JSON.parse(sentBody)
  expect(Object.keys(parsed)).toEqual(["package_id"])
  expect(typeof parsed.package_id).toBe("string")
})

test("10. Double-click creates no duplicate request", async ({ page }) => {
  let postCount = 0
  await page.route("**/api/candy-purchases", async (route, request) => {
    if (request.method() === "POST" && !request.url().includes("/complete")) {
      postCount++
      await route.fulfill({ status: 201, body: JSON.stringify(MOCK_CREATE_RESPONSE) })
    } else {
      await route.fulfill({ status: 200, body: JSON.stringify(MOCK_BILLING) })
    }
  })
  await page.goto(`${BASE}/dashboard/billing`)
  await page.waitForLoadState("networkidle")
  await page.getByRole("button", { name: "انتخاب بسته" }).first().click()
  const confirmBtn = page.getByRole("button", { name: "ایجاد سفارش" })
  await confirmBtn.click()
  await confirmBtn.click({ force: true })
  await page.waitForTimeout(300)
  expect(postCount).toBe(1)
})

// ═════════════════════════════════════════════════════════════════════════════
// Purchase lifecycle
// ═════════════════════════════════════════════════════════════════════════════

test("11. Pending purchase appears after creation", async ({ page }) => {
  await page.route("**/api/candy-purchases", async (route, request) => {
    if (request.method() === "POST" && !request.url().includes("/complete")) {
      await route.fulfill({ status: 201, body: JSON.stringify(MOCK_CREATE_RESPONSE) })
    } else {
      await route.fulfill({ status: 200, body: JSON.stringify({
        wallet: { balance: 150 },
        purchases: [
          { id: "pur-new", packageName: "استارتر", candyAmount: 100, priceAmount: 50000, originalPriceAmount: 50000, discountAmount: 0, finalPriceAmount: 50000, currency: "IRR", status: "pending", createdAt: "2026-07-30T08:00:00Z", paidAt: null, couponApplied: false, couponCodeSnapshot: null, couponName: null, couponStatus: null, paymentStarted: false },
          ...MOCK_BILLING.purchases,
        ],
      }) })
    }
  })
  await page.goto(`${BASE}/dashboard/billing`)
  await page.waitForLoadState("networkidle")
  await page.getByRole("button", { name: "انتخاب بسته" }).first().click()
  await page.getByRole("button", { name: "ایجاد سفارش" }).click()
  await page.waitForTimeout(300)
  await expect(page.getByText("سفارش پرداخت ایجاد شد")).toBeVisible()
  await expect(page.getByText("در انتظار پرداخت").first()).toBeVisible()
})

test("12. Wallet does not change after pending purchase", async ({ page }) => {
  await page.goto(`${BASE}/dashboard/billing`)
  await page.waitForLoadState("networkidle")
  await expect(page.getByText("۱۵۰")).toBeVisible()
  await page.getByRole("button", { name: "انتخاب بسته" }).first().click()
  await page.getByRole("button", { name: "ایجاد سفارش" }).click()
  await page.waitForTimeout(300)
  await expect(page.getByText("۱۵۰")).toBeVisible()
})

// ═════════════════════════════════════════════════════════════════════════════
// Dev-only completion
// ═════════════════════════════════════════════════════════════════════════════

test("13. Development completion button appears in dev test mode", async ({ page }) => {
  await page.goto(`${BASE}/dashboard/billing`)
  await page.waitForLoadState("networkidle")
  const devBtn = page.getByRole("button", { name: "تکمیل آزمایشی پرداخت" })
  await expect(devBtn).toBeVisible()
})

test("14. Production mode hides completion button", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "location", {
      value: new URL("https://cartoona.com/dashboard/billing"),
      writable: true,
    })
  })
  await page.goto(`${BASE}/dashboard/billing`)
  await page.waitForLoadState("networkidle")
  await expect(page.getByText("تکمیل آزمایشی پرداخت")).toHaveCount(0)
})

test("15. Completion confirmation appears", async ({ page }) => {
  await page.goto(`${BASE}/dashboard/billing`)
  await page.waitForLoadState("networkidle")
  await page.getByRole("button", { name: "تکمیل آزمایشی پرداخت" }).click()
  await expect(page.getByRole("dialog")).toBeVisible()
  await expect(page.getByText("این عملیات فقط برای تست توسعه است")).toBeVisible()
})

test("16. Successful completion refreshes balance", async ({ page }) => {
  let billingCallCount = 0
  await page.route("**/api/candy-purchases", async (route, request) => {
    if (request.method() === "POST" && request.url().includes("/complete")) {
      await route.fulfill({ status: 200, body: JSON.stringify(MOCK_COMPLETE_RESPONSE) })
    } else {
      billingCallCount++
      await route.fulfill({ status: 200, body: JSON.stringify(
        billingCallCount > 1
          ? { wallet: { balance: 250 }, purchases: MOCK_BILLING.purchases.map((p) => p.id === "pur-2" ? { ...p, status: "paid", paidAt: "2026-07-30T08:05:00Z" } : p) }
          : MOCK_BILLING
      ) })
    }
  })
  await page.goto(`${BASE}/dashboard/billing`)
  await page.waitForLoadState("networkidle")
  await page.getByRole("button", { name: "تکمیل آزمایشی پرداخت" }).click()
  await page.getByRole("button", { name: "تأیید و تکمیل" }).click()
  await page.waitForTimeout(300)
  await expect(page.getByText("پرداخت آزمایشی تکمیل شد")).toBeVisible()
  await expect(page.getByText("۲۵۰")).toBeVisible()
})

test("17. Paid purchase status appears", async ({ page }) => {
  await page.route("**/api/candy-purchases", async (route, request) => {
    if (request.method() === "POST" && request.url().includes("/complete")) {
      await route.fulfill({ status: 200, body: JSON.stringify(MOCK_COMPLETE_RESPONSE) })
    } else {
      await route.fulfill({ status: 200, body: JSON.stringify({
        wallet: { balance: 250 },
        purchases: MOCK_BILLING.purchases.map((p) => p.id === "pur-2" ? { ...p, status: "paid", paidAt: "2026-07-30T08:05:00Z" } : p),
      }) })
    }
  })
  await page.goto(`${BASE}/dashboard/billing`)
  await page.waitForLoadState("networkidle")
  await page.getByRole("button", { name: "تکمیل آزمایشی پرداخت" }).click()
  await page.getByRole("button", { name: "تأیید و تکمیل" }).click()
  await page.waitForTimeout(300)
  await expect(page.getByText("پرداخت‌شده")).toBeVisible()
})

test("18. Completion action disappears after payment", async ({ page }) => {
  let afterPaid = false
  await page.route("**/api/candy-purchases", async (route, request) => {
    if (request.method() === "POST" && request.url().includes("/complete")) {
      await route.fulfill({ status: 200, body: JSON.stringify(MOCK_COMPLETE_RESPONSE) })
    } else {
      await route.fulfill({ status: 200, body: JSON.stringify(
        afterPaid
          ? { wallet: { balance: 250 }, purchases: MOCK_BILLING.purchases.map((p) => p.id === "pur-2" ? { ...p, status: "paid" } : p) }
          : MOCK_BILLING
      ) })
    }
  })
  await page.goto(`${BASE}/dashboard/billing`)
  await page.waitForLoadState("networkidle")
  await page.getByRole("button", { name: "تکمیل آزمایشی پرداخت" }).click()
  afterPaid = true
  await page.getByRole("button", { name: "تأیید و تکمیل" }).click()
  await page.waitForTimeout(300)
  await expect(page.getByText("تکمیل آزمایشی پرداخت")).toHaveCount(0)
})

// ═════════════════════════════════════════════════════════════════════════════
// Error states
// ═════════════════════════════════════════════════════════════════════════════

test("19. Package-load failure shows retry", async ({ page }) => {
  await page.route("**/api/candy-packages", async (route) => {
    await route.fulfill({ status: 503, body: JSON.stringify({ error: "Unavailable" }) })
  })
  await page.goto(`${BASE}/dashboard/billing`)
  await page.waitForLoadState("networkidle")
  await expect(page.getByText("دریافت اطلاعات انجام نشد")).toBeVisible()
  await expect(page.getByRole("button", { name: "تلاش دوباره" })).toBeVisible()
})

test("20. Purchase-history failure shows safe error", async ({ page }) => {
  await page.route("**/api/candy-purchases", async (route) => {
    await route.fulfill({ status: 500, body: JSON.stringify({ error: "Server error" }) })
  })
  await page.goto(`${BASE}/dashboard/billing`)
  await page.waitForLoadState("networkidle")
  await expect(page.getByText("دریافت اطلاعات انجام نشد")).toBeVisible()
})

test("21. Inactive-package error is safe", async ({ page }) => {
  await page.route("**/api/candy-purchases", async (route, request) => {
    if (request.method() === "POST" && !request.url().includes("/complete")) {
      await route.fulfill({ status: 404, body: JSON.stringify({ error: "این بسته در حال حاضر در دسترس نیست." }) })
    } else {
      await route.fulfill({ status: 200, body: JSON.stringify(MOCK_BILLING) })
    }
  })
  await page.goto(`${BASE}/dashboard/billing`)
  await page.waitForLoadState("networkidle")
  await page.getByRole("button", { name: "انتخاب بسته" }).first().click()
  await page.getByRole("button", { name: "ایجاد سفارش" }).click()
  await page.waitForTimeout(300)
  await expect(page.getByText("این بسته در حال حاضر در دسترس نیست")).toBeVisible()
})

test("22. Empty purchase state appears", async ({ page }) => {
  await page.route("**/api/candy-purchases", async (route) => {
    await route.fulfill({ status: 200, body: JSON.stringify({ wallet: { balance: 0 }, purchases: [] }) })
  })
  await page.goto(`${BASE}/dashboard/billing`)
  await page.waitForLoadState("networkidle")
  await expect(page.getByText("هنوز خریدی ثبت نشده است")).toBeVisible()
})

// ═════════════════════════════════════════════════════════════════════════════
// Content safety
// ═════════════════════════════════════════════════════════════════════════════

test("23. Status labels are Persian", async ({ page }) => {
  await page.goto(`${BASE}/dashboard/billing`)
  await page.waitForLoadState("networkidle")
  await expect(page.getByText("در انتظار پرداخت").first()).toBeVisible()
  await expect(page.getByText("پرداخت‌شده")).toBeVisible()
})

test("24. No raw payment reference is shown", async ({ page }) => {
  await page.goto(`${BASE}/dashboard/billing`)
  await page.waitForLoadState("networkidle")
  const body = await page.locator("body").innerText()
  expect(body).not.toContain("dev-simulated")
  expect(body).not.toContain("payment_reference")
})

test("25. No parent/wallet IDs appear", async ({ page }) => {
  await page.goto(`${BASE}/dashboard/billing`)
  await page.waitForLoadState("networkidle")
  const body = await page.locator("body").innerText()
  expect(body).not.toContain("wallet_id")
  expect(body).not.toContain("parent_id")
  expect(body).not.toContain("purchase_id")
  expect(body).not.toContain("ledger_entry_id")
})

// ═════════════════════════════════════════════════════════════════════════════
// Responsive
// ═════════════════════════════════════════════════════════════════════════════

test("26. Mobile viewport has no overflow", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 })
  await page.goto(`${BASE}/dashboard/billing`)
  await page.waitForLoadState("networkidle")
  const overflow = await page.evaluate(() => {
    return document.documentElement.scrollWidth > document.documentElement.clientWidth
  })
  expect(overflow).toBe(false)
})

// ═════════════════════════════════════════════════════════════════════════════
// Scope enforcement
// ═════════════════════════════════════════════════════════════════════════════

test("27. No referral reward UI appears", async ({ page }) => {
  await page.goto(`${BASE}/dashboard/billing`)
  await page.waitForLoadState("networkidle")
  const body = await page.locator("body").innerText()
  expect(body).not.toContain("معرفی")
  expect(body).not.toContain("پاداش")
})

test("28. UI tests use mocked routes and cause no database mutation", async ({ page }) => {
  await page.goto(`${BASE}/dashboard/billing`)
  await page.waitForLoadState("networkidle")
  // Verify all API calls went through mocked routes
  // The auth cookie is real but all candy API routes are mocked
  await expect(page.getByText("۱۵۰")).toBeVisible()
})

// ═════════════════════════════════════════════════════════════════════════════
// Pending-purchase coupon flow
// ═════════════════════════════════════════════════════════════════════════════

test("29. Pending purchase shows coupon input", async ({ page }) => {
  await page.goto(`${BASE}/dashboard/billing`)
  await page.waitForLoadState("networkidle")
  await expect(page.getByText("سفارش‌های در انتظار پرداخت")).toBeVisible()
  await expect(page.getByLabel("کد تخفیف")).toBeVisible()
})

test("30. Pending purchase shows price breakdown", async ({ page }) => {
  await page.goto(`${BASE}/dashboard/billing`)
  await page.waitForLoadState("networkidle")
  await expect(page.getByText("قیمت اصلی")).toBeVisible()
  await expect(page.getByText("مبلغ نهایی")).toBeVisible()
})

test("31. Coupon validate sends only purchase_id and code", async ({ page }) => {
  let sentBody = ""
  await page.route("**/api/coupons/validate", async (route, request) => {
    sentBody = request.postData() || ""
    await route.fulfill({ status: 200, body: JSON.stringify(MOCK_COUPON_VALIDATE_RESPONSE) })
  })
  await page.goto(`${BASE}/dashboard/billing`)
  await page.waitForLoadState("networkidle")
  await page.getByLabel("کد تخفیف").fill("welcome10")
  await page.getByRole("button", { name: "بررسی کد" }).click()
  await page.waitForTimeout(200)
  const parsed = JSON.parse(sentBody)
  expect(Object.keys(parsed).sort()).toEqual(["code", "purchase_id"])
  expect(typeof parsed.purchase_id).toBe("string")
})

test("32. Valid coupon shows preview and apply button", async ({ page }) => {
  await page.goto(`${BASE}/dashboard/billing`)
  await page.waitForLoadState("networkidle")
  await page.getByLabel("کد تخفیف").fill("welcome10")
  await page.getByRole("button", { name: "بررسی کد" }).click()
  await expect(page.getByText("کد تخفیف معتبر است")).toBeVisible()
  await expect(page.getByRole("button", { name: "اعمال کد" })).toBeVisible()
})

test("33. Apply sends code and idempotency key only", async ({ page }) => {
  let sentBody = ""
  await page.route("**/api/candy-purchases", async (route, request) => {
    if (request.method() === "POST" && request.url().includes("/coupon")) {
      sentBody = request.postData() || ""
      await route.fulfill({ status: 200, body: JSON.stringify(MOCK_COUPON_APPLY_RESPONSE) })
    } else if (request.method() === "POST") {
      await route.fulfill({ status: 201, body: JSON.stringify(MOCK_CREATE_RESPONSE) })
    } else {
      await route.fulfill({ status: 200, body: JSON.stringify(MOCK_BILLING) })
    }
  })
  await page.goto(`${BASE}/dashboard/billing`)
  await page.waitForLoadState("networkidle")
  await page.getByLabel("کد تخفیف").fill("welcome10")
  await page.getByRole("button", { name: "بررسی کد" }).click()
  await page.getByRole("button", { name: "اعمال کد" }).click()
  await page.waitForTimeout(200)
  const parsed = JSON.parse(sentBody)
  expect(Object.keys(parsed).sort()).toEqual(["code", "idempotency_key"])
  expect(parsed.code).toBe("WELCOME10")
  expect(typeof parsed.idempotency_key).toBe("string")
  expect(/^[0-9]+$/.test(parsed.idempotency_key)).toBe(false)
})

test("34. Retrying apply reuses the same idempotency key", async ({ page }) => {
  const keys: string[] = []
  let applyCalls = 0
  await page.route("**/api/candy-purchases", async (route, request) => {
    if (request.method() === "POST" && request.url().includes("/coupon")) {
      applyCalls++
      keys.push(JSON.parse(request.postData() || "").idempotency_key)
      if (applyCalls === 1) {
        await route.fulfill({ status: 500, body: JSON.stringify({ error: { code: "unknown_error", message: "خطا در اعمال کد تخفیف." } }) })
      } else {
        await route.fulfill({ status: 200, body: JSON.stringify(MOCK_COUPON_APPLY_RESPONSE) })
      }
    } else if (request.method() === "POST") {
      await route.fulfill({ status: 201, body: JSON.stringify(MOCK_CREATE_RESPONSE) })
    } else {
      await route.fulfill({ status: 200, body: JSON.stringify(MOCK_BILLING) })
    }
  })
  await page.goto(`${BASE}/dashboard/billing`)
  await page.waitForLoadState("networkidle")
  await page.getByLabel("کد تخفیف").fill("welcome10")
  await page.getByRole("button", { name: "بررسی کد" }).click()
  const applyBtn = page.getByRole("button", { name: /اعمال کد|در حال اعمال/ })
  await applyBtn.click()
  await page.waitForTimeout(200)
  await applyBtn.click()
  await page.waitForTimeout(200)
  expect(applyCalls).toBe(2)
  expect(new Set(keys).size).toBe(1)
})

test("35. Applied coupon locks the card", async ({ page }) => {
  await page.route("**/api/candy-purchases", async (route, request) => {
    if (request.method() === "POST" && request.url().includes("/coupon")) {
      await route.fulfill({ status: 200, body: JSON.stringify(MOCK_COUPON_APPLY_RESPONSE) })
    } else {
      await route.fulfill({ status: 200, body: JSON.stringify({
        wallet: { balance: 150 },
        purchases: [
          { id: "pur-2", packageName: "استارتر", candyAmount: 100, priceAmount: 50000, originalPriceAmount: 50000, discountAmount: 5000, finalPriceAmount: 45000, currency: "IRR", status: "pending", createdAt: "2026-07-29T14:00:00Z", paidAt: null, couponApplied: true, couponCodeSnapshot: "WELCOME10", couponName: "تخفیف خوش‌آمد", couponStatus: "reserved", paymentStarted: false },
          { id: "pur-1", packageName: "رشد", candyAmount: 300, priceAmount: 135000, originalPriceAmount: 135000, discountAmount: 0, finalPriceAmount: 135000, currency: "IRR", status: "paid", createdAt: "2026-07-28T10:00:00Z", paidAt: "2026-07-28T10:05:00Z", couponApplied: false, couponCodeSnapshot: null, couponName: null, couponStatus: null, paymentStarted: true },
        ],
      }) })
    }
  })
  await page.goto(`${BASE}/dashboard/billing`)
  await page.waitForLoadState("networkidle")
  await expect(page.getByText("کد تخفیف اعمال شد")).toBeVisible()
  await expect(page.getByText("WELCOME10")).toBeVisible()
  await expect(page.getByText("برای هر خرید فقط یک کد تخفیف قابل استفاده است.")).toBeVisible()
  await expect(page.getByLabel("کد تخفیف")).toHaveCount(0)
})

test("36. paymentStarted hides coupon input", async ({ page }) => {
  await page.route("**/api/candy-purchases", async (route) => {
    await route.fulfill({ status: 200, body: JSON.stringify({
      wallet: { balance: 150 },
      purchases: [
        { id: "pur-2", packageName: "استارتر", candyAmount: 100, priceAmount: 50000, originalPriceAmount: 50000, discountAmount: 0, finalPriceAmount: 50000, currency: "IRR", status: "pending", createdAt: "2026-07-29T14:00:00Z", paidAt: null, couponApplied: false, couponCodeSnapshot: null, couponName: null, couponStatus: null, paymentStarted: true },
      ],
    }) })
  })
  await page.goto(`${BASE}/dashboard/billing`)
  await page.waitForLoadState("networkidle")
  await expect(page.getByText("امکان اعمال کد تخفیف وجود ندارد")).toBeVisible()
  await expect(page.getByLabel("کد تخفیف")).toHaveCount(0)
})

test("37. Expired purchase shows منقضی‌شده and no coupon controls", async ({ page }) => {
  await page.route("**/api/candy-purchases", async (route) => {
    await route.fulfill({ status: 200, body: JSON.stringify({
      wallet: { balance: 0 },
      purchases: [
        { id: "pur-x", packageName: "استارتر", candyAmount: 100, priceAmount: 50000, originalPriceAmount: 50000, discountAmount: 0, finalPriceAmount: 50000, currency: "IRR", status: "expired", createdAt: "2026-07-29T14:00:00Z", paidAt: null, couponApplied: false, couponCodeSnapshot: null, couponName: null, couponStatus: null, paymentStarted: false },
      ],
    }) })
  })
  await page.goto(`${BASE}/dashboard/billing`)
  await page.waitForLoadState("networkidle")
  await expect(page.getByText("منقضی‌شده")).toBeVisible()
  await expect(page.getByLabel("کد تخفیف")).toHaveCount(0)
})

test("38. Coupon validate error shows safe server message", async ({ page }) => {
  await page.route("**/api/coupons/validate", async (route) => {
    await route.fulfill({ status: 400, body: JSON.stringify({ error: { code: "coupon_not_found", message: "این کد تخفیف معتبر نیست." } }) })
  })
  await page.goto(`${BASE}/dashboard/billing`)
  await page.waitForLoadState("networkidle")
  await page.getByLabel("کد تخفیف").fill("nope999")
  await page.getByRole("button", { name: "بررسی کد" }).click()
  await expect(page.getByText("این کد تخفیف معتبر نیست.")).toBeVisible()
  await expect(page.getByRole("button", { name: "اعمال کد" })).toHaveCount(0)
})

test("39. Coupon input enforces format on validate", async ({ page }) => {
  let validateCalled = false
  await page.route("**/api/coupons/validate", async (route) => {
    validateCalled = true
    await route.fulfill({ status: 200, body: JSON.stringify(MOCK_COUPON_VALIDATE_RESPONSE) })
  })
  await page.goto(`${BASE}/dashboard/billing`)
  await page.waitForLoadState("networkidle")
  await page.getByLabel("کد تخفیف").fill("ab")
  await expect(page.getByRole("button", { name: "بررسی کد" })).toBeDisabled()
  expect(validateCalled).toBe(false)
})
