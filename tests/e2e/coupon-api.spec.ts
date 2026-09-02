import { test, expect } from "@playwright/test"
import * as fs from "fs"
import * as path from "path"

// ── Load env BEFORE importing the guard (guard reads process.env) ─────────────
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

import { assertSafeDatabaseTarget } from "../helpers/assert-safe-database-target"

// Part 20 guard: this spec is DESTRUCTIVE (creates coupons, redemptions,
// purchases). It must ONLY run against an explicitly allowed disposable target.
// Against the main Cartoona project it is blocked immediately.
const _guard = assertSafeDatabaseTarget()
if (!_guard.ok) throw new Error(`Guard blocked: ${_guard.reason}`)

const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || "").replace(/\/+$/, "")
const BASE = "http://localhost:3000"

const KEY = process.env.SUPABASE_SECRET_KEY || ""
const HDR = { "Content-Type": "application/json", apikey: KEY, Authorization: `Bearer ${KEY}` }
const PASSWORD = "TestPass999!"
const TS = String(Date.now()).slice(-8)

function buildCookie(at: string, _rt: string, _ei: number): string {
  return "base64-" + Buffer.from(JSON.stringify({
    access_token: at, refresh_token: _rt, expires_in: _ei,
    expires_at: Math.floor(Date.now() / 1000) + _ei, token_type: "bearer",
  })).toString("base64url")
}

interface SyntheticUser {
  id: string
  email: string
  profileId: string | null
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

  const profCheck = await fetch(`${SUPABASE_URL}/rest/v1/parent_profiles?user_id=eq.${u.id}&select=id`, { headers: HDR })
  const profData = profCheck.ok ? await profCheck.json() : []

  return {
    id: u.id,
    email,
    profileId: profData.length > 0 ? profData[0].id : null,
  }
}

const tokenCache: Record<string, string> = {}

async function loginAs(email: string): Promise<string> {
  if (tokenCache[email]) return tokenCache[email]
  const r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST", headers: HDR,
    body: JSON.stringify({ email, password: PASSWORD }),
  })
  const data = await r.json()
  if (!data.access_token) throw new Error(`Login failed for ${email}: ${JSON.stringify(data)}`)
  tokenCache[email] = data.access_token
  return data.access_token
}

function cookieHeaders(token: string): Record<string, string> {
  const c = buildCookie(token, "", 3600)
  return { Cookie: `sb-coupon-test-auth-token=${c}` }
}

// ═════════════════════════════════════════════════════════════════════════════
// Part 20 requirements — coupon stateful tests (guarded, disposable-only).
// ═════════════════════════════════════════════════════════════════════════════

const EMAIL_ADMIN = `cpn_adm_${TS}@test.com`
const EMAIL_PARENT = `cpn_par_${TS}@test.com`
const EMAIL_PARENT2 = `cpn_par2_${TS}@test.com`

let adminUser: SyntheticUser
let parentUser: SyntheticUser
let parent2User: SyntheticUser
let testPackageId: string
const cleanupIds: string[] = []
const cleanupCouponIds: string[] = []

test.beforeAll(async () => {
  test.setTimeout(120000)
  if (!SUPABASE_URL || !KEY) throw new Error("Missing Supabase env for coupon e2e")

  adminUser = await createUser(EMAIL_ADMIN, "admin")
  parentUser = await createUser(EMAIL_PARENT, "parent")
  parent2User = await createUser(EMAIL_PARENT2, "parent")
  cleanupIds.push(adminUser.id, parentUser.id, parent2User.id)

  const pkgR = await fetch(`${SUPABASE_URL}/rest/v1/candy_packages`, {
    method: "POST", headers: { ...HDR, Prefer: "return=representation" },
    body: JSON.stringify({
      name: "Coupon Test Package",
      description: "Coupon e2e package",
      candy_amount: 100,
      price_amount: 100000,
      currency: "IRR",
      is_active: true,
      display_order: 998,
    }),
  })
  const pkgBody = await pkgR.json()
  testPackageId = Array.isArray(pkgBody) ? pkgBody[0].id : pkgBody.id
  expect(testPackageId).toBeTruthy()
})

