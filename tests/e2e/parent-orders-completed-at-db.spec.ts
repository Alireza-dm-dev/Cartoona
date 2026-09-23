import { test, expect } from "@playwright/test"
import { assertSafeDatabaseTarget, guardedProjectRef, guardedSupabaseUrl } from "../helpers/assert-safe-database-target"
import { loadTestEnv } from "../helpers/load-test-env"

/**
 * Stateful coverage for V0.1.19 — the parent orders LIST now derives
 * completedAt from the real `delivered` transition in order_status_history
 * (via the new batch-safe get_parent_orders_delivered_at RPC,
 * 20260923100000_parent_orders_delivered_at_batch.sql), matching the order
 * detail page instead of the removed orders.updated_at proxy.
 *
 * This exercises the RPC directly over PostgREST (not just the rendered
 * page), because the rendered date is formatted and loses the precision an
 * exact-equality check against order_status_history.created_at needs.
 */

loadTestEnv()

const _guard = assertSafeDatabaseTarget()
if (!_guard.ok) throw new Error(`Guard blocked: ${_guard.reason}`)

const PROJECT_REF = guardedProjectRef()
const SUPABASE_URL = guardedSupabaseUrl()
const BASE = process.env.CARTOONA_TEST_BASE_URL || "http://localhost:3000"
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ""

const KEY = process.env.SUPABASE_SECRET_KEY || ""
const HDR = { "Content-Type": "application/json", apikey: KEY, Authorization: `Bearer ${KEY}` }
const PASSWORD = "TestPass999!"
const TS = String(Date.now()).slice(-8)

const COOKIE_NAME = `sb-${PROJECT_REF}-auth-token`

function buildCookie(accessToken: string): string {
  const session = {
    access_token: accessToken,
    refresh_token: "",
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    token_type: "bearer",
  }
  return "base64-" + Buffer.from(JSON.stringify(session)).toString("base64url")
}

interface TestParent {
  userId: string
  profileId: string
  email: string
  accessToken: string
}

async function createParent(tag: string): Promise<TestParent> {
  const email = `parent-completedat-${tag}-${TS}@example.com`
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

async function createAdminUser(email: string): Promise<string> {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: "POST", headers: HDR,
    body: JSON.stringify({ email, password: PASSWORD, email_confirm: true }),
  })
  const u = await r.json()
  if (!u.id) throw new Error(`create admin user: ${r.status} ${JSON.stringify(u)}`)
  await fetch(`${SUPABASE_URL}/rest/v1/users`, {
    method: "POST", headers: { ...HDR, Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({ id: u.id, email, role: "admin" }),
  }).catch(() => {})
  return u.id
}

async function adminSessionToken(email: string): Promise<string> {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST", headers: HDR, body: JSON.stringify({ email, password: PASSWORD }),
  })
  const d = await r.json()
  if (!d.access_token) throw new Error(`admin login: ${JSON.stringify(d)}`)
  return d.access_token
}

async function createOrder(parentProfileId: string, title: string): Promise<string> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/orders`, {
    method: "POST", headers: { ...HDR, Prefer: "return=representation" },
    body: JSON.stringify({
      parent_id: parentProfileId, type: "image", status: "pending_review",
      title, candy_cost: 15, moderation_status: "passed",
    }),
  })
  const rows = await res.json()
  const id = Array.isArray(rows) ? rows[0]?.id : undefined
  if (!id) throw new Error(`order create failed: ${JSON.stringify(rows)}`)
  return id
}

async function getOrderRow(orderId: string): Promise<{ status: string; updated_at: string }> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/orders?select=status,updated_at&id=eq.${orderId}`, { headers: HDR })
  return (await res.json())[0]
}

async function adminUpdateStatus(orderId: string, adminToken: string, status: string, expectedUpdatedAt: string) {
  const res = await fetch(`${BASE}/api/admin/requests/${orderId}/status`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Cookie: `${COOKIE_NAME}=${buildCookie(adminToken)}` },
    body: JSON.stringify({ status, expectedUpdatedAt, internalNote: null, parentVisibleNote: null }),
  })
  return { status: res.status, body: await res.json().catch(() => ({})) }
}

const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
)

