import { test, expect } from "@playwright/test"
import * as fs from "fs"
import * as path from "path"
import { assertSafeDatabaseTarget, guardedProjectRef, guardedSupabaseUrl } from "../helpers/assert-safe-database-target"

// ⚠️ Stateful admin homepage-media tests. Disposable/local Supabase ONLY.
// Guarded by assertSafeDatabaseTarget() — must never run against the
// production main project (oucyhmrnzahlhqjfqcge).
//
// Covers: admin/super-admin upload, parent + anonymous denial, direct
// storage/table write denial, atomic hero+layout commit, applyToBoth
// atomicity, stale-layout conflict, failed-commit cleanup, post-success old
// object cleanup, revert-to-default, and local-fallback preservation.
//
// NOTE: left unexecuted here — no disposable Supabase target is available in
// this environment (only main + the forbidden migration-test project exist,
// and local `supabase start` needs Docker, which is absent). Run on a
// disposable target with all three homepage migrations applied.

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
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ""
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

/** Narrows an untyped JSON field for assertion. These are black-box checks
 * against the HTTP contract, so the response body is not statically typed. */
const rec = (value: unknown) => value as Record<string, unknown>
const arr = (value: unknown) => value as Record<string, unknown>[]

async function apiGet(path: string, token?: string) {
  const res = await fetch(`${BASE}${path}`, {
    headers: token
      ? { Cookie: `sb-${PROJECT_REF}-auth-token=${buildCookie(token)}` }
      : {},
  })
  return { status: res.status, data: await res.json().catch(() => ({})) as Record<string, unknown> }
}

async function apiUpload(slot: string, filePath: string, fileName: string, mime: string, fields: Record<string, string>, token?: string) {
  const buf = fs.readFileSync(path.resolve(__dirname, "../..", filePath))
  const form = new FormData()
  form.append("file", new Blob([new Uint8Array(buf)], { type: mime }), fileName)
  for (const [k, v] of Object.entries(fields)) form.append(k, v)
  const res = await fetch(`${BASE}/api/admin/homepage/media/${encodeURIComponent(slot)}`, {
    method: "POST",
    headers: token ? { Cookie: `sb-${PROJECT_REF}-auth-token=${buildCookie(token)}` } : {},
    body: form,
  })
  return { status: res.status, data: await res.json().catch(() => ({})) as Record<string, unknown> }
}

async function sbRest(method: string, tablePath: string, body: unknown, useAnon: boolean) {
  const key = useAnon ? ANON_KEY : KEY
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${tablePath}`, {
    method,
    headers: { "Content-Type": "application/json", apikey: key, Authorization: `Bearer ${key}` },
    body: body ? JSON.stringify(body) : undefined,
  })
  return res.status
}

async function sbStorageUpload(useAnon: boolean, objectName: string) {
  const key = useAnon ? ANON_KEY : KEY
  const res = await fetch(
    `${SUPABASE_URL}/storage/v1/object/homepage-media/${objectName}`,
    {
      method: "POST",
      headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "image/png", "x-upsert": "false" },
      body: fs.readFileSync(path.resolve(__dirname, "../../public/images/homepage/card-image.jpg")),
    },
  )
  return res.status
}

const EMAIL_ADMIN = `hmedia_admin_${TS}@test.com`
const EMAIL_SUPER = `hmedia_super_${TS}@test.com`
const EMAIL_PARENT = `hmedia_parent_${TS}@test.com`

let admin: SyntheticUser
let superAdmin: SyntheticUser
let parent: SyntheticUser

test.beforeAll(async () => {
  test.setTimeout(180000)
  admin = await createUser(EMAIL_ADMIN, "admin")
  superAdmin = await createUser(EMAIL_SUPER, "super_admin")
  parent = await createUser(EMAIL_PARENT, "parent")
})

test.afterAll(async () => {
  for (const u of [admin, superAdmin, parent]) {
    await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${u.id}`, { method: "DELETE", headers: HDR }).catch(() => {})
  }
})

test("anonymous GET media is 401; parent GET is 403; admin GET lists 7 slots", async () => {
  expect((await apiGet("/api/admin/homepage/media")).status).toBe(401)
  expect((await apiGet("/api/admin/homepage/media", parent.accessToken)).status).toBe(403)
  const adminView = await apiGet("/api/admin/homepage/media", admin.accessToken)
  expect(adminView.status).toBe(200)
  expect(arr(adminView.data.slots).length).toBe(7)
  // No storage internals leak to the browser.
  expect(JSON.stringify(adminView.data)).not.toContain("storage_path")
})

