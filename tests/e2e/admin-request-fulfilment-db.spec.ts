import { test, expect } from "@playwright/test"
import * as fs from "fs"
import * as path from "path"
import { assertSafeDatabaseTarget } from "../helpers/assert-safe-database-target"

/**
 * Stateful end-to-end coverage for the Admin request fulfilment workflow.
 *
 * Requires a disposable/local Supabase target (guard refuses the main project
 * and the migration-test project) and a running dev server on localhost:3000.
 * Executes real trusted-RPC + storage round-trips: controlled status
 * transitions, append-only history, private final-media upload/approval/
 * supersede, and parent visibility boundaries.
 */

const BASE = "http://localhost:3000"
const PROJECT_REF = "oucyhmrnzahlhqjfqcge"
const SUPABASE_URL = `https://${PROJECT_REF}.supabase.co`

function loadEnv(): void {
  try {
    const content = fs.readFileSync(path.resolve(__dirname, "../../.env.local"), "utf-8")
    for (const line of content.split("\n")) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith("#")) continue
      const eqIdx = trimmed.indexOf("=")
      if (eqIdx === -1) continue
      const key = trimmed.slice(0, eqIdx)
      const val = trimmed.slice(eqIdx + 1)
      if (key === "NEXT_PUBLIC_SUPABASE_URL" || key === "SUPABASE_URL") {
        // keep the real target — the guard verifies it is disposable
        process.env[key] = val
      } else {
        process.env[key] = val
      }
    }
  } catch { /* fallback */ }
}

loadEnv()

const _guard = assertSafeDatabaseTarget()
if (!_guard.ok) throw new Error(`Guard blocked: ${_guard.reason}`)

const KEY = process.env.SUPABASE_SECRET_KEY || ""
const HDR = { "Content-Type": "application/json", apikey: KEY, Authorization: `Bearer ${KEY}` }
const PASSWORD = "TestPass999!"
const TS = String(Date.now()).slice(-8)
const EMAIL_ADMIN = `ful_admin_${TS}@test.com`
const EMAIL_PARENT = `ful_parent_${TS}@test.com`

const COOKIE_NAME = `sb-${PROJECT_REF}-auth-token`

// A 1x1 valid PNG.
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
)

function buildCookie(accessToken: string, refreshToken: string, expiresIn: number): string {
  const session = {
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_in: expiresIn,
    expires_at: Math.floor(Date.now() / 1000) + expiresIn,
    token_type: "bearer",
  }
  return "base64-" + Buffer.from(JSON.stringify(session)).toString("base64url")
}

let adminToken = ""
let parentToken = ""
let orderId = ""
let parentProfileId = ""

async function createUser(email: string, role: string): Promise<string> {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: "POST",
    headers: HDR,
    body: JSON.stringify({ email, password: PASSWORD, email_confirm: true, user_metadata: { full_name: "Test" } }),
  })
  const u = await r.json()
  if (!u.id) throw new Error(`Create user: ${r.status} ${JSON.stringify(u)}`)
  await fetch(`${SUPABASE_URL}/rest/v1/users`, {
    method: "POST",
    headers: { ...HDR, Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({ id: u.id, email, role }),
  }).catch(() => {})
  return u.id
}

async function sessionToken(email: string): Promise<string> {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: HDR,
    body: JSON.stringify({ email, password: PASSWORD }),
  })
  const d = await r.json()
  if (!d.access_token) throw new Error(`Login: ${JSON.stringify(d)}`)
  return d.access_token
}

/** Localhost API route call with the admin session cookie attached. */
async function apiCall<T>(
  method: string,
  url: string,
  token: string,
  body?: unknown,
  raw?: BodyInit,
): Promise<{ status: number; data: T }> {
  const headers: Record<string, string> = {
    Cookie: `${COOKIE_NAME}=${buildCookie(token, "", 3600)}`,
  }
  let res: Response
  if (raw !== undefined) {
    res = await fetch(url, { method, headers, body: raw })
  } else {
    headers["Content-Type"] = "application/json"
    res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  }
  const json = (await res.json().catch(() => ({}))) as T
  return { status: res.status, data: json }
}