async function uploadAndApproveFinal(orderId: string, adminToken: string): Promise<void> {
  const form = new FormData()
  form.append("files", new File([PNG_BYTES], "final.png", { type: "image/png" }))
  const upload = await fetch(`${BASE}/api/admin/requests/${orderId}/final-media`, {
    method: "POST",
    headers: { Cookie: `${COOKIE_NAME}=${buildCookie(adminToken)}` },
    body: form,
  })
  const uploadBody = await upload.json()
  const assetId = uploadBody?.data?.assetIds?.[0]
  if (!assetId) throw new Error(`final upload failed: ${JSON.stringify(uploadBody)}`)

  const approve = await fetch(`${BASE}/api/admin/requests/${orderId}/final-media/${assetId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Cookie: `${COOKIE_NAME}=${buildCookie(adminToken)}` },
    body: JSON.stringify({ action: "approve" }),
  })
  if (approve.status !== 200) throw new Error(`final approve failed: ${approve.status}`)
}

/** Drives an order all the way through in_progress -> (final upload/approve) -> ready -> delivered. */
async function deliverOrder(orderId: string, adminToken: string): Promise<void> {
  let row = await getOrderRow(orderId)
  expect((await adminUpdateStatus(orderId, adminToken, "in_progress", row.updated_at)).status).toBe(200)
  await uploadAndApproveFinal(orderId, adminToken)
  row = await getOrderRow(orderId)
  expect((await adminUpdateStatus(orderId, adminToken, "ready", row.updated_at)).status).toBe(200)
  row = await getOrderRow(orderId)
  expect((await adminUpdateStatus(orderId, adminToken, "delivered", row.updated_at)).status).toBe(200)
}

/** Direct RPC call over PostgREST, authenticated as the given parent. */
async function callDeliveredAtBatch(
  parentAccessToken: string,
  orderIds: string[],
): Promise<Array<{ order_id: string; delivered_at: string }>> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_parent_orders_delivered_at`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: ANON_KEY,
      Authorization: `Bearer ${parentAccessToken}`,
    },
    body: JSON.stringify({ p_order_ids: orderIds }),
  })
  const body = await res.json()
  if (!res.ok) throw new Error(`get_parent_orders_delivered_at: ${res.status} ${JSON.stringify(body)}`)
  return body
}

