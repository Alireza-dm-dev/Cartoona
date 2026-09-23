import { test, expect } from "@playwright/test"
import { assertSafeDatabaseTarget, guardedProjectRef, guardedSupabaseUrl } from "../helpers/assert-safe-database-target"
import { loadTestEnv } from "../helpers/load-test-env"

/**
 * Stateful coverage for the order_status_history append-only fix
 * (20260922120000_fix_order_status_history_append_only.sql).
 *
 * The prior trigger's `pg_trigger_depth() = 0` guard never actually fired —
 * rehearsed directly against this disposable project, a direct UPDATE or
 * DELETE runs the trigger at depth 1, and an FK-cascade DELETE (from
 * deleting the parent order) runs it at depth 2, so `= 0` was unreachable
 * from any caller. This file proves the fixed trigger (`depth <= 1` rejects
 * DELETE, UPDATE is always rejected) actually blocks direct service-role
 * tampering while still letting a cascade delete through, and that nothing
 * about the ordinary fulfilment flow (transitions, deliveredAt) regressed.
 */

loadTestEnv()

const _guard = assertSafeDatabaseTarget()
if (!_guard.ok) throw new Error(`Guard blocked: ${_guard.reason}`)

const PROJECT_REF = guardedProjectRef()
const SUPABASE_URL = guardedSupabaseUrl()
const BASE = process.env.CARTOONA_TEST_BASE_URL || "http://localhost:3000"

const KEY = process.env.SUPABASE_SECRET_KEY || ""
const HDR = { "Content-Type": "application/json", apikey: KEY, Authorization: `Bearer ${KEY}` }
const PASSWORD = "TestPass999!"
const TS = String(Date.now()).slice(-8)
const EMAIL_ADMIN = `aoh_admin_${TS}@test.com`

const COOKIE_NAME = `sb-${PROJECT_REF}-auth-token`

function adminCookie(accessToken: string): string {
  const session = {
    access_token: accessToken,
    refresh_token: "",
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    token_type: "bearer",
  }
  return "base64-" + Buffer.from(JSON.stringify(session)).toString("base64url")
}

async function createAdminUser(email: string): Promise<string> {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: "POST",
    headers: HDR,
    body: JSON.stringify({ email, password: PASSWORD, email_confirm: true }),
  })
  const u = await r.json()
  if (!u.id) throw new Error(`create admin user: ${r.status} ${JSON.stringify(u)}`)
  await fetch(`${SUPABASE_URL}/rest/v1/users`, {
    method: "POST",
    headers: { ...HDR, Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({ id: u.id, email, role: "admin" }),
  }).catch(() => {})
  return u.id
}

async function adminSessionToken(email: string): Promise<string> {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: HDR,
    body: JSON.stringify({ email, password: PASSWORD }),
  })
  const d = await r.json()
  if (!d.access_token) throw new Error(`admin login: ${JSON.stringify(d)}`)
  return d.access_token
}

async function existingParentProfileId(): Promise<string> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/parent_profiles?select=id&limit=1`, { headers: HDR })
  const rows = await r.json()
  if (!rows[0]?.id) throw new Error("no parent_profiles row available to attach a throwaway order to")
  return rows[0].id
}

async function createOrder(parentProfileId: string, title: string): Promise<string> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/orders`, {
    method: "POST",
    headers: { ...HDR, Prefer: "return=representation" },
    body: JSON.stringify({
      parent_id: parentProfileId,
      type: "image",
      status: "pending_review",
      title,
      candy_cost: 15,
      moderation_status: "passed",
    }),
  })
  const rows = await res.json()
  const id = Array.isArray(rows) ? rows[0]?.id : undefined
  if (!id) throw new Error(`order create failed: ${JSON.stringify(rows)}`)
  return id
}