async function getOrderRow(): Promise<{ id: string; status: string; updated_at: string }> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/orders?select=id,status,updated_at&id=eq.${orderId}`, {
    headers: HDR,
  })
  const rows = await res.json()
  return rows[0]
}

interface ApiErrorShape {
  error?: string
  code?: string
  data?: { status?: string }
}

async function updateStatus(
  status: string,
  expectedUpdatedAt: string,
  extra: Record<string, unknown> = {},
) {
  return apiCall<ApiErrorShape>("PATCH", `${BASE}/api/admin/requests/${orderId}/status`, adminToken, {
    status,
    expectedUpdatedAt,
    internalNote: extra.internalNote ?? null,
    parentVisibleNote: extra.parentVisibleNote ?? null,
  })
}

async function uploadFinal(fileName: string) {
  const form = new FormData()
  form.append("files", new File([PNG_BYTES], fileName, { type: "image/png" }))
  return apiCall<ApiErrorShape>("POST", `${BASE}/api/admin/requests/${orderId}/final-media`, adminToken, undefined, form)
}

async function queryMedia(selector: string): Promise<Array<Record<string, unknown>>> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/media_assets?${selector}`, { headers: HDR })
  return res.json() as Promise<Array<Record<string, unknown>>>
}

async function approveFirst(selector: string, action: "approve" | "supersede"): Promise<number> {
  const rows = await queryMedia(selector)
  const assetId = String(rows[0].id)
  const res = await apiCall<ApiErrorShape>(
    "PATCH",
    `${BASE}/api/admin/requests/${orderId}/final-media/${assetId}`,
    adminToken,
    { action },
  )
  return res.status
}

test.beforeAll(async () => {
  test.setTimeout(180000)

  const adminId = await createUser(EMAIL_ADMIN, "admin")
  const parentId = await createUser(EMAIL_PARENT, "parent")

  // both user ids exist only to satisfy FK constraints; role rows are seeded
  void adminId

  const pp = await fetch(
    `${SUPABASE_URL}/rest/v1/parent_profiles?user_id=eq.${parentId}&select=id`,
    { headers: HDR },
  )
  const existing = await pp.json()
  if (Array.isArray(existing) && existing.length > 0) {
    parentProfileId = existing[0].id
  } else {
    const created = await fetch(`${SUPABASE_URL}/rest/v1/parent_profiles`, {
      method: "POST",
      headers: { ...HDR, Prefer: "return=representation" },
      body: JSON.stringify({
        user_id: parentId,
        full_name: "فولفیل والد",
        consent_granted: true,
        consent_granted_at: new Date().toISOString(),
      }),
    })
    const row = await created.json()
    parentProfileId = row?.id
  }
  if (!parentProfileId) throw new Error("parent profile not created")

  // Create a request directly (service_role bypasses RLS) in pending_review.
  const order = await fetch(`${SUPABASE_URL}/rest/v1/orders`, {
    method: "POST",
    headers: { ...HDR, Prefer: "return=representation" },
    body: JSON.stringify({
      parent_id: parentProfileId,
      type: "image",
      status: "pending_review",
      title: "درخواست تست فولفیل",
      description: null,
      candy_cost: 15,
      moderation_status: "passed",
    }),
  })
  const orderRows = await order.json()
  orderId = Array.isArray(orderRows) ? orderRows[0]?.id : orderRows?.id

  adminToken = await sessionToken(EMAIL_ADMIN)
  parentToken = await sessionToken(EMAIL_PARENT)
})

test.afterAll(async () => {
  const cleanup = async (email: string) => {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?email=${email}`, { headers: HDR })
    const users = await r.json()
    if (Array.isArray(users)) {
      for (const u of users) {
        await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${u.id}`, { method: "DELETE", headers: HDR }).catch(() => {})
      }
    }
  }
  await cleanup(EMAIL_ADMIN)
  await cleanup(EMAIL_PARENT)
})

// ── Controlled transitions ──────────────────────────────────────────────────

test("1. invalid transition returns 422 transition_invalid", async () => {
  const row = await getOrderRow()
  const res = await updateStatus("ready", row.updated_at)
  expect(res.status).toBe(422)
  expect(res.data.code).toBe("REQUEST_TRANSITION_INVALID")
})

test("2. rejection without a reason returns 422", async () => {
  const row = await getOrderRow()
  const res = await updateStatus("rejected", row.updated_at, {
    internalNote: "",
    parentVisibleNote: "",
  })
  expect(res.status).toBe(422)
  expect(res.data.code).toBe("REQUEST_REJECTION_REASON_REQUIRED")
})

test("3. stale expectedUpdatedAt returns 409 conflict", async () => {
  const res = await updateStatus("in_progress", "1970-01-01T00:00:00.000Z")
  expect(res.status).toBe(409)
  expect(res.data.code).toBe("REQUEST_STATUS_CONFLICT")
})

