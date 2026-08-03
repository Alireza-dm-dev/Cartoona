import { test, expect, type Page } from "@playwright/test"
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
      process.env[t.slice(0, eq)] = t.slice(eq + 1)
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
const EMAIL_ADMIN = `coup_admin_${TS}@test.com`

const MOCK_COUPONS = {
  coupons: [
    {
      id: "11111111-1111-4111-8111-111111111111",
      code: "SUMMER50",
      name: "تخفیف تابستان",
      description: null,
      discountType: "percentage",
      discountValue: 5000,
      isActive: true,
      startsAt: null,
      expiresAt: null,
      status: "active",
      globalUsageLimit: 100,
      perParentUsageLimit: 1,
      minimumPurchaseAmount: 0,
      maximumDiscountAmount: null,
      packageIds: [],
      packageNames: [],
      reservedCount: 3,
      redeemedCount: 2,
      cancelledCount: 1,
      createdAt: "2026-07-20T10:00:00.000Z",
      updatedAt: "2026-07-20T10:00:00.000Z",
    },
    {
      id: "22222222-2222-4222-8222-222222222222",
      code: "FIXED100K",
      name: "هدیه مبلغی",
      description: "با سقف تخفیف",
      discountType: "fixed_amount",
      discountValue: 100000,
      isActive: false,
      startsAt: null,
      expiresAt: null,
      status: "inactive",
      globalUsageLimit: null,
      perParentUsageLimit: null,
      minimumPurchaseAmount: 500000,
      maximumDiscountAmount: 50000,
      packageIds: [],
      packageNames: [],
      reservedCount: 0,
      redeemedCount: 0,
      cancelledCount: 0,
      createdAt: "2026-07-18T10:00:00.000Z",
      updatedAt: "2026-07-19T10:00:00.000Z",
    },
  ],
  pagination: { page: 1, pageSize: 25, total: 2, totalPages: 1 },
}

const MOCK_EMPTY = { coupons: [], pagination: { page: 1, pageSize: 25, total: 0, totalPages: 0 } }

const MOCK_DETAIL = {
  ...MOCK_COUPONS.coupons[0],
  createdBy: { id: "33333333-3333-4333-8333-333333333333", email: "admin@cartoona.test" },
}

const MOCK_CREATE_OK = { coupon: MOCK_DETAIL }

function buildCookie(at: string): string {
  return "base64-" + Buffer.from(JSON.stringify({
    access_token: at,
    refresh_token: "",
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    token_type: "bearer",
  })).toString("base64url")
}

let adminToken = ""

test.beforeAll(async () => {
  test.setTimeout(120000)
  const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: "POST",
    headers: HDR,
    body: JSON.stringify({ email: EMAIL_ADMIN, password: PASSWORD, email_confirm: true, user_metadata: { full_name: "Coupon Admin" } }),
  })
  const u = await r.json()
  if (!u.id) throw new Error(`Create admin: ${r.status} ${JSON.stringify(u)}`)

  await fetch(`${SUPABASE_URL}/rest/v1/users`, {
    method: "POST",
    headers: { ...HDR, Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({ id: u.id, email: EMAIL_ADMIN, role: "admin" }),
  }).catch(() => {})

  const login = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: HDR,
    body: JSON.stringify({ email: EMAIL_ADMIN, password: PASSWORD }),
  })
  const loginData = await login.json()
  adminToken = loginData.access_token
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

async function loginAs(page: Page) {
  await page.context().addCookies([
    { name: `sb-${PROJECT_REF}-auth-token`, value: buildCookie(adminToken), domain: "localhost", path: "/" },
  ])
}

async function mockCoupons(page: Page, payload = MOCK_COUPONS) {
  await page.route("**/api/admin/coupons", async (route) => {
    const req = route.request()
    if (req.method() === "POST") {
      await route.fulfill({ status: 201, body: JSON.stringify(MOCK_CREATE_OK) })
    } else {
      await route.fulfill({ status: 200, body: JSON.stringify(payload) })
    }
  })
  await page.route("**/api/admin/coupons/*", async (route) => {
    const req = route.request()
    if (req.method() === "PATCH") {
      await route.fulfill({ status: 200, body: JSON.stringify({ coupon: MOCK_DETAIL }) })
    } else {
      await route.fulfill({ status: 200, body: JSON.stringify(MOCK_DETAIL) })
    }
  })
}

