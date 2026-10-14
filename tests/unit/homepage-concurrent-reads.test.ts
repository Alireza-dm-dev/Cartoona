/**
 * V0.1.36 - the homepage's three independent CMS reads run concurrently, and a
 * failure in one still degrades only that piece.
 *
 * Uses the real admin client (retries disabled) over a stubbed fetch, so the
 * network attempts observed are the ones production code would make.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

import { createAdminSupabaseClient } from "@/lib/supabase/admin"
import { resolveHomepageWith } from "@/lib/homepage/resolve-core"
import { DEFAULT_HOMEPAGE_CONTENT } from "@/lib/homepage/default-content"
import { DEFAULT_TV_RECT } from "@/lib/homepage/hero-layout"
import { SUPABASE_REQUEST_TIMEOUT_MS } from "@/lib/supabase/timeout-fetch"

const TABLES = ["homepage_content", "homepage_media_assets", "homepage_hero_layout"] as const
type Table = (typeof TABLES)[number]

const STORED_RECT = { x: 0.1, y: 0.2, width: 0.3, height: 0.25 }
const STORED_CONTENT = {
  ...DEFAULT_HOMEPAGE_CONTENT,
  hero: { ...DEFAULT_HOMEPAGE_CONTENT.hero, title: "from the database" },
}

const OK_ROWS: Record<Table, unknown> = {
  homepage_content: [{ content_json: STORED_CONTENT, revision: 4 }],
  homepage_media_assets: [],
  homepage_hero_layout: [{ tv_rect: STORED_RECT, revision: 2 }],
}

let started: Table[]
const originalFetch = globalThis.fetch

function tableOf(input: RequestInfo | URL): Table {
  const path = new URL(String(input)).pathname
  const table = TABLES.find((t) => path.endsWith(`/${t}`))
  if (!table) throw new Error(`unexpected request ${path}`)
  return table
}

/** Per-table behaviour: "ok" answers with OK_ROWS, "fail" errors, "hang" never answers. */
function stubFetch(behaviour: Partial<Record<Table, "ok" | "fail" | "hang">>) {
  globalThis.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const table = tableOf(input)
    started.push(table)
    const mode = behaviour[table] ?? "ok"
    if (mode === "fail") return Promise.reject(new TypeError("fetch failed"))
    if (mode === "hang") {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason))
      })
    }
    return Promise.resolve(
      new Response(JSON.stringify(OK_ROWS[table]), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    )
  }) as typeof fetch
}

beforeEach(() => {
  started = []
  vi.useFakeTimers()
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://stub.supabase.invalid")
  vi.stubEnv("SUPABASE_SECRET_KEY", "stub-secret-key")
})

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

describe("homepage reads run concurrently", () => {
  it("all three requests are in flight before any of them answers", async () => {
    stubFetch({ homepage_content: "hang", homepage_media_assets: "hang", homepage_hero_layout: "hang" })
    let settled = false
    resolveHomepageWith(createAdminSupabaseClient()).then(() => (settled = true))

    await vi.advanceTimersByTimeAsync(0)

    expect([...started].sort()).toEqual([...TABLES].sort())
    expect(settled).toBe(false)
  })

  it("an unreachable backend costs one request timeout, not three in a row", async () => {
    stubFetch({ homepage_content: "hang", homepage_media_assets: "hang", homepage_hero_layout: "hang" })
    let settled = false
    const pending = resolveHomepageWith(createAdminSupabaseClient()).then((r) => {
      settled = true
      return r
    })

    await vi.advanceTimersByTimeAsync(SUPABASE_REQUEST_TIMEOUT_MS - 1)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(settled).toBe(true)

    const resolved = await pending
    expect(started).toHaveLength(3)
    expect(resolved.sources.content).toBe("default-read-error")
    expect(resolved.content).toEqual(DEFAULT_HOMEPAGE_CONTENT)
    expect(resolved.heroLayout).toEqual(DEFAULT_TV_RECT)
  })

  it("three fast failures settle together with one attempt each", async () => {
    stubFetch({ homepage_content: "fail", homepage_media_assets: "fail", homepage_hero_layout: "fail" })
    const resolved = await resolveHomepageWith(createAdminSupabaseClient())

    expect(started).toHaveLength(3)
    expect(vi.getTimerCount()).toBe(0)
    expect(resolved.sources.content).toBe("default-read-error")
    expect(resolved.sources.heroLayout).toBe("default")
    expect(Object.values(resolved.sources.mediaPerSlot).every((s) => s === "local-fallback")).toBe(true)
  })
})

describe("one failed read still degrades only its own piece", () => {
  it("all reads succeed: content and hero layout come from the database", async () => {
    stubFetch({})
    const resolved = await resolveHomepageWith(createAdminSupabaseClient())

    expect(resolved.sources.content).toBe("database")
    expect(resolved.content.hero.title).toBe("from the database")
    expect(resolved.sources.heroLayout).toBe("database")
    expect(resolved.heroLayout).toEqual(STORED_RECT)
  })

  it("content read fails: content falls back, hero layout is still served from the database", async () => {
    stubFetch({ homepage_content: "fail" })
    const resolved = await resolveHomepageWith(createAdminSupabaseClient())

    expect(resolved.sources.content).toBe("default-read-error")
    expect(resolved.content).toEqual(DEFAULT_HOMEPAGE_CONTENT)
    expect(resolved.sources.heroLayout).toBe("database")
    expect(resolved.heroLayout).toEqual(STORED_RECT)
  })

  it("hero layout read fails: layout falls back, content is still served from the database", async () => {
    stubFetch({ homepage_hero_layout: "fail" })
    const resolved = await resolveHomepageWith(createAdminSupabaseClient())

    expect(resolved.sources.content).toBe("database")
    expect(resolved.content.hero.title).toBe("from the database")
    expect(resolved.sources.heroLayout).toBe("default")
    expect(resolved.heroLayout).toEqual(DEFAULT_TV_RECT)
  })

  it("media read fails: every slot uses its local asset, content and layout unaffected", async () => {
    stubFetch({ homepage_media_assets: "fail" })
    const resolved = await resolveHomepageWith(createAdminSupabaseClient())

    expect(Object.values(resolved.sources.mediaPerSlot).every((s) => s === "local-fallback")).toBe(true)
    expect(resolved.sources.content).toBe("database")
    expect(resolved.sources.heroLayout).toBe("database")
  })
})
