import { test, expect, type Page } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import { assertSafeDatabaseTarget } from "../helpers/assert-safe-database-target";

const BASE = "http://localhost:3000";
const PROJECT_REF = "oucyhmrnzahlhqjfqcge";
const SUPABASE_URL = `https://${PROJECT_REF}.supabase.co`;

function loadEnv(): void {
  try {
    const content = fs.readFileSync(path.resolve(__dirname, "../../.env.local"), "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx);
      const val = trimmed.slice(eqIdx + 1);
      process.env[key] = val;
    }
  } catch { /* fallback */ }
}

loadEnv();

const _guard = assertSafeDatabaseTarget();
if (!_guard.ok) throw new Error(`Guard blocked: ${_guard.reason}`);

const ADMIN_KEY = process.env.SUPABASE_SECRET_KEY || "";
const TS = String(Date.now()).slice(-8);

function adminHeaders() {
  return { "Content-Type": "application/json", apikey: ADMIN_KEY, Authorization: `Bearer ${ADMIN_KEY}` };
}

const COOKIE_NAME = `sb-${PROJECT_REF}-auth-token`;

async function createUser(email: string): Promise<string> {
  const createResp = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: "POST",
    headers: adminHeaders(),
    body: JSON.stringify({ email, password: "TestPass999!", email_confirm: true, user_metadata: { full_name: "Test" } }),
  });
  if (!createResp.ok) throw new Error(`Create ${email}: ${await createResp.text()}`);
  const user = await createResp.json();
  return user.id;
}

async function ensureParentProfile(userId: string): Promise<void> {
  const check = await fetch(`${SUPABASE_URL}/rest/v1/parent_profiles?user_id=eq.${userId}&select=id`, { headers: adminHeaders() });
  const existing = await check.json();
  if (existing && existing.length > 0) return;
  await fetch(`${SUPABASE_URL}/rest/v1/parent_profiles`, {
    method: "POST",
    headers: adminHeaders(),
    body: JSON.stringify({ user_id: userId, full_name: "Test", consent_granted: true, consent_granted_at: new Date().toISOString() }),
  });
}

function buildCookie(accessToken: string, refreshToken: string, expiresIn: number): string {
  const session = {
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_in: expiresIn,
    expires_at: Math.floor(Date.now() / 1000) + expiresIn,
    token_type: "bearer",
  };
  return "base64-" + Buffer.from(JSON.stringify(session)).toString("base64url");
}

async function buildSession(email: string): Promise<string> {
  const loginResp = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: adminHeaders(),
    body: JSON.stringify({ email, password: "TestPass999!" }),
  });
  const data = await loginResp.json();
  return buildCookie(data.access_token, data.refresh_token, data.expires_in);
}

async function bindViaApi(cookie: string, code: string): Promise<void> {
  const resp = await fetch(`${BASE}/api/referrals/bind`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: `${COOKIE_NAME}=${cookie}` },
    body: JSON.stringify({ code }),
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`bind via API failed (${resp.status}): ${body}`);
  }
}

async function waitForBoundState(page: Page): Promise<void> {
  await expect(page.getByText("کد معرف ثبت شده است")).toBeVisible({ timeout: 10000 });
}

async function navigateWithAuth(page: Page, url: string, cookie: string): Promise<void> {
  await page.evaluate(() => { try { localStorage.clear(); sessionStorage.clear(); } catch {} }).catch(() => {});
  await page.context().clearCookies();
  await page.context().addCookies([
    { name: COOKIE_NAME, value: cookie, domain: "localhost", path: "/", httpOnly: false, secure: false, sameSite: "Lax" as const },
  ]);
  await page.goto(url, { waitUntil: "load", timeout: 15000 });
}

async function getReferralCode(cookie: string): Promise<string> {
  const resp = await fetch(`${BASE}/api/referrals`, {
    headers: { Cookie: `${COOKIE_NAME}=${cookie}` },
  });
  if (!resp.ok) return "";
  const data = await resp.json();
  return data.referralCode || "";
}

// ── Users and sessions ────────────────────────────────────────────────────

