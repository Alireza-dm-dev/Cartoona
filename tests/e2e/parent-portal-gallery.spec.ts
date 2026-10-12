import { test, expect } from "@playwright/test"
import { loadTestEnv } from "../helpers/load-test-env"
import {
  assertSafeDatabaseTarget,
  guardedProjectRef,
  guardedSupabaseUrl,
} from "../helpers/assert-safe-database-target"

// ⚠️ Stateful parent-portal tests. These create synthetic parents, orders and
// private storage objects, so they run against a disposable/local target ONLY,
// never the production main project. assertSafeDatabaseTarget() gates the whole
// file, and both the Supabase URL and the auth cookie name are derived from the
// same environment the guard inspected, so the guard's verdict is binding on
// every request.

function loadEnv(): void {
  loadTestEnv()
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

/** Smallest valid PNG, used as a real storage object so previews can sign. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
)

function buildCookie(at: string): string {
  return "base64-" + Buffer.from(JSON.stringify({
    access_token: at, refresh_token: "", expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600, token_type: "bearer",
  })).toString("base64url")
}

function cookieFor(token: string): Record<string, string> {
  return { Cookie: `sb-${PROJECT_REF}-auth-token=${buildCookie(token)}` }
}

interface TestParent {
  userId: string
  profileId: string
  email: string
  accessToken: string
}

async function createParent(tag: string): Promise<TestParent> {
  const email = `portal-gallery-${tag}-${TS}@example.com`

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

async function createOrder(parentId: string, over: Record<string, unknown> = {}): Promise<string> {
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

/**
 * Put a real object in the private bucket and register it as a source upload,
 * mirroring exactly what the request API produces.
 */
async function createSourceAsset(
  parent: TestParent,
  orderId: string,
  fileName: string,
): Promise<{ id: string; path: string }> {
  const storagePath = `${parent.userId}/${orderId}/${fileName}`

  const up = await fetch(`${SUPABASE_URL}/storage/v1/object/parent-uploads/${storagePath}`, {
    method: "POST",
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "image/png" },
    body: PNG,
  })
  if (!up.ok) throw new Error(`upload ${storagePath}: ${await up.text()}`)

  const res = await fetch(`${SUPABASE_URL}/rest/v1/media_assets`, {
    method: "POST", headers: { ...HDR, Prefer: "return=representation" },
    body: JSON.stringify({
      order_id: orderId, type: "upload", asset_role: "source",
      file_url: storagePath, mime_type: "image/png", original_filename: fileName,
    }),
  })
  const row = (await res.json())[0]
  if (!row?.id) throw new Error(`asset: ${JSON.stringify(row)}`)
  return { id: row.id, path: storagePath }
}

let parentA: TestParent
let parentB: TestParent
let assetA: { id: string; path: string }
let assetB: { id: string; path: string }
let finalAssetId: string
let characterId: string
const orderIds: string[] = []
const storagePaths: string[] = []

/** Enough candy for an image request with a reference file. */
async function fundWallet(profileId: string): Promise<void> {
  await fetch(`${SUPABASE_URL}/rest/v1/candy_wallets?parent_id=eq.${profileId}`, {
    method: "PATCH", headers: HDR, body: JSON.stringify({ balance: 100000 }),
  })
}

