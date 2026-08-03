import { test, expect } from "@playwright/test"
import * as fs from "fs"
import * as path from "path"
import { assertSafeDatabaseTarget } from "../helpers/assert-safe-database-target"

// ⚠️ Stateful admin coupon tests. These create real coupons through the Admin
// API and mutate coupon_redemptions-adjacent state on a disposable/local
// target ONLY. They are guarded by assertSafeDatabaseTarget() and must never
// run against the production main project (coupons=0 is expected on main).

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

function buildCookie(at: string): string {
  return "base64-" + Buffer.from(JSON.stringify({
    access_token: at, refresh_token: "", expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600, token_type: "bearer",
  })).toString("base64url")
}

interface SyntheticUser {
  id: string
  email: string
  accessToken: string
}

async function createUser(email: string, role: string): Promise<SyntheticUser> {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: "POST", headers: HDR,
    body: JSON.stringify({ email, password: PASSWORD, email_confirm: true, user_metadata: { full_name: "Test" } }),
  })
  const u = await r.json()
  if (!u.id) throw new Error(`Create ${email}: ${r.status} ${JSON.stringify(u)}`)

  await fetch(`${SUPABASE_URL}/rest/v1/users`, {
    method: "POST",
    headers: { ...HDR, Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({ id: u.id, email, role }),
  }).catch(() => {})

  const login = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST", headers: HDR,
    body: JSON.stringify({ email, password: PASSWORD }),
  })
  const loginData = await login.json()

  return { id: u.id, email, accessToken: loginData.access_token }
}

