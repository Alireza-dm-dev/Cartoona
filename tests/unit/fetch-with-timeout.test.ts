import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import {
  fetchWithTimeout,
  createTimeoutFetch,
  FetchTimeoutError,
  isFetchTimeoutError,
} from "@/lib/http/fetch-with-timeout"
import {
  resolveSupabaseTimeoutMs,
  SUPABASE_REQUEST_TIMEOUT_MS,
  SUPABASE_STORAGE_TIMEOUT_MS,
} from "@/lib/supabase/timeout-fetch"
import { AuthRetryableFetchError, isAuthRetryableFetchError } from "@supabase/supabase-js"

/** A fetch that never answers; rejects with AbortError only when aborted. */
function stalledFetch() {
  return vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      const abort = () => reject(new DOMException("This operation was aborted", "AbortError"))
      if (init?.signal?.aborted) return abort()
      init?.signal?.addEventListener("abort", abort)
    }),
  )
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe("fetchWithTimeout", () => {
  it("fast request succeeds and its timer is cleaned up", async () => {
    const impl = vi.fn(async () => new Response("ok", { status: 200 }))
    const res = await fetchWithTimeout("http://x/a", undefined, 1000, impl)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe("ok")
    expect(vi.getTimerCount()).toBe(0)
  })

  it("stalled request aborts after the configured timeout with a distinguishable error", async () => {
    const impl = stalledFetch()
    const p = fetchWithTimeout("http://x/a", undefined, 1000, impl)
    const caught = p.catch((e) => e)
    await vi.advanceTimersByTimeAsync(999)
    expect(impl).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    const err = await caught
    expect(isFetchTimeoutError(err)).toBe(true)
    expect(err).toBeInstanceOf(FetchTimeoutError)
    expect((err as FetchTimeoutError).timeoutMs).toBe(1000)
    expect(vi.getTimerCount()).toBe(0)
  })

  it("a body that stalls after headers is bounded too", async () => {
    const impl = vi.fn(async () => new Response(new ReadableStream({ start() {} }), { status: 200 }))
    const res = await fetchWithTimeout("http://x/a", undefined, 1000, impl)
    const reading = res.text().catch((e) => e)
    await vi.advanceTimersByTimeAsync(1000)
    expect(isFetchTimeoutError(await reading)).toBe(true)
  })

  it("timer is released once the body is read, and on cancel", async () => {
    const impl = vi.fn(async () => new Response("done"))
    const res = await fetchWithTimeout("http://x/a", undefined, 1000, impl)
    expect(vi.getTimerCount()).toBe(1) // body not read yet: deadline still guards it
    await res.text()
    expect(vi.getTimerCount()).toBe(0)

    const res2 = await fetchWithTimeout("http://x/a", undefined, 1000, impl)
    await res2.body!.cancel()
    expect(vi.getTimerCount()).toBe(0)
  })

  it("caller-provided AbortSignal still aborts, with the caller's error not a timeout", async () => {
    const impl = stalledFetch()
    const caller = new AbortController()
    const caught = fetchWithTimeout("http://x/a", { signal: caller.signal }, 1000, impl).catch((e) => e)
    caller.abort()
    const err = await caught
    expect(isFetchTimeoutError(err)).toBe(false)
    expect((err as Error).name).toBe("AbortError")
    expect(vi.getTimerCount()).toBe(0)
  })

  it("an already-aborted caller signal aborts immediately", async () => {
    const impl = stalledFetch()
    const caller = new AbortController()
    caller.abort()
    const err = await fetchWithTimeout("http://x/a", { signal: caller.signal }, 1000, impl).catch((e) => e)
    expect(isFetchTimeoutError(err)).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it("non-timeout network errors pass through unchanged and clear the timer", async () => {
    const boom = new TypeError("fetch failed")
    const impl = vi.fn(async () => { throw boom })
    await expect(fetchWithTimeout("http://x/a", undefined, 1000, impl)).rejects.toBe(boom)
    expect(vi.getTimerCount()).toBe(0)
  })

  it("never retries: a timed-out POST is sent exactly once", async () => {
    const impl = stalledFetch()
    const caught = fetchWithTimeout("http://x/orders", { method: "POST", body: "{}" }, 1000, impl).catch((e) => e)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(isFetchTimeoutError(await caught)).toBe(true)
    expect(impl).toHaveBeenCalledTimes(1)
  })

  it("preserves method, headers and body for the underlying call", async () => {
    const impl = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }))
    await fetchWithTimeout("http://x/a", { method: "POST", headers: { a: "b" }, body: "z" }, 1000, impl)
    const init = impl.mock.calls[0][1]!
    expect(init.method).toBe("POST")
    expect(init.body).toBe("z")
    expect(init.signal).toBeInstanceOf(AbortSignal)
    expect(vi.getTimerCount()).toBe(0) // null body: released at once
  })
})

describe("createTimeoutFetch / Supabase policy", () => {
  it("uses the per-URL deadline", async () => {
    const impl = stalledFetch()
    const f = createTimeoutFetch((u) => (String(u).includes("slow") ? 5000 : 1000), impl)
    const fast = f("http://x/fast").catch((e) => e)
    const slow = f("http://x/slow").catch((e) => e)
    await vi.advanceTimersByTimeAsync(1000)
    expect(isFetchTimeoutError(await fast)).toBe(true)
    await vi.advanceTimersByTimeAsync(4000)
    expect(isFetchTimeoutError(await slow)).toBe(true)
  })

  it("storage gets a longer budget than auth/rest/rpc", () => {
    expect(resolveSupabaseTimeoutMs("https://p.supabase.co/auth/v1/user")).toBe(SUPABASE_REQUEST_TIMEOUT_MS)
    expect(resolveSupabaseTimeoutMs("https://p.supabase.co/rest/v1/rpc/x")).toBe(SUPABASE_REQUEST_TIMEOUT_MS)
    expect(resolveSupabaseTimeoutMs(new URL("https://p.supabase.co/storage/v1/object/b/p"))).toBe(SUPABASE_STORAGE_TIMEOUT_MS)
    expect(SUPABASE_STORAGE_TIMEOUT_MS).toBeGreaterThan(SUPABASE_REQUEST_TIMEOUT_MS)
    expect(SUPABASE_REQUEST_TIMEOUT_MS).toBeGreaterThanOrEqual(8000)
  })
})

describe("timeout vs auth semantics (real supabase-js clients)", () => {
  async function timedOutClient() {
    const { createClient } = await import("@supabase/supabase-js")
    const f = createTimeoutFetch(() => 1000, stalledFetch())
    return createClient("http://localhost:54321", "anon-key", {
      global: { fetch: f },
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    })
  }

  it("getUser() timing out is a retryable fetch error, not an invalid session", async () => {
    const sb = await timedOutClient()
    const pending = sb.auth.getUser("some.jwt.token")
    await vi.advanceTimersByTimeAsync(1000)
    const { data, error } = await pending
    expect(data.user).toBeNull()
    expect(error).toBeInstanceOf(AuthRetryableFetchError)
    expect(isAuthRetryableFetchError(error)).toBe(true) // middleware -> 503 branch
  })

  it("an RPC timing out returns an error object, which maps to lookup_failed (not expired)", async () => {
    const { checkCurrentParentSessionLifetime } = await import("@/lib/auth/parent-session-lifetime")
    const sb = await timedOutClient()
    const pending = checkCurrentParentSessionLifetime(sb)
    await vi.advanceTimersByTimeAsync(1000)
    expect(await pending).toEqual({ valid: false, reason: "lookup_failed" })
  })
})