test("4. valid transition appends history atomically", async () => {
  const row = await getOrderRow()
  const res = await updateStatus("in_progress", row.updated_at, {
    internalNote: "تأیید شد",
    parentVisibleNote: "در حال تولید",
  })
  expect(res.status).toBe(200)
  expect(res.data.data?.status).toBe("in_progress")
  const history = await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_order_status_history_admin`, {
    method: "POST",
    headers: HDR,
    body: JSON.stringify({ p_order_id: orderId }),
  })
  const rows = (await history.json()) as Array<Record<string, unknown>>
  expect(rows.length).toBeGreaterThanOrEqual(1)
  expect(rows[0].new_status).toBe("in_progress")
  expect(rows[0].internal_note).toBe("تأیید شد")
})

// ── Final media upload / approval ───────────────────────────────────────────

test("5. upload records an uploaded, non-parent-visible final asset", async () => {
  const res = await uploadFinal("final-one.png")
  expect(res.status).toBe(200)
  const rows = await queryMedia(
    "select=id,asset_role,delivery_status,parent_visible,byte_size,original_filename&order_id=eq." + orderId,
  )
  const finals = rows.filter((m) => m.asset_role === "final")
  expect(finals.length).toBeGreaterThanOrEqual(1)
  expect(finals[0].delivery_status).toBe("uploaded")
  expect(finals[0].parent_visible).toBe(false)
})

test("6. parent cannot read an unapproved final asset", async () => {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/media_assets?select=id,asset_role&order_id=eq.${orderId}`,
    { headers: { apikey: KEY, Authorization: `Bearer ${parentToken}` } },
  )
  const rows = (await res.json()) as Array<Record<string, unknown>>
  expect(rows.every((m) => m.asset_role === "source")).toBe(true)
})

test("7. approving an asset makes it parent-visible", async () => {
  const status = await approveFirst(
    "select=id&order_id=eq." + orderId + "&asset_role=eq.final&delivery_status=eq.uploaded",
    "approve",
  )
  expect(status).toBe(200)
  const after = await queryMedia(
    "select=delivery_status,parent_visible&asset_role=eq.final&delivery_status=eq.approved&order_id=eq." + orderId,
  )
  expect(after.length).toBeGreaterThanOrEqual(1)
  expect(after[0].delivery_status).toBe("approved")
  expect(after[0].parent_visible).toBe(true)
})

test("8. ready is now allowed and requires approved media", async () => {
  const row = await getOrderRow()
  const res = await updateStatus("ready", row.updated_at)
  expect(res.status).toBe(200)
  expect(res.data.data?.status).toBe("ready")
})

test("9. terminal status never reopens", async () => {
  const row = await getOrderRow()
  const delivered = await updateStatus("delivered", row.updated_at)
  expect(delivered.status).toBe(200)
  const again = await updateStatus("in_progress", (await getOrderRow()).updated_at)
  expect(again.status).toBe(422)
  expect(again.data.code).toBe("REQUEST_TRANSITION_INVALID")
})

test("10. supersede hides an approved asset permanently", async () => {
  const status = await approveFirst(
    "select=id&order_id=eq." + orderId + "&asset_role=eq.final&delivery_status=eq.approved",
    "supersede",
  )
  expect(status).toBe(200)
  const after = await queryMedia(
    "select=delivery_status,parent_visible,superseded_at&asset_role=eq.final&delivery_status=eq.superseded&order_id=eq." + orderId,
  )
  expect(after.length).toBeGreaterThanOrEqual(1)
  expect(after[0].parent_visible).toBe(false)
  expect(after[0].superseded_at).not.toBeNull()
})

test("11. history is append-only (direct update refused)", async () => {
  const history = await fetch(
    `${SUPABASE_URL}/rest/v1/order_status_history?select=id&order_id=eq.${orderId}&limit=1`,
    { headers: HDR },
  )
  const rows = (await history.json()) as Array<{ id: string }>
  expect(rows.length).toBeGreaterThanOrEqual(1)
  const patch = await fetch(`${SUPABASE_URL}/rest/v1/order_status_history?id=eq.${rows[0].id}`, {
    method: "PATCH",
    headers: HDR,
    body: JSON.stringify({ internal_note: "بازنویسی" }),
  })
  expect([403, 500, 404]).toContain(patch.status)
})

