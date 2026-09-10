import { test, expect } from "@playwright/test"
import * as fs from "fs"
import * as path from "path"
import { assertSafeDatabaseTarget, guardedProjectRef, guardedSupabaseUrl } from "../helpers/assert-safe-database-target"

// ⚠️ Stateful admin homepage tests. These exercise GET /api/admin/homepage
// and PUT /api/admin/homepage against a disposable/local target ONLY.
// Guarded by assertSafeDatabaseTarget() — must never run against the
// production main project (oucyhmrnzahlhqjfqcge).
//
// Migration awareness: 20260802100000_homepage_cms_foundation.sql and
// 20260802110000_homepage_cms_admin_write.sql are PENDING (not applied to
// main, validated locally/disposable only). When the target lacks the CMS
// tables, GET serves bundled defaults (revision null) and the write path is
// unavailable — the spec asserts that degraded contract instead of writing.

// Base URL of the app under test. Overridable so a run can target an app
// instance started against the guarded project, rather than whatever
// happens to be listening on the default port.
const BASE = process.env.CARTOONA_TEST_BASE_URL || "http://localhost:3000"

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

// Target is derived from the same environment the guard inspected, so the
// guard's verdict and these requests can never describe different projects.
const PROJECT_REF = guardedProjectRef()
const SUPABASE_URL = guardedSupabaseUrl()

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
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: token
      ? { "Content-Type": "application/json", Cookie: `sb-${PROJECT_REF}-auth-token=${buildCookie(token)}` }
      : { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json().catch(() => ({}))
  return { status: res.status, data: data as Record<string, unknown> }
}

const EMAIL_ADMIN = `hapi_admin_${TS}@test.com`
const EMAIL_PARENT = `hapi_parent_${TS}@test.com`

let admin: SyntheticUser
let parent: SyntheticUser

test.beforeAll(async () => {
  test.setTimeout(120000)
  admin = await createUser(EMAIL_ADMIN, "admin")
  parent = await createUser(EMAIL_PARENT, "parent")
})

test.afterAll(async () => {
  for (const u of [admin, parent]) {
    await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${u.id}`, { method: "DELETE", headers: HDR }).catch(() => {})
  }
})

test("unauthenticated GET is 401", async () => {
  const res = await apiReq("/api/admin/homepage")
  expect(res.status).toBe(401)
})

test("parent GET is 403", async () => {
  const res = await apiReq("/api/admin/homepage", "GET", undefined, parent.accessToken)
  expect(res.status).toBe(403)
})

test("admin GET returns content with a revision or a null-revision default", async () => {
  const res = await apiReq("/api/admin/homepage", "GET", undefined, admin.accessToken)
  expect(res.status).toBe(200)
  const content = res.data.content as Record<string, unknown>
  expect(typeof content).toBe("object")
  for (const section of ["hero", "buildOptions", "characters", "safety", "pricing", "testimonials", "faqTeaser", "finalCta"]) {
    expect(content[section], `section ${section}`).toBeDefined()
  }
  expect(res.data.revision === null || typeof res.data.revision === "number").toBe(true)
})

test("admin PUT rejects contract violations with 422 before touching the database", async () => {
  const get = await apiReq("/api/admin/homepage", "GET", undefined, admin.accessToken)
  const content = JSON.parse(JSON.stringify(get.data.content))
  content.hero.primaryCta.href = "javascript:alert(1)"
  const revision = typeof get.data.revision === "number" ? get.data.revision : 1
  const res = await apiReq("/api/admin/homepage", "PUT", { content, expectedRevision: revision }, admin.accessToken)
  expect(res.status).toBe(422)
  expect(res.data.code).toBe("HOMEPAGE_INVALID")
  expect(Array.isArray(res.data.errors)).toBe(true)
})

test("admin PUT rejects a non-integer revision with 400", async () => {
  const get = await apiReq("/api/admin/homepage", "GET", undefined, admin.accessToken)
  const res = await apiReq(
    "/api/admin/homepage", "PUT",
    { content: get.data.content, expectedRevision: "stale" }, admin.accessToken,
  )
  expect(res.status).toBe(400)
})

test("parent PUT is 403", async () => {
  const get = await apiReq("/api/admin/homepage", "GET", undefined, admin.accessToken)
  const revision = typeof get.data.revision === "number" ? get.data.revision : 1
  const res = await apiReq(
    "/api/admin/homepage", "PUT",
    { content: get.data.content, expectedRevision: revision }, parent.accessToken,
  )
  expect(res.status).toBe(403)
})

test("write path: saves with revision bump, rejects stale writes with 409", async () => {
  const get = await apiReq("/api/admin/homepage", "GET", undefined, admin.accessToken)
  if (typeof get.data.revision !== "number") {
    // CMS tables absent on this target (pending migrations): the editor
    // serves defaults and saving is unavailable. Any write attempt must fail
    // safely rather than clobber.
    const res = await apiReq(
      "/api/admin/homepage", "PUT",
      { content: get.data.content, expectedRevision: 1 }, admin.accessToken,
    )
    expect(res.status).not.toBe(200)
    return
  }

  const baseRevision = get.data.revision as number
  const edited = JSON.parse(JSON.stringify(get.data.content))
  const marker = `یادداشت آزمایشی ${TS}`
  edited.safety.note = marker

  // Save succeeds and bumps the revision.
  const saved = await apiReq(
    "/api/admin/homepage", "PUT",
    { content: edited, expectedRevision: baseRevision }, admin.accessToken,
  )
  expect(saved.status).toBe(200)
  expect(saved.data.revision).toBe(baseRevision + 1)

  try {
    // A stale write against the old revision is a 409 with the snapshot.
    const stale = JSON.parse(JSON.stringify(get.data.content))
    stale.safety.note = "نسخه قدیمی"
    const conflict = await apiReq(
      "/api/admin/homepage", "PUT",
      { content: stale, expectedRevision: baseRevision }, admin.accessToken,
    )
    expect(conflict.status).toBe(409)
    expect(conflict.data.code).toBe("HOMEPAGE_CONFLICT")
    expect((conflict.data.content as Record<string, unknown>)).toBeDefined()
    expect(conflict.data.revision).toBe(baseRevision + 1)
  } finally {
    // Restore the original copy so the disposable target is left clean.
    const restore = JSON.parse(JSON.stringify(get.data.content))
    const back = await apiReq(
      "/api/admin/homepage", "PUT",
      { content: restore, expectedRevision: baseRevision + 1 }, admin.accessToken,
    )
    expect(back.status).toBe(200)
  }
})
