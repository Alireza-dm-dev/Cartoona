import { test, expect } from "@playwright/test"
import {
  assertSafeDatabaseTarget,
  guardedProjectRef,
  guardedSupabaseUrl,
} from "../helpers/assert-safe-database-target"
import { loadTestEnv } from "../helpers/load-test-env"

/**
 * Stateful coverage for parent-facing final-media delivery (V0.1.17).
 *
 * The admin-side upload/approve/supersede/status-transition backend is
 * already covered end-to-end by admin-request-fulfilment-db.spec.ts; this
 * file exercises the new surface only — the signed-URL endpoint a parent
 * uses to view/download their own order's current final deliverable, and the
 * eligibility boundary around it (before approval, after supersede, across
 * parents). Requires a disposable/local Supabase target and a running dev
 * server; never runs against the main project.
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
const EMAIL_ADMIN = `pfm_admin_${TS}@test.com`

const COOKIE_NAME = `sb-${PROJECT_REF}-auth-token`

const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
)
// Content is never inspected for a real video signature — the storage object
// carries whatever Content-Type the upload declared, and the RPC trusts that
// stored metadata, so any small byte string doubles for "a video file" here.
const FAKE_VIDEO_BYTES = Buffer.from("fake-mp4-bytes-for-test")

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

async function devAuth(body: unknown): Promise<{ status: number; json: Record<string, unknown>; cookies: string[] }> {
  const resp = await fetch(`${BASE}/api/dev/parent-auth`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  return { status: resp.status, json: await resp.json(), cookies: resp.headers.getSetCookie?.() ?? [] }
}

function cookieHeaderFrom(setCookies: string[]): string {
  return setCookies.map((c) => c.split(";")[0]).join("; ")
}

interface Parent {
  userId: string
  profileId: string
  cookie: string
}

/** Sign up a phone-only parent and grant consent — mirrors request-submission.spec.ts. */
async function createParent(tag: string): Promise<Parent> {
  const phone = `09${tag}${TS.slice(0, 7)}`

  const request = await devAuth({ action: "signup_request_code", phone })
  if (request.status !== 200) throw new Error(`signup request failed: ${JSON.stringify(request.json)}`)

  const verify = await devAuth({
    action: "signup_verify_code",
    phone,
    code: request.json.developmentCode,
    challengeToken: request.json.challengeToken,
  })
  if (verify.status !== 200) throw new Error(`signup verify failed: ${JSON.stringify(verify.json)}`)

  const cookie = cookieHeaderFrom(verify.cookies)

  const consent = await fetch(`${BASE}/api/parent-consent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ consentGranted: true }),
  })
  if (!consent.ok) throw new Error("consent failed")

  const devEmail = `parent-98${phone.replace(/^0/, "")}@dev.cartoona.example`
  const users = await (await fetch(`${SUPABASE_URL}/auth/v1/admin/users?per_page=200`, { headers: HDR })).json()
  const user = (users.users || []).find((u: { email: string }) => u.email === devEmail)
  if (!user) throw new Error("created parent user not found")

  const profiles = await (await fetch(
    `${SUPABASE_URL}/rest/v1/parent_profiles?user_id=eq.${user.id}&select=id`,
    { headers: HDR },
  )).json()

  return { userId: user.id, profileId: profiles[0].id, cookie }
}

async function createOrderForParent(profileId: string): Promise<string> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/orders`, {
    method: "POST",
    headers: { ...HDR, Prefer: "return=representation" },
    body: JSON.stringify({
      parent_id: profileId,
      type: "image",
      status: "pending_review",
      title: "درخواست تست تحویل نهایی",
      candy_cost: 15,
      moderation_status: "passed",
    }),
  })
  const rows = await res.json()
  const id = Array.isArray(rows) ? rows[0]?.id : rows?.id
  if (!id) throw new Error(`order create failed: ${JSON.stringify(rows)}`)
  return id
}

async function adminUploadFinal(
  adminToken: string,
  orderId: string,
  fileName: string,
  bytes: Buffer,
  mimeType: string,
): Promise<{ status: number; assetId: string | null }> {
  const form = new FormData()
  form.append("files", new File([bytes], fileName, { type: mimeType }))
  const res = await fetch(`${BASE}/api/admin/requests/${orderId}/final-media`, {
    method: "POST",
    headers: { Cookie: `${COOKIE_NAME}=${adminCookie(adminToken)}` },
    body: form,
  })
  const json = await res.json().catch(() => ({}))
  const assetId = json?.data?.assetIds?.[0] ?? null
  return { status: res.status, assetId }
}