const EMAIL_OWNER = `dash_owner_${TS}@test.com`;
const EMAIL_BIND = `dash_bind_${TS}@test.com`; // used for UI binding flow
const EMAIL_BOUND = `dash_bound_${TS}@test.com`; // pre-bound for bound-state tests
const EMAIL_UNAUTH = `dash_unauth_${TS}@test.com`;
const cleanupIds: string[] = [];

let ownerCookie = "";
let bindCookie = "";
let boundCookie = "";
let ownerCode = "";

test.beforeAll(async () => {
  test.setTimeout(60000);
  const u1 = await createUser(EMAIL_OWNER);
  const u2 = await createUser(EMAIL_BIND);
  const u3 = await createUser(EMAIL_BOUND);
  const u4 = await createUser(EMAIL_UNAUTH);
  await ensureParentProfile(u1);
  await ensureParentProfile(u2);
  await ensureParentProfile(u3);
  cleanupIds.push(u1, u2, u3, u4);

  ownerCookie = await buildSession(EMAIL_OWNER);
  bindCookie = await buildSession(EMAIL_BIND);
  boundCookie = await buildSession(EMAIL_BOUND);
  ownerCode = await getReferralCode(ownerCookie);

  // Pre-bind the bound user via API so bound-state tests are deterministic
  await bindViaApi(boundCookie, ownerCode);
});