test.beforeAll(async () => {
  parentA = await createParent("a")
  parentB = await createParent("b")

  const orderA = await createOrder(parentA.profileId, { title: "سفارش الف" })
  const orderB = await createOrder(parentB.profileId, { title: "سفارش ب" })
  orderIds.push(orderA, orderB)

  assetA = await createSourceAsset(parentA, orderA, "child-a.png")
  assetB = await createSourceAsset(parentB, orderB, "child-b.png")
  storagePaths.push(assetA.path, assetB.path)

  // A delivered asset on parent A's order. The library must not show it.
  const finalPath = `${parentA.userId}/${orderA}/final-a.png`
  await fetch(`${SUPABASE_URL}/storage/v1/object/parent-uploads/${finalPath}`, {
    method: "POST",
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "image/png" },
    body: PNG,
  })
  storagePaths.push(finalPath)
  const finalRes = await fetch(`${SUPABASE_URL}/rest/v1/media_assets`, {
    method: "POST", headers: { ...HDR, Prefer: "return=representation" },
    body: JSON.stringify({
      order_id: orderA, type: "generated", asset_role: "final",
      delivery_status: "approved", parent_visible: true,
      file_url: finalPath, mime_type: "image/png", original_filename: "final-a.png",
    }),
  })
  finalAssetId = (await finalRes.json())[0]?.id

  const charRes = await fetch(`${SUPABASE_URL}/rest/v1/characters`, {
    method: "POST", headers: { ...HDR, Prefer: "return=representation" },
    body: JSON.stringify({
      name: `شخصیت آزمایشی ${TS}`, description: "برای آزمون", category: "Adventure",
    }),
  })
  characterId = (await charRes.json())[0]?.id
  if (!characterId) throw new Error("character fixture could not be created")

  await fundWallet(parentA.profileId)
})