async function getOrderRow(id: string): Promise<{ status: string; updated_at: string }> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/orders?select=status,updated_at&id=eq.${id}`, { headers: HDR })
  const rows = await res.json()
  return rows[0]
}

async function adminUpdateStatus(orderIdToUpdate: string, status: string, expectedUpdatedAt: string): Promise<number> {
  const res = await fetch(`${BASE}/api/admin/requests/${orderIdToUpdate}/status`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Cookie: `${COOKIE_NAME}=${adminCookie(adminToken)}` },
    body: JSON.stringify({ status, expectedUpdatedAt, internalNote: null, parentVisibleNote: null }),
  })
  return res.status
}

async function adminSetFinalState(
  adminToken: string,
  orderId: string,
  assetId: string,
  action: "approve" | "supersede",
): Promise<number> {
  const res = await fetch(`${BASE}/api/admin/requests/${orderId}/final-media/${assetId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Cookie: `${COOKIE_NAME}=${adminCookie(adminToken)}` },
    body: JSON.stringify({ action }),
  })
  return res.status
}

interface ParentFinalMediaResult {
  status: number
  json: Record<string, unknown>
}

async function parentFinalMedia(
  cookie: string,
  orderId: string,
  action?: "view" | "download",
): Promise<ParentFinalMediaResult> {
  // Path-encoded so a traversal/injection payload arrives as a literal path
  // segment for the route to reject, rather than being normalized away by
  // fetch()'s own URL resolution before the request is even sent.
  const res = await fetch(`${BASE}/api/parent/orders/${encodeURIComponent(orderId)}/final-media`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify(action ? { action } : {}),
  })
  return { status: res.status, json: await res.json().catch(() => ({})) }
}

let adminToken = ""
let parentA: Parent
let parentB: Parent
let orderId = ""

test.describe.configure({ mode: "serial" })
test.beforeEach(() => {
  test.setTimeout(120_000)
})

test.beforeAll(async () => {
  test.setTimeout(180_000)
  await createAdminUser(EMAIL_ADMIN)
  adminToken = await adminSessionToken(EMAIL_ADMIN)
  parentA = await createParent("41")
  parentB = await createParent("42")
  orderId = await createOrderForParent(parentA.profileId)
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
  for (const p of [parentA, parentB]) {
    await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${p.userId}`, { method: "DELETE", headers: HDR }).catch(() => {})
  }
})

// ── 2. Before delivery ──────────────────────────────────────────────────────

test("2 — parent cannot access before any final is uploaded", async () => {
  const result = await parentFinalMedia(parentA.cookie, orderId)
  expect(result.status).toBe(404)
  expect(result.json.code).toBe("FINAL_NOT_READY")
})

let firstAssetId = ""

test("1 — admin uploads an image final", async () => {
  const upload = await adminUploadFinal(adminToken, orderId, "final-a.png", PNG_BYTES, "image/png")
  expect(upload.status).toBe(200)
  expect(upload.assetId).toBeTruthy()
  firstAssetId = upload.assetId as string
})

test("2b — parent still cannot access an uploaded-but-not-approved final", async () => {
  const result = await parentFinalMedia(parentA.cookie, orderId)
  expect(result.status).toBe(404)
  expect(result.json.code).toBe("FINAL_NOT_READY")
})

test("15 — parent cannot use the admin upload endpoint", async () => {
  const form = new FormData()
  form.append("files", new File([PNG_BYTES], "x.png", { type: "image/png" }))
  const res = await fetch(`${BASE}/api/admin/requests/${orderId}/final-media`, {
    method: "POST",
    headers: { Cookie: parentA.cookie },
    body: form,
  })
  expect(res.status).toBe(403)
})

test("15b — parent cannot use the admin deliver (approve) endpoint", async () => {
  const res = await fetch(`${BASE}/api/admin/requests/${orderId}/final-media/${firstAssetId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Cookie: parentA.cookie },
    body: JSON.stringify({ action: "approve" }),
  })
  expect(res.status).toBe(403)
})

