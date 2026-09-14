import { test, expect } from "@playwright/test"
import * as fs from "fs"
import * as path from "path"
import {
  assertSafeDatabaseTarget,
  guardedProjectRef,
  guardedSupabaseUrl,
} from "../helpers/assert-safe-database-target"

// ⚠️ Stateful parent-orders tests. These create synthetic parents and orders,
// so they run against a disposable/local target ONLY, never the production
// main project. assertSafeDatabaseTarget() gates the whole file, and both the
// Supabase URL and the auth cookie name are derived from the same environment
// the guard inspected, so the guard's verdict is binding on every request.

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

const PROJECT_REF = guardedProjectRef()
const SUPABASE_URL = guardedSupabaseUrl()
const BASE = process.env.CARTOONA_TEST_BASE_URL || "http://localhost:3000"

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

interface TestParent {
  userId: string
  profileId: string
  email: string
  accessToken: string
}

async function createParent(tag: string): Promise<TestParent> {
  const email = `parent-orders-${tag}-${TS}@example.com`

  const created = await (await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: "POST", headers: HDR,
    body: JSON.stringify({ email, password: PASSWORD, email_confirm: true }),
  })).json()
  if (!created.id) throw new Error(`create ${email}: ${JSON.stringify(created)}`)

  await fetch(`${SUPABASE_URL}/rest/v1/users`, {
    method: "POST", headers: { ...HDR, Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({ id: created.id, email, role: "parent" }),
  })

  const profileRes = await fetch(`${SUPABASE_URL}/rest/v1/parent_profiles`, {
    method: "POST", headers: { ...HDR, Prefer: "return=representation" },
    body: JSON.stringify({
      user_id: created.id, full_name: `Test Parent ${tag}`,
      consent_granted: true, consent_granted_at: new Date().toISOString(),
    }),
  })
  const profile = (await profileRes.json())[0]
  if (!profile?.id) throw new Error(`profile ${email}: ${JSON.stringify(profile)}`)

  const login = await (await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST", headers: HDR, body: JSON.stringify({ email, password: PASSWORD }),
  })).json()

  return { userId: created.id, profileId: profile.id, email, accessToken: login.access_token }
}

async function createOrder(
  parentId: string,
  over: Record<string, unknown> = {},
): Promise<string> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/orders`, {
    method: "POST", headers: { ...HDR, Prefer: "return=representation" },
    body: JSON.stringify({
      parent_id: parentId, type: "image", status: "pending_review",
      title: "سفارش آزمایشی", candy_cost: 100, ...over,
    }),
  })
  const row = (await res.json())[0]
  if (!row?.id) throw new Error(`order: ${JSON.stringify(row)}`)
  return row.id
}

async function getOrdersPage(token?: string): Promise<{ status: number; body: string }> {
  const res = await fetch(`${BASE}/dashboard/orders`, {
    headers: token ? { Cookie: `sb-${PROJECT_REF}-auth-token=${buildCookie(token)}` } : {},
    redirect: "manual",
  })
  return { status: res.status, body: await res.text() }
}

let parentA: TestParent
let parentB: TestParent
const createdOrderIds: string[] = []

test.beforeAll(async () => {
  parentA = await createParent("a")
  parentB = await createParent("b")

  // Parent A: one of each creation type, inserted oldest first so the page has
  // to do the ordering rather than inheriting insertion order.
  createdOrderIds.push(await createOrder(parentA.profileId, {
    type: "image", title: "تصویر الف", status: "pending_review",
    created_at: "2026-01-01T00:00:00Z", candy_cost: 150,
  }))
  createdOrderIds.push(await createOrder(parentA.profileId, {
    type: "video", title: "ویدیو الف", status: "in_progress",
    created_at: "2026-02-01T00:00:00Z", candy_cost: 500,
  }))
  createdOrderIds.push(await createOrder(parentA.profileId, {
    type: "drawing_animation", title: "نقاشی الف", status: "delivered",
    created_at: "2026-03-01T00:00:00Z", candy_cost: 300,
  }))
  // Hidden pre-submission order.
  createdOrderIds.push(await createOrder(parentA.profileId, {
    type: "image", title: "پیش‌نویس الف", status: "draft",
    created_at: "2026-04-01T00:00:00Z",
  }))
  // Parent B's private order. Must never appear for parent A.
  createdOrderIds.push(await createOrder(parentB.profileId, {
    type: "video", title: "سفارش محرمانه ب", status: "in_progress",
    created_at: "2026-05-01T00:00:00Z",
  }))
})

test.afterAll(async () => {
  for (const id of createdOrderIds) {
    await fetch(`${SUPABASE_URL}/rest/v1/orders?id=eq.${id}`, { method: "DELETE", headers: HDR }).catch(() => {})
  }
  for (const p of [parentA, parentB]) {
    if (!p) continue
    await fetch(`${SUPABASE_URL}/rest/v1/parent_profiles?id=eq.${p.profileId}`, { method: "DELETE", headers: HDR }).catch(() => {})
    await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${p.userId}`, { method: "DELETE", headers: HDR }).catch(() => {})
  }
})