/** Ground truth, read directly with the service-role key. */
async function earliestDeliveredHistoryTimestamp(orderId: string): Promise<string | null> {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/order_status_history?select=created_at&order_id=eq.${orderId}&new_status=eq.delivered&order=created_at.asc&limit=1`,
    { headers: HDR },
  )
  const rows = await res.json()
  return rows[0]?.created_at ?? null
}

async function getOrdersPage(token: string): Promise<{ status: number; body: string }> {
  const res = await fetch(`${BASE}/dashboard/orders`, {
    headers: { Cookie: `${COOKIE_NAME}=${buildCookie(token)}` },
    redirect: "manual",
  })
  return { status: res.status, body: await res.text() }
}

let adminToken = ""
let adminUserId = ""
let parentA: TestParent
let parentB: TestParent
let orderDelivered = ""
let orderInProgress = ""
let orderReadyNotDelivered = ""
let orderOtherParentDelivered = ""
const cleanupOrderIds: string[] = []

test.describe.configure({ mode: "serial" })
test.beforeEach(() => {
  test.setTimeout(60_000)
})

test.beforeAll(async () => {
  test.setTimeout(180_000)
  const adminEmail = `completedat_admin_${TS}@test.com`
  adminUserId = await createAdminUser(adminEmail)
  adminToken = await adminSessionToken(adminEmail)

  parentA = await createParent("a")
  parentB = await createParent("b")

  orderDelivered = await createOrder(parentA.profileId, "تکمیل‌شده الف")
  orderInProgress = await createOrder(parentA.profileId, "در حال ساخت الف")
  orderReadyNotDelivered = await createOrder(parentA.profileId, "آماده اما تحویل‌نشده الف")
  orderOtherParentDelivered = await createOrder(parentB.profileId, "تکمیل‌شده ب")
  cleanupOrderIds.push(orderDelivered, orderInProgress, orderReadyNotDelivered, orderOtherParentDelivered)

  // 1 — delivered.
  await deliverOrder(orderDelivered, adminToken)

  // 2 — in_progress only.
  const rowIp = await getOrderRow(orderInProgress)
  expect((await adminUpdateStatus(orderInProgress, adminToken, "in_progress", rowIp.updated_at)).status).toBe(200)

  // 3 — ready, but never delivered.
  const rowRnd = await getOrderRow(orderReadyNotDelivered)
  expect((await adminUpdateStatus(orderReadyNotDelivered, adminToken, "in_progress", rowRnd.updated_at)).status).toBe(200)
  await uploadAndApproveFinal(orderReadyNotDelivered, adminToken)
  const rowRnd2 = await getOrderRow(orderReadyNotDelivered)
  expect((await adminUpdateStatus(orderReadyNotDelivered, adminToken, "ready", rowRnd2.updated_at)).status).toBe(200)

  // Parent B's own delivered order, used only for the cross-parent check.
  await deliverOrder(orderOtherParentDelivered, adminToken)
})

test.afterAll(async () => {
  for (const id of cleanupOrderIds) {
    await fetch(`${SUPABASE_URL}/rest/v1/orders?id=eq.${id}`, { method: "DELETE", headers: HDR }).catch(() => {})
  }
  for (const p of [parentA, parentB]) {
    if (!p) continue
    await fetch(`${SUPABASE_URL}/rest/v1/parent_profiles?id=eq.${p.profileId}`, { method: "DELETE", headers: HDR }).catch(() => {})
    await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${p.userId}`, { method: "DELETE", headers: HDR }).catch(() => {})
  }
  if (adminUserId) {
    await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${adminUserId}`, { method: "DELETE", headers: HDR }).catch(() => {})
  }
})

// ── 1-5 — list returns completedAt only for the delivered order ────────────

test("1-5 — the batch RPC returns delivered_at only for the delivered order among a mixed set", async () => {
  const rows = await callDeliveredAtBatch(parentA.accessToken, [
    orderDelivered,
    orderInProgress,
    orderReadyNotDelivered,
  ])
  expect(rows).toHaveLength(1)
  expect(rows[0].order_id).toBe(orderDelivered)
  expect(typeof rows[0].delivered_at).toBe("string")
})

// ── 6 — matches order_status_history exactly ────────────────────────────────

test("6 — delivered_at equals the order_status_history delivered timestamp exactly", async () => {
  const rows = await callDeliveredAtBatch(parentA.accessToken, [orderDelivered])
  const truth = await earliestDeliveredHistoryTimestamp(orderDelivered)
  expect(truth).not.toBeNull()
  expect(rows[0].delivered_at).toBe(truth)
})

// ── 7 — orders.updated_at no longer influences the result ──────────────────

test("7 — mutating orders.updated_at directly does not change delivered_at", async () => {
  const before = (await callDeliveredAtBatch(parentA.accessToken, [orderDelivered]))[0].delivered_at

  await fetch(`${SUPABASE_URL}/rest/v1/orders?id=eq.${orderDelivered}`, {
    method: "PATCH",
    headers: HDR,
    body: JSON.stringify({ updated_at: "2099-01-01T00:00:00.000Z" }),
  })

  const after = (await callDeliveredAtBatch(parentA.accessToken, [orderDelivered]))[0].delivered_at
  expect(after).toBe(before)
})

// ── 8 — another parent's delivered history is never returned ───────────────

test("8 — a parent cannot retrieve another parent's delivered_at, even by id", async () => {
  const asParentA = await callDeliveredAtBatch(parentA.accessToken, [orderOtherParentDelivered])
  expect(asParentA).toHaveLength(0)

  const asParentB = await callDeliveredAtBatch(parentB.accessToken, [orderOtherParentDelivered])
  expect(asParentB).toHaveLength(1)
  expect(asParentB[0].order_id).toBe(orderOtherParentDelivered)
})

// ── 9 — list and detail agree on the exact same timestamp ──────────────────

test("9 — the list batch RPC and the detail single-order RPC agree exactly", async () => {
  const listValue = (await callDeliveredAtBatch(parentA.accessToken, [orderDelivered]))[0].delivered_at

  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_parent_order_status_history`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: ANON_KEY, Authorization: `Bearer ${parentA.accessToken}` },
    body: JSON.stringify({ p_order_id: orderDelivered }),
  })
  const historyRows: Array<{ new_status: string; created_at: string }> = await res.json()
  const deliveredRows = historyRows.filter((r) => r.new_status === "delivered").map((r) => r.created_at)
  const detailValue = deliveredRows.sort()[0]

  expect(detailValue).toBe(listValue)
})

// ── page-level smoke check ──────────────────────────────────────────────────

test("the rendered orders list shows a delivered label only for the delivered order", async () => {
  const { status, body } = await getOrdersPage(parentA.accessToken)
  expect(status).toBe(200)
  expect(body).toContain("تکمیل‌شده الف")
  expect(body).toContain("در حال ساخت الف")
  expect(body).toContain("آماده اما تحویل‌نشده الف")

  // Next's App Router ships the same rendered text twice: once in the DOM
  // and again, JSON-encoded, in its inline RSC hydration payload
  // (`self.__next_f.push(...)`). A raw substring count over the whole body
  // would double the true count, so <script> blocks are stripped first —
  // the label only appears right after a real DOM tag (`>label`) outside
  // them, never JSON-quoted inside one.
  const withoutScripts = body.replace(/<script[\s\S]*?<\/script>/g, "")
  const deliveredLabelCount = withoutScripts.split(">تحویل شده در:").length - 1
  expect(deliveredLabelCount).toBe(1)
})

// ── empty / no-history edge case ────────────────────────────────────────────

test("a non-delivered order returns no row at all from the batch RPC", async () => {
  const rows = await callDeliveredAtBatch(parentA.accessToken, [orderInProgress, orderReadyNotDelivered])
  expect(rows).toHaveLength(0)
})