// ── 3, 4, 5, 7, 13 — delivered and accessible ───────────────────────────────

test("3 — admin delivers (approves) the final", async () => {
  const status = await adminSetFinalState(adminToken, orderId, firstAssetId, "approve")
  expect(status).toBe(200)
})

test("4, 7, 13 — owning parent can view; no raw path leaks; expiry is short", async () => {
  const result = await parentFinalMedia(parentA.cookie, orderId, "view")
  expect(result.status).toBe(200)
  expect(typeof result.json.url).toBe("string")
  expect(result.json.mediaType).toBe("image/png")

  // 7 — the response carries exactly the safe fields. The signed `url` itself
  // necessarily embeds the bucket and storage path (that is what a Supabase
  // signed URL is), so the check is that nothing ELSE exposes them: no bare
  // path/bucket field alongside `url`, and no admin identifier (the media
  // row's own id, distinct from the random filename inside the storage path).
  expect(Object.keys(result.json).sort()).toEqual(["expiresAt", "fileName", "mediaType", "url"])
  const serialized = JSON.stringify(result.json)
  expect(serialized).not.toContain(firstAssetId)
  expect(serialized).not.toContain("bucket_id")

  // The signed URL itself actually works.
  const fetched = await fetch(result.json.url as string)
  expect(fetched.status).toBe(200)

  // 13 — expiresAt is close to 300s from now, not persisted/long-lived.
  const expiresMs = new Date(result.json.expiresAt as string).getTime()
  const deltaSeconds = (expiresMs - Date.now()) / 1000
  expect(deltaSeconds).toBeGreaterThan(250)
  expect(deltaSeconds).toBeLessThan(320)
})

test("5 — owning parent can download, with a download disposition", async () => {
  const result = await parentFinalMedia(parentA.cookie, orderId, "download")
  expect(result.status).toBe(200)
  const fetched = await fetch(result.json.url as string)
  expect(fetched.status).toBe(200)
  const disposition = fetched.headers.get("content-disposition") || ""
  expect(disposition.toLowerCase()).toContain("attachment")
})

// ── 6 — cross-parent isolation ──────────────────────────────────────────────

test("6 — a different parent is denied exactly like a non-existent order", async () => {
  const result = await parentFinalMedia(parentB.cookie, orderId)
  expect(result.status).toBe(404)
  expect(result.json.code).toBe("ORDER_NOT_FOUND")

  const missing = await parentFinalMedia(parentB.cookie, "11111111-1111-4111-8111-111111111111")
  expect(missing.status).toBe(result.status)
  expect(missing.json.code).toBe(result.json.code)
})

// ── 8, 9, 10 — replacement / supersede ──────────────────────────────────────

let secondAssetId = ""

test("8 — admin uploads a replacement final", async () => {
  const upload = await adminUploadFinal(adminToken, orderId, "final-b.png", PNG_BYTES, "image/png")
  expect(upload.status).toBe(200)
  secondAssetId = upload.assetId as string
  expect(secondAssetId).not.toBe(firstAssetId)
})

test("9 — superseding the old final removes parent access to it", async () => {
  const status = await adminSetFinalState(adminToken, orderId, firstAssetId, "supersede")
  expect(status).toBe(200)

  // Neither final is approved+visible right now (B not approved yet), so the
  // parent sees "not ready" again rather than the superseded A.
  const result = await parentFinalMedia(parentA.cookie, orderId)
  expect(result.status).toBe(404)
  expect(result.json.code).toBe("FINAL_NOT_READY")

  const row = await (await fetch(
    `${SUPABASE_URL}/rest/v1/media_assets?id=eq.${firstAssetId}&select=delivery_status,parent_visible,superseded_at`,
    { headers: HDR },
  )).json()
  expect(row[0].delivery_status).toBe("superseded")
  expect(row[0].parent_visible).toBe(false)
  expect(row[0].superseded_at).not.toBeNull()
})

test("10 — approving the replacement makes it the new current final", async () => {
  const status = await adminSetFinalState(adminToken, orderId, secondAssetId, "approve")
  expect(status).toBe(200)

  const result = await parentFinalMedia(parentA.cookie, orderId, "view")
  expect(result.status).toBe(200)
  const fetched = await fetch(result.json.url as string)
  expect(fetched.status).toBe(200)
})