function gotoList(page: Page) {
  return page.goto(`${BASE}/admin/coupons`)
}

// ═════════════════════════════════════════════════════════════════════════════
// List page structure
// ═════════════════════════════════════════════════════════════════════════════

test("1. Page has one h1", async ({ page }) => {
  await loginAs(page)
  await mockCoupons(page)
  await gotoList(page)
  await page.waitForLoadState("networkidle")
  await expect(page.locator("h1")).toHaveCount(1)
  await expect(page.locator("h1")).toHaveText("کدهای تخفیف")
})

test("2. Header has create button", async ({ page }) => {
  await loginAs(page)
  await mockCoupons(page)
  await gotoList(page)
  await page.waitForLoadState("networkidle")
  await expect(page.getByRole("link", { name: "+ کد تخفیف جدید" })).toBeVisible()
})

test("3. Coupon rows render code and name", async ({ page }) => {
  await loginAs(page)
  await mockCoupons(page)
  await gotoList(page)
  await page.waitForLoadState("networkidle")
  await expect(page.getByText("SUMMER50")).toBeVisible()
  await expect(page.getByText("تخفیف تابستان")).toBeVisible()
  await expect(page.getByText("FIXED100K")).toBeVisible()
  await expect(page.getByText("هدیه مبلغی")).toBeVisible()
})

test("4. Discount summary shows percent", async ({ page }) => {
  await loginAs(page)
  await mockCoupons(page)
  await gotoList(page)
  await page.waitForLoadState("networkidle")
  await expect(page.getByText("۵۰٪")).toBeVisible()
})

test("5. Discount summary shows fixed amount", async ({ page }) => {
  await loginAs(page)
  await mockCoupons(page)
  await gotoList(page)
  await page.waitForLoadState("networkidle")
  await expect(page.getByText("۱۰۰٬۰۰۰ ریال")).toBeVisible()
})

test("6. Status badges render", async ({ page }) => {
  await loginAs(page)
  await mockCoupons(page)
  await gotoList(page)
  await page.waitForLoadState("networkidle")
  await expect(page.getByText("فعال")).toBeVisible()
  await expect(page.getByText("غیرفعال")).toBeVisible()
})

test("7. Usage summary shows bounded count", async ({ page }) => {
  await loginAs(page)
  await mockCoupons(page)
  await gotoList(page)
  await page.waitForLoadState("networkidle")
  await expect(page.getByText("استفاده قطعی: ۲ از ۱۰۰")).toBeVisible()
})

test("8. Reserved count is shown", async ({ page }) => {
  await loginAs(page)
  await mockCoupons(page)
  await gotoList(page)
  await page.waitForLoadState("networkidle")
  await expect(page.getByText("رزروشده: ۳")).toBeVisible()
})

test("9. Maximum discount cap is shown", async ({ page }) => {
  await loginAs(page)
  await mockCoupons(page)
  await gotoList(page)
  await page.waitForLoadState("networkidle")
  await expect(page.getByText("حداکثر تخفیف: ۵۰٬۰۰۰ ریال")).toBeVisible()
})

test("10. Edit link navigates to detail page", async ({ page }) => {
  await loginAs(page)
  await mockCoupons(page)
  await gotoList(page)
  await page.waitForLoadState("networkidle")
  await page.getByRole("link", { name: "ویرایش" }).first().click()
  await page.waitForURL(/\/admin\/coupons\/[0-9a-f-]{36}/)
  await expect(page.locator("h1")).toHaveText("ویرایش کد تخفیف")
})

test("11. Search input is present", async ({ page }) => {
  await loginAs(page)
  await mockCoupons(page)
  await gotoList(page)
  await page.waitForLoadState("networkidle")
  await expect(page.getByRole("textbox", { name: "جستجوی کدهای تخفیف" })).toBeVisible()
})

test("12. Status filter is present", async ({ page }) => {
  await loginAs(page)
  await mockCoupons(page)
  await gotoList(page)
  await page.waitForLoadState("networkidle")
  await expect(page.getByLabel("فیلتر وضعیت")).toBeVisible()
})

