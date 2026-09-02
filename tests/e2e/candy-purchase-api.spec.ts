import { test, expect } from "@playwright/test"
import * as fs from "fs"
import * as path from "path"

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

import { assertSafeDatabaseTarget } from "../helpers/assert-safe-database-target"

const _guard = assertSafeDatabaseTarget()
if (!_guard.ok) throw new Error(`Guard blocked: ${_guard.reason}`)

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

const EMAIL_ADMIN = `candy_adm_${TS}@test.com`
const EMAIL_PARENT = `candy_par_${TS}@test.com`
const EMAIL_PARENT2 = `candy_par2_${TS}@test.com`

let adminUser: SyntheticUser
let parentUser: SyntheticUser
let parent2User: SyntheticUser
let testPackageId: string
const cleanupIds: string[] = []

test.beforeAll(async () => {
  test.setTimeout(120000)

  adminUser = await createUser(EMAIL_ADMIN, "admin")
  parentUser = await createUser(EMAIL_PARENT, "parent")
  parent2User = await createUser(EMAIL_PARENT2, "parent")

  cleanupIds.push(adminUser.id, parentUser.id, parent2User.id)

  // Create a dedicated test candy package (not relying on seeded data)
  const pkgR = await fetch(`${SUPABASE_URL}/rest/v1/candy_packages`, {
    method: "POST", headers: { ...HDR, Prefer: "return=representation" },
    body: JSON.stringify({
      name: "Test Package",
      description: "E2E test package",
      candy_amount: 50,
      price_amount: 25000,
      currency: "IRR",
      is_active: true,
      display_order: 999,
    }),
  })
  const pkgBody = await pkgR.json()
  testPackageId = Array.isArray(pkgBody) ? pkgBody[0].id : pkgBody.id
  expect(testPackageId).toBeTruthy()
})