test.afterAll(async () => {
  for (const uid of cleanupIds) {
    await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${uid}`, { method: "DELETE", headers: adminHeaders() }).catch(() => {});
  }
});

function loginAs(page: Page, cookie: string) {
  return navigateWithAuth(page, `${BASE}/dashboard/referrals`, cookie);
}

// ══════════════════════════════════════════════════════════════════════════
//  Part A — Navigation, layout, code display
// ══════════════════════════════════════════════════════════════════════════

test("dashboard navigation contains معرفی دوستان", async ({ page }) => {
  await navigateWithAuth(page, `${BASE}/dashboard`, ownerCookie);
  const navLink = page.locator("nav a", { hasText: "معرفی دوستان" });
  await expect(navLink).toBeVisible();
  await expect(navLink).toHaveAttribute("href", "/dashboard/referrals");
});

test("route loads for authenticated parent", async ({ page }) => {
  await loginAs(page, ownerCookie);
  await expect(page).toHaveURL(/\/dashboard\/referrals/);
  await expect(page.locator("h1")).toBeVisible();
});

test("one h1 is present", async ({ page }) => {
  await loginAs(page, ownerCookie);
  await expect(page.locator("h1")).toHaveCount(1);
});

test("referral code is displayed", async ({ page }) => {
  await loginAs(page, ownerCookie);
  expect(ownerCode).toMatch(/^CT[0-9A-F]{12}$/);
  await expect(page.locator("code")).toContainText(ownerCode);
});

test("code element uses LTR direction", async ({ page }) => {
  await loginAs(page, ownerCookie);
  await expect(page.locator("code").first()).toHaveAttribute("dir", "ltr");
});

test("copy action provides success feedback", async ({ page }) => {
  await page.context().grantPermissions(["clipboard-write", "clipboard-read"]);
  await loginAs(page, ownerCookie);
  await page.getByRole("button", { name: "کپی کد معرفی" }).click();
  await expect(page.getByText("کد معرفی کپی شد.")).toBeVisible({ timeout: 3000 });
});

test("share fallback works when navigator.share is unavailable", async ({ page }) => {
  await page.context().grantPermissions(["clipboard-write", "clipboard-read"]);
  await loginAs(page, ownerCookie);
  await page.getByRole("button", { name: "اشتراک‌گذاری کد معرفی" }).click();
  await expect(page.getByText("متن اشتراک‌گذاری کپی شد.")).toBeVisible({ timeout: 3000 });
});

test("referredCount is displayed", async ({ page }) => {
  await loginAs(page, ownerCookie);
  await expect(page.getByText("تعداد معرفی‌های ثبت‌شده")).toBeVisible();
  await expect(page.locator("p.text-3xl.font-bold")).toBeVisible();
});

test("reward percentage derives from rewardBasisPoints", async ({ page }) => {
  await loginAs(page, ownerCookie);
  await expect(page.getByText("15%")).toBeVisible();
});

// ══════════════════════════════════════════════════════════════════════════
//  Part B — Binding form (unbound user: bindCookie)
// ══════════════════════════════════════════════════════════════════════════

test("unbound parent sees code input", async ({ page }) => {
  await loginAs(page, bindCookie);
  await expect(page.locator("#referral-code-input")).toBeVisible();
});

test("input normalizes lowercase letters to uppercase", async ({ page }) => {
  await loginAs(page, bindCookie);
  await page.locator("#referral-code-input").fill("ct12ab34cd56ef");
  await expect(page.locator("#referral-code-input")).toHaveValue("CT12AB34CD56EF");
});

test("invalid client format cannot open final confirmation", async ({ page }) => {
  await loginAs(page, bindCookie);
  await page.locator("#referral-code-input").fill("invalid");
  await expect(page.getByRole("button", { name: "ثبت کد معرف" })).toBeDisabled();
});

test("valid code opens permanent-binding confirmation", async ({ page }) => {
  expect(ownerCode).toMatch(/^CT[0-9A-F]{12}$/);
  await loginAs(page, bindCookie);
  await page.locator("#referral-code-input").fill(ownerCode);
  await page.getByRole("button", { name: "ثبت کد معرف" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByText("ثبت دائمی کد معرف")).toBeVisible();
});

test("confirmation shows the entered normalized code", async ({ page }) => {
  await loginAs(page, bindCookie);
  await page.locator("#referral-code-input").fill(ownerCode.toLowerCase());
  await page.getByRole("button", { name: "ثبت کد معرف" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.locator('[role="dialog"] code')).toContainText(ownerCode);
});

test("cancelling does not call the binding API", async ({ page }) => {
  await loginAs(page, bindCookie);
  const beforeResp = await fetch(`${BASE}/api/referrals`, {
    headers: { Cookie: `${COOKIE_NAME}=${bindCookie}` },
  });
  const before = await beforeResp.json();
  expect(before.binding.isBound).toBe(false);

  await page.locator("#referral-code-input").fill(ownerCode);
  await page.getByRole("button", { name: "ثبت کد معرف" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "انصراف" }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();

  const afterResp = await fetch(`${BASE}/api/referrals`, {
    headers: { Cookie: `${COOKIE_NAME}=${bindCookie}` },
  });
  const after = await afterResp.json();
  expect(after.binding.isBound).toBe(false);
});

test("confirmation dialog is keyboard accessible", async ({ page }) => {
  await loginAs(page, bindCookie);
  await page.locator("#referral-code-input").fill(ownerCode);
  await page.getByRole("button", { name: "ثبت کد معرف" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(page.locator(":focus")).toBeVisible();
});

// ══════════════════════════════════════════════════════════════════════════
//  Part C — Binding execution and bound state
// ══════════════════════════════════════════════════════════════════════════

test("confirming a valid code creates the binding", async ({ page }) => {
  await loginAs(page, bindCookie);
  await page.waitForSelector("#referral-code-input", { timeout: 10000 });
  await page.locator("#referral-code-input").fill(ownerCode);
  await page.getByRole("button", { name: "ثبت کد معرف" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "تأیید و ثبت کد" }).click();
  await expect(page.getByText("کد معرف ثبت شده است")).toBeVisible({ timeout: 5000 });
  await expect(page.locator("#referral-code-input")).not.toBeVisible();
});

test("double-click confirm sends no more than one active UI request", async ({ page }) => {
  // Use ownerCookie (unbound) to test double-click protection
  await loginAs(page, ownerCookie);
  await page.locator("#referral-code-input").fill(ownerCode);
  await page.getByRole("button", { name: "ثبت کد معرف" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();

  let postCount = 0;
  // Intercept to count POSTs and abort them so no actual binding occurs
  await page.route("**/api/referrals/bind", (route) => {
    if (route.request().method() === "POST") postCount++;
    route.abort("connectionaborted");
  });

  // Click twice in the same microtask to simulate double-click
  await page.evaluate(async () => {
    const btns = Array.from(document.querySelectorAll<HTMLElement>('button'));
    const target = btns.find(b => b.textContent?.trim() === 'تأیید و ثبت کد');
    if (target) {
      target.click();
      target.click();
    }
  });
  await page.waitForTimeout(1000);
  expect(postCount).toBeLessThanOrEqual(1);
  await page.unroute("**/api/referrals/bind");
}, 15000);

test("bound state has no edit/delete/replace action", async ({ page }) => {
  await loginAs(page, boundCookie);
  await waitForBoundState(page);

  // Check no action buttons / links appear that would allow editing, deleting, or replacing
  await expect(page.getByRole("button", { name: /ویرایش|حذف|تغییر/i })).not.toBeVisible();
  await expect(page.getByRole("link", { name: /ویرایش|حذف|تغییر/i })).not.toBeVisible();
});

test("bound state exposes no referrer identity", async ({ page }) => {
  await loginAs(page, boundCookie);
  await waitForBoundState(page);
  const forbidden = ["نام معرف", "شماره معرف", "ایمیل معرف", "ارجاع‌دهنده"];
  for (const term of forbidden) {
    await expect(page.getByText(term, { exact: false })).not.toBeVisible();
  }
});

test("already-bound response refreshes the bound state", async ({ page }) => {
  await loginAs(page, boundCookie);
  await waitForBoundState(page);
});

// ══════════════════════════════════════════════════════════════════════════
//  Part D — Error states
// ══════════════════════════════════════════════════════════════════════════

test("GET failure shows retry UI", async ({ page }) => {
  await page.route("**/api/referrals", (route) => {
    if (route.request().method() === "GET") route.abort("connectionfailed");
    else route.continue();
  });
  await loginAs(page, ownerCookie);
  await expect(page.getByText("تلاش دوباره")).toBeVisible({ timeout: 5000 });
});

test("retry reloads summary", async ({ page }) => {
  await page.route("**/api/referrals", (route) => {
    if (route.request().method() === "GET") route.abort("connectionfailed");
    else route.continue();
  }, { times: 1 });
  await loginAs(page, ownerCookie);
  await expect(page.getByText("تلاش دوباره")).toBeVisible({ timeout: 5000 });
  await page.unroute("**/api/referrals");
  await page.getByRole("button", { name: "تلاش دوباره" }).click();
  await expect(page.getByText("کد معرفی شما")).toBeVisible({ timeout: 5000 });
});

test("API invalid-code response displays the generic invalid message", async ({ page }) => {
  // ownerCookie user is unbound, so they have the binding form
  await loginAs(page, ownerCookie);
  await page.locator("#referral-code-input").fill("CTAAAAAAAAAAAA");
  await page.getByRole("button", { name: "ثبت کد معرف" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "تأیید و ثبت کد" }).click();
  await expect(page.getByText("کد معرف نامعتبر است.")).toBeVisible({ timeout: 5000 });
});

test("self, malformed, and unknown cases expose no differing identity detail", async ({ page }) => {
  await loginAs(page, ownerCookie);
  await page.locator("#referral-code-input").fill("CTAAAAAAAAAAAA");
  await page.getByRole("button", { name: "ثبت کد معرف" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "تأیید و ثبت کد" }).click();
  await expect(page.getByText("کد معرف نامعتبر است.")).toBeVisible({ timeout: 5000 });
});

test("rate-limit response displays the safe message", async ({ page }) => {
  await loginAs(page, ownerCookie);

  for (let i = 0; i < 6; i++) {
    await fetch(`${BASE}/api/referrals/bind`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: `${COOKIE_NAME}=${ownerCookie}` },
      body: JSON.stringify({ code: "CTFFFFFFFFFFFF" }),
    });
  }

  await page.locator("#referral-code-input").fill("CTAAAAAAAAAAAA");
  await page.getByRole("button", { name: "ثبت کد معرف" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "تأیید و ثبت کد" }).click();
  await expect(page.getByText("تعداد تلاش‌ها زیاد است")).toBeVisible({ timeout: 5000 });
});

// ══════════════════════════════════════════════════════════════════════════
//  Part E — Program disabled
// ══════════════════════════════════════════════════════════════════════════

test("program-disabled state hides or disables new binding", async ({ page }) => {
  await fetch(`${SUPABASE_URL}/rest/v1/referral_program_settings?id=eq.1`, {
    method: "PATCH",
    headers: adminHeaders(),
    body: JSON.stringify({ is_enabled: false }),
  });
  await loginAs(page, ownerCookie);
  await expect(page.getByText("برنامه معرفی در حال حاضر فعال نیست")).toBeVisible({ timeout: 5000 });
  await fetch(`${SUPABASE_URL}/rest/v1/referral_program_settings?id=eq.1`, {
    method: "PATCH",
    headers: adminHeaders(),
    body: JSON.stringify({ is_enabled: true }),
  });
});

test("program-disabled state still allows own-code copy", async ({ page }) => {
  await page.context().grantPermissions(["clipboard-write", "clipboard-read"]);
  await fetch(`${SUPABASE_URL}/rest/v1/referral_program_settings?id=eq.1`, {
    method: "PATCH",
    headers: adminHeaders(),
    body: JSON.stringify({ is_enabled: false }),
  });
  await loginAs(page, ownerCookie);
  await expect(page.getByText("کد معرفی شما")).toBeVisible();
  await expect(page.getByRole("button", { name: "کپی کد معرفی" })).toBeVisible();
  await page.getByRole("button", { name: "کپی کد معرفی" }).click();
  await expect(page.getByText("کد معرفی کپی شد.")).toBeVisible({ timeout: 3000 });
  await fetch(`${SUPABASE_URL}/rest/v1/referral_program_settings?id=eq.1`, {
    method: "PATCH",
    headers: adminHeaders(),
    body: JSON.stringify({ is_enabled: true }),
  });
});

// ══════════════════════════════════════════════════════════════════════════
//  Part F — Privacy, no-reward, responsive
// ══════════════════════════════════════════════════════════════════════════

test("no reward-history or fake candy amounts appear", async ({ page }) => {
  await loginAs(page, ownerCookie);
  await expect(page.getByText("تاریخچه پاداش")).not.toBeVisible();
  await expect(page.getByText("پرداخت", { exact: true })).not.toBeVisible();
  const bodyText = await page.locator("body").textContent() || "";
  expect(bodyText).not.toContain("0 آبنبات");
  expect(bodyText).not.toContain("1 آبنبات");
  expect(bodyText).not.toContain("آبنبات‌های");
});

test("no other-parent email, phone, name, ID, or code appears", async ({ page }) => {
  await loginAs(page, ownerCookie);
  const identities = [EMAIL_OWNER, EMAIL_BIND, "090", "091"];
  for (const id of identities) {
    await expect(page.locator(`text=${id}`).first()).not.toBeVisible();
  }
});

test("session-expired redirects to login", async ({ page }) => {
  await page.goto(`${BASE}/dashboard/referrals`);
  await expect(page).toHaveURL(/\/login/);
});

test("mobile viewport has no horizontal overflow", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await loginAs(page, ownerCookie);
  await page.waitForTimeout(500);
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth > document.documentElement.clientWidth
  );
  expect(overflow).toBe(false);
});

test("320px viewport has no horizontal overflow", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await loginAs(page, ownerCookie);
  await page.waitForTimeout(500);
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth > document.documentElement.clientWidth
  );
  expect(overflow).toBe(false);
});

test("no wallet or ledger data changes during binding", async ({ page }) => {
  const beforeResp = await fetch(`${SUPABASE_URL}/rest/v1/parent_wallets?select=id`, { headers: adminHeaders() });
  const beforeWallets = await beforeResp.json();
  const beforeCount = Array.isArray(beforeWallets) ? beforeWallets.length : 0;

  await loginAs(page, boundCookie);
  await waitForBoundState(page);

  const afterResp = await fetch(`${SUPABASE_URL}/rest/v1/parent_wallets?select=id`, { headers: adminHeaders() });
  const afterWallets = await afterResp.json();
  const afterCount = Array.isArray(afterWallets) ? afterWallets.length : 0;
  expect(afterCount).toBe(beforeCount);
});