async function getOrderRow(orderId: string): Promise<{ status: string; updated_at: string }> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/orders?select=status,updated_at&id=eq.${orderId}`, { headers: HDR })
  const rows = await res.json()
  return rows[0]
}

async function adminUpdateStatus(
  orderId: string,
  adminToken: string,
  status: string,
  expectedUpdatedAt: string,
  extra: Record<string, unknown> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${BASE}/api/admin/requests/${orderId}/status`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Cookie: `${COOKIE_NAME}=${adminCookie(adminToken)}` },
    body: JSON.stringify({
      status,
      expectedUpdatedAt,
      internalNote: extra.internalNote ?? null,
      parentVisibleNote: extra.parentVisibleNote ?? null,
    }),
  })
  return { status: res.status, body: await res.json().catch(() => ({})) }
}

const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
)

/** ready requires an approved final asset — upload one and approve it. */
async function uploadAndApproveFinal(orderId: string, adminToken: string): Promise<void> {
  const form = new FormData()
  form.append("files", new File([PNG_BYTES], "final.png", { type: "image/png" }))
  const upload = await fetch(`${BASE}/api/admin/requests/${orderId}/final-media`, {
    method: "POST",
    headers: { Cookie: `${COOKIE_NAME}=${adminCookie(adminToken)}` },
    body: form,
  })
  const uploadBody = await upload.json()
  const assetId = uploadBody?.data?.assetIds?.[0]
  if (!assetId) throw new Error(`final upload failed: ${JSON.stringify(uploadBody)}`)

  const approve = await fetch(`${BASE}/api/admin/requests/${orderId}/final-media/${assetId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Cookie: `${COOKIE_NAME}=${adminCookie(adminToken)}` },
    body: JSON.stringify({ action: "approve" }),
  })
  if (approve.status !== 200) throw new Error(`final approve failed: ${approve.status}`)
}

async function historyRows(orderId: string): Promise<Array<Record<string, unknown>>> {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/order_status_history?select=id,order_id,new_status,internal_note,created_at&order_id=eq.${orderId}&order=created_at.asc`,
    { headers: HDR },
  )
  return res.json()
}

let adminToken = ""
let parentProfileId = ""

test.describe.configure({ mode: "serial" })
test.beforeEach(() => {
  test.setTimeout(60_000)
})

test.beforeAll(async () => {
  test.setTimeout(120_000)
  await createAdminUser(EMAIL_ADMIN)
  adminToken = await adminSessionToken(EMAIL_ADMIN)
  parentProfileId = await existingParentProfileId()
})

test.afterAll(async () => {
  await fetch(`${SUPABASE_URL}/auth/v1/admin/users?email=${EMAIL_ADMIN}`, { headers: HDR })
    .then((r) => r.json())
    .then((users) =>
      Promise.all(
        (users || []).map((u: { id: string }) =>
          fetch(`${SUPABASE_URL}/auth/v1/admin/users/${u.id}`, { method: "DELETE", headers: HDR }).catch(() => {}),
        ),
      ),
    )
    .catch(() => {})
})

// ── 1, 9 — legitimate transition still inserts history via the trusted RPC ──

let orderId = ""
let historyRowId = ""

test("1, 9 — a legitimate status transition still inserts a history row", async () => {
  orderId = await createOrder(parentProfileId, "append-only-fixture")
  const row = await getOrderRow(orderId)
  const res = await adminUpdateStatus(orderId, adminToken, "in_progress", row.updated_at, {
    internalNote: "شروع تولید",
  })
  expect(res.status).toBe(200)

  const rows = await historyRows(orderId)
  expect(rows).toHaveLength(1)
  expect(rows[0].new_status).toBe("in_progress")
  expect(rows[0].internal_note).toBe("شروع تولید")
  historyRowId = String(rows[0].id)
})

// ── 2, 4 — direct UPDATE rejected, twice ────────────────────────────────────

