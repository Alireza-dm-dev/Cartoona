import { test, expect } from "@playwright/test"
import * as fs from "fs"
import * as path from "path"
import {
  assertSafeDatabaseTarget,
  guardedProjectRef,
  guardedSupabaseUrl,
} from "../helpers/assert-safe-database-target"

// ⚠️ Stateful parent order-detail tests. These create synthetic parents,
// orders and status history, so they run against a disposable/local target
// ONLY. assertSafeDatabaseTarget() gates the file, and both the Supabase URL
// and the auth cookie name come from the same environment the guard read.

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

const INTERNAL_NOTE = "ADMIN-ONLY-NOTE-do-not-leak"

function buildCookie(at: string): string {
  return "base64-" + Buffer.from(JSON.stringify({
    access_token: at, refresh_token: "", expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600, token_type: "bearer",
  })).toString("base64url")
}

interface TestParent { userId: string; profileId: string; accessToken: string }

async function createParent(tag: string): Promise<TestParent> {
  const email = `order-detail-${tag}-${TS}@example.com`
  const created = await (await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: "POST", headers: HDR,
    body: JSON.stringify({ email, password: PASSWORD, email_confirm: true }),
  })).json()
  if (!created.id) throw new Error(`create ${email}: ${JSON.stringify(created)}`)

  await fetch(`${SUPABASE_URL}/rest/v1/users`, {
    method: "POST", headers: { ...HDR, Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({ id: created.id, email, role: "parent" }),
  })
  const profile = (await (await fetch(`${SUPABASE_URL}/rest/v1/parent_profiles`, {
    method: "POST", headers: { ...HDR, Prefer: "return=representation" },
    body: JSON.stringify({
      user_id: created.id, full_name: `Detail Parent ${tag}`,
      consent_granted: true, consent_granted_at: new Date().toISOString(),
    }),
  })).json())[0]

  const login = await (await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST", headers: HDR, body: JSON.stringify({ email, password: PASSWORD }),
  })).json()

  return { userId: created.id, profileId: profile.id, accessToken: login.access_token }
}

async function createOrder(parentId: string, over: Record<string, unknown> = {}): Promise<string> {
  const row = (await (await fetch(`${SUPABASE_URL}/rest/v1/orders`, {
    method: "POST", headers: { ...HDR, Prefer: "return=representation" },
    body: JSON.stringify({
      parent_id: parentId, type: "image", status: "in_progress",
      title: "سفارش جزئیات", candy_cost: 120, ...over,
    }),
  })).json())[0]
  if (!row?.id) throw new Error(`order: ${JSON.stringify(row)}`)
  return row.id
}

async function addHistory(orderId: string, rows: Array<Record<string, unknown>>): Promise<void> {
  // PostgREST rejects a bulk insert whose objects do not all share the same
  // keys (PGRST102), so every row is normalised to the full column set.
  const payload = rows.map((r) => ({
    order_id: orderId,
    previous_status: null,
    new_status: null,
    internal_note: null,
    parent_visible_note: null,
    created_at: null,
    ...r,
  }))
  const res = await fetch(`${SUPABASE_URL}/rest/v1/order_status_history`, {
    method: "POST", headers: { ...HDR, Prefer: "return=minimal" },
    body: JSON.stringify(payload),
  })
  if (!res.ok) throw new Error(`history insert failed: ${res.status} ${await res.text()}`)
}

async function getDetail(orderId: string, token?: string) {
  const res = await fetch(`${BASE}/dashboard/orders/${orderId}`, {
    headers: token ? { Cookie: `sb-${PROJECT_REF}-auth-token=${buildCookie(token)}` } : {},
    redirect: "manual",
  })
  return { status: res.status, body: await res.text() }
}

let parentA: TestParent
let parentB: TestParent
let orderInProgress: string
let orderRejected: string
let orderCancelled: string
let orderOfB: string
const orderIds: string[] = []

test.beforeAll(async () => {
  parentA = await createParent("a")
  parentB = await createParent("b")

  orderInProgress = await createOrder(parentA.profileId, {
    type: "video", title: "ویدیوی جنگل", status: "in_progress", candy_cost: 500,
  })
  await addHistory(orderInProgress, [
    { previous_status: null, new_status: "pending_review", created_at: "2026-01-01T00:00:00Z",
      internal_note: INTERNAL_NOTE, parent_visible_note: "درخواست شما دریافت شد" },
    { previous_status: "pending_review", new_status: "in_progress", created_at: "2026-02-01T00:00:00Z",
      internal_note: INTERNAL_NOTE, parent_visible_note: null },
  ])

  orderRejected = await createOrder(parentA.profileId, {
    title: "سفارش رد شده", status: "rejected",
  })
  await addHistory(orderRejected, [
    { previous_status: null, new_status: "pending_review", created_at: "2026-01-01T00:00:00Z" },
    { previous_status: "pending_review", new_status: "rejected", created_at: "2026-03-01T00:00:00Z",
      internal_note: INTERNAL_NOTE, parent_visible_note: "تصویر ارسالی واضح نبود" },
  ])

  // Cancelled with no parent-visible note, so the neutral fallback is used.
  orderCancelled = await createOrder(parentA.profileId, {
    title: "سفارش لغو شده", status: "cancelled",
  })
  await addHistory(orderCancelled, [
    { previous_status: null, new_status: "pending_review", created_at: "2026-01-01T00:00:00Z" },
    { previous_status: "pending_review", new_status: "cancelled", created_at: "2026-04-01T00:00:00Z",
      internal_note: INTERNAL_NOTE, parent_visible_note: null },
  ])

  orderOfB = await createOrder(parentB.profileId, { title: "سفارش محرمانه ب" })

  orderIds.push(orderInProgress, orderRejected, orderCancelled, orderOfB)
})