// ── 11 — video final ────────────────────────────────────────────────────────

test("11 — a video final works the same way as an image final", async () => {
  const upload = await adminUploadFinal(adminToken, orderId, "final-video.mp4", FAKE_VIDEO_BYTES, "video/mp4")
  expect(upload.status).toBe(200)
  const videoAssetId = upload.assetId as string

  // Supersede the prior current final first, mirroring the real admin flow.
  expect(await adminSetFinalState(adminToken, orderId, secondAssetId, "supersede")).toBe(200)
  expect(await adminSetFinalState(adminToken, orderId, videoAssetId, "approve")).toBe(200)

  const result = await parentFinalMedia(parentA.cookie, orderId, "view")
  expect(result.status).toBe(200)
  expect(result.json.mediaType).toBe("video/mp4")
})

// ── 14 — anonymous denied ───────────────────────────────────────────────────

test("14 — an anonymous caller is denied", async () => {
  const res = await fetch(`${BASE}/api/parent/orders/${orderId}/final-media`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "view" }),
  })
  expect(res.status).toBe(401)
})

// ── Malformed input ──────────────────────────────────────────────────────────

test("a malformed order id is refused like a missing one", async () => {
  for (const bad of ["not-a-uuid", "../../etc/passwd", "'; drop table orders;--"]) {
    const result = await parentFinalMedia(parentA.cookie, bad)
    expect(result.status, bad).toBe(404)
    expect(result.json.code, bad).toBe("ORDER_NOT_FOUND")
  }
})

test("an invalid action is refused", async () => {
  const res = await fetch(`${BASE}/api/parent/orders/${orderId}/final-media`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: parentA.cookie },
    body: JSON.stringify({ action: "delete" }),
  })
  expect(res.status).toBe(422)
  const body = await res.json()
  expect(body.code).toBe("INVALID_ACTION")
})

// ── 12 — completedAt on the rendered page, driven by the real transition ────

test("12 — the order detail page shows the real delivered date and the final panel", async ({ page, context }) => {
  // Walk the order through the real admin workflow so order_status_history
  // gets a genuine `delivered` row rather than one fabricated for the test.
  let row = await getOrderRow(orderId)
  expect(await adminUpdateStatus(orderId, "in_progress", row.updated_at)).toBe(200)
  row = await getOrderRow(orderId)
  expect(await adminUpdateStatus(orderId, "ready", row.updated_at)).toBe(200)
  row = await getOrderRow(orderId)
  expect(await adminUpdateStatus(orderId, "delivered", row.updated_at)).toBe(200)

  await context.addCookies(
    parentA.cookie.split("; ").map((pair) => {
      const eq = pair.indexOf("=")
      return { name: pair.slice(0, eq), value: pair.slice(eq + 1), domain: "localhost", path: "/" }
    }),
  )

  await page.goto(`${BASE}/dashboard/orders/${orderId}`)

  // completedAt is non-null (rendered) and the final-media panel is present —
  // both come from the same real transition, not a proxy value.
  await expect(page.getByText("تاریخ تحویل", { exact: true })).toBeVisible()
  await expect(page.getByText("کارتون شما آماده است", { exact: false })).toBeVisible()
  await expect(page.getByRole("button", { name: "مشاهده نتیجه" })).toBeVisible()
  await expect(page.getByRole("button", { name: /دانلود/ })).toBeVisible()

  // No broken control: the view/download buttons stay clickable-sized even
  // before the inline preview has finished loading.
  const viewButton = page.getByRole("button", { name: "مشاهده نتیجه" })
  const box = await viewButton.boundingBox()
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(44)
})

test("19 — no horizontal overflow at a phone viewport", async ({ page, context }) => {
  await page.setViewportSize({ width: 375, height: 812 })
  await context.addCookies(
    parentA.cookie.split("; ").map((pair) => {
      const eq = pair.indexOf("=")
      return { name: pair.slice(0, eq), value: pair.slice(eq + 1), domain: "localhost", path: "/" }
    }),
  )
  await page.goto(`${BASE}/dashboard/orders/${orderId}`)
  await expect(page.getByText("کارتون شما آماده است", { exact: false })).toBeVisible()

  const hasOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  )
  expect(hasOverflow).toBe(false)
})