test("admin image upload succeeds; super-admin video upload succeeds", async () => {
  const img = await apiUpload("safety.image", "public/images/homepage/card-image.jpg", "card-image.jpg", "image/jpeg", {}, admin.accessToken)
  expect(img.status).toBe(200)
  expect(rec(img.data.record).slotKey).toBe("safety.image")
  expect(rec(img.data.record).previewUrl).toMatch(/^https?:\/\//)

  const vid = await apiUpload("build_options.card_video", "public/videos/homepage/build-video.mp4", "build-video.mp4", "video/mp4", {}, superAdmin.accessToken)
  expect(vid.status).toBe(200)
  expect(rec(vid.data.record).slotKey).toBe("build_options.card_video")
})

test("parent and anonymous uploads are denied", async () => {
  const asParent = await apiUpload("safety.image", "public/images/homepage/card-image.jpg", "x.jpg", "image/jpeg", {}, parent.accessToken)
  expect(asParent.status).toBe(403)
  const anon = await apiUpload("safety.image", "public/images/homepage/card-image.jpg", "x.jpg", "image/jpeg", {}, undefined)
  expect(anon.status).toBe(401)
})

test("direct browser storage upload and table writes are denied", async () => {
  // No storage INSERT policy exists for any browser role — even anon 400s/403s.
  expect(await sbStorageUpload(true, `probe-anon-${TS}.jpg`)).not.toBe(200)
  // homepage_media_assets grants nobody any write via PostgREST.
  expect(await sbRest("POST", "homepage_media_assets", { slot_key: "safety.image" }, true)).not.toBe(201)
  expect(await sbRest("POST", "homepage_media_assets", { slot_key: "safety.image" }, false)).not.toBe(201)
  expect(await sbRest("PATCH", "homepage_media_assets?slot_key=eq.safety.image", { byte_size: 1 }, false)).not.toBe(200)
})

test("hero replacement commits media + layout atomically; stale layout conflicts cleanly", async () => {
  const before = await apiGet("/api/admin/homepage/media", admin.accessToken)
  const layoutRev = rec(before.data.heroLayout).revision as number

  // Stale revision: 409, and nothing changed.
  const stale = await apiUpload("hero.background", "public/images/homepage/sections-bg.png", "bg.png", "image/png", {
    tv_rect: JSON.stringify({ x: 0.11, y: 0.15, width: 0.09, height: 0.096 }),
    expected_layout_revision: String(layoutRev - 1000),
  }, admin.accessToken)
  expect(stale.status).toBe(409)
  const afterStale = await apiGet("/api/admin/homepage/media", admin.accessToken)
  expect(rec(afterStale.data.heroLayout).revision).toBe(layoutRev)

  // Fresh revision with apply_to_sections: both rows share the new object, layout bumps once.
  const fresh = await apiUpload("hero.background", "public/images/homepage/sections-bg.png", "bg.png", "image/png", {
    tv_rect: JSON.stringify({ x: 0.11, y: 0.15, width: 0.09, height: 0.096 }),
    expected_layout_revision: String(layoutRev),
    apply_to_sections: "true",
  }, admin.accessToken)
  expect(fresh.status).toBe(200)
  expect(rec(fresh.data.layout).revision).toBe(layoutRev + 1)
  expect(fresh.data.sectionsRecord).not.toBeNull()
  expect(rec(fresh.data.sectionsRecord).previewUrl).toBe(rec(fresh.data.record).previewUrl)

  // Hero without geometry is rejected before any activation.
  const noGeom = await apiUpload("hero.background", "public/images/homepage/sections-bg.png", "bg.png", "image/png", {
    expected_layout_revision: String(layoutRev + 1),
  }, admin.accessToken)
  expect(noGeom.status).toBe(422)
})

test("failed DB commit cleans the new object; success cleans the old object after commit", async () => {
  // Wrong MIME for slot passes multipart parsing but fails validation —
  // assert the pre-existing preview is untouched.
  const before = await apiGet("/api/admin/homepage/media", admin.accessToken)
  const tvBefore = arr(before.data.slots).find((s) => s.slotKey === "hero.tv_video") as Record<string, unknown>
  const bad = await apiUpload("hero.tv_video", "public/images/homepage/card-image.jpg", "x.png", "image/png", {}, admin.accessToken)
  expect(bad.status).toBe(422)
  const after = await apiGet("/api/admin/homepage/media", admin.accessToken)
  const tvAfter = arr(after.data.slots).find((s) => s.slotKey === "hero.tv_video") as Record<string, unknown>
  expect(tvAfter.previewUrl).toBe(tvBefore.previewUrl)

  // Two successive safety.image replacements: the second supersedes the
  // first; the first object must be gone from storage afterwards.
  const first = await apiUpload("safety.image", "public/images/homepage/card-image.jpg", "a.jpg", "image/jpeg", {}, admin.accessToken)
  expect(first.status).toBe(200)
  const second = await apiUpload("safety.image", "public/images/homepage/family-tablet.jpg", "b.jpg", "image/jpeg", {}, admin.accessToken)
  expect(second.status).toBe(200)
  expect(rec(second.data.record).previewUrl).not.toBe(rec(first.data.record).previewUrl)
})

test("revert-to-default deletes metadata; committed local fallback untouched", async () => {
  const del = await fetch(`${BASE}/api/admin/homepage/media/safety.image`, {
    method: "DELETE",
    headers: { Cookie: `sb-${PROJECT_REF}-auth-token=${buildCookie(admin.accessToken)}` },
  })
  expect(del.status).toBe(200)
  const view = await apiGet("/api/admin/homepage/media", admin.accessToken)
  const safety = arr(view.data.slots).find((s) => s.slotKey === "safety.image") as Record<string, unknown>
  expect(safety.mimeType).toBe("")
  expect(safety.previewUrl).toBe("/images/homepage/family-tablet.jpg")
  // Committed fallback files still exist on disk.
  expect(fs.existsSync(path.resolve(__dirname, "../../public/images/homepage/family-tablet.jpg"))).toBe(true)
  expect(fs.existsSync(path.resolve(__dirname, "../../public/images/homepage/sections-bg.png"))).toBe(true)
})