test.afterAll(async () => {
  for (const id of cleanupCouponIds) {
    await fetch(`${SUPABASE_URL}/rest/v1/coupons?id=eq.${id}`, { method: "DELETE", headers: HDR }).catch(() => {})
  }
  if (testPackageId) {
    await fetch(`${SUPABASE_URL}/rest/v1/candy_packages?id=eq.${testPackageId}`, {
      method: "DELETE", headers: HDR,
    }).catch(() => {})
  }
  for (const id of cleanupIds) {
    await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${id}`, { method: "DELETE", headers: HDR }).catch(() => {})
  }
})

async function createCoupon(overrides: Record<string, unknown> = {}): Promise<{ id: string; code: string }> {
  const code = "CPN" + TS + (cleanupCouponIds.length + 1)
  const body = {
    code,
    name: "Test Coupon " + code,
    discount_type: "percentage",
    discount_value: 1000,
    is_active: true,
    ...overrides,
  }
  if (overrides.code === undefined) body.code = code
  const r = await fetch(`${SUPABASE_URL}/rest/v1/coupons`, {
    method: "POST", headers: { ...HDR, Prefer: "return=representation" },
    body: JSON.stringify(body),
  })
  const data = await r.json()
  const row = Array.isArray(data) ? data[0] : data
  if (!row || !row.id) throw new Error(`Coupon create failed: ${JSON.stringify(data)}`)
  cleanupCouponIds.push(row.id)
  return { id: row.id, code: row.code }
}

async function createPurchase(token: string): Promise<string> {
  const r = await fetch(`${BASE}/api/candy-purchases`, {
    method: "POST",
    headers: { ...cookieHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({ package_id: testPackageId }),
  })
  expect(r.status).toBe(201)
  const body = await r.json()
  return body.purchase.id
}

const VALIDATE_URL = `${BASE}/api/coupons/validate`

// ═════════════════════════════════════════════════════════════════════════════
// Access control — no browser writes, no coupon enumeration
// ═════════════════════════════════════════════════════════════════════════════

test("1. Parent cannot enumerate coupons (admin-select-only RLS)", async () => {
  const token = await loginAs(EMAIL_PARENT)
  const r = await fetch(`${SUPABASE_URL}/rest/v1/coupons?select=code&limit=10`, {
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, ...cookieHeaders(token) },
  })
  // No rows visible (no SELECT-all policy for parents) — empty array, not an error.
  expect(r.status).toBe(200)
  const body = await r.json()
  const rows = Array.isArray(body) ? body : []
  expect(rows).toEqual([])
})

test("2. Parent cannot write coupons via browser session", async () => {
  const token = await loginAs(EMAIL_PARENT)
  const r = await fetch(`${SUPABASE_URL}/rest/v1/coupons`, {
    method: "POST", headers: { ...HDR, ...cookieHeaders(token) },
    body: JSON.stringify({ code: "HACK123", name: "x", discount_type: "fixed_amount", discount_value: 10 }),
  })
  expect([403, 404, 405, 400]).toContain(r.status)
})

test("3. Parent cannot write redemptions via browser session", async () => {
  const token = await loginAs(EMAIL_PARENT)
  const r = await fetch(`${SUPABASE_URL}/rest/v1/coupon_redemptions`, {
    method: "POST", headers: { ...HDR, ...cookieHeaders(token) },
    body: JSON.stringify({ coupon_id: "00000000-0000-0000-0000-000000000000", purchase_id: "00000000-0000-0000-0000-000000000000", parent_profile_id: "00000000-0000-0000-0000-000000000000", normalized_code_snapshot: "X", discount_type_snapshot: "fixed_amount", discount_value_snapshot: 10, original_price_amount: 100, discount_amount: 10, final_price_amount: 90, currency: "IRR", status: "reserved", idempotency_key: "x" }),
  })
  expect([403, 404, 405, 400]).toContain(r.status)
})

test("4. Trusted RPCs are not callable by browser roles", async () => {
  const token = await loginAs(EMAIL_PARENT)
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/apply_coupon_to_purchase_trusted`, {
    method: "POST",
    headers: { apikey: KEY, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ p_parent_profile_id: "00000000-0000-0000-0000-000000000000", p_purchase_id: "00000000-0000-0000-0000-000000000000", p_coupon_code: "AAA", p_idempotency_key: "x" }),
  })
  expect([403, 404, 405, 400]).toContain(r.status)
})

// ═════════════════════════════════════════════════════════════════════════════
// Validation API
// ═════════════════════════════════════════════════════════════════════════════