test("13. Discount type filter is present", async ({ page }) => {
  await loginAs(page)
  await mockCoupons(page)
  await gotoList(page)
  await page.waitForLoadState("networkidle")
  await expect(page.getByLabel("فیلتر نوع تخفیف")).toBeVisible()
})

test("14. Filtering by status refetches", async ({ page }) => {
  let requested = false
  await loginAs(page)
  await page.route("**/api/admin/coupons", async (route) => {
    requested = true
    await route.fulfill({ status: 200, body: JSON.stringify(MOCK_COUPONS) })
  })
  await gotoList(page)
  await page.waitForLoadState("networkidle")
  await page.getByLabel("فیلتر وضعیت").selectOption("inactive")
  await expect.poll(() => requested).toBeTruthy()
})

test("15. Pagination renders when multiple pages", async ({ page }) => {
  await loginAs(page)
  await mockCoupons(page, {
    coupons: MOCK_COUPONS.coupons,
    pagination: { page: 1, pageSize: 25, total: 60, totalPages: 3 },
  })
  await gotoList(page)
  await page.waitForLoadState("networkidle")
  await expect(page.getByRole("button", { name: "صفحه بعد" })).toBeVisible()
  await expect(page.getByRole("button", { name: "صفحه قبل" })).toBeDisabled()
})

test("16. Pagination next goes to page 2", async ({ page }) => {
  await loginAs(page)
  await mockCoupons(page, {
    coupons: MOCK_COUPONS.coupons,
    pagination: { page: 1, pageSize: 25, total: 60, totalPages: 3 },
  })
  await gotoList(page)
  await page.waitForLoadState("networkidle")
  await page.getByRole("button", { name: "صفحه بعد" }).click()
  await expect(page.getByText("صفحه ۲ از ۳")).toBeVisible()
})

test("17. Empty state shows when no coupons", async ({ page }) => {
  await loginAs(page)
  await mockCoupons(page, MOCK_EMPTY)
  await gotoList(page)
  await page.waitForLoadState("networkidle")
  await expect(page.getByText("هنوز کد تخفیفی ایجاد نشده است")).toBeVisible()
  await expect(page.getByText("برای شروع، اولین کد تخفیف را ایجاد کنید.")).toBeVisible()
})

test("18. Filtered empty state shows distinct message", async ({ page }) => {
  await loginAs(page)
  await page.route("**/api/admin/coupons", async (route) => {
    const url = new URL(route.request().url())
    if (url.searchParams.get("status") === "expired") {
      await route.fulfill({ status: 200, body: JSON.stringify(MOCK_EMPTY) })
    } else {
      await route.fulfill({ status: 200, body: JSON.stringify(MOCK_COUPONS) })
    }
  })
  await gotoList(page)
  await page.waitForLoadState("networkidle")
  await page.getByLabel("فیلتر وضعیت").selectOption("expired")
  await expect(page.getByText("کدی با این فیلتر پیدا نشد")).toBeVisible()
})

test("19. Error state shows retry", async ({ page }) => {
  await loginAs(page)
  await page.route("**/api/admin/coupons", async (route) => {
    await route.fulfill({ status: 500, body: JSON.stringify({ error: "خطای داخلی" }) })
  })
  await gotoList(page)
  await page.waitForLoadState("networkidle")
  await expect(page.getByRole("button", { name: "تلاش دوباره" })).toBeVisible()
})

test("20. Error state retry refetches", async ({ page }) => {
  let calls = 0
  await loginAs(page)
  await page.route("**/api/admin/coupons", async (route) => {
    calls += 1
    if (calls === 1) {
      await route.fulfill({ status: 500, body: JSON.stringify({ error: "خطای داخلی" }) })
    } else {
      await route.fulfill({ status: 200, body: JSON.stringify(MOCK_COUPONS) })
    }
  })
  await gotoList(page)
  await page.waitForLoadState("networkidle")
  await page.getByRole("button", { name: "تلاش دوباره" }).click()
  await expect(page.getByText("SUMMER50")).toBeVisible()
})

// ═════════════════════════════════════════════════════════════════════════════
// Create form
// ═════════════════════════════════════════════════════════════════════════════

