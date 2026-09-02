import { test, expect } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import { assertSafeDatabaseTarget } from "../helpers/assert-safe-database-target";

const BASE = "http://localhost:3000";
const PASSWORD = "TestPass999!";

function loadEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  try {
    const content = fs.readFileSync(path.resolve(__dirname, "../../.env.local"), "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx);
      const val = trimmed.slice(eqIdx + 1);
      env[key] = val;
      process.env[key] = val; // Set in process.env for guard compatibility
    }
  } catch { /* fallback */ }
  return env;
}

loadEnv();
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const SUPABASE_SECRET = process.env.SUPABASE_SECRET_KEY || "";

const _guard = assertSafeDatabaseTarget();
if (!_guard.ok) {
  throw new Error(`Guard blocked: ${_guard.reason}`);
}

function adminHeaders() {
  return {
    "Content-Type": "application/json",
    apikey: SUPABASE_SECRET,
    Authorization: `Bearer ${SUPABASE_SECRET}`,
  };
}

// ── Synthetic parent management ──────────────────────────────────────

const TS = String(Date.now()).slice(-8);
const PARENT_A_PHONE = `090${TS.slice(0, 8)}`;
const PARENT_B_PHONE = `091${TS.slice(0, 8)}`;
const FULL_NAME = "کاربر تست";

const cleanup: (() => Promise<void>)[] = [];

async function findUserIdByEmail(email: string): Promise<string | null> {
  const resp = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    headers: adminHeaders(),
  });
  if (!resp.ok) return null;
  const data = await resp.json();
  const user = (data.users || []).find((u: { email: string }) => u.email === email);
  return user?.id || null;
}

async function findUserByPhone(phone: string): Promise<{ id: string; email: string } | null> {
  const cleaned = phone.replace(/^0/, "");
  const devEmail = `parent-98${cleaned}@dev.cartoona.example`;
  const id = await findUserIdByEmail(devEmail);
  if (!id) return null;
  return { id, email: devEmail };
}

async function setUserPassword(userId: string, password: string): Promise<void> {
  await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
    method: "PUT",
    headers: adminHeaders(),
    body: JSON.stringify({ password }),
  });
}

async function setParentConsent(userId: string, granted: boolean): Promise<void> {
  await fetch(`${SUPABASE_URL}/rest/v1/parent_profiles?user_id=eq.${userId}`, {
    method: "PATCH",
    headers: adminHeaders(),
    body: JSON.stringify({
      consent_granted: granted,
      consent_granted_at: granted ? new Date().toISOString() : null,
    }),
  });
}

async function signupDevUser(phone: string): Promise<void> {
  const r1 = await fetch(`${BASE}/api/dev/parent-auth`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "signup_request_code", phone, fullName: FULL_NAME }),
  });
  const d1 = await r1.json();
  const r2 = await fetch(`${BASE}/api/dev/parent-auth`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "signup_verify_code",
      phone,
      fullName: FULL_NAME,
      code: d1.developmentCode,
      challengeToken: d1.challengeToken,
    }),
  });
  if (!r2.ok) throw new Error(`Signup failed for ${phone}`);
}

async function setupParentA(): Promise<void> {
  // Parent A: consent=false (dev signup default)
  await signupDevUser(PARENT_A_PHONE);
}

async function setupParentB(): Promise<void> {
  // Parent B: consent=true, known password
  await signupDevUser(PARENT_B_PHONE);
  const user = await findUserByPhone(PARENT_B_PHONE);
  if (!user) throw new Error("Parent B not found after signup");
  await setUserPassword(user.id, PASSWORD);
  await setParentConsent(user.id, true);
}

// ── Crockford base32 decode helper ───────────────────────────────────
function readPersianCode(text: string): string {
  const map: Record<string, string> = {
    "۰": "0", "۱": "1", "۲": "2", "۳": "3", "۴": "4",
    "۵": "5", "۶": "6", "۷": "7", "۸": "8", "۹": "9",
  };
  return Array.from(text || "").map((c) => map[c] || c).join("");
}