test.afterAll(async () => {
  // Clean up test package
  if (testPackageId) {
    await fetch(`${SUPABASE_URL}/rest/v1/candy_packages?id=eq.${testPackageId}`, {
      method: "DELETE", headers: HDR,
    }).catch(() => {})
  }
  // Clean up synthetic users
  for (const id of cleanupIds) {
    await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${id}`, { method: "DELETE", headers: HDR }).catch(() => {})
  }
})

// ═════════════════════════════════════════════════════════════════════════════
// 1. Active package visible
// ═════════════════════════════════════════════════════════════════════════════

test("1. Active package is visible to authenticated parent", async () => {
  const { access_token } = await loginAs(EMAIL_PARENT)
  const r = await fetch(`${SUPABASE_URL}/rest/v1/candy_packages?id=eq.${testPackageId}`, {
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, ...cookieHeaders(access_token) },
  })
  expect(r.status).toBe(200)
  const body = await r.json()
  const pkg = Array.isArray(body) ? body.find((p: Record<string, unknown>) => p.id === testPackageId) : body
  expect(pkg).toBeTruthy()
  expect(pkg.name).toBe("Test Package")
  expect(pkg.is_active).toBe(true)
})

// ═════════════════════════════════════════════════════════════════════════════
// 2. Inactive package hidden
// ═════════════════════════════════════════════════════════════════════════════

test("2. Inactive package is hidden from authenticated parent", async () => {
  // Temporarily set package to inactive
  await fetch(`${SUPABASE_URL}/rest/v1/candy_packages?id=eq.${testPackageId}`, {
    method: "PATCH", headers: HDR,
    body: JSON.stringify({ is_active: false }),
  })

  const { access_token } = await loginAs(EMAIL_PARENT)
  const r = await fetch(`${SUPABASE_URL}/rest/v1/candy_packages?id=eq.${testPackageId}`, {
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, ...cookieHeaders(access_token) },
  })

  // The RLS policy filters out inactive packages — response should be empty array
  const body = await r.json()
  const results = Array.isArray(body) ? body : []
  const found = results.find((p: Record<string, unknown>) => p.id === testPackageId)
  expect(found).toBeFalsy()

  // Reactivate
  await fetch(`${SUPABASE_URL}/rest/v1/candy_packages?id=eq.${testPackageId}`, {
    method: "PATCH", headers: HDR,
    body: JSON.stringify({ is_active: true }),
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 3. Parent creates purchase
// ═════════════════════════════════════════════════════════════════════════════

let pendingPurchaseId: string

test("3. Parent can create a pending purchase", async () => {
  const { access_token } = await loginAs(EMAIL_PARENT)
  const r = await fetch(`${BASE}/api/candy-purchases`, {
    method: "POST",
    headers: { ...cookieHeaders(access_token), "Content-Type": "application/json" },
    body: JSON.stringify({ package_id: testPackageId }),
  })
  expect(r.status).toBe(201)
  const body = await r.json()
  expect(body).toHaveProperty("purchase")
  expect(body.purchase).toHaveProperty("id")
  expect(body.purchase.candy_amount).toBe(50)
  expect(body.purchase.price_amount).toBe(25000)
  expect(body.purchase.currency).toBe("IRR")
  expect(body.purchase.status).toBe("pending")
  pendingPurchaseId = body.purchase.id
  expect(pendingPurchaseId).toBeTruthy()
})

// ═════════════════════════════════════════════════════════════════════════════
// 4. Non-parent rejected
// ═════════════════════════════════════════════════════════════════════════════

test("4. Non-parent (admin) cannot create a purchase", async () => {
  const { access_token } = await loginAs(EMAIL_ADMIN)
  const r = await fetch(`${BASE}/api/candy-purchases`, {
    method: "POST",
    headers: { ...cookieHeaders(access_token), "Content-Type": "application/json" },
    body: JSON.stringify({ package_id: testPackageId }),
  })
  expect(r.status).toBe(403)
})

// ═════════════════════════════════════════════════════════════════════════════
// 5. Successful completion
// ═════════════════════════════════════════════════════════════════════════════

test("5. Parent can complete a pending purchase", async () => {
  expect(pendingPurchaseId).toBeTruthy()
  const { access_token } = await loginAs(EMAIL_PARENT)
  const r = await fetch(`${BASE}/api/candy-purchases/${pendingPurchaseId}/complete`, {
    method: "POST",
    headers: { ...cookieHeaders(access_token), "Content-Type": "application/json" },
    body: JSON.stringify({ payment_reference: "e2e-test-ref-" + TS }),
  })
  expect(r.status).toBe(200)
  const body = await r.json()
  expect(body.purchase_status).toBe("paid")
  expect(body.purchase_id).toBe(pendingPurchaseId)
  expect(body.wallet_id).toBeTruthy()
  expect(typeof body.wallet_balance).toBe("number")
  expect(body.ledger_entry_id).toBeTruthy()
})

// ═════════════════════════════════════════════════════════════════════════════
// 6. Wallet increases exactly
// ═════════════════════════════════════════════════════════════════════════════

test("6. Wallet balance increases by exactly the candy amount", async () => {
  // Since we can't easily get pre-purchase balance (wallet may have been modified),
  // we verify the balance is at least 50 and the delta is correct by creating
  // a fresh purchase and checking before/after.

  // Get pre-purchase wallet balance
  const walletR = await fetch(`${SUPABASE_URL}/rest/v1/candy_wallets?select=id,balance&parent_id=eq.${parentUser.profileId}`, { headers: HDR })
  const walletData = await walletR.json()
  const wallet = Array.isArray(walletData) ? walletData[0] : walletData
  expect(wallet).toBeTruthy()
  const preBalance = Number(wallet.balance)

  // Create a second pending purchase
  const { access_token } = await loginAs(EMAIL_PARENT)
  const createR = await fetch(`${BASE}/api/candy-purchases`, {
    method: "POST",
    headers: { ...cookieHeaders(access_token), "Content-Type": "application/json" },
    body: JSON.stringify({ package_id: testPackageId }),
  })
  expect(createR.status).toBe(201)
  const createBody = await createR.json()
  const purchase2Id = createBody.purchase.id

  // Complete it
  const completeR = await fetch(`${BASE}/api/candy-purchases/${purchase2Id}/complete`, {
    method: "POST",
    headers: { ...cookieHeaders(access_token), "Content-Type": "application/json" },
  })
  expect(completeR.status).toBe(200)
  const completeBody = await completeR.json()

  // Wallet should have increased by exactly 50
  expect(Number(completeBody.wallet_balance)).toBe(preBalance + 50)
})

// ═════════════════════════════════════════════════════════════════════════════
// 7. Ledger entry created
// ═════════════════════════════════════════════════════════════════════════════

test("7. A ledger entry is created for the purchase credit", async () => {
  expect(pendingPurchaseId).toBeTruthy()
  const { access_token } = await loginAs(EMAIL_PARENT)

  // Resolve wallet ID
  const walletR = await fetch(`${SUPABASE_URL}/rest/v1/candy_wallets?select=id&parent_id=eq.${parentUser.profileId}`, { headers: HDR })
  const walletData = await walletR.json()
  const walletId = Array.isArray(walletData) ? walletData[0].id : walletData.id

  // Query ledger for the purchase credit entry
  // Need to also try through RLS — the RLS policy for candy_transactions requires
  // parent to own the wallet. Try with the parent's auth headers.
  const txR2 = await fetch(`${SUPABASE_URL}/rest/v1/candy_transactions?wallet_id=eq.${walletId}&reference_id=eq.${pendingPurchaseId}&select=id,amount,type,reference_type,reference_id,idempotency_key,description`, {
    headers: { ...HDR, ...cookieHeaders(access_token) },
  })
  expect(txR2.status).toBe(200)
  const txns = await txR2.json()
  const entries = Array.isArray(txns) ? txns.filter((t: Record<string, unknown>) =>
    t.reference_id === pendingPurchaseId && t.type === "purchase"
  ) : []
  expect(entries.length).toBeGreaterThanOrEqual(1)

  const entry = entries[0]
  expect(Number(entry.amount)).toBe(50)
  expect(entry.type).toBe("purchase")
  expect(entry.reference_type).toBe("candy_purchase")
  expect(entry.reference_id).toBe(pendingPurchaseId)
  expect(entry.idempotency_key).toBe("purchase_credit:" + pendingPurchaseId)
  expect(entry.description).toBeTruthy()
})

// ═════════════════════════════════════════════════════════════════════════════
// 8. Duplicate completion rejected safely (idempotent)
// ═════════════════════════════════════════════════════════════════════════════

test("8. Duplicate completion is idempotent — returns current state without double-crediting", async () => {
  // Create a fresh purchase for this test
  const { access_token } = await loginAs(EMAIL_PARENT)
  const createR = await fetch(`${BASE}/api/candy-purchases`, {
    method: "POST",
    headers: { ...cookieHeaders(access_token), "Content-Type": "application/json" },
    body: JSON.stringify({ package_id: testPackageId }),
  })
  expect(createR.status).toBe(201)
  const createBody = await createR.json()
  const purchaseId = createBody.purchase.id

  // Get pre-completion wallet balance via REST API (service role)
  const walletR = await fetch(`${SUPABASE_URL}/rest/v1/candy_wallets?select=balance&parent_id=eq.${parentUser.profileId}`, { headers: HDR })
  const walletData = await walletR.json()
  const preBalance = Number(Array.isArray(walletData) ? walletData[0].balance : walletData.balance)

  // First completion
  const r1 = await fetch(`${BASE}/api/candy-purchases/${purchaseId}/complete`, {
    method: "POST",
    headers: { ...cookieHeaders(access_token), "Content-Type": "application/json" },
  })
  expect(r1.status).toBe(200)
  const body1 = await r1.json()
  expect(body1.purchase_status).toBe("paid")
  const afterFirstBalance = Number(body1.wallet_balance)
  expect(afterFirstBalance).toBe(preBalance + 50)

  // Second completion — must be idempotent
  const r2 = await fetch(`${BASE}/api/candy-purchases/${purchaseId}/complete`, {
    method: "POST",
    headers: { ...cookieHeaders(access_token), "Content-Type": "application/json" },
  })
  expect(r2.status).toBe(200)
  const body2 = await r2.json()
  expect(body2.purchase_status).toBe("paid")

  // Balance should NOT have increased again
  expect(Number(body2.wallet_balance)).toBe(afterFirstBalance)

  // Only one ledger entry should exist
  const walletId = body1.wallet_id
  const txR = await fetch(`${SUPABASE_URL}/rest/v1/candy_transactions?wallet_id=eq.${walletId}&idempotency_key=eq.purchase_credit:${purchaseId}&select=id`, { headers: HDR })
  const txBody = await txR.json()
  const txns = Array.isArray(txBody) ? txBody : []
  expect(txns.length).toBe(1)
})

// ═════════════════════════════════════════════════════════════════════════════
// 9. Failed purchase does not credit wallet
// ═════════════════════════════════════════════════════════════════════════════

test("9. Failed purchase cannot be completed and does not credit wallet", async () => {
  const { access_token } = await loginAs(EMAIL_PARENT)

  // Create a new pending purchase
  const createR = await fetch(`${BASE}/api/candy-purchases`, {
    method: "POST",
    headers: { ...cookieHeaders(access_token), "Content-Type": "application/json" },
    body: JSON.stringify({ package_id: testPackageId }),
  })
  expect(createR.status).toBe(201)
  const createBody = await createR.json()
  const purchaseId = createBody.purchase.id

  // Get wallet balance before
  const walletR = await fetch(`${SUPABASE_URL}/rest/v1/candy_wallets?select=balance&parent_id=eq.${parentUser.profileId}`, { headers: HDR })
  const walletData = await walletR.json()
  const preBalance = Number(Array.isArray(walletData) ? walletData[0].balance : walletData.balance)

  // Directly set the purchase status to "failed" (simulating a payment failure)
  await fetch(`${SUPABASE_URL}/rest/v1/candy_purchases?id=eq.${purchaseId}`, {
    method: "PATCH", headers: HDR,
    body: JSON.stringify({ status: "failed" }),
  })

  // Attempt to complete — should be rejected
  const completeR = await fetch(`${BASE}/api/candy-purchases/${purchaseId}/complete`, {
    method: "POST",
    headers: { ...cookieHeaders(access_token), "Content-Type": "application/json" },
  })
  expect(completeR.status).toBe(409)

  // Wallet balance must remain unchanged
  const walletR2 = await fetch(`${SUPABASE_URL}/rest/v1/candy_wallets?select=balance&parent_id=eq.${parentUser.profileId}`, { headers: HDR })
  const walletData2 = await walletR2.json()
  const postBalance = Number(Array.isArray(walletData2) ? walletData2[0].balance : walletData2.balance)
  expect(postBalance).toBe(preBalance)
})

// ═════════════════════════════════════════════════════════════════════════════
// 10. User cannot complete another parent's purchase
// ═════════════════════════════════════════════════════════════════════════════

test("10. Parent cannot complete another parent's purchase", async () => {
  // Parent1 creates a purchase
  const { access_token: parent1Token } = await loginAs(EMAIL_PARENT)
  const createR = await fetch(`${BASE}/api/candy-purchases`, {
    method: "POST",
    headers: { ...cookieHeaders(parent1Token), "Content-Type": "application/json" },
    body: JSON.stringify({ package_id: testPackageId }),
  })
  expect(createR.status).toBe(201)
  const createBody = await createR.json()
  const purchaseId = createBody.purchase.id

  // Parent2 tries to complete it
  const { access_token: parent2Token } = await loginAs(EMAIL_PARENT2)
  const completeR = await fetch(`${BASE}/api/candy-purchases/${purchaseId}/complete`, {
    method: "POST",
    headers: { ...cookieHeaders(parent2Token), "Content-Type": "application/json" },
  })
  expect(completeR.status).toBe(403)

  // Verify purchase is still pending and owned by parent1
  const checkR = await fetch(`${SUPABASE_URL}/rest/v1/candy_purchases?id=eq.${purchaseId}&select=id,parent_id,status`, { headers: HDR })
  const checkData = await checkR.json()
  const purchase = Array.isArray(checkData) ? checkData[0] : checkData
  expect(purchase).toBeTruthy()
  expect(purchase.status).toBe("pending")
  expect(purchase.parent_id).toBe(parentUser.profileId)
})
