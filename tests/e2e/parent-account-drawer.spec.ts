import { test, expect, type Page } from "@playwright/test"
import { loadTestEnv } from "../helpers/load-test-env"
import {
  assertSafeDatabaseTarget,
  guardedProjectRef,
  guardedSupabaseUrl,
} from "../helpers/assert-safe-database-target"

// ⚠️ Stateful parent-account tests. These create synthetic parent and admin
// accounts, so they run against a disposable/local target ONLY, never the
// production main project. assertSafeDatabaseTarget() gates the whole file, and
// both the Supabase URL and the auth cookie name are derived from the same
// environment the guard inspected, so the guard's verdict is binding.

function loadEnv(): void {
  loadTestEnv()
}

loadEnv()

const _guard = assertSafeDatabaseTarget()
if (!_guard.ok) throw new Error(`Guard blocked: ${_guard.reason}`)

const PROJECT_REF = guardedProjectRef()
const SUPABASE_URL = guardedSupabaseUrl()
const BASE = process.env.CARTOONA_TEST_BASE_URL || "http://localhost:3000"

const KEY = process.env.SUPABASE_SECRET_KEY || ""
const HDR = { "Content-Type": "application/json", apikey: KEY, Authorization: `Bearer ${KEY}` }
const PASSWORD = "TestPass999!"
const TS = String(Date.now()).slice(-8)

const PARENT_NAME = "مریم رضایی"
const PARENT_INITIALS = "مر"

/** Public routes that must all carry the account control. */
const PUBLIC_ROUTES = ["/", "/create-image", "/request-video", "/animate-drawing", "/faq"]

interface TestUser { userId: string; email: string; accessToken: string }

async function createUser(tag: string, role: string, fullName?: string): Promise<TestUser> {
  const email = `account-drawer-${tag}-${TS}@example.com`

  const created = await (await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: "POST", headers: HDR,
    body: JSON.stringify({ email, password: PASSWORD, email_confirm: true }),
  })).json()
  if (!created.id) throw new Error(`create ${email}: ${JSON.stringify(created)}`)

  await fetch(`${SUPABASE_URL}/rest/v1/users`, {
    method: "POST", headers: { ...HDR, Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({ id: created.id, email, role }),
  })

  if (fullName) {
    await fetch(`${SUPABASE_URL}/rest/v1/parent_profiles`, {
      method: "POST", headers: HDR,
      body: JSON.stringify({
        user_id: created.id, full_name: fullName,
        consent_granted: true, consent_granted_at: new Date().toISOString(),
      }),
    })
  }

  const login = await (await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST", headers: HDR, body: JSON.stringify({ email, password: PASSWORD }),
  })).json()

  return { userId: created.id, email, accessToken: login.access_token }
}

function cookieValue(token: string): string {
  return "base64-" + Buffer.from(JSON.stringify({
    access_token: token, refresh_token: "", expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600, token_type: "bearer",
  })).toString("base64url")
}

async function signIn(page: Page, user: TestUser): Promise<void> {
  await page.context().addCookies([{
    name: `sb-${PROJECT_REF}-auth-token`,
    value: cookieValue(user.accessToken),
    domain: "localhost", path: "/",
  }])
}

const trigger = (page: Page) => page.getByRole("button", { name: "باز کردن منوی حساب والد" })
const drawer = (page: Page) => page.getByRole("dialog", { name: "منوی حساب والد" })

let parent: TestUser
let admin: TestUser

test.beforeAll(async () => {
  parent = await createUser("parent", "parent", PARENT_NAME)
  admin = await createUser("admin", "admin")
})