test("21. New page has one h1", async ({ page }) => {
  await loginAs(page)
  await gotoList(page).catch(() => {})
  await page.goto(`${BASE}/admin/coupons/new`)
  await page.waitForLoadState("networkidle")
  await expect(page.locator("h1")).toHaveCount(1)
  await expect(page.locator("h1")).toHaveText("افزودن کد تخفیف")
})

test("22. New form has required fields", async ({ page }) => {
  await loginAs(page)
  await page.goto(`${BASE}/admin/coupons/new`)
  await page.waitForLoadState("networkidle")
  await expect(page.getByLabel("کد تخفیف")).toBeVisible()
  await expect(page.getByLabel("نام داخلی")).toBeVisible()
  await expect(page.getByLabel("نوع تخفیف")).toBeVisible()
  await expect(page.getByText("فعال بودن کد")).toBeVisible()
})

test("23. New form validates empty submission", async ({ page }) => {
  await loginAs(page)
  await page.goto(`${BASE}/admin/coupons/new`)
  await page.waitForLoadState("networkidle")
  await page.getByRole("button", { name: "افزودن کد تخفیف" }).click()
  await expect(page.getByText("فرمت کد تخفیف معتبر نیست.")).toBeVisible()
  await expect(page.getByText("نام داخلی الزامی است.")).toBeVisible()
  await expect(page.getByText("درصد تخفیف باید بیشتر از صفر و حداکثر ۱۰۰ باشد.")).toBeVisible()
})

test("24. New form normalizes code preview", async ({ page }) => {
  await loginAs(page)
  await page.goto(`${BASE}/admin/coupons/new`)
  await page.waitForLoadState("networkidle")
  await page.getByLabel("کد تخفیف").fill("  welcome-10  ")
  await expect(page.getByText("WELCOME-10")).toBeVisible()
})

test("25. Percentage type shows percent hint", async ({ page }) => {
  await loginAs(page)
  await page.goto(`${BASE}/admin/coupons/new`)
  await page.waitForLoadState("networkidle")
  await expect(page.getByText(/درصد در قالب پایه/)).toBeVisible()
})

test("26. Fixed amount type shows Rial hint", async ({ page }) => {
  await loginAs(page)
  await page.goto(`${BASE}/admin/coupons/new`)
  await page.waitForLoadState("networkidle")
  await page.getByLabel("نوع تخفیف").selectOption("fixed_amount")
  await expect(page.getByText(/تمام مبلغ‌ها به ریال/)).toBeVisible()
})

test("27. Expiry before start shows error", async ({ page }) => {
  await loginAs(page)
  await page.goto(`${BASE}/admin/coupons/new`)
  await page.waitForLoadState("networkidle")
  await page.getByLabel("شروع اعتبار").fill("2026-08-10T10:00")
  await page.getByLabel("پایان اعتبار").fill("2026-08-01T10:00")
  await page.getByRole("button", { name: "افزودن کد تخفیف" }).click()
  await expect(page.getByText("تاریخ پایان باید بعد از تاریخ شروع باشد.")).toBeVisible()
})

test("28. Submit sends JSON and redirects", async ({ page }) => {
  let sent: unknown = null
  await loginAs(page)
  await page.route("**/api/admin/coupons", async (route) => {
    const req = route.request()
    if (req.method() === "POST") {
      sent = req.postDataJSON()
      await route.fulfill({ status: 201, body: JSON.stringify(MOCK_CREATE_OK) })
    } else {
      await route.fulfill({ status: 200, body: JSON.stringify(MOCK_COUPONS) })
    }
  })
  await page.goto(`${BASE}/admin/coupons/new`)
  await page.waitForLoadState("networkidle")
  await page.getByLabel("کد تخفیف").fill("WELCOME10")
  await page.getByLabel("نام داخلی").fill("تخفیف خوش‌آمد")
  await page.getByLabel("درصد تخفیف (۱ تا ۱۰۰)").fill("10")
  await page.getByRole("button", { name: "افزودن کد تخفیف" }).click()
  await page.waitForURL("**/admin/coupons")
  const payload = sent as Record<string, unknown> | null
  expect(payload).toBeTruthy()
  expect(payload?.code).toBe("WELCOME10")
  expect(payload?.discountValue).toBe(1000)
  expect(payload?.isActive).toBe(true)
})