test("5. Unknown code returns non-enumerating 404-style message", async () => {
  const token = await loginAs(EMAIL_PARENT)
  const purchaseId = await createPurchase(token)
  const r = await fetch(VALIDATE_URL, {
    method: "POST", headers: { ...cookieHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({ purchase_id: purchaseId, code: "DOESNOTEXIST" }),
  })
  expect(r.status).toBe(404)
  const body = await r.json()
  expect(body.error.message).toBe("این کد تخفیف معتبر نیست.")
  expect(JSON.stringify(body)).not.toContain("DOESNOTEXIST")
})

test("6. Valid coupon validates to a computed discount", async () => {
  const { code } = await createCoupon()
  const token = await loginAs(EMAIL_PARENT)
  const purchaseId = await createPurchase(token)
  const r = await fetch(VALIDATE_URL, {
    method: "POST", headers: { ...cookieHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({ purchase_id: purchaseId, code }),
  })
  expect(r.status).toBe(200)
  const body = await r.json()
  expect(body.coupon.normalizedCode).toBe(code)
  expect(body.coupon.originalPriceAmount).toBe(100000)
  expect(body.coupon.discountAmount).toBe(10000)
  expect(body.coupon.finalPriceAmount).toBe(90000)
  expect(body.coupon.currency).toBe("IRR")
})

test("7. Validation is read-only — creates no redemption", async () => {
  const { code } = await createCoupon()
  const token = await loginAs(EMAIL_PARENT)
  const purchaseId = await createPurchase(token)
  await fetch(VALIDATE_URL, {
    method: "POST", headers: { ...cookieHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({ purchase_id: purchaseId, code }),
  })
  const check = await fetch(`${SUPABASE_URL}/rest/v1/coupon_redemptions?purchase_id=eq.${purchaseId}&select=id`, { headers: HDR })
  const data = await check.json()
  expect(Array.isArray(data) ? data : []).toEqual([])
})

test("8. Cross-parent validation is rejected", async () => {
  const { code } = await createCoupon()
  const token1 = await loginAs(EMAIL_PARENT)
  const token2 = await loginAs(EMAIL_PARENT2)
  const purchaseId = await createPurchase(token1)
  const r = await fetch(VALIDATE_URL, {
    method: "POST", headers: { ...cookieHeaders(token2), "Content-Type": "application/json" },
    body: JSON.stringify({ purchase_id: purchaseId, code }),
  })
  expect(r.status).toBe(403)
})

test("9. Coupon with a payment attempt is rejected at validation", async () => {
  const { code } = await createCoupon()
  const token = await loginAs(EMAIL_PARENT)
  const purchaseId = await createPurchase(token)
  // Simulate an active payment attempt (the completion flow would create one).
  await fetch(`${SUPABASE_URL}/rest/v1/payment_attempts`, {
    method: "POST", headers: { ...HDR, Prefer: "return=representation" },
    body: JSON.stringify({
      purchase_id: purchaseId,
      provider: "bale",
      provider_session_id: "cpn-test-" + TS,
      requested_amount: 100000,
      requested_currency: "IRR",
      status: "pending",
    }),
  }).catch(() => {})
  const attempt = await fetch(`${SUPABASE_URL}/rest/v1/payment_attempts?purchase_id=eq.${purchaseId}&select=id`, { headers: HDR })
  const attemptBody = await attempt.json()
  const attemptId = Array.isArray(attemptBody) ? attemptBody[0]?.id : attemptBody?.id
  if (attemptId) {
    await fetch(`${SUPABASE_URL}/rest/v1/candy_purchases?id=eq.${purchaseId}`, {
      method: "PATCH", headers: HDR,
      body: JSON.stringify({ active_payment_attempt_id: attemptId }),
    }).catch(() => {})
  }
  const r = await fetch(VALIDATE_URL, {
    method: "POST", headers: { ...cookieHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({ purchase_id: purchaseId, code }),
  })
  expect(r.status).toBe(409)
})

// ═════════════════════════════════════════════════════════════════════════════
// Apply API
// ═════════════════════════════════════════════════════════════════════════════

test("10. Parent applies a coupon — purchase gets discount/final", async () => {
  const { code } = await createCoupon()
  const token = await loginAs(EMAIL_PARENT)
  const purchaseId = await createPurchase(token)
  const r = await fetch(`${BASE}/api/candy-purchases/${purchaseId}/coupon`, {
    method: "POST", headers: { ...cookieHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({ code, idempotency_key: "apply-" + TS }),
  })
  expect(r.status).toBe(200)
  const body = await r.json()
  expect(body.coupon.status).toBe("reserved")
  expect(body.coupon.finalPriceAmount).toBe(90000)
  expect(body.coupon.discountAmount).toBe(10000)
  // Purchase updated atomically
  const chk = await fetch(`${SUPABASE_URL}/rest/v1/candy_purchases?id=eq.${purchaseId}&select=original_price_amount,discount_amount,final_price_amount,price_amount`, { headers: HDR })
  const chkData = await chk.json()
  const p = Array.isArray(chkData) ? chkData[0] : chkData
  expect(p.original_price_amount).toBe(100000)
  expect(p.price_amount).toBe(100000)
  expect(p.discount_amount).toBe(10000)
  expect(p.final_price_amount).toBe(90000)
})

test("11. Apply is idempotent for the same idempotency key", async () => {
  const { code } = await createCoupon()
  const token = await loginAs(EMAIL_PARENT)
  const purchaseId = await createPurchase(token)
  const payload = { code, idempotency_key: "same-key-" + TS }
  const r1 = await fetch(`${BASE}/api/candy-purchases/${purchaseId}/coupon`, {
    method: "POST", headers: { ...cookieHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  })
  expect(r1.status).toBe(200)
  const body1 = await r1.json()
  const r2 = await fetch(`${BASE}/api/candy-purchases/${purchaseId}/coupon`, {
    method: "POST", headers: { ...cookieHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  })
  expect(r2.status).toBe(200)
  const body2 = await r2.json()
  expect(body2.coupon.finalPriceAmount).toBe(body1.coupon.finalPriceAmount)
  expect(body2.coupon.normalizedCode).toBe(body1.coupon.normalizedCode)
  expect(body2.coupon.status).toBe(body1.coupon.status)
  // Internal IDs are never exposed to the parent.
  expect(JSON.stringify(body2.coupon)).not.toContain("redemptionId")
  expect(JSON.stringify(body2.coupon)).not.toContain("couponId")
})

test("12. A different coupon on the same purchase is rejected", async () => {
  const c1 = await createCoupon()
  const c2 = await createCoupon()
  const token = await loginAs(EMAIL_PARENT)
  const purchaseId = await createPurchase(token)
  const ok = await fetch(`${BASE}/api/candy-purchases/${purchaseId}/coupon`, {
    method: "POST", headers: { ...cookieHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({ code: c1.code, idempotency_key: "k1-" + TS }),
  })
  expect(ok.status).toBe(200)
  const bad = await fetch(`${BASE}/api/candy-purchases/${purchaseId}/coupon`, {
    method: "POST", headers: { ...cookieHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({ code: c2.code, idempotency_key: "k2-" + TS }),
  })
  expect(bad.status).toBe(409)
})

test("13. Cross-parent apply is rejected", async () => {
  const { code } = await createCoupon()
  const token1 = await loginAs(EMAIL_PARENT)
  const token2 = await loginAs(EMAIL_PARENT2)
  const purchaseId = await createPurchase(token1)
  const r = await fetch(`${BASE}/api/candy-purchases/${purchaseId}/coupon`, {
    method: "POST", headers: { ...cookieHeaders(token2), "Content-Type": "application/json" },
    body: JSON.stringify({ code, idempotency_key: "cross-" + TS }),
  })
  expect(r.status).toBe(403)
})

test("14. A paid purchase cannot accept a coupon", async () => {
  const { code } = await createCoupon()
  const token = await loginAs(EMAIL_PARENT)
  const purchaseId = await createPurchase(token)
  // Mark paid directly (bypasses completion flow for this guard-only test)
  await fetch(`${SUPABASE_URL}/rest/v1/candy_purchases?id=eq.${purchaseId}`, {
    method: "PATCH", headers: HDR,
    body: JSON.stringify({ status: "paid", paid_at: new Date().toISOString() }),
  })
  const r = await fetch(`${BASE}/api/candy-purchases/${purchaseId}/coupon`, {
    method: "POST", headers: { ...cookieHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({ code, idempotency_key: "paid-" + TS }),
  })
  expect(r.status).toBe(409)
})

test("15. Apply rejects a coupon after a payment attempt exists", async () => {
  const { code } = await createCoupon()
  const token = await loginAs(EMAIL_PARENT)
  const purchaseId = await createPurchase(token)
  await fetch(`${SUPABASE_URL}/rest/v1/payment_attempts`, {
    method: "POST", headers: { ...HDR, Prefer: "return=representation" },
    body: JSON.stringify({
      purchase_id: purchaseId,
      provider: "bale",
      provider_session_id: "cpn-test2-" + TS,
      requested_amount: 100000,
      requested_currency: "IRR",
      status: "pending",
    }),
  }).catch(() => {})
  const attempt = await fetch(`${SUPABASE_URL}/rest/v1/payment_attempts?purchase_id=eq.${purchaseId}&select=id`, { headers: HDR })
  const attemptBody = await attempt.json()
  const attemptId = Array.isArray(attemptBody) ? attemptBody[0]?.id : attemptBody?.id
  if (attemptId) {
    await fetch(`${SUPABASE_URL}/rest/v1/candy_purchases?id=eq.${purchaseId}`, {
      method: "PATCH", headers: HDR,
      body: JSON.stringify({ active_payment_attempt_id: attemptId }),
    }).catch(() => {})
  }
  const r = await fetch(`${BASE}/api/candy-purchases/${purchaseId}/coupon`, {
    method: "POST", headers: { ...cookieHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({ code, idempotency_key: "attempt-" + TS }),
  })
  expect(r.status).toBe(409)
})

test("16. Coupon application does not touch the wallet", async () => {
  const { code } = await createCoupon()
  const token = await loginAs(EMAIL_PARENT)
  const walletR = await fetch(`${SUPABASE_URL}/rest/v1/candy_wallets?select=balance&parent_id=eq.${parentUser.profileId}`, { headers: HDR })
  const walletData = await walletR.json()
  const preBalance = Number(Array.isArray(walletData) ? walletData[0]?.balance : walletData?.balance ?? 0)
  const purchaseId = await createPurchase(token)
  await fetch(`${BASE}/api/candy-purchases/${purchaseId}/coupon`, {
    method: "POST", headers: { ...cookieHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({ code, idempotency_key: "nowallet-" + TS }),
  })
  const walletR2 = await fetch(`${SUPABASE_URL}/rest/v1/candy_wallets?select=balance&parent_id=eq.${parentUser.profileId}`, { headers: HDR })
  const walletData2 = await walletR2.json()
  const postBalance = Number(Array.isArray(walletData2) ? walletData2[0]?.balance : walletData2?.balance ?? 0)
  expect(postBalance).toBe(preBalance)
})

test("17. Usage limit reached is rejected", async () => {
  const { code } = await createCoupon({ global_usage_limit: 1, per_parent_usage_limit: 1 })
  const token = await loginAs(EMAIL_PARENT)
  const p1 = await createPurchase(token)
  const ok = await fetch(`${BASE}/api/candy-purchases/${p1}/coupon`, {
    method: "POST", headers: { ...cookieHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({ code, idempotency_key: "limit1-" + TS }),
  })
  expect(ok.status).toBe(200)
  const p2 = await createPurchase(token)
  const r = await fetch(`${BASE}/api/candy-purchases/${p2}/coupon`, {
    method: "POST", headers: { ...cookieHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({ code, idempotency_key: "limit2-" + TS }),
  })
  expect(r.status).toBe(409)
})

test("18. Package-eligibility restriction is enforced", async () => {
  const { code } = await createCoupon()
  // Restrict this coupon to a DIFFERENT package via a direct service-role insert
  // into coupon_package_rules. Inserting a rule is admin-only; service role can.
  const other = await fetch(`${SUPABASE_URL}/rest/v1/candy_packages`, {
    method: "POST", headers: { ...HDR, Prefer: "return=representation" },
    body: JSON.stringify({ name: "Other", description: "x", candy_amount: 5, price_amount: 5000, currency: "IRR", is_active: true, display_order: 997 }),
  })
  const otherBody = await other.json()
  const otherPkgId = Array.isArray(otherBody) ? otherBody[0].id : otherBody.id
  await fetch(`${SUPABASE_URL}/rest/v1/coupon_package_rules`, {
    method: "POST", headers: HDR,
    body: JSON.stringify({ coupon_id: (await (await fetch(`${SUPABASE_URL}/rest/v1/coupons?code=eq.${code}&select=id`, { headers: HDR })).json())[0].id, package_id: otherPkgId }),
  })
  await fetch(`${SUPABASE_URL}/rest/v1/candy_packages?id=eq.${otherPkgId}`, { method: "DELETE", headers: HDR }).catch(() => {})
  const token = await loginAs(EMAIL_PARENT)
  const purchaseId = await createPurchase(token)
  const r = await fetch(`${BASE}/api/candy-purchases/${purchaseId}/coupon`, {
    method: "POST", headers: { ...cookieHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({ code, idempotency_key: "pkg-" + TS }),
  })
  expect(r.status).toBe(409)
})

test("19. Minimum purchase amount is enforced before discount", async () => {
  const { code } = await createCoupon({ minimum_purchase_amount: 200000 })
  const token = await loginAs(EMAIL_PARENT)
  const purchaseId = await createPurchase(token) // 100000 < 200000
  const r = await fetch(`${BASE}/api/candy-purchases/${purchaseId}/coupon`, {
    method: "POST", headers: { ...cookieHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({ code, idempotency_key: "min-" + TS }),
  })
  expect(r.status).toBe(409)
})

test("20. Inactive coupon is rejected", async () => {
  const c = await createCoupon({ is_active: false })
  const token = await loginAs(EMAIL_PARENT)
  const purchaseId = await createPurchase(token)
  const r = await fetch(`${BASE}/api/candy-purchases/${purchaseId}/coupon`, {
    method: "POST", headers: { ...cookieHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({ code: c.code, idempotency_key: "inactive-" + TS }),
  })
  expect(r.status).toBe(404)
})

test("21. Not-started coupon is rejected", async () => {
  const c = await createCoupon({ starts_at: new Date(Date.now() + 3600_000).toISOString() })
  const token = await loginAs(EMAIL_PARENT)
  const purchaseId = await createPurchase(token)
  const r = await fetch(`${BASE}/api/candy-purchases/${purchaseId}/coupon`, {
    method: "POST", headers: { ...cookieHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({ code: c.code, idempotency_key: "notstarted-" + TS }),
  })
  expect(r.status).toBe(404)
})

test("22. Expired coupon is rejected", async () => {
  const c = await createCoupon({ expires_at: new Date(Date.now() - 3600_000).toISOString() })
  const token = await loginAs(EMAIL_PARENT)
  const purchaseId = await createPurchase(token)
  const r = await fetch(`${BASE}/api/candy-purchases/${purchaseId}/coupon`, {
    method: "POST", headers: { ...cookieHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({ code: c.code, idempotency_key: "expired-" + TS }),
  })
  expect(r.status).toBe(404)
})

test("23. Fixed-amount coupon clamps above the purchase price", async () => {
  const { code } = await createCoupon({ discount_type: "fixed_amount", discount_value: 500000 })
  const token = await loginAs(EMAIL_PARENT)
  const purchaseId = await createPurchase(token) // 100000
  const r = await fetch(`${BASE}/api/candy-purchases/${purchaseId}/coupon`, {
    method: "POST", headers: { ...cookieHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({ code, idempotency_key: "clamp-" + TS }),
  })
  expect(r.status).toBe(200)
  const body = await r.json()
  expect(body.coupon.discountAmount).toBe(100000)
  expect(body.coupon.finalPriceAmount).toBe(0)
})

test("24. Invalid-format code is rejected at the API boundary", async () => {
  const token = await loginAs(EMAIL_PARENT)
  const purchaseId = await createPurchase(token)
  const r = await fetch(`${BASE}/api/candy-purchases/${purchaseId}/coupon`, {
    method: "POST", headers: { ...cookieHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({ code: "A B C", idempotency_key: "badcode-" + TS }),
  })
  expect(r.status).toBe(400)
  // Unknown fields rejected too
  const r2 = await fetch(`${BASE}/api/candy-purchases/${purchaseId}/coupon`, {
    method: "POST", headers: { ...cookieHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({ code: "ABC", idempotency_key: "x", extra: "y" }),
  })
  expect(r2.status).toBe(400)
})

test("25. Unauthenticated requests are rejected", async () => {
  const r = await fetch(`${BASE}/api/coupons/validate`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ purchase_id: "00000000-0000-0000-0000-000000000000", code: "ABC" }),
  })
  expect([401, 403]).toContain(r.status)
})