test.afterAll(async () => {
  await fetch(`${SUPABASE_URL}/storage/v1/object/parent-uploads`, {
    method: "DELETE", headers: HDR, body: JSON.stringify({ prefixes: storagePaths }),
  }).catch(() => {})
  for (const id of orderIds) {
    await fetch(`${SUPABASE_URL}/rest/v1/orders?id=eq.${id}`, { method: "DELETE", headers: HDR }).catch(() => {})
  }
  if (characterId) {
    await fetch(`${SUPABASE_URL}/rest/v1/characters?id=eq.${characterId}`, { method: "DELETE", headers: HDR }).catch(() => {})
  }
  // A parent whose request actually succeeded has an immutable candy_transactions
  // row, and that ledger is append-only by design — so their profile and user
  // rows cannot be removed. The delete is attempted and its failure ignored:
  // the residue is a synthetic parent on the disposable project, and forcing it
  // away would mean weakening the ledger guard, which is not worth it.
  for (const p of [parentA, parentB]) {
    if (!p) continue
    await fetch(`${SUPABASE_URL}/rest/v1/parent_profiles?user_id=eq.${p.userId}`, { method: "DELETE", headers: HDR }).catch(() => {})
    await fetch(`${SUPABASE_URL}/rest/v1/users?id=eq.${p.userId}`, { method: "DELETE", headers: HDR }).catch(() => {})
    await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${p.userId}`, { method: "DELETE", headers: HDR }).catch(() => {})
  }
})

async function galleryApi(token?: string) {
  const res = await fetch(`${BASE}/api/parent/gallery`, {
    headers: token ? cookieFor(token) : {},
    redirect: "manual",
  })
  return { status: res.status, body: await res.text() }
}

test("a parent sees their own source media in the private gallery", async () => {
  const { status, body } = await galleryApi(parentA.accessToken)
  expect(status).toBe(200)
  const parsed = JSON.parse(body)
  expect(parsed.media.map((m: { id: string }) => m.id)).toContain(assetA.id)
})

test("another parent's media never appears", async () => {
  const { body } = await galleryApi(parentA.accessToken)
  const ids = JSON.parse(body).media.map((m: { id: string }) => m.id)
  expect(ids).not.toContain(assetB.id)
  expect(body).not.toContain(parentB.userId)
  expect(body).not.toContain("child-b.png")
})

test("delivered output stays out of the source library", async () => {
  const { body } = await galleryApi(parentA.accessToken)
  const ids = JSON.parse(body).media.map((m: { id: string }) => m.id)
  expect(ids).not.toContain(finalAssetId)
})

test("the gallery carries no storage path of its own", async () => {
  const { body } = await galleryApi(parentA.accessToken)
  const media = JSON.parse(body).media

  // The read model has no path-bearing field: the browser is given an opaque
  // asset id and a signed preview, nothing it could turn into a storage
  // address of its own.
  for (const item of media) {
    expect(Object.keys(item).sort()).toEqual(
      ["id", "isImage", "label", "mimeType", "signedUrl", "uploadedAt"],
    )
  }

  // A Supabase signed URL embeds the object path by construction, so the
  // parent's own path is visible inside their own signature — the same
  // convention the order detail page already uses. What must never happen is
  // a path appearing anywhere else, or another parent's path appearing at all.
  const withoutSignatures = media
    .map((m: { signedUrl: string | null }) => m.signedUrl ?? "")
    .reduce((acc: string, url: string) => acc.replace(url, ""), body)

  expect(withoutSignatures).not.toContain(assetA.path)
  expect(withoutSignatures).not.toContain(`${parentA.userId}/`)
  expect(body).not.toContain(assetB.path)
  expect(body).not.toContain(parentB.userId)
})

test("the gallery is closed to anonymous callers", async () => {
  const { status } = await galleryApi()
  expect(status).toBe(401)
})

test("previews are signed, short-lived URLs rather than public objects", async () => {
  const { body } = await galleryApi(parentA.accessToken)
  const item = JSON.parse(body).media.find((m: { id: string }) => m.id === assetA.id)
  expect(item.signedUrl).toContain("token=")
  // The same object without the signature must not be readable.
  const unsigned = await fetch(`${SUPABASE_URL}/storage/v1/object/public/parent-uploads/${assetA.path}`)
  expect(unsigned.ok).toBe(false)
})

test("/dashboard forwards an authenticated parent to the request list", async () => {
  const res = await fetch(`${BASE}/dashboard`, {
    headers: cookieFor(parentA.accessToken),
    redirect: "manual",
  })
  expect([307, 308]).toContain(res.status)
  expect(res.headers.get("location")).toContain("/dashboard/orders")
})

test("a creation request can reuse the parent's own gallery asset", async () => {
  const form = new FormData()
  form.set("draft", JSON.stringify({
    version: 1, type: "image", createdAt: new Date().toISOString(), estimatedCandyCost: 0,
    selectedCharacterId: characterId, sceneDescription: "صحنه آزمایشی",
    style: "", occasion: "", parentNote: "", referenceFileName: "child-a.png",
  }))
  form.set("sourceAssetId", assetA.id)

  const res = await fetch(`${BASE}/api/requests`, {
    method: "POST", headers: cookieFor(parentA.accessToken), body: form, redirect: "manual",
  })
  const body = await res.text()
  expect(res.status, body).toBe(200)

  const newOrderId = JSON.parse(body).order.id
  orderIds.push(newOrderId)

  // The reused file is a copy that the NEW order owns, so the original stays
  // untouched and the <uid>/<orderId>/ storage invariant still holds.
  const assetsRes = await fetch(
    `${SUPABASE_URL}/rest/v1/media_assets?order_id=eq.${newOrderId}&select=file_url,type,asset_role`,
    { headers: HDR },
  )
  const assets = await assetsRes.json()
  expect(assets).toHaveLength(1)
  expect(assets[0].type).toBe("upload")
  expect(assets[0].asset_role).toBe("source")
  expect(assets[0].file_url).toBe(`${parentA.userId}/${newOrderId}/child-a.png`)
  expect(assets[0].file_url).not.toBe(assetA.path)
  storagePaths.push(assets[0].file_url)

  // The original is still there and still listed.
  const gallery = JSON.parse((await galleryApi(parentA.accessToken)).body)
  const ids = gallery.media.map((m: { id: string }) => m.id)
  expect(ids).toContain(assetA.id)
  // And the copy has joined the library, so it can be reused again.
  expect(gallery.media).toHaveLength(2)
})

test("the reused request appears in the parent's own order list", async () => {
  const res = await fetch(`${BASE}/dashboard/orders`, {
    headers: cookieFor(parentA.accessToken), redirect: "manual",
  })
  expect(res.status).toBe(200)
  const html = await res.text()
  expect(html).toContain("تصویر کارتونی")
})

test("a creation request is refused another parent's gallery asset", async () => {
  const form = new FormData()
  form.set("draft", JSON.stringify({
    version: 1, type: "image", createdAt: new Date().toISOString(), estimatedCandyCost: 0,
    selectedCharacterId: "00000000-0000-4000-8000-000000000000",
    sceneDescription: "صحنه آزمایشی", style: "", occasion: "", parentNote: "",
    referenceFileName: "child-b.png",
  }))
  form.set("sourceAssetId", assetB.id)

  const res = await fetch(`${BASE}/api/requests`, {
    method: "POST", headers: cookieFor(parentA.accessToken), body: form, redirect: "manual",
  })
  const body = await res.text()
  expect(res.status).toBe(422)
  expect(body).toContain("source_asset_unavailable")
  // The refusal must not confirm that the asset exists at all.
  expect(body).not.toContain(assetB.path)
  expect(body).not.toContain(parentB.userId)
})

test("a fabricated asset id is refused the same way as a foreign one", async () => {
  const form = new FormData()
  form.set("draft", JSON.stringify({
    version: 1, type: "image", createdAt: new Date().toISOString(), estimatedCandyCost: 0,
    selectedCharacterId: "00000000-0000-4000-8000-000000000000",
    sceneDescription: "صحنه", style: "", occasion: "", parentNote: "", referenceFileName: "x.png",
  }))
  form.set("sourceAssetId", "99999999-9999-4999-8999-999999999999")

  const res = await fetch(`${BASE}/api/requests`, {
    method: "POST", headers: cookieFor(parentA.accessToken), body: form, redirect: "manual",
  })
  expect(res.status).toBe(422)
  expect(await res.text()).toContain("source_asset_unavailable")
})

test("a browser-supplied storage path is never trusted as a selection", async () => {
  const form = new FormData()
  form.set("draft", JSON.stringify({
    version: 1, type: "image", createdAt: new Date().toISOString(), estimatedCandyCost: 0,
    selectedCharacterId: "00000000-0000-4000-8000-000000000000",
    sceneDescription: "صحنه", style: "", occasion: "", parentNote: "", referenceFileName: "x.png",
  }))
  form.set("sourceAssetId", assetB.path)

  const res = await fetch(`${BASE}/api/requests`, {
    method: "POST", headers: cookieFor(parentA.accessToken), body: form, redirect: "manual",
  })
  expect(res.status).toBe(422)
  expect(await res.text()).toContain("source_asset_unavailable")
})

test("the session survives leaving the portal for the public site", async () => {
  // Marketing and creation routes are outside the middleware matcher, so the
  // cookie must still be accepted by the portal afterwards.
  for (const route of ["/", "/create-image", "/request-video", "/animate-drawing"]) {
    const res = await fetch(`${BASE}${route}`, { headers: cookieFor(parentA.accessToken), redirect: "manual" })
    expect(res.status).toBe(200)
  }

  const back = await fetch(`${BASE}/dashboard/orders`, {
    headers: cookieFor(parentA.accessToken), redirect: "manual",
  })
  expect(back.status).toBe(200)
})

test("the portal renders the new navigation and no dashboard entry", async () => {
  const res = await fetch(`${BASE}/dashboard/orders`, {
    headers: cookieFor(parentA.accessToken), redirect: "manual",
  })
  const html = await res.text()

  expect(html).toContain("گرفتن تخفیف")
  expect(html).toContain("گالری خصوصی")
  expect(html).toContain("درخواست‌ها")
  expect(html).not.toContain(">داشبورد<")
  expect(html).not.toContain("/dashboard/create-image")
  expect(html).not.toContain("/dashboard/request-video")
  expect(html).not.toContain("/dashboard/animate-drawing")
  // Creation CTAs point at the public routes.
  expect(html).toContain('href="/create-image"')
  expect(html).toContain('href="/request-video"')
  expect(html).toContain('href="/animate-drawing"')
})
