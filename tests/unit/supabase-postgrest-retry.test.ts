/**
 * V0.1.36 - server-side PostgREST reads make exactly one network attempt.
 *
 * Every test drives the REAL supabase-js / @supabase/ssr clients through the
 * app's own factories; only `globalThis.fetch` is stubbed, so nothing leaves
 * the machine and a library upgrade that changes the retry wiring fails here.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { createClient } from "@supabase/supabase-js"

vi.mock("next/headers", () => ({
  cookies: async () => ({ getAll: () => [], set: () => {} }),
}))

import { createAdminSupabaseClient } from "@/lib/supabase/admin"
import { createServerSupabaseClient } from "@/lib/supabase/server"
import { disablePostgrestRetries } from "@/lib/supabase/postgrest-retry"
import { SUPABASE_REQUEST_TIMEOUT_MS, supabaseTimeoutFetch } from "@/lib/supabase/timeout-fetch"

const URL_ = "https://stub.supabase.invalid"

interface Attempt {
  at: number
  method: string
  url: string
}

let attempts: Attempt[]

function record(input: RequestInfo | URL, init?: RequestInit) {
  attempts.push({ at: Date.now(), method: init?.method ?? "GET", url: String(input) })
}

/** Network failure in milliseconds - DNS miss / connection refused. */
function failingFetch() {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    record(input, init)
    throw new TypeError("fetch failed")
  }) as typeof fetch
}

/** Never answers; rejects only when the timeout fetch aborts it. */
function hangingFetch() {
  globalThis.fetch = vi.fn(
    (input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        record(input, init)
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason))
      }),
  ) as typeof fetch
}

function statusFetch(status: number) {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    record(input, init)
    return new Response(JSON.stringify({ message: "unavailable" }), {
      status,
      headers: { "content-type": "application/json" },
    })
  }) as typeof fetch
}

/** Observe a thenable's settlement without awaiting it under fake timers. */
function track<T>(thenable: PromiseLike<T>) {
  const state: { settled: boolean; value?: T } = { settled: false }
  Promise.resolve(thenable).then((value) => {
    state.settled = true
    state.value = value
  })
  return state
}

const originalFetch = globalThis.fetch

beforeEach(() => {
  attempts = []
  vi.useFakeTimers()
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", URL_)
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "stub-anon-key")
  vi.stubEnv("SUPABASE_SECRET_KEY", "stub-secret-key")
})

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

describe("baseline: the installed postgrest-js retries GETs by default", () => {
  // Pins the library behaviour this release works around. If it ever stops
  // retrying, this fails and the helper can be revisited rather than trusted.
  it("an unconfigured client makes 4 attempts spaced 1 s, 2 s, 4 s apart", async () => {
    failingFetch()
    const raw = createClient(URL_, "k", { global: { fetch: supabaseTimeoutFetch } })
    const start = Date.now()
    const read = track(raw.from("homepage_content").select("*"))

    await vi.advanceTimersByTimeAsync(7_000)

    expect(read.settled).toBe(true)
    expect(attempts.map((a) => a.at - start)).toEqual([0, 1_000, 3_000, 7_000])
  })
})

describe("server-side reads: one network attempt", () => {
  it.each([
    ["admin", () => createAdminSupabaseClient()],
    ["server (cookie session)", () => createServerSupabaseClient()],
  ])("%s client: a failed read settles immediately after one attempt", async (_name, make) => {
    failingFetch()
    const db = await make()
    const read = track(db.from("homepage_content").select("*"))

    // No timer is advanced: a scheduled 1 s backoff would leave it pending.
    await vi.advanceTimersByTimeAsync(0)

    expect(read.settled).toBe(true)
    expect(read.value?.error).toBeTruthy()
    expect(read.value?.data).toBeNull()
    expect(attempts).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(60_000)
    expect(attempts).toHaveLength(1)
  })

  it("no 1 s / 2 s / 4 s retry sequence is ever scheduled", async () => {
    failingFetch()
    const db = createAdminSupabaseClient()
    await db.from("homepage_content").select("*")

    expect(vi.getTimerCount()).toBe(0)
  })

  it("a hanging read fails at the request timeout - one attempt, not ~47 s", async () => {
    hangingFetch()
    const db = createAdminSupabaseClient()
    const read = track(db.from("homepage_content").select("*"))

    await vi.advanceTimersByTimeAsync(SUPABASE_REQUEST_TIMEOUT_MS - 1)
    expect(read.settled).toBe(false)

    await vi.advanceTimersByTimeAsync(1)
    expect(read.settled).toBe(true)
    expect(read.value?.error?.message).toMatch(/timed out after 10000ms/)
    expect(attempts).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(60_000)
    expect(attempts).toHaveLength(1)
  })

  it("a 503 (schema cache reload) is returned, not retried", async () => {
    statusFetch(503)
    const db = createAdminSupabaseClient()
    const { error, status } = await db.from("homepage_content").select("*")

    expect(status).toBe(503)
    expect(error).toBeTruthy()
    expect(attempts).toHaveLength(1)
  })

  it("the policy carries over to schema() and GET-mode rpc()", async () => {
    failingFetch()
    const db = createAdminSupabaseClient()

    await db.schema("public").from("homepage_content").select("*")
    await db.rpc("some_read_fn", {}, { get: true })

    expect(attempts.map((a) => a.method)).toEqual(["GET", "GET"])
  })
})

describe("writes and RPCs: unchanged, never retried", () => {
  it.each([
    ["insert", (db: ReturnType<typeof createAdminSupabaseClient>) => db.from("t").insert({ a: 1 })],
    ["update", (db: ReturnType<typeof createAdminSupabaseClient>) => db.from("t").update({ a: 1 }).eq("id", 1)],
    ["delete", (db: ReturnType<typeof createAdminSupabaseClient>) => db.from("t").delete().eq("id", 1)],
    ["rpc", (db: ReturnType<typeof createAdminSupabaseClient>) => db.rpc("submit_order", { x: 1 })],
  ])("%s: one attempt, settles without any backoff timer", async (_name, write) => {
    failingFetch()
    const db = createAdminSupabaseClient()
    const result = await write(db)

    expect(result.error).toBeTruthy()
    expect(attempts).toHaveLength(1)
    expect(attempts[0].method).not.toBe("GET")
    expect(vi.getTimerCount()).toBe(0)
  })

  it("a timed-out write is not replayed", async () => {
    hangingFetch()
    const db = createAdminSupabaseClient()
    const write = track(db.rpc("submit_order", { x: 1 }))

    await vi.advanceTimersByTimeAsync(SUPABASE_REQUEST_TIMEOUT_MS + 60_000)

    expect(write.settled).toBe(true)
    expect(attempts).toHaveLength(1)
  })

  it("a failed storage upload is attempted once", async () => {
    failingFetch()
    const db = createAdminSupabaseClient()
    const { error } = await db.storage.from("bucket").upload("a.png", new Blob(["x"]))

    expect(error).toBeTruthy()
    expect(attempts).toHaveLength(1)
  })
})

describe("disablePostgrestRetries", () => {
  it("returns the same client instance", () => {
    const raw = createClient(URL_, "k")
    expect(disablePostgrestRetries(raw)).toBe(raw)
  })

  it("leaves test doubles without a PostgREST instance untouched", () => {
    const fake = { auth: {} }
    expect(disablePostgrestRetries(fake)).toEqual({ auth: {} })
    expect(disablePostgrestRetries(null)).toBeNull()
  })
})
