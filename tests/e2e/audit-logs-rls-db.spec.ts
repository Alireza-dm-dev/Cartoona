import { test, expect } from "@playwright/test"
import { assertSafeDatabaseTarget, guardedSupabaseUrl } from "../helpers/assert-safe-database-target"
import { loadTestEnv } from "../helpers/load-test-env"

/**
 * Stateful coverage for V0.1.20 — public.audit_logs is now under row level
 * security (20260924100000_secure_audit_logs.sql).
 *
 * Before that migration the table had RLS off and no GRANT/REVOKE, so it fell
 * back to Supabase's default public-schema privileges: any signed-in parent
 * could read the whole cross-customer access trail and insert fabricated
 * rows. V0.1.18 is what made this live, by adding the only writer
 * (lib/audit/final-media-audit.ts) recording final_media_view /
 * final_media_download.
 *
 * This talks to PostgREST directly rather than through the app, because the
 * thing under test is the table's own posture, not a route's behaviour — so
 * no dev server is required to run this file.
 */

loadTestEnv()

const _guard = assertSafeDatabaseTarget()
if (!_guard.ok) throw new Error(`Guard blocked: ${_guard.reason}`)

const SUPABASE_URL = guardedSupabaseUrl()
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ""
const KEY = process.env.SUPABASE_SECRET_KEY || ""

const SERVICE_HDR = { "Content-Type": "application/json", apikey: KEY, Authorization: `Bearer ${KEY}` }
const PASSWORD = "TestPass999!"
const TS = String(Date.now()).slice(-8)
const EMAIL_PARENT = `auditrls_parent_${TS}@test.com`

/** Tagged onto every row this spec writes so cleanup can find them again. */
const SENTINEL_ORDER_ID = crypto.randomUUID()
const SENTINEL_TARGET_ID = crypto.randomUUID()

let parentUserId = ""
let parentToken = ""
let preExistingCount = 0

function parentHdr(): Record<string, string> {
  return { "Content-Type": "application/json", apikey: ANON_KEY, Authorization: `Bearer ${parentToken}` }
}

function anonHdr(): Record<string, string> {
  return { "Content-Type": "application/json", apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}` }
}

async function serviceInsertAudit(action: string): Promise<number> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/audit_logs`, {
    method: "POST",
    headers: { ...SERVICE_HDR, Prefer: "return=representation" },
    body: JSON.stringify({
      actor_id: parentUserId,
      action,
      target_type: "media_asset",
      target_id: SENTINEL_TARGET_ID,
      metadata: { orderId: SENTINEL_ORDER_ID },
    }),
  })
  return res.status
}

async function serviceCountAll(): Promise<number> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/audit_logs?select=id`, {
    headers: { ...SERVICE_HDR, Prefer: "count=exact" },
  })
  const rows = await res.json()
  return Array.isArray(rows) ? rows.length : 0
}

async function serviceSentinelRows(): Promise<Array<Record<string, unknown>>> {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/audit_logs?select=id,action,actor_id,target_id&target_id=eq.${SENTINEL_TARGET_ID}`,
    { headers: SERVICE_HDR },
  )
  const rows = await res.json()
  return Array.isArray(rows) ? rows : []
}

test.describe.configure({ mode: "serial" })
test.beforeEach(() => {
  test.setTimeout(60_000)
})

test.beforeAll(async () => {
  test.setTimeout(120_000)

  const created = await (await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: "POST",
    headers: SERVICE_HDR,
    body: JSON.stringify({ email: EMAIL_PARENT, password: PASSWORD, email_confirm: true }),
  })).json()
  if (!created.id) throw new Error(`create parent: ${JSON.stringify(created)}`)
  parentUserId = created.id

  await fetch(`${SUPABASE_URL}/rest/v1/users`, {
    method: "POST",
    headers: { ...SERVICE_HDR, Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({ id: created.id, email: EMAIL_PARENT, role: "parent" }),
  }).catch(() => {})

  const login = await (await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: SERVICE_HDR,
    body: JSON.stringify({ email: EMAIL_PARENT, password: PASSWORD }),
  })).json()
  if (!login.access_token) throw new Error(`parent login: ${JSON.stringify(login)}`)
  parentToken = login.access_token

  // Baseline for the "existing rows preserved" assertion.
  preExistingCount = await serviceCountAll()
})

