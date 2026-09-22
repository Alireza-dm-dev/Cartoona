import { test, expect } from "@playwright/test"
import {
  assertSafeDatabaseTarget,
  guardedSupabaseUrl,
} from "../helpers/assert-safe-database-target"
import { loadTestEnv } from "../helpers/load-test-env"

// ⚠️ Stateful request-submission tests. They create real parents, real orders,
// real storage objects and real candy ledger entries, so they run against a
// disposable/local target ONLY, never the production main project.
// assertSafeDatabaseTarget() gates the whole file and the Supabase URL is
// derived from the same environment the guard inspected, so the guard's verdict
// is binding on every request made here.

loadTestEnv()

const _guard = assertSafeDatabaseTarget()
if (!_guard.ok) throw new Error(`Guard blocked: ${_guard.reason}`)

const SUPABASE_URL = guardedSupabaseUrl()
const BASE = process.env.CARTOONA_TEST_BASE_URL || "http://localhost:3000"
const KEY = process.env.SUPABASE_SECRET_KEY || ""
const HDR = { "Content-Type": "application/json", apikey: KEY, Authorization: `Bearer ${KEY}` }

const TS = String(Date.now()).slice(-8)
const BUCKET = "parent-uploads"

/** A 1x1 PNG. Small enough to upload quickly, real enough to sniff as an image. */
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
)

function pngFile(name: string): File {
  return new File([new Uint8Array(PNG_BYTES)], name, { type: "image/png" })
}

// ── Fixtures ────────────────────────────────────────────────────────────────

const createdUserIds: string[] = []

interface Parent {
  userId: string
  profileId: string
  cookie: string
}