test.afterAll(async () => {
  for (const u of [parent, admin]) {
    if (!u) continue
    await fetch(`${SUPABASE_URL}/rest/v1/parent_profiles?user_id=eq.${u.userId}`, { method: "DELETE", headers: HDR }).catch(() => {})
    await fetch(`${SUPABASE_URL}/rest/v1/users?id=eq.${u.userId}`, { method: "DELETE", headers: HDR }).catch(() => {})
    await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${u.userId}`, { method: "DELETE", headers: HDR }).catch(() => {})
  }
})

test("an anonymous visitor keeps ورود and the signup action", async ({ page }) => {
  for (const route of ["/create-image", "/faq"]) {
    await page.goto(`${BASE}${route}`)
    await expect(page.getByRole("link", { name: "ورود" }).first()).toBeVisible()
    await expect(trigger(page)).toHaveCount(0)
  }

  await page.goto(BASE)
  // The homepage hero carries its own header with CMS-driven labels.
  await expect(page.locator('nav a[href="/login"]').first()).toBeVisible()
  await expect(trigger(page)).toHaveCount(0)
})

test("an authenticated parent sees the account control on every public route", async ({ page }) => {
  await signIn(page, parent)

  for (const route of PUBLIC_ROUTES) {
    await page.goto(`${BASE}${route}`)
    await expect(trigger(page).first(), route).toBeVisible()
    // The public auth actions are gone.
    await expect(page.getByRole("link", { name: "ورود", exact: true }), route).toHaveCount(0)
    await expect(page.getByRole("link", { name: "ساخت حساب", exact: true }), route).toHaveCount(0)
  }
})

test("the account control is correct in the first HTML, with no logged-out flash", async () => {
  // Server-rendered markup, before any client JavaScript has run.
  const res = await fetch(`${BASE}/create-image`, {
    headers: { Cookie: `sb-${PROJECT_REF}-auth-token=${cookieValue(parent.accessToken)}` },
  })
  const html = await res.text()
  expect(html).toContain(PARENT_INITIALS)
  expect(html).toContain("باز کردن منوی حساب والد")
  expect(html).not.toContain(">ساخت حساب<")
})

test("clicking the control opens a right-side drawer with the portal destinations", async ({ page }) => {
  await signIn(page, parent)
  await page.goto(`${BASE}/create-image`)

  await expect(trigger(page)).toHaveAttribute("aria-expanded", "false")
  await trigger(page).click()

  const panel = drawer(page)
  await expect(panel).toBeVisible()
  await expect(trigger(page)).toHaveAttribute("aria-expanded", "true")
  await expect(panel.getByText(PARENT_NAME)).toBeVisible()

  // Anchored to the right edge for RTL.
  const box = await panel.boundingBox()
  const width = page.viewportSize()!.width
  expect(Math.abs(box!.x + box!.width - width)).toBeLessThanOrEqual(2)

  for (const [label, href] of [
    ["درخواست‌ها", "/dashboard/orders"],
    ["گالری خصوصی", "/dashboard/gallery"],
    ["پروفایل", "/dashboard/settings#profile"],
    ["آبنبات‌ها و پرداخت", "/dashboard/billing"],
    ["گرفتن تخفیف", "/dashboard/referrals"],
    ["تنظیمات", "/dashboard/settings"],
  ]) {
    await expect(panel.getByRole("link", { name: label, exact: true })).toHaveAttribute("href", href)
  }

  // No dashboard destination, and creation stays on the public routes.
  await expect(panel.getByRole("link", { name: "داشبورد", exact: true })).toHaveCount(0)
  await expect(panel.locator('a[href="/dashboard"]')).toHaveCount(0)
  await expect(panel.getByText("سفارش جدید")).toBeVisible()
  for (const href of ["/create-image", "/request-video", "/animate-drawing"]) {
    await expect(panel.locator(`a[href="${href}"]`)).toHaveCount(1)
  }
  await expect(panel.locator('a[href^="/dashboard/create"], a[href^="/dashboard/request"], a[href^="/dashboard/animate"]')).toHaveCount(0)
})

test("the drawer escapes the homepage hero header and covers the viewport", async ({ page }) => {
  // The hero's floating header carries a transform and a backdrop-filter, and
  // either of those makes it the containing block for its fixed descendants.
  // Without a portal the drawer is trapped inside that header bar, so this
  // asserts the overlay really spans the viewport on the homepage.
  await signIn(page, parent)
  await page.goto(BASE)
  await trigger(page).first().click()

  const panel = drawer(page)
  await expect(panel).toBeVisible()

  const box = await panel.boundingBox()
  const viewport = await page.evaluate(() => ({
    width: document.documentElement.clientWidth,
    height: document.documentElement.clientHeight,
  }))

  expect(Math.abs(box!.x + box!.width - viewport.width)).toBeLessThanOrEqual(2)
  expect(box!.height).toBeGreaterThanOrEqual(viewport.height - 2)

  const overlay = await page.evaluate(() => {
    const el = document.querySelector('[role="dialog"][aria-label="منوی حساب والد"]')!
      .parentElement as HTMLElement
    const r = el.getBoundingClientRect()
    return { width: r.width, height: r.height, parent: el.parentElement?.tagName }
  })
  expect(overlay.width).toBeGreaterThanOrEqual(viewport.width - 2)
  expect(overlay.height).toBeGreaterThanOrEqual(viewport.height - 2)
  expect(overlay.parent).toBe("BODY")
})

test("the drawer closes on Escape, on the close button, and on an outside click", async ({ page }) => {
  await signIn(page, parent)
  await page.goto(`${BASE}/create-image`)

  await trigger(page).click()
  await expect(drawer(page)).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(drawer(page)).toHaveCount(0)
  // Focus returns to the trigger.
  await expect(trigger(page)).toBeFocused()

  await trigger(page).click()
  await page.getByRole("button", { name: "بستن" }).click()
  await expect(drawer(page)).toHaveCount(0)

  await trigger(page).click()
  await page.mouse.click(12, 300)
  await expect(drawer(page)).toHaveCount(0)
})

test("the trigger opens the drawer instead of navigating", async ({ page }) => {
  await signIn(page, parent)
  await page.goto(`${BASE}/create-image`)
  await trigger(page).click()
  await expect(drawer(page)).toBeVisible()
  expect(new URL(page.url()).pathname).toBe("/create-image")
})

test("the drawer reaches every portal destination and the session persists throughout", async ({ page }) => {
  // Six soft navigations. Against a cold dev server each destination is
  // compiled on demand, which overruns the default per-test budget.
  test.setTimeout(120_000)
  await signIn(page, parent)

  for (const [label, expected] of [
    ["درخواست‌ها", "/dashboard/orders"],
    ["گالری خصوصی", "/dashboard/gallery"],
    ["آبنبات‌ها و پرداخت", "/dashboard/billing"],
    ["گرفتن تخفیف", "/dashboard/referrals"],
    ["تنظیمات", "/dashboard/settings"],
  ]) {
    await page.goto(BASE)
    await trigger(page).first().click()
    await drawer(page).getByRole("link", { name: label, exact: true }).click()
    // Polled rather than waitForURL: these are client-side soft navigations,
    // and a prerendered destination fires no fresh load event to wait on.
    await expect
      .poll(() => new URL(page.url()).pathname, { message: label, timeout: 20000 })
      .toBe(expected)
  }

  // Back out to the public site, still signed in.
  await page.goto(BASE)
  await expect(trigger(page).first()).toBeVisible()
  await page.goto(`${BASE}/create-image`)
  await expect(trigger(page).first()).toBeVisible()
})

test("an admin never receives the parent drawer", async ({ page }) => {
  await signIn(page, admin)

  for (const route of ["/", "/create-image", "/faq"]) {
    await page.goto(`${BASE}${route}`)
    await expect(trigger(page), route).toHaveCount(0)
    await expect(drawer(page), route).toHaveCount(0)
  }
})

test("logout clears the session and restores the public actions", async ({ page }) => {
  await signIn(page, parent)
  await page.goto(`${BASE}/create-image`)

  await trigger(page).click()
  await drawer(page).getByRole("button", { name: "خروج" }).click()

  // The existing server logout redirects to the canonical destination.
  await page.waitForURL("**/login**")
  expect(new URL(page.url()).pathname).toBe("/login")

  await page.goto(`${BASE}/create-image`)
  await expect(trigger(page)).toHaveCount(0)
  await expect(page.getByRole("link", { name: "ورود" }).first()).toBeVisible()
  await expect(page.getByRole("link", { name: "ساخت حساب" }).first()).toBeVisible()
})