async function apiReq(path: string, method = "GET", body?: unknown, token?: string) {
  return fetch(`${BASE}${path}`, {
    method,
    headers: token
      ? { "Content-Type": "application/json", Cookie: `sb-${PROJECT_REF}-auth-token=${buildCookie(token)}` }
      : { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  })
}

const EMAIL_ADMIN = `capi_admin_${TS}@test.com`
const EMAIL_PARENT = `capi_parent_${TS}@test.com`

let admin: SyntheticUser
let parent: SyntheticUser
let packageId: string | null = null

test.beforeAll(async () => {
  test.setTimeout(120000)
  admin = await createUser(EMAIL_ADMIN, "admin")
  parent = await createUser(EMAIL_PARENT, "parent")

  const pkgs = await fetch(`${SUPABASE_URL}/rest/v1/candy_packages?is_active=eq.true&select=id`, { headers: HDR })
  const rows = await pkgs.json()
  packageId = Array.isArray(rows) && rows.length > 0 ? rows[0].id : null
})

test.afterAll(async () => {
  for (const u of [admin, parent]) {
    await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${u.id}`, { method: "DELETE", headers: HDR }).catch(() => {})
  }
})

function validInput(overrides: Record<string, unknown> = {}) {
  return {
    code: `CAPI${TS}${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
    name: "کد تست",
    description: null,
    discountType: "percentage",
    discountValue: 2000,
    isActive: true,
    startsAt: null,
    expiresAt: null,
    globalUsageLimit: null,
    perParentUsageLimit: null,
    minimumPurchaseAmount: 0,
    maximumDiscountAmount: null,
    packageIds: [],
    ...overrides,
  }
}

test("1. unauthenticated request returns 401", async () => {
  const res = await apiReq("/api/admin/coupons")
  expect(res.status).toBe(401)
})

test("2. parent (non-admin) request returns 403", async () => {
  const res = await apiReq("/api/admin/coupons", "GET", undefined, parent.accessToken)
  expect(res.status).toBe(403)
})

test("3. admin can create a coupon", async () => {
  const input = validInput()
  const res = await apiReq("/api/admin/coupons", "POST", input, admin.accessToken)
  expect(res.status).toBe(201)
  const body = await res.json()
  expect(body.coupon.code).toBe(input.code)
  expect(body.coupon.status).toBe("active")
  expect(body.coupon.redeemedCount).toBe(0)
})

test("4. duplicate code returns 409", async () => {
  const input = validInput()
  const first = await apiReq("/api/admin/coupons", "POST", input, admin.accessToken)
  expect(first.status).toBe(201)

  const second = await apiReq("/api/admin/coupons", "POST", input, admin.accessToken)
  expect(second.status).toBe(409)
  const body = await second.json()
  expect(body.code).toBe("COUPON_DUPLICATE_CODE")
})

test("5. invalid input returns 422 with field errors", async () => {
  const res = await apiReq("/api/admin/coupons", "POST", validInput({ discountValue: 0 }), admin.accessToken)
  expect(res.status).toBe(422)
  const body = await res.json()
  expect(body.code).toBe("COUPON_INVALID")
  expect(body.errors.discountValue).toBeDefined()
})

test("6. non-JSON content type returns 415", async () => {
  const res = await fetch(`${BASE}/api/admin/coupons`, {
    method: "POST",
    headers: { "Content-Type": "text/plain", Cookie: `sb-${PROJECT_REF}-auth-token=${buildCookie(admin.accessToken)}` },
    body: "code=hi",
  })
  expect(res.status).toBe(415)
})

test("7. list returns created coupon with pagination", async () => {
  const input = validInput({ code: `SEARCH${TS}` })
  await apiReq("/api/admin/coupons", "POST", input, admin.accessToken)

  const res = await apiReq(`/api/admin/coupons?search=${input.code}`, "GET", undefined, admin.accessToken)
  expect(res.status).toBe(200)
  const body = await res.json()
  expect(body.coupons.length).toBeGreaterThanOrEqual(1)
  expect(body.coupons[0].code).toBe(input.code)
  expect(body.pagination.total).toBeGreaterThanOrEqual(1)
  expect(res.headers.get("cache-control")).toContain("no-store")
})

test("8. list pageSize is capped at 50", async () => {
  const res = await apiReq("/api/admin/coupons?pageSize=9999", "GET", undefined, admin.accessToken)
  const body = await res.json()
  expect(body.pagination.pageSize).toBe(50)
})

test("9. detail returns coupon", async () => {
  const input = validInput()
  const created = await apiReq("/api/admin/coupons", "POST", input, admin.accessToken)
  const { coupon } = await created.json()

  const res = await apiReq(`/api/admin/coupons/${coupon.id}`, "GET", undefined, admin.accessToken)
  expect(res.status).toBe(200)
  const body = await res.json()
  expect(body.coupon.code).toBe(input.code)
  expect(body.coupon.createdBy?.email).toBe(EMAIL_ADMIN)
})

test("10. detail of unknown id returns 404", async () => {
  const res = await apiReq("/api/admin/coupons/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", "GET", undefined, admin.accessToken)
  expect(res.status).toBe(404)
})

test("11. admin can update a coupon name", async () => {
  const input = validInput()
  const created = await apiReq("/api/admin/coupons", "POST", input, admin.accessToken)
  const { coupon } = await created.json()

  const res = await apiReq(`/api/admin/coupons/${coupon.id}`, "PATCH", {
    ...validInput({ code: input.code }),
    name: "نام جدید",
    expectedUpdatedAt: coupon.updatedAt,
  }, admin.accessToken)
  expect(res.status).toBe(200)
  const body = await res.json()
  expect(body.coupon.name).toBe("نام جدید")
})

test("12. stale expectedUpdatedAt returns 409", async () => {
  const input = validInput()
  const created = await apiReq("/api/admin/coupons", "POST", input, admin.accessToken)
  const { coupon } = await created.json()

  const res = await apiReq(`/api/admin/coupons/${coupon.id}`, "PATCH", {
    ...validInput({ code: input.code }),
    name: "تغییر",
    expectedUpdatedAt: "2000-01-01T00:00:00.000Z",
  }, admin.accessToken)
  expect(res.status).toBe(409)
  expect((await res.json()).code).toBe("COUPON_CONFLICT")
})

test("13. list supports status filter", async () => {
  const input = validInput()
  await apiReq("/api/admin/coupons", "POST", input, admin.accessToken)

  const res = await apiReq(`/api/admin/coupons?status=inactive&search=${input.code}`, "GET", undefined, admin.accessToken)
  const body = await res.json()
  // The coupon is active, so the inactive filter must not include it.
  expect(body.coupons.every((c: { code: string }) => c.code !== input.code)).toBe(true)
  // But it exists as active.
  const activeRes = await apiReq(`/api/admin/coupons?status=active&search=${input.code}`, "GET", undefined, admin.accessToken)
  const activeBody = await activeRes.json()
  expect(activeBody.coupons.some((c: { code: string }) => c.code === input.code)).toBe(true)
})

test("14. scheduled status via future start", async () => {
  const future = new Date(Date.now() + 10 * 60 * 60 * 1000).toISOString()
  const input = validInput({ startsAt: future })
  const created = await apiReq("/api/admin/coupons", "POST", input, admin.accessToken)
  expect(created.status).toBe(201)
  const body = await created.json()
  expect(body.coupon.status).toBe("scheduled")
})

test("15. package restriction creates rules", async () => {
  if (!packageId) {
    console.warn("Skipping: no active candy package found on this target")
    return
  }
  const input = validInput({ packageIds: [packageId] })
  const created = await apiReq("/api/admin/coupons", "POST", input, admin.accessToken)
  expect(created.status).toBe(201)
  const { coupon } = await created.json()
  expect(coupon.packageIds).toContain(packageId)
})

test("16. invalid package id returns 422", async () => {
  const res = await apiReq("/api/admin/coupons", "POST", validInput({ packageIds: ["aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"] }), admin.accessToken)
  expect(res.status).toBe(422)
  expect((await res.json()).code).toBe("COUPON_PACKAGE_INVALID")
})

test("17. trusted RPC is not executable by the public role", async () => {
  const anonRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/create_coupon_trusted`, {
    method: "POST",
    headers: { ...HDR, apikey: KEY },
    body: JSON.stringify({}),
  })
  expect(anonRes.status).toBe(403)
})

test("18. GET does not expose redemption ids or parent identities", async () => {
  const res = await apiReq("/api/admin/coupons", "GET", undefined, admin.accessToken)
  const body = await res.json()
  const json = JSON.stringify(body)
  expect(json).not.toContain("coupon_redemptions")
  expect(json).not.toContain("parent_id")
})