async function devAuth(body: unknown): Promise<{ status: number; json: Record<string, unknown>; cookies: string[] }> {
  const resp = await fetch(`${BASE}/api/dev/parent-auth`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  return {
    status: resp.status,
    json: await resp.json(),
    cookies: resp.headers.getSetCookie?.() ?? [],
  }
}

function cookieHeaderFrom(setCookies: string[]): string {
  return setCookies.map((c) => c.split(";")[0]).join("; ")
}

/** Sign up a phone-only parent, grant consent, and return their session. */
async function createParent(tag: string): Promise<Parent> {
  const phone = `09${tag}${TS.slice(0, 7)}`

  const request = await devAuth({ action: "signup_request_code", phone })
  if (request.status !== 200) throw new Error(`signup request failed for ${phone}: ${JSON.stringify(request.json)}`)

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
  if (!user) throw new Error("created user not found")
  createdUserIds.push(user.id)

  const profiles = await (await fetch(
    `${SUPABASE_URL}/rest/v1/parent_profiles?user_id=eq.${user.id}&select=id`,
    { headers: HDR },
  )).json()

  return { userId: user.id, profileId: profiles[0].id, cookie }
}

/** Give the parent enough candy to pay for a request. */
async function setBalance(profileId: string, balance: number): Promise<void> {
  const resp = await fetch(
    `${SUPABASE_URL}/rest/v1/candy_wallets?parent_id=eq.${profileId}`,
    { method: "PATCH", headers: { ...HDR, Prefer: "return=representation" }, body: JSON.stringify({ balance }) },
  )
  if (!resp.ok) throw new Error(`could not set balance: ${await resp.text()}`)
}

async function getBalance(profileId: string): Promise<number> {
  const rows = await (await fetch(
    `${SUPABASE_URL}/rest/v1/candy_wallets?parent_id=eq.${profileId}&select=balance`,
    { headers: HDR },
  )).json()
  return rows[0]?.balance ?? 0
}

/**
 * A real seeded character, referenced the way the creation forms do — by name.
 *
 * Deliberately not a fixture row: the point of these tests is that the name a
 * public form stores in the draft resolves to an active character, so they use
 * the same canonical cast the forms render.
 */
async function canonicalCharacter(): Promise<{ id: string; name: string }> {
  const rows = await (await fetch(
    `${SUPABASE_URL}/rest/v1/characters?is_active=eq.true&select=id,name&limit=1`,
    { headers: HDR },
  )).json()
  if (!rows[0]?.id) {
    throw new Error(
      "No active characters. Apply 20260918130000_seed_canonical_characters.sql to the disposable project.",
    )
  }
  return { id: rows[0].id, name: rows[0].name }
}

async function submit(
  cookie: string,
  draft: unknown,
  source?: { file?: File; sourceAssetId?: string; submissionKey?: string },
): Promise<{ status: number; json: Record<string, unknown> }> {
  const form = new FormData()
  form.set("draft", JSON.stringify(draft))
  // A fresh key per call unless the caller is deliberately testing a retry —
  // every other test in this file submits once and does not care about
  // idempotency, so it must not need to know the field exists.
  form.set("submissionKey", source?.submissionKey ?? crypto.randomUUID())
  if (source?.file) form.set("file", source.file)
  if (source?.sourceAssetId) form.set("sourceAssetId", source.sourceAssetId)

  const resp = await fetch(`${BASE}/api/requests`, {
    method: "POST",
    headers: { Cookie: cookie },
    body: form,
  })
  return { status: resp.status, json: await resp.json().catch(() => ({})) }
}

async function orderRow(orderId: string): Promise<Record<string, unknown> | null> {
  const rows = await (await fetch(
    `${SUPABASE_URL}/rest/v1/orders?id=eq.${orderId}&select=id,type,status,candy_cost,child_name,parent_id,title`,
    { headers: HDR },
  )).json()
  return rows[0] ?? null
}

async function sourceAssets(orderId: string): Promise<Array<Record<string, unknown>>> {
  return (await fetch(
    `${SUPABASE_URL}/rest/v1/media_assets?order_id=eq.${orderId}&select=id,file_url,mime_type,original_filename,asset_role,type`,
    { headers: HDR },
  )).json()
}

/**
 * Whether an object exists, asked via the list endpoint.
 *
 * The object/info endpoint intermittently leaves the connection hanging from
 * Node's fetch against this project, which showed up as a headers timeout
 * rather than a failure. Listing the containing folder answers the same
 * question over a code path that stays responsive.
 */
async function storageObjectExists(path: string): Promise<boolean> {
  const lastSlash = path.lastIndexOf("/")
  const prefix = lastSlash === -1 ? "" : path.slice(0, lastSlash)
  const name = lastSlash === -1 ? path : path.slice(lastSlash + 1)

  const resp = await fetch(`${SUPABASE_URL}/storage/v1/object/list/${BUCKET}`, {
    method: "POST",
    headers: HDR,
    body: JSON.stringify({ prefix, limit: 100 }),
  })
  if (!resp.ok) return false
  const rows = await resp.json()
  return Array.isArray(rows) && rows.some((r: { name: string }) => r.name === name)
}

async function listStorageUnder(prefix: string): Promise<string[]> {
  const resp = await fetch(`${SUPABASE_URL}/storage/v1/object/list/${BUCKET}`, {
    method: "POST",
    headers: HDR,
    body: JSON.stringify({ prefix, limit: 100 }),
  })
  if (!resp.ok) return []
  const rows = await resp.json()
  return Array.isArray(rows) ? rows.map((r: { name: string }) => r.name) : []
}

const imageDraft = (characterName: string, over: Record<string, unknown> = {}) => ({
  version: 1,
  createdAt: new Date().toISOString(),
  estimatedCandyCost: 15,
  type: "image",
  selectedCharacterId: characterName,
  sceneDescription: "یک جنگل پر از پروانه",
  style: "کارتونی نرم",
  occasion: "",
  parentNote: "",
  referenceFileName: "photo.png",
  childName: "آریا",
  ...over,
})

const videoDraft = (characterName: string, over: Record<string, unknown> = {}) => ({
  version: 1,
  createdAt: new Date().toISOString(),
  estimatedCandyCost: 40,
  type: "video",
  selectedCharacterId: characterName,
  storyDescription: "ماجرای شب مهتابی",
  duration: "5_10",
  charactersSpeak: true,
  occasion: "",
  parentNote: "",
  referenceFileName: "",
  childName: "آریا",
  ...over,
})

const drawingDraft = (over: Record<string, unknown> = {}) => ({
  version: 1,
  createdAt: new Date().toISOString(),
  estimatedCandyCost: 35,
  type: "drawing",
  drawingFileName: "naghashi.png",
  title: "نقاشی من",
  movementType: "پرواز آرام",
  animationDescription: "پرنده پرواز کند",
  backgroundScene: "آسمان آبی",
  duration: "کوتاه",
  parentNote: "",
  ...over,
})

test.afterAll(async () => {
  // Orders cascade from the parent, and storage objects are removed with the
  // folder prefix, so deleting the identities clears almost everything.
  for (const id of createdUserIds) {
    await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${id}`, { method: "DELETE", headers: HDR }).catch(() => {})
  }
})

test.describe.configure({ mode: "serial" })

// Each test here makes several round trips to a remote Supabase project —
// signup, consent, an upload, the RPC, then verification reads. The default
// 30s budget is for a local page interaction, not for that.
test.beforeEach(() => {
  test.setTimeout(120_000)
})

let character: { id: string; name: string }
let parent: Parent

test.beforeAll(async () => {
  character = await canonicalCharacter()
  parent = await createParent("35")
})

// ── The four request types ──────────────────────────────────────────────────

test("1, 5, 6, 10 — image with a new upload: created, priced, child name kept, no path returned", async () => {
  await setBalance(parent.profileId, 500)
  const before = await getBalance(parent.profileId)

  const result = await submit(parent.cookie, imageDraft(character.name), {
    file: pngFile("عکس-آریا.png"),
  })

  expect(result.status).toBe(200)
  const orderId = result.json.orderId as string
  expect(orderId).toMatch(/^[0-9a-f-]{36}$/i)

  // 10 — nothing about storage reaches the client.
  const serialized = JSON.stringify(result.json)
  for (const leak of ["parent-uploads", parent.userId, "file_url", "storage", ".png"]) {
    expect(serialized, leak).not.toContain(leak)
  }

  const order = await orderRow(orderId)
  expect(order?.type).toBe("image")
  expect(order?.status).toBe("pending_review")
  // 5 — the child name landed in its own column.
  expect(order?.child_name).toBe("آریا")

  // 6 — image.default (12) + image.reference_file (3).
  expect(order?.candy_cost).toBe(15)
  expect(await getBalance(parent.profileId)).toBe(before - 15)

  // 4/9 — the source row belongs to this order and keeps the parent's own name.
  const assets = await sourceAssets(orderId)
  expect(assets).toHaveLength(1)
  expect(assets[0].asset_role).toBe("source")
  expect(assets[0].original_filename).toBe("عکس-آریا.png")
  // The path is owned by this parent and this order, and the sanitizer has
  // stripped the non-ASCII characters — which is exactly why the readable name
  // has to live in original_filename rather than be read back off the path.
  const path = String(assets[0].file_url)
  expect(path.startsWith(`${parent.userId}/${orderId}/`)).toBe(true)
  expect(path.endsWith(".png")).toBe(true)
  expect(path).not.toContain("عکس")
})

test("3 — video request is created with its duration and speech choice", async () => {
  await setBalance(parent.profileId, 500)
  const before = await getBalance(parent.profileId)

  const result = await submit(parent.cookie, videoDraft(character.name))
  expect(result.status).toBe(200)

  const orderId = result.json.orderId as string
  const order = await orderRow(orderId)
  expect(order?.type).toBe("video")
  expect(order?.child_name).toBe("آریا")
  // video.short, no reference file.
  expect(order?.candy_cost).toBe(40)
  expect(await getBalance(parent.profileId)).toBe(before - 40)

  const rows = await (await fetch(
    `${SUPABASE_URL}/rest/v1/video_requests?order_id=eq.${orderId}&select=script,duration_choice,characters_speak`,
    { headers: HDR },
  )).json()
  expect(rows[0].duration_choice).toBe("5_10")
  expect(rows[0].characters_speak).toBe(true)
  expect(rows[0].script).toBe("ماجرای شب مهتابی")
})

test("4 — drawing animation is created with its source drawing", async () => {
  await setBalance(parent.profileId, 500)
  const before = await getBalance(parent.profileId)

  const result = await submit(parent.cookie, drawingDraft(), { file: pngFile("naghashi.png") })
  expect(result.status).toBe(200)

  const orderId = result.json.orderId as string
  const order = await orderRow(orderId)
  expect(order?.type).toBe("drawing_animation")
  expect(order?.title).toBe("نقاشی من")
  // The drawing form collects no child name, and none is invented.
  expect(order?.child_name).toBeNull()
  expect(order?.candy_cost).toBe(35)
  expect(await getBalance(parent.profileId)).toBe(before - 35)

  const rows = await (await fetch(
    `${SUPABASE_URL}/rest/v1/drawing_animation_requests?order_id=eq.${orderId}&select=animation_style`,
    { headers: HDR },
  )).json()
  expect(rows[0].animation_style).toBe("پرواز آرام")
})

// ── Gallery reuse ───────────────────────────────────────────────────────────

test("2, 9 — gallery reuse copies into the new order and leaves the original alone", async () => {
  await setBalance(parent.profileId, 500)

  // A first request supplies the gallery asset the second will reuse.
  const first = await submit(parent.cookie, imageDraft(character.name), {
    file: pngFile("original.png"),
  })
  expect(first.status).toBe(200)
  const firstOrderId = first.json.orderId as string
  const firstAssets = await sourceAssets(firstOrderId)
  const sourceAssetId = firstAssets[0].id as string
  const originalPath = String(firstAssets[0].file_url)

  const before = await getBalance(parent.profileId)

  const second = await submit(
    parent.cookie,
    imageDraft(character.name, { referenceFileName: "original.png" }),
    { sourceAssetId },
  )
  expect(second.status).toBe(200)
  const secondOrderId = second.json.orderId as string
  expect(secondOrderId).not.toBe(firstOrderId)

  // 9 — a brand-new row and a brand-new object under the new order's folder.
  const secondAssets = await sourceAssets(secondOrderId)
  expect(secondAssets).toHaveLength(1)
  expect(secondAssets[0].id).not.toBe(sourceAssetId)
  const copiedPath = String(secondAssets[0].file_url)
  expect(copiedPath).toContain(`${parent.userId}/${secondOrderId}/`)
  expect(copiedPath).not.toBe(originalPath)

  // The original is untouched and still readable.
  expect(await storageObjectExists(originalPath)).toBe(true)
  expect(await storageObjectExists(copiedPath)).toBe(true)
  expect((await sourceAssets(firstOrderId))).toHaveLength(1)

  // Reuse is priced exactly like an upload — it is still a reference file.
  expect(await getBalance(parent.profileId)).toBe(before - 15)
})

test("8 — another parent's gallery asset is refused exactly like a missing one", async () => {
  const stranger = await createParent("36")
  await setBalance(stranger.profileId, 500)

  const theirs = await submit(stranger.cookie, imageDraft(character.name), {
    file: pngFile("theirs.png"),
  })
  expect(theirs.status).toBe(200)
  const theirAssetId = (await sourceAssets(theirs.json.orderId as string))[0].id as string

  await setBalance(parent.profileId, 500)
  const before = await getBalance(parent.profileId)

  const foreign = await submit(parent.cookie, imageDraft(character.name), {
    sourceAssetId: theirAssetId,
  })
  const missing = await submit(parent.cookie, imageDraft(character.name), {
    sourceAssetId: "11111111-1111-4111-8111-111111111111",
  })

  // Identical answers: a crafted id cannot be used to probe whether another
  // parent's media is real.
  expect(foreign.status).toBe(missing.status)
  expect(foreign.json.error).toBe(missing.json.error)
  expect(foreign.status).toBe(422)

  // Nothing was created and nothing was charged.
  expect(await getBalance(parent.profileId)).toBe(before)
})

test("13 — a rejected submission leaves no order, no charge and no orphan file", async () => {
  await setBalance(parent.profileId, 500)
  const before = await getBalance(parent.profileId)
  const filesBefore = await listStorageUnder(`${parent.userId}/`)

  // A video draft missing its speech choice: the file uploads, then the RPC
  // refuses the request, so the route must remove what it just wrote.
  const result = await submit(
    parent.cookie,
    videoDraft(character.name, { charactersSpeak: null }),
    { file: pngFile("orphan.png") },
  )

  expect(result.status).toBeGreaterThanOrEqual(400)
  expect(await getBalance(parent.profileId)).toBe(before)

  const filesAfter = await listStorageUnder(`${parent.userId}/`)
  expect(filesAfter.length).toBe(filesBefore.length)
})

// ── Money ───────────────────────────────────────────────────────────────────

test("7 — an unaffordable request is refused and charges nothing", async () => {
  await setBalance(parent.profileId, 3)

  const result = await submit(parent.cookie, imageDraft(character.name), {
    file: pngFile("broke.png"),
  })

  expect(result.status).toBe(402)
  expect(String(result.json.error)).toContain("کافی نیست")
  // Persian, and nothing about the schema.
  expect(String(result.json.error)).not.toMatch(/[a-z]{4,}/)
  expect(await getBalance(parent.profileId)).toBe(3)
})

test("pricing cannot be talked down from the browser", async () => {
  await setBalance(parent.profileId, 500)
  const before = await getBalance(parent.profileId)

  // The draft claims this costs nothing. The server prices it from the catalog.
  const result = await submit(
    parent.cookie,
    imageDraft(character.name, { estimatedCandyCost: 0, candyCost: 0, candy_cost: 0 }),
    { file: pngFile("cheap.png") },
  )

  expect(result.status).toBe(200)
  const order = await orderRow(result.json.orderId as string)
  expect(order?.candy_cost).toBe(15)
  expect(await getBalance(parent.profileId)).toBe(before - 15)
})

// ── Security ────────────────────────────────────────────────────────────────

test("an anonymous submission is refused", async () => {
  const form = new FormData()
  form.set("draft", JSON.stringify(imageDraft(character.name)))

  const resp = await fetch(`${BASE}/api/requests`, { method: "POST", body: form })
  expect(resp.status).toBe(401)
})

test("both source modes at once are refused rather than resolved", async () => {
  await setBalance(parent.profileId, 500)
  const before = await getBalance(parent.profileId)

  const first = await submit(parent.cookie, imageDraft(character.name), {
    file: pngFile("one.png"),
  })
  const assetId = (await sourceAssets(first.json.orderId as string))[0].id as string

  const both = await submit(parent.cookie, imageDraft(character.name), {
    file: pngFile("two.png"),
    sourceAssetId: assetId,
  })

  expect(both.status).toBe(422)
  expect(both.json.code).toBe("ambiguous_source")
  // Only the first request was charged.
  expect(await getBalance(parent.profileId)).toBe(before - 15)
})

test("a malformed asset id is refused like a missing one", async () => {
  await setBalance(parent.profileId, 500)
  for (const bad of ["not-a-uuid", "../../etc/passwd", "'; drop table orders;--", "1"]) {
    const result = await submit(parent.cookie, imageDraft(character.name), { sourceAssetId: bad })
    expect(result.status, bad).toBe(422)
  }
})

test("a storage path in the draft cannot redirect where the file is written", async () => {
  await setBalance(parent.profileId, 500)

  const result = await submit(
    parent.cookie,
    imageDraft(character.name, {
      referenceFileName: "../../../other-parent/stolen.png",
      filePath: "other-parent/secret/stolen.png",
      file_path: "other-parent/secret/stolen.png",
    }),
    { file: pngFile("../../escape.png") },
  )

  expect(result.status).toBe(200)
  const orderId = result.json.orderId as string
  const path = String((await sourceAssets(orderId))[0].file_url)

  // The path is built from the authenticated user id and the new order id,
  // whatever the draft claimed.
  expect(path.startsWith(`${parent.userId}/${orderId}/`)).toBe(true)
  expect(path).not.toContain("..")
  expect(path).not.toContain("other-parent")
})

test("an oversized child name is refused by the database check", async () => {
  await setBalance(parent.profileId, 500)
  const result = await submit(
    parent.cookie,
    imageDraft(character.name, { childName: "آ".repeat(61) }),
    { file: pngFile("long.png") },
  )
  expect(result.status).toBe(422)
})

test("an unsupported request type is refused", async () => {
  await setBalance(parent.profileId, 500)
  const result = await submit(parent.cookie, imageDraft(character.name, { type: "hologram" }))
  expect(result.status).toBe(422)
})

// ── The parent-facing result ────────────────────────────────────────────────

test("11, 12 — the created order appears in the portal and its detail page loads", async ({ page, context }) => {
  await setBalance(parent.profileId, 500)

  const result = await submit(parent.cookie, imageDraft(character.name), {
    file: pngFile("visible.png"),
  })
  expect(result.status).toBe(200)
  const orderId = result.json.orderId as string

  await context.addCookies(
    parent.cookie.split("; ").map((pair) => {
      const eq = pair.indexOf("=")
      return { name: pair.slice(0, eq), value: pair.slice(eq + 1), domain: "localhost", path: "/" }
    }),
  )

  // 11 — it is listed.
  await page.goto(`${BASE}/dashboard/orders`)
  await expect(page.locator(`a[href$="/dashboard/orders/${orderId}"]`).first()).toBeVisible()

  // 12 — and its detail page renders, showing the child name.
  await page.goto(`${BASE}/dashboard/orders/${orderId}`)
  await expect(page.getByText("نام کودک", { exact: true })).toBeVisible()
  await expect(page.getByText("آریا", { exact: true }).first()).toBeVisible()

  // The parent may view their own source file, so the page does render a
  // storage reference — but only ever as a signed, expiring URL. What must not
  // appear is a bare path that would work without one.
  const html = await page.content()
  const bareReferences = [...html.matchAll(/parent-uploads\/[^"'\s?]+/g)].map((m) => m[0])
  for (const reference of bareReferences) {
    const index = html.indexOf(reference)
    const following = html.slice(index, index + reference.length + 200)
    expect(following, reference).toContain("token=")
  }
  // And the raw path is never handed over as JSON for a script to read.
  expect(html).not.toContain('"file_url"')
  expect(html).not.toContain('"storagePath"')
})

// ── Idempotent submission (V0.1.16) ─────────────────────────────────────────
// The same submissionKey, resubmitted any number of times, must never create
// a second order, a second candy debit, or a second source-media row.

async function candyDebitCount(orderId: string): Promise<number> {
  const rows = await (await fetch(
    `${SUPABASE_URL}/rest/v1/candy_transactions?reference_id=eq.${orderId}&type=eq.order_debit&select=id`,
    { headers: HDR },
  )).json()
  return Array.isArray(rows) ? rows.length : 0
}

async function ordersBySubmissionKey(parentId: string, key: string): Promise<Array<Record<string, unknown>>> {
  return (await fetch(
    `${SUPABASE_URL}/rest/v1/orders?parent_id=eq.${parentId}&submission_key=eq.${key}&select=id`,
    { headers: HDR },
  )).json()
}

test.describe("idempotent order submission (V0.1.16)", () => {
  test("1, 2 — a normal first submission and an exact retry resolve to the same order", async () => {
    await setBalance(parent.profileId, 500)
    const before = await getBalance(parent.profileId)
    const key = crypto.randomUUID()

    const first = await submit(parent.cookie, imageDraft(character.name), {
      file: pngFile("idem-1.png"),
      submissionKey: key,
    })
    expect(first.status).toBe(200)
    expect(first.json.replayed).toBe(false)
    const orderId = first.json.orderId as string

    const retry = await submit(parent.cookie, imageDraft(character.name), {
      file: pngFile("idem-1.png"),
      submissionKey: key,
    })
    expect(retry.status).toBe(200)
    expect(retry.json.orderId).toBe(orderId)
    expect(retry.json.replayed).toBe(true)

    expect(await getBalance(parent.profileId)).toBe(before - 15)
    expect(await candyDebitCount(orderId)).toBe(1)
    expect(await sourceAssets(orderId)).toHaveLength(1)
  })

  test("3 — five sequential retries still produce exactly one order, one debit, one asset", async () => {
    await setBalance(parent.profileId, 500)
    const before = await getBalance(parent.profileId)
    const key = crypto.randomUUID()

    let orderId: string | null = null
    for (let i = 0; i < 5; i++) {
      const result = await submit(parent.cookie, imageDraft(character.name), {
        file: pngFile(`idem-seq-${i}.png`),
        submissionKey: key,
      })
      expect(result.status, `attempt ${i}`).toBe(200)
      if (orderId) {
        expect(result.json.orderId, `attempt ${i}`).toBe(orderId)
        expect(result.json.replayed, `attempt ${i}`).toBe(true)
      } else {
        orderId = result.json.orderId as string
        expect(result.json.replayed).toBe(false)
      }
    }

    expect(await getBalance(parent.profileId)).toBe(before - 15)
    expect(await candyDebitCount(orderId!)).toBe(1)
    expect(await sourceAssets(orderId!)).toHaveLength(1)
    expect(await ordersBySubmissionKey(parent.profileId, key)).toHaveLength(1)
  })

  test("4, 5, 6, 7 — five concurrent identical submissions collapse to one order", async () => {
    await setBalance(parent.profileId, 500)
    const before = await getBalance(parent.profileId)
    const key = crypto.randomUUID()

    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        submit(parent.cookie, imageDraft(character.name), {
          file: pngFile(`idem-conc-${i}.png`),
          submissionKey: key,
        }),
      ),
    )

    for (const r of results) expect(r.status).toBe(200)
    const orderIds = new Set(results.map((r) => r.json.orderId))
    expect(orderIds.size).toBe(1)
    const orderId = [...orderIds][0] as string

    // Exactly one of the five actually created the order; the rest replayed it.
    const replayedFlags = results.map((r) => r.json.replayed)
    expect(replayedFlags.filter((v) => v === false)).toHaveLength(1)
    expect(replayedFlags.filter((v) => v === true)).toHaveLength(4)

    expect(await getBalance(parent.profileId)).toBe(before - 15)
    expect(await candyDebitCount(orderId)).toBe(1)
    expect(await sourceAssets(orderId)).toHaveLength(1)
    expect(await ordersBySubmissionKey(parent.profileId, key)).toHaveLength(1)
  })

  test("8 — gallery original is unaffected by a retried submission", async () => {
    await setBalance(parent.profileId, 500)

    const seed = await submit(parent.cookie, imageDraft(character.name), {
      file: pngFile("idem-gallery-seed.png"),
    })
    expect(seed.status).toBe(200)
    const seedAssets = await sourceAssets(seed.json.orderId as string)
    const galleryAssetId = seedAssets[0].id as string
    const galleryPath = String(seedAssets[0].file_url)

    const key = crypto.randomUUID()
    const first = await submit(
      parent.cookie,
      imageDraft(character.name, { referenceFileName: "idem-gallery-seed.png" }),
      { sourceAssetId: galleryAssetId, submissionKey: key },
    )
    expect(first.status).toBe(200)
    const orderId = first.json.orderId as string

    const retry = await submit(
      parent.cookie,
      imageDraft(character.name, { referenceFileName: "idem-gallery-seed.png" }),
      { sourceAssetId: galleryAssetId, submissionKey: key },
    )
    expect(retry.status).toBe(200)
    expect(retry.json.orderId).toBe(orderId)

    expect(await sourceAssets(orderId)).toHaveLength(1)
    expect(await storageObjectExists(galleryPath)).toBe(true)
    expect(await sourceAssets(seed.json.orderId as string)).toHaveLength(1)
  })

  test("9 — a different parent with the same key creates their own independent order", async () => {
    const other = await createParent("37")
    await setBalance(parent.profileId, 500)
    await setBalance(other.profileId, 500)

    const key = crypto.randomUUID()
    const mine = await submit(parent.cookie, imageDraft(character.name), {
      file: pngFile("idem-sec-a.png"),
      submissionKey: key,
    })
    const theirs = await submit(other.cookie, imageDraft(character.name), {
      file: pngFile("idem-sec-b.png"),
      submissionKey: key,
    })

    expect(mine.status).toBe(200)
    expect(theirs.status).toBe(200)
    expect(mine.json.orderId).not.toBe(theirs.json.orderId)
    expect(mine.json.replayed).toBe(false)
    expect(theirs.json.replayed).toBe(false)
  })

  test("10 — an invalid source does not become successful through replay", async () => {
    await setBalance(parent.profileId, 500)
    const before = await getBalance(parent.profileId)
    const key = crypto.randomUUID()

    const first = await submit(parent.cookie, imageDraft(character.name), {
      sourceAssetId: "11111111-1111-4111-8111-111111111111",
      submissionKey: key,
    })
    expect(first.status).toBe(422)

    const retry = await submit(parent.cookie, imageDraft(character.name), {
      sourceAssetId: "11111111-1111-4111-8111-111111111111",
      submissionKey: key,
    })
    expect(retry.status).toBe(422)

    // Nothing was ever created under this key, on either attempt.
    expect(await getBalance(parent.profileId)).toBe(before)
    expect(await ordersBySubmissionKey(parent.profileId, key)).toHaveLength(0)
  })

  test("11 — a timeout/retry simulation returns the same orderId", async () => {
    await setBalance(parent.profileId, 500)
    const key = crypto.randomUUID()

    // A real timeout means the client never reads the first response even
    // though the server finished the work. Issuing a second call with the
    // same key, independent of the first call's outcome, reproduces that.
    const first = await submit(parent.cookie, imageDraft(character.name), {
      file: pngFile("idem-timeout.png"),
      submissionKey: key,
    })
    expect(first.status).toBe(200)

    const retry = await submit(parent.cookie, imageDraft(character.name), {
      file: pngFile("idem-timeout.png"),
      submissionKey: key,
    })
    expect(retry.status).toBe(200)
    expect(retry.json.orderId).toBe(first.json.orderId)
  })

  test("12 — the order from a retried submission appears once in the parent's orders", async () => {
    await setBalance(parent.profileId, 500)
    const key = crypto.randomUUID()

    const first = await submit(parent.cookie, imageDraft(character.name), {
      file: pngFile("idem-list.png"),
      submissionKey: key,
    })
    expect(first.status).toBe(200)
    await submit(parent.cookie, imageDraft(character.name), {
      file: pngFile("idem-list.png"),
      submissionKey: key,
    })

    const rows = await ordersBySubmissionKey(parent.profileId, key)
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe(first.json.orderId)
  })
})