async function attemptDirectUpdate(id: string): Promise<number> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/order_status_history?id=eq.${id}`, {
    method: "PATCH",
    headers: HDR,
    body: JSON.stringify({ internal_note: "تلاش برای دستکاری" }),
  })
  return res.status
}

test("2 — a direct service-role UPDATE is rejected", async () => {
  const status = await attemptDirectUpdate(historyRowId)
  expect(status).toBeGreaterThanOrEqual(400)

  const rows = await historyRows(orderId)
  expect(rows[0].internal_note).toBe("شروع تولید")
})

test("4 — a second direct UPDATE attempt is rejected the same way", async () => {
  const status = await attemptDirectUpdate(historyRowId)
  expect(status).toBeGreaterThanOrEqual(400)

  const rows = await historyRows(orderId)
  expect(rows[0].internal_note).toBe("شروع تولید")
})

// ── 3, 5 — direct DELETE rejected, twice ────────────────────────────────────

async function attemptDirectDelete(id: string): Promise<number> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/order_status_history?id=eq.${id}`, {
    method: "DELETE",
    headers: HDR,
  })
  return res.status
}

test("3 — a direct service-role DELETE is rejected", async () => {
  const status = await attemptDirectDelete(historyRowId)
  expect(status).toBeGreaterThanOrEqual(400)

  const rows = await historyRows(orderId)
  expect(rows).toHaveLength(1)
})

test("5 — a second direct DELETE attempt is rejected the same way", async () => {
  const status = await attemptDirectDelete(historyRowId)
  expect(status).toBeGreaterThanOrEqual(400)

  const rows = await historyRows(orderId)
  expect(rows).toHaveLength(1)
})

// ── 6, 7 — cascade delete still works, and only for the deleted order ──────

test("6, 7 — deleting the order cascades its history, leaving an unrelated order's history untouched", async () => {
  const otherOrderId = await createOrder(parentProfileId, "append-only-unrelated")
  const otherRow = await getOrderRow(otherOrderId)
  const otherRes = await adminUpdateStatus(otherOrderId, adminToken, "in_progress", otherRow.updated_at)
  expect(otherRes.status).toBe(200)
  const otherHistoryBefore = await historyRows(otherOrderId)
  expect(otherHistoryBefore).toHaveLength(1)

  const del = await fetch(`${SUPABASE_URL}/rest/v1/orders?id=eq.${orderId}`, { method: "DELETE", headers: HDR })
  expect(del.status).toBeLessThan(300)

  // 6 — the deleted order's history is gone (cascade, not blocked).
  const afterOwn = await historyRows(orderId)
  expect(afterOwn).toHaveLength(0)

  // 7 — a different order's history is completely unaffected.
  const afterOther = await historyRows(otherOrderId)
  expect(afterOther).toHaveLength(1)
  expect(afterOther[0].id).toBe(otherHistoryBefore[0].id)

  await fetch(`${SUPABASE_URL}/rest/v1/orders?id=eq.${otherOrderId}`, { method: "DELETE", headers: HDR })
})

// ── 8 — deliveredAt mapping still works off real history ───────────────────

test("8 — the delivered transition still lands in history for deliveredAt to read", async () => {
  const freshOrderId = await createOrder(parentProfileId, "append-only-delivered")
  let row = await getOrderRow(freshOrderId)
  expect((await adminUpdateStatus(freshOrderId, adminToken, "in_progress", row.updated_at)).status).toBe(200)

  // "ready" requires an approved final asset (update_order_status_trusted §9).
  await uploadAndApproveFinal(freshOrderId, adminToken)

  row = await getOrderRow(freshOrderId)
  expect((await adminUpdateStatus(freshOrderId, adminToken, "ready", row.updated_at)).status).toBe(200)
  row = await getOrderRow(freshOrderId)
  expect((await adminUpdateStatus(freshOrderId, adminToken, "delivered", row.updated_at)).status).toBe(200)

  const rows = await historyRows(freshOrderId)
  const delivered = rows.find((r) => r.new_status === "delivered")
  expect(delivered).toBeTruthy()
  expect(typeof delivered?.created_at).toBe("string")

  await fetch(`${SUPABASE_URL}/rest/v1/orders?id=eq.${freshOrderId}`, { method: "DELETE", headers: HDR })
})