test.afterAll(async () => {
  for (const id of orderIds) {
    await fetch(`${SUPABASE_URL}/rest/v1/orders?id=eq.${id}`, { method: "DELETE", headers: HDR }).catch(() => {})
  }
  for (const p of [parentA, parentB]) {
    if (!p) continue
    await fetch(`${SUPABASE_URL}/rest/v1/parent_profiles?id=eq.${p.profileId}`, { method: "DELETE", headers: HDR }).catch(() => {})
    await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${p.userId}`, { method: "DELETE", headers: HDR }).catch(() => {})
  }
})

test("anonymous is redirected to login", async () => {
  const res = await getDetail(orderInProgress)
  expect([302, 307, 308]).toContain(res.status)
  expect(res.body).not.toContain("ویدیوی جنگل")
})

test("a parent can open their own order detail", async () => {
  const res = await getDetail(orderInProgress, parentA.accessToken)
  expect(res.status).toBe(200)
  expect(res.body).toContain("ویدیوی جنگل")
  expect(res.body).toContain("ویدیوی کارتونی")
})

test("another parent's order is indistinguishable from a missing one", async () => {
  const other = await getDetail(orderOfB, parentA.accessToken)
  const missing = await getDetail("00000000-0000-4000-8000-000000000000", parentA.accessToken)

  expect(other.status).toBe(404)
  expect(missing.status).toBe(404)
  expect(other.body).toContain("این سفارش پیدا نشد")
  expect(missing.body).toContain("این سفارش پیدا نشد")
  // Nothing about the other parent's order may appear.
  expect(other.body).not.toContain("سفارش محرمانه ب")
  expect(other.body).not.toContain(parentB.profileId)
})

test("the timeline renders newest first from real history", async () => {
  const { body } = await getDetail(orderInProgress, parentA.accessToken)
  const creating = body.indexOf("در حال ساخت")
  const submitted = body.indexOf("درخواست ثبت شد")
  expect(creating).toBeGreaterThan(-1)
  expect(submitted).toBeGreaterThan(-1)
  expect(creating).toBeLessThan(submitted)
  expect(body).toContain("درخواست شما دریافت شد")
})

test("internal notes never reach the page", async () => {
  for (const id of [orderInProgress, orderRejected, orderCancelled]) {
    const { body } = await getDetail(id, parentA.accessToken)
    expect(body).not.toContain(INTERNAL_NOTE)
  }
})

test("raw internal status and event names never render", async () => {
  const { body } = await getDetail(orderInProgress, parentA.accessToken)
  for (const internal of ["pending_review", "in_progress", "previous_status", "new_status", "internal_note"]) {
    expect(body).not.toContain(internal)
  }
})

test("a rejected order shows its parent-visible reason", async () => {
  const { body } = await getDetail(orderRejected, parentA.accessToken)
  // The closure heading, not just the status badge: the badge reads
  // "لغو/رد شده", which would satisfy a bare "رد شده" check on its own.
  expect(body).toContain("وضعیت نهایی")
  expect(body).toContain("تصویر ارسالی واضح نبود")
  expect(body).not.toContain(INTERNAL_NOTE)
})

test("a cancelled order with no safe reason shows the neutral fallback", async () => {
  const { body } = await getDetail(orderCancelled, parentA.accessToken)
  expect(body).toContain("وضعیت نهایی")
  expect(body).toContain("لغو شده")
  expect(body).toContain("توضیح بیشتری برای نمایش ثبت نشده است")
  expect(body).not.toContain(INTERNAL_NOTE)
})

test("no admin or storage field reaches the page", async () => {
  const { body } = await getDetail(orderInProgress, parentA.accessToken)
  for (const leak of ["assigned_admin_id", "moderation_status", "parent-uploads", "changed_by_user_id"]) {
    expect(body).not.toContain(leak)
  }
})

test("no final-file download is offered in this phase", async () => {
  const { body } = await getDetail(orderInProgress, parentA.accessToken)
  expect(body).not.toContain("final-deliverables")
  expect(body).not.toContain("دانلود فایل نهایی")
})