// ═════════════════════════════════════════════════════════════════════════════
// Edit form + confirm dialog
// ═════════════════════════════════════════════════════════════════════════════

test("29. Edit page loads coupon values", async ({ page }) => {
  await loginAs(page)
  await mockCoupons(page)
  await page.goto(`${BASE}/admin/coupons/11111111-1111-4111-8111-111111111111`)
  await page.waitForLoadState("networkidle")
  await expect(page.getByLabel("کد تخفیف")).toHaveValue("SUMMER50")
  await expect(page.getByLabel("نام داخلی")).toHaveValue("تخفیف تابستان")
  await expect(page.getByLabel("درصد تخفیف (۱ تا ۱۰۰)")).toHaveValue("50")
})

test("30. Used coupon disables discount fields", async ({ page }) => {
  await loginAs(page)
  await mockCoupons(page)
  await page.goto(`${BASE}/admin/coupons/11111111-1111-4111-8111-111111111111`)
  await page.waitForLoadState("networkidle")
  await expect(page.getByLabel("کد تخفیف")).toBeDisabled()
  await expect(page.getByLabel("درصد تخفیف (۱ تا ۱۰۰)")).toBeDisabled()
  await expect(page.getByText("این کد قبلاً استفاده شده است و کد آن قابل تغییر نیست.")).toBeVisible()
})

test("31. Saving edit sends expectedUpdatedAt", async ({ page }) => {
  let sent: unknown = null
  await loginAs(page)
  await page.route("**/api/admin/coupons/11111111-1111-4111-8111-111111111111", async (route) => {
    const req = route.request()
    if (req.method() === "PATCH") {
      sent = req.postDataJSON()
      await route.fulfill({ status: 200, body: JSON.stringify({ coupon: MOCK_DETAIL }) })
    } else {
      await route.fulfill({ status: 200, body: JSON.stringify(MOCK_DETAIL) })
    }
  })
  await page.goto(`${BASE}/admin/coupons/11111111-1111-4111-8111-111111111111`)
  await page.waitForLoadState("networkidle")
  await page.getByLabel("نام داخلی").fill("تخفیف جدید")
  await page.getByRole("button", { name: "ذخیره تغییرات" }).click()
  await page.waitForURL("**/admin/coupons")
  const payload = sent as Record<string, unknown> | null
  expect(payload?.expectedUpdatedAt).toBe("2026-07-20T10:00:00.000Z")
})

test("32. Deactivating used coupon opens confirm dialog", async ({ page }) => {
  await loginAs(page)
  await mockCoupons(page)
  await page.goto(`${BASE}/admin/coupons/11111111-1111-4111-8111-111111111111`)
  await page.waitForLoadState("networkidle")
  await page.getByRole("switch").click()
  await page.getByRole("button", { name: "ذخیره تغییرات" }).click()
  await expect(page.getByRole("dialog")).toBeVisible()
  await expect(page.getByText("غیرفعال کردن کد تخفیف")).toBeVisible()
  await expect(page.getByText("این کد برای استفاده‌های جدید غیرفعال می‌شود.")).toBeVisible()
})

test("33. Confirm dialog applies deactivation", async ({ page }) => {
  await loginAs(page)
  await page.route("**/api/admin/coupons/11111111-1111-4111-8111-111111111111", async (route) => {
    const req = route.request()
    if (req.method() === "PATCH") {
      await route.fulfill({ status: 200, body: JSON.stringify({ coupon: MOCK_DETAIL }) })
    } else {
      await route.fulfill({ status: 200, body: JSON.stringify(MOCK_DETAIL) })
    }
  })
  await page.goto(`${BASE}/admin/coupons/11111111-1111-4111-8111-111111111111`)
  await page.waitForLoadState("networkidle")
  await page.getByRole("switch").click()
  await page.getByRole("button", { name: "ذخیره تغییرات" }).click()
  await page.getByRole("button", { name: "تأیید" }).click()
  await page.waitForURL("**/admin/coupons")
  await expect(page.locator("h1")).toHaveText("کدهای تخفیف")
})