test("anonymous cannot read the parent order list", async () => {
  const res = await getOrdersPage()
  expect([302, 307, 308]).toContain(res.status)
  expect(res.body).not.toContain("تصویر الف")
})

test("a parent sees their own submitted requests", async () => {
  const res = await getOrdersPage(parentA.accessToken)
  expect(res.status).toBe(200)
  expect(res.body).toContain("تصویر الف")
  expect(res.body).toContain("ویدیو الف")
  expect(res.body).toContain("نقاشی الف")
})

test("a parent never sees another parent's request", async () => {
  const res = await getOrdersPage(parentA.accessToken)
  expect(res.status).toBe(200)
  expect(res.body).not.toContain("سفارش محرمانه ب")
  expect(res.body).not.toContain(parentB.profileId)

  // And the reverse: B sees only their own.
  const other = await getOrdersPage(parentB.accessToken)
  expect(other.body).toContain("سفارش محرمانه ب")
  expect(other.body).not.toContain("تصویر الف")
})

test("all three creation types render their Persian labels", async () => {
  const res = await getOrdersPage(parentA.accessToken)
  expect(res.body).toContain("تصویر کارتونی")
  expect(res.body).toContain("ویدیوی کارتونی")
  expect(res.body).toContain("جان‌بخشی به نقاشی")
})

test("orders are listed newest first", async () => {
  const { body } = await getOrdersPage(parentA.accessToken)
  const drawing = body.indexOf("نقاشی الف")   // created 2026-03
  const video = body.indexOf("ویدیو الف")     // created 2026-02
  const image = body.indexOf("تصویر الف")     // created 2026-01
  expect(drawing).toBeGreaterThan(-1)
  expect(drawing).toBeLessThan(video)
  expect(video).toBeLessThan(image)
})

test("pre-submission drafts stay out of the list", async () => {
  const { body } = await getOrdersPage(parentA.accessToken)
  expect(body).not.toContain("پیش‌نویس الف")
})

test("no raw internal status string reaches the page", async () => {
  const { body } = await getOrdersPage(parentA.accessToken)
  // Internal workflow statuses only. `requestType` is part of the parent read
  // model by design, so its values legitimately appear in the payload.
  for (const internal of ["pending_review", "in_progress", "pending_payment", "cancelled"]) {
    expect(body).not.toContain(internal)
  }
  // Parent-facing labels are present instead.
  expect(body).toContain("ثبت شد")
  expect(body).toContain("در حال ساخت")
})

test("no admin or operational field reaches the page", async () => {
  const { body } = await getOrdersPage(parentA.accessToken)
  for (const leak of ["assigned_admin_id", "moderation_status", "parent_id", "final-deliverables"]) {
    expect(body).not.toContain(leak)
  }
})