test.afterAll(async () => {
  await fetch(`${SUPABASE_URL}/rest/v1/audit_logs?target_id=eq.${SENTINEL_TARGET_ID}`, {
    method: "DELETE",
    headers: SERVICE_HDR,
  }).catch(() => {})
  if (parentUserId) {
    await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${parentUserId}`, {
      method: "DELETE",
      headers: SERVICE_HDR,
    }).catch(() => {})
  }
})

// ── service-role writes still work (the regression that matters) ───────────

test("4 — a service-role final_media_view insert still succeeds", async () => {
  const status = await serviceInsertAudit("final_media_view")
  expect(status).toBeGreaterThanOrEqual(200)
  expect(status).toBeLessThan(300)

  const rows = await serviceSentinelRows()
  expect(rows.some((r) => r.action === "final_media_view")).toBe(true)
})

test("5 — a service-role final_media_download insert still succeeds", async () => {
  const status = await serviceInsertAudit("final_media_download")
  expect(status).toBeGreaterThanOrEqual(200)
  expect(status).toBeLessThan(300)

  const rows = await serviceSentinelRows()
  expect(rows.some((r) => r.action === "final_media_download")).toBe(true)
})

// ── browser roles are shut out entirely ────────────────────────────────────

/**
 * Under RLS a denied read can surface either way: a revoked grant gives a
 * hard 401/403 (42501), while a grant with no matching policy gives 200 and
 * an empty set. This migration does both (REVOKE + RLS with no policy), so
 * either shape is acceptable — what must never happen is a real row coming
 * back, which is asserted unconditionally.
 */
async function expectNoReadAccess(headers: Record<string, string>, label: string): Promise<void> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/audit_logs?select=id,action,actor_id,metadata`, { headers })
  const body = await res.json().catch(() => null)
  const rows = Array.isArray(body) ? body : []

  expect(res.status >= 400 || rows.length === 0, `${label} must not read audit_logs (status ${res.status})`).toBe(true)

  const serialized = JSON.stringify(body)
  expect(serialized).not.toContain(SENTINEL_TARGET_ID)
  expect(serialized).not.toContain("final_media_view")
  expect(serialized).not.toContain("final_media_download")
}

test("1 — anon cannot SELECT audit_logs", async () => {
  await expectNoReadAccess(anonHdr(), "anon")
})

test("2 — an authenticated parent cannot SELECT audit_logs", async () => {
  await expectNoReadAccess(parentHdr(), "authenticated parent")

  // Targeted read of a row that definitely exists — proves the denial is not
  // just an empty table.
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/audit_logs?select=id,action&target_id=eq.${SENTINEL_TARGET_ID}`,
    { headers: parentHdr() },
  )
  const body = await res.json().catch(() => null)
  const rows = Array.isArray(body) ? body : []
  expect(res.status >= 400 || rows.length === 0).toBe(true)
})

test("3 — an authenticated parent cannot INSERT into audit_logs", async () => {
  const forgedTargetId = crypto.randomUUID()
  const res = await fetch(`${SUPABASE_URL}/rest/v1/audit_logs`, {
    method: "POST",
    headers: parentHdr(),
    body: JSON.stringify({
      actor_id: parentUserId,
      action: "final_media_view",
      target_type: "media_asset",
      target_id: forgedTargetId,
      metadata: { forged: true },
    }),
  })
  expect(res.status).toBeGreaterThanOrEqual(400)

  // And nothing landed, verified with the service role.
  const check = await fetch(
    `${SUPABASE_URL}/rest/v1/audit_logs?select=id&target_id=eq.${forgedTargetId}`,
    { headers: SERVICE_HDR },
  )
  const rows = await check.json()
  expect(Array.isArray(rows) ? rows : []).toHaveLength(0)
})

// ── existing data is untouched by the migration ────────────────────────────

test("6 — existing rows are preserved", async () => {
  const rows = await serviceSentinelRows()
  expect(rows).toHaveLength(2)

  // The baseline rows captured before this spec wrote anything are still
  // there: the total is the pre-existing count plus exactly our two inserts.
  const total = await serviceCountAll()
  expect(total).toBe(preExistingCount + 2)
})