async function doDevSmsLogin(page: import("@playwright/test").Page, phone: string): Promise<void> {
  await page.fill('input[placeholder="مثال: 09123456789"]', phone);
  await page.getByRole("button", { name: "دریافت کد ورود", exact: true }).click();
  await page.waitForSelector("text=کد آزمایشی شما", { timeout: 10000 });

  const devCodeText = await page.locator("text=کد آزمایشی شما")
    .locator("..")
    .locator("p.tracking-widest")
    .textContent();
  const devCode = readPersianCode(devCodeText || "");

  await page.fill('input[placeholder="کد ۶ رقمی"]', devCode);
  await page.getByRole("button", { name: "ورود", exact: true }).click();
}

async function doDevPasswordLogin(page: import("@playwright/test").Page, phone: string): Promise<void> {
  await page.getByRole("button", { name: "ورود با رمز عبور", exact: true }).click();
  await page.waitForTimeout(300);
  await page.fill('input[placeholder="مثال: 09123456789"]', phone);
  await page.fill('input[placeholder="رمز عبور"]', PASSWORD);
  await page.getByRole("button", { name: "ورود", exact: true }).click();
}

// ── Setup ────────────────────────────────────────────────────────────

test.beforeAll(async () => {
  if (!SUPABASE_URL || !SUPABASE_SECRET) {
    console.log("SKIP: Supabase credentials missing — cannot create test users");
    return;
  }
  await setupParentA();
  await setupParentB();
  // Register cleanup
  for (const phone of [PARENT_A_PHONE, PARENT_B_PHONE]) {
    const user = await findUserByPhone(phone);
    if (user) {
      cleanup.push(async () => {
        await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${user.id}`, {
          method: "DELETE",
          headers: adminHeaders(),
        }).catch(() => {});
      });
    }
  }
});

test.afterAll(async () => {
  for (const fn of cleanup) await fn();
});

// ══════════════════════════════════════════════════════════════════════
//  Part 2 — Consent-priority runtime test
// ══════════════════════════════════════════════════════════════════════

test("Part 2 — consent=false + from=/dashboard/orders → /parent-consent", async ({ page }) => {
  await page.goto(`${BASE}/login?reason=session_expired&from=/dashboard/orders`);
  await page.waitForLoadState("networkidle");

  await doDevSmsLogin(page, PARENT_A_PHONE);

  await page.waitForURL("/parent-consent", { timeout: 15000 });
  expect(page.url()).not.toContain("/dashboard/orders");
});

// ══════════════════════════════════════════════════════════════════════
//  Part 3 — Nested Dashboard return
// ══════════════════════════════════════════════════════════════════════

test("Part 3 — consent=true + from=/dashboard/settings → /dashboard/settings", async ({ page }) => {
  // Ensure fully logged out
  await page.goto(`${BASE}/login`);
  await page.waitForLoadState("networkidle");

  await page.goto(`${BASE}/login?reason=session_expired&from=/dashboard/settings`);
  await page.waitForLoadState("networkidle");

  await doDevSmsLogin(page, PARENT_B_PHONE);

  await page.waitForURL(/\/dashboard\/settings/, { timeout: 15000 });
  // Confirm the page loads (not a redirect loop)
  await expect(page.locator("body")).toBeVisible();
});

// ══════════════════════════════════════════════════════════════════════
//  Part 4 — Complete Request return (password login)
// ══════════════════════════════════════════════════════════════════════

test("Part 4 — consent=true + from=/complete-request → /complete-request", async ({ page }) => {
  // Log out by clearing context
  await page.goto(`${BASE}/login`);
  await page.waitForLoadState("networkidle");

  await page.goto(`${BASE}/login?reason=session_expired&from=/complete-request`);
  await page.waitForLoadState("networkidle");

  await doDevPasswordLogin(page, PARENT_B_PHONE);

  await page.waitForURL(/\/complete-request/, { timeout: 15000 });
  await expect(page.locator("body")).toBeVisible();
});

// ══════════════════════════════════════════════════════════════════════
//  Part 5 — Unsafe destinations after successful login
// ══════════════════════════════════════════════════════════════════════

const unsafeAfterLogin: [string, string][] = [
  ["/admin", "/admin"],
  ["external URL", "https://evil.example"],
  ["protocol-relative", "//evil.example"],
  ["path-traversal", "/dashboard/../admin"],
  ["encoded-traversal", "/%2e%2e/admin"],
];

for (const [label, fromValue] of unsafeAfterLogin) {
  test(`Part 5 — Unsafe ${label} → /dashboard after login`, async ({ page }) => {
    // Fresh browser context: clear any leftover session
    await page.context().clearCookies();
    await page.evaluate(() => {
      try { localStorage.clear(); sessionStorage.clear(); } catch {}
    });

    // Navigate directly to login with from parameter (single navigation)
    await page.goto(`${BASE}/login?from=${encodeURIComponent(fromValue)}`);
    await page.waitForLoadState("networkidle");

    await doDevSmsLogin(page, PARENT_B_PHONE);
    await page.waitForURL(/\/dashboard($|\?)/, { timeout: 15000 });

    // Must be on localhost
    expect(page.url()).toContain("localhost:3000");
    // Must not be on admin route
    expect(page.url()).not.toContain("/admin");
    // No redirect loop
    await expect(page.locator("body")).toBeVisible();
  });
}

// ══════════════════════════════════════════════════════════════════════
//  Part 6 — Normal login without query parameters
// ══════════════════════════════════════════════════════════════════════

test("Part 6a — Parent A consent=false → /parent-consent", async ({ page }) => {
  await page.goto(`${BASE}/login`);
  await page.waitForLoadState("networkidle");

  await doDevSmsLogin(page, PARENT_A_PHONE);

  await page.waitForURL("/parent-consent", { timeout: 15000 });
});

test("Part 6b — Parent B consent=true → /dashboard", async ({ page }) => {
  await page.goto(`${BASE}/login`);
  await page.waitForLoadState("networkidle");

  await doDevPasswordLogin(page, PARENT_B_PHONE);

  await page.waitForURL(/\/dashboard($|\?)/, { timeout: 15000 });
});

// ══════════════════════════════════════════════════════════════════════
//  Part 7 — Notice preservation during errors
// ══════════════════════════════════════════════════════════════════════

test("Part 7a — Wrong OTP preserves session-expired notice", async ({ page }) => {
  await page.goto(`${BASE}/login?reason=session_expired&from=/dashboard`);
  await page.waitForLoadState("networkidle");

  // Confirm notice is visible
  const notice = page.getByText("برای حفظ امنیت حساب، پس از ۳۰ روز باید دوباره وارد شوید.", { exact: true });
  await expect(notice).toBeVisible();

  // Trigger dev OTP request
  await page.fill('input[placeholder="مثال: 09123456789"]', PARENT_A_PHONE);
  await page.getByRole("button", { name: "دریافت کد ورود", exact: true }).click();
  await page.waitForSelector('input[placeholder="کد ۶ رقمی"]', { timeout: 10000 });

  // Submit wrong code
  await page.fill('input[placeholder="کد ۶ رقمی"]', "000000");
  await page.getByRole("button", { name: "ورود", exact: true }).click();
  await page.waitForTimeout(2000);

  // Persian OTP error must appear
  await expect(page.getByText("شماره موبایل یا کد ورود صحیح نیست")).toBeVisible();
  // Session-expired notice must still be visible
  await expect(notice).toBeVisible();
});

test("Part 7b — Wrong password preserves session-expired notice", async ({ page }) => {
  // Log out first
  await page.goto(`${BASE}/login`);
  await page.waitForLoadState("networkidle");

  await page.goto(`${BASE}/login?reason=session_expired&from=/dashboard`);
  await page.waitForLoadState("networkidle");

  const notice = page.getByText("برای حفظ امنیت حساب، پس از ۳۰ روز باید دوباره وارد شوید.", { exact: true });
  await expect(notice).toBeVisible();

  // Switch to password tab
  await page.getByRole("button", { name: "ورود با رمز عبور", exact: true }).click();
  await page.waitForTimeout(300);

  // Submit wrong password (use a phone that doesn't exist, or wrong password for existing user)
  await page.fill('input[placeholder="مثال: 09123456789"]', PARENT_B_PHONE);
  await page.fill('input[placeholder="رمز عبور"]', "DefinitelyWrongPassword!");
  await page.getByRole("button", { name: "ورود", exact: true }).click();
  await page.waitForTimeout(2000);

  // Dev password error must appear
  await expect(page.getByText("شماره موبایل یا رمز عبور صحیح نیست")).toBeVisible();
  // Session-expired notice must still be visible
  await expect(notice).toBeVisible();
});

// ══════════════════════════════════════════════════════════════════════
//  Part 2 baseline — Notice rendering (no login)
// ══════════════════════════════════════════════════════════════════════

test("Part 2a — Session-expired notice render", async ({ page }) => {
  await page.goto(`${BASE}/login?reason=session_expired&from=/dashboard`);
  await page.waitForLoadState("networkidle");
  const notice = page.getByText("برای حفظ امنیت حساب، پس از ۳۰ روز باید دوباره وارد شوید.", { exact: true });
  await expect(notice).toBeVisible();
});

test("Part 2b — No notice for other reason", async ({ page }) => {
  await page.goto(`${BASE}/login?reason=anything_else`);
  await page.waitForLoadState("networkidle");
  await expect(page.getByText("برای حفظ امنیت حساب")).toHaveCount(0);
});

test("Part 2c — No notice without params", async ({ page }) => {
  await page.goto(`${BASE}/login`);
  await page.waitForLoadState("networkidle");
  await expect(page.getByText("برای حفظ امنیت حساب")).toHaveCount(0);
});

test("Part 2e — Notice is informational (bg-cream)", async ({ page }) => {
  await page.goto(`${BASE}/login?reason=session_expired&from=/dashboard`);
  await page.waitForLoadState("networkidle");
  const notice = page.getByText("برای حفظ امنیت حساب، پس از ۳۰ روز باید دوباره وارد شوید.", { exact: true });
  const container = notice.locator("xpath=..");
  const classAttr = await container.getAttribute("class") || "";
  expect(classAttr).toContain("bg-cream");
});

test("Part 2d — SMS tab active by default", async ({ page }) => {
  await page.goto(`${BASE}/login`);
  await page.waitForLoadState("networkidle");
  const smsTab = page.getByText("ورود با کد پیامکی", { exact: true });
  await expect(smsTab).toBeVisible();
  await expect(smsTab).toHaveClass(/border-candy-pink/);
});

// ══════════════════════════════════════════════════════════════════════
//  Part 6 baseline — Unsafe destinations (render only)
// ══════════════════════════════════════════════════════════════════════

const unsafeRender = [
  ["/admin", "from=/admin"],
  ["/admin/users", "from=/admin/users"],
  ["/admin-login", "from=/admin-login"],
  ["/login", "from=/login"],
  ["/signup", "from=/signup"],
  ["https://evil.example", "from=https://evil.example"],
  ["//evil.example", "from=//evil.example"],
  ["javascript:alert(1)", "from=javascript:alert(1)"],
  ["/dashboard/../admin", "from=/dashboard/../admin"],
  ["/%2e%2e/admin", "from=/%2e%2e/admin"],
];

for (const [label, qs] of unsafeRender) {
  test(`Unsafe render ${label} stays on /login`, async ({ page }) => {
    await page.goto(`${BASE}/login?${qs}`);
    await page.waitForLoadState("networkidle");
    await expect(page.getByText("ورود والدین", { exact: true })).toBeVisible();
    expect(page.url()).toContain("/login");
  });
}

// ══════════════════════════════════════════════════════════════════════
//  Regression: signup link, no email field
// ══════════════════════════════════════════════════════════════════════

test("No email field on login page", async ({ page }) => {
  await page.goto(`${BASE}/login`);
  await page.waitForLoadState("networkidle");
  await expect(page.locator('input[type="email"]')).toHaveCount(0);
});

test("Signup link exists", async ({ page }) => {
  await page.goto(`${BASE}/login`);
  await page.waitForLoadState("networkidle");
  await expect(page.locator('a[href="/signup"]')).toBeVisible();
});
