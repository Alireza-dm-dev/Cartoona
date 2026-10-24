import { describe, it, expect, vi } from "vitest"
import fs from "node:fs"
import path from "node:path"
import {
  SUBMISSION_ATTEMPT_STORAGE_KEY,
  beginAttempt,
  endAttempt,
  hashDraft,
  markUncertain,
  mintSubmissionKey,
  readAttempt,
  staleAttempt,
  type AttemptStore,
  type SubmissionAttempt,
} from "@/lib/requests/submission-attempt"
import { checkSubmissionStatus, classifySubmissionError, failureProvesNothingCreated } from "@/lib/requests/submission-client"

/**
 * V0.1.50 submission-key stability. The key is what prevents a second charge, so
 * these tests pin WHEN it is kept and when it is dropped - without a browser:
 * the store is injected, the "reload" is a second read of the same store.
 */

function memoryStore(): AttemptStore & { map: Map<string, string> } {
  const map = new Map<string, string>()
  return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v), removeItem: (k) => void map.delete(k) }
}
let n = 0
const mint = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`
const draft = { version: 1, type: "image", selectedCharacterId: "Captain Candy", sceneDescription: "a scene", childName: "Sara" }

describe("one key per logical submission, stable across everything that is not a new submission", () => {
  it("the same draft gets the same key on every click (retry, double click, timeout retry)", () => {
    const store = memoryStore()
    const h = hashDraft(draft)
    const first = beginAttempt(store, h, mint)
    for (let i = 0; i < 5; i++) expect(beginAttempt(store, h, mint).key).toBe(first.key)
  })

  it("a RELOAD / navigating away and back (fresh in-memory state, same storage) keeps the key", () => {
    const store = memoryStore()
    const h = hashDraft(draft)
    const before = beginAttempt(store, h, mint)
    markUncertain(store, before)
    const afterReload = beginAttempt(store, hashDraft({ ...draft }), mint, { current: null })
    expect(afterReload.key).toBe(before.key)
    expect(afterReload.uncertain).toBe(true)
  })

  it("the key does not depend on the FILE: re-selecting a file is not an identity change (it is not even an input)", () => {
    const store = memoryStore()
    const h = hashDraft(draft)
    const key = beginAttempt(store, h, mint).key
    // The component calls nothing on file selection; the next click sees the same record.
    expect(beginAttempt(store, h, mint).key).toBe(key)
    const source = fs.readFileSync(path.join(process.cwd(), "components/creation/complete-creation-request.tsx"), "utf8")
    const handlers = ["function handleFileChange", "function handleRemoveFile", "function handleGallerySelect", "function handleUseUpload"]
    for (const name of handlers) {
      const start = source.indexOf(name)
      expect(start, name).toBeGreaterThan(-1)
      const body = source.slice(start, source.indexOf("\n  }\n", start))
      expect(body, name).not.toMatch(/submissionKey|endAttempt|beginAttempt|attemptRef\.current\s*=|randomUUID/)
    }
  })

  it("hashing is order-independent and content-sensitive", () => {
    expect(hashDraft({ a: 1, b: { c: 2, d: [1, 2] } })).toBe(hashDraft({ b: { d: [1, 2], c: 2 }, a: 1 }))
    expect(hashDraft({ ...draft, sceneDescription: "another" })).not.toBe(hashDraft(draft))
  })

  it("the record is written BEFORE the first send (a reload mid-request still finds it)", () => {
    const store = memoryStore()
    beginAttempt(store, hashDraft(draft), mint)
    expect(readAttempt(store)).toMatchObject({ uncertain: false })
    expect(store.map.has(SUBMISSION_ATTEMPT_STORAGE_KEY)).toBe(true)
  })

  it("a confirmed outcome (or a refusal that created nothing) forgets the key; the next logical submission gets a NEW one", () => {
    const store = memoryStore()
    const h = hashDraft(draft)
    const memory = { current: null as SubmissionAttempt | null }
    const k1 = beginAttempt(store, h, mint, memory).key
    endAttempt(store, memory)
    expect(readAttempt(store)).toBeNull()
    expect(beginAttempt(store, h, mint, memory).key).not.toBe(k1)
  })

  it("an UNCERTAIN attempt survives a draft edit: the other draft must resolve it first, never silently mint a competing key", () => {
    const store = memoryStore()
    const a = beginAttempt(store, hashDraft(draft), mint)
    markUncertain(store, a)
    const edited = hashDraft({ ...draft, sceneDescription: "edited" })
    expect(staleAttempt(store, edited)?.key).toBe(a.key)
    expect(staleAttempt(store, hashDraft(draft))).toBeNull() // same draft: reuse, nothing to resolve
  })

  it("only an uncertain record is 'stale': a plain in-flight/known one is just replaced for a different draft", () => {
    const store = memoryStore()
    beginAttempt(store, hashDraft(draft), mint)
    expect(staleAttempt(store, hashDraft({ ...draft, style: "x" }))).toBeNull()
  })

  it("blocked or corrupt storage never throws and never invents a key from garbage", () => {
    const broken: AttemptStore = { getItem: () => { throw new Error("blocked") }, setItem: () => { throw new Error("blocked") }, removeItem: () => { throw new Error("blocked") } }
    const memory = { current: null as SubmissionAttempt | null }
    const a = beginAttempt(broken, "h", mint, memory)
    expect(beginAttempt(broken, "h", mint, memory).key).toBe(a.key) // the in-memory copy still protects this page load
    const store = memoryStore()
    store.map.set(SUBMISSION_ATTEMPT_STORAGE_KEY, '{"key":"not-a-uuid","draftHash":"h","uncertain":false}')
    expect(readAttempt(store)).toBeNull()
    store.map.set(SUBMISSION_ATTEMPT_STORAGE_KEY, "{{{")
    expect(readAttempt(store)).toBeNull()
    expect(readAttempt(null)).toBeNull()
  })
})

describe("mintSubmissionKey works outside secure contexts", () => {
  it("returns a valid v4 UUID with crypto.randomUUID, and without it (plain http)", () => {
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    expect(mintSubmissionKey()).toMatch(UUID)
    const real = globalThis.crypto
    vi.stubGlobal("crypto", { getRandomValues: real.getRandomValues.bind(real) })
    try {
      const keys = new Set(Array.from({ length: 50 }, () => mintSubmissionKey()))
      expect(keys.size).toBe(50)
      for (const k of keys) expect(k).toMatch(UUID)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it("a failure BEFORE the request is sent forgets the key instead of calling it uncertain", () => {
    const page = fs.readFileSync(path.join(process.cwd(), "components/creation/complete-creation-request.tsx"), "utf8")
    expect(page).toMatch(/let sent = false/)
    expect(page).toMatch(/sent = true;\s*const res = await fetch\("\/api\/requests"/)
    expect(page).toMatch(/if \(!sent\) \{[\s\S]*?endAttempt\(store\(\), attemptRef\)/)
  })
})

describe("when may the client forget the key? only when the answer PROVES nothing was created", () => {
  it.each([
    [402, "INSUFFICIENT_CANDIES", true],
    [422, "validation_error", true],
    [422, "request_failed", true],
    [403, "request_consent_required", true],
    [429, undefined, true],
    [413, "request_too_large", true],
    [503, "request_outcome_unknown", false],
    [503, "request_not_created", false],
    [503, "request_unavailable", false],
    [503, "SESSION_CHECK_UNAVAILABLE", false],
    [500, "request_failed", false],
    [502, undefined, false],
    [500, undefined, false],
  ])("status %s code %s -> forget key: %s", (status, code, forget) => {
    expect(failureProvesNothingCreated(status, code)).toBe(forget)
  })

  it("the uncertain and not-created answers are their own UI states, not 'failed' or 'pricing'", () => {
    expect(classifySubmissionError(503, "request_outcome_unknown")).toBe("uncertain")
    expect(classifySubmissionError(503, "request_not_created")).toBe("not_created")
    expect(classifySubmissionError(503, "request_unavailable")).toBe("unavailable")
    expect(classifySubmissionError(503, "CREATION_PRICING_UNAVAILABLE")).toBe("pricing")
    expect(classifySubmissionError(402, "INSUFFICIENT_CANDIES")).toBe("insufficient_candy")
  })
})

describe("checkSubmissionStatus (the 'check status' button)", () => {
  const reply = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch
  const KEY = "11111111-1111-4111-8111-111111111111"

  it("found / absent / unclear are distinct; anything unclear is 'unknown', never 'absent'", async () => {
    expect(await checkSubmissionStatus(KEY, reply(200, { found: true, orderId: "o1" }))).toEqual({ kind: "found", orderId: "o1" })
    expect(await checkSubmissionStatus(KEY, reply(200, { found: false }))).toEqual({ kind: "absent" })
    expect(await checkSubmissionStatus(KEY, reply(503, { code: "service_unavailable" }))).toEqual({ kind: "unknown" })
    expect(await checkSubmissionStatus(KEY, reply(401, {}))).toEqual({ kind: "unknown" })
    expect(await checkSubmissionStatus(KEY, reply(200, { found: true }))).toEqual({ kind: "unknown" })
    expect(await checkSubmissionStatus(KEY, vi.fn(async () => { throw new Error("offline") }) as unknown as typeof fetch)).toEqual({ kind: "unknown" })
  })

  it("is one GET to the Next route with the key URL-encoded, no body, never cached", async () => {
    const f = reply(200, { found: false })
    await checkSubmissionStatus(KEY, f)
    const [url, init] = (f as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls[0]
    expect(url).toBe(`/api/requests/by-submission-key?submissionKey=${KEY}`)
    expect(init).toMatchObject({ method: "GET", cache: "no-store", credentials: "same-origin" })
    expect(init.body).toBeUndefined()
  })
})