test("34. Cancel closes confirm dialog", async ({ page }) => {
  await loginAs(page)
  await mockCoupons(page)
  await page.goto(`${BASE}/admin/coupons/11111111-1111-4111-8111-111111111111`)
  await page.waitForLoadState("networkidle")
  await page.getByRole("switch").click()
  await page.getByRole("button", { name: "ذخیره تغییرات" }).click()
  await expect(page.getByRole("dialog")).toBeVisible()
  await page.getByRole("button", { name: "انصراف" }).click()
  await expect(page.getByRole("dialog")).toHaveCount(0)
})

test("35. Escape closes confirm dialog", async ({ page }) => {
  await loginAs(page)
  await mockCoupons(page)
  await page.goto(`${BASE}/admin/coupons/11111111-1111-4111-8111-111111111111`)
  await page.waitForLoadState("networkidle")
  await page.getByRole("switch").click()
  await page.getByRole("button", { name: "ذخیره تغییرات" }).click()
  await expect(page.getByRole("dialog")).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(page.getByRole("dialog")).toHaveCount(0)
})

test("36. Conflict shows reload message", async ({ page }) => {
  await loginAs(page)
  await page.route("**/api/admin/coupons/11111111-1111-4111-8111-111111111111", async (route) => {
    const req = route.request()
    if (req.method() === "PATCH") {
      await route.fulfill({
        status: 409,
        body: JSON.stringify({ error: "این کد توسط مدیر دیگری تغییر کرده است. اطلاعات جدید را دوباره بارگذاری کنید.", code: "COUPON_CONFLICT" }),
      })
    } else {
      await route.fulfill({ status: 200, body: JSON.stringify(MOCK_DETAIL) })
    }
  })
  await page.goto(`${BASE}/admin/coupons/11111111-1111-4111-8111-111111111111`)
  await page.waitForLoadState("networkidle")
  await page.getByLabel("نام داخلی").fill("تخفیف جدید")
  await page.getByRole("button", { name: "ذخیره تغییرات" }).click()
  await expect(page.getByText("این کد توسط مدیر دیگری تغییر کرده است. اطلاعات جدید را دوباره بارگذاری کنید.")).toBeVisible()
})

test("37. Server field errors render inline", async ({ page }) => {
  await loginAs(page)
  await page.route("**/api/admin/coupons", async (route) => {
    const req = route.request()
    if (req.method() === "POST") {
      await route.fulfill({
        status: 422,
        body: JSON.stringify({ error: "اطلاعات کد تخفیف معتبر نیست.", code: "COUPON_INVALID", errors: { name: "نام داخلی الزامی است." } }),
      })
    } else {
      await route.fulfill({ status: 200, body: JSON.stringify(MOCK_COUPONS) })
    }
  })
  await page.goto(`${BASE}/admin/coupons/new`)
  await page.waitForLoadState("networkidle")
  await page.getByLabel("کد تخفیف").fill("WELCOME10")
  await page.getByLabel("درصد تخفیف (۱ تا ۱۰۰)").fill("10")
  await page.getByRole("button", { name: "افزودن کد تخفیف" }).click()
  await expect(page.getByText("نام داخلی الزامی است.")).toBeVisible()
})

test("38. Cancel button returns to list", async ({ page }) => {
  await loginAs(page)
  await page.goto(`${BASE}/admin/coupons/new`)
  await page.waitForLoadState("networkidle")
  await page.getByRole("button", { name: "انصراف" }).click()
  await page.waitForURL("**/admin/coupons")
})

test("39. Package restriction toggle appears", async ({ page }) => {
  await loginAs(page)
  await page.goto(`${BASE}/admin/coupons/new`)
  await page.waitForLoadState("networkidle")
  await expect(page.getByText("اعمال برای همه بسته‌ها")).toBeVisible()
  await expect(page.getByText("فقط بسته‌های انتخاب‌شده")).toBeVisible()
})

test("40. Selecting restricted packages shows package list", async ({ page }) => {
  await loginAs(page)
  await page.goto(`${BASE}/admin/coupons/new`)
  await page.waitForLoadState("networkidle")
  await page.getByText("فقط بسته‌های انتخاب‌شده").click()
  await expect(page.getByText("حداقل یک بسته را انتخاب کنید.")).toBeVisible()
})
