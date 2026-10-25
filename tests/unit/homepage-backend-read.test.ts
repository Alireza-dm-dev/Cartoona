import { describe, it, expect, vi, beforeEach } from "vitest"

/**
 * V0.1.53: the public homepage is ONE anonymous backend read (PostgreSQL), not
 * three Supabase table reads. It replaces the V0.1.36 concurrent-reads test:
 * there is nothing left to run concurrently, so the properties that matter are
 * "one request, no identity, any failure degrades to the committed defaults".
 */

const m = vi.hoisted(() => ({ callGet: vi.fn() }))
vi.mock("@/lib/backend/call", () => ({ callGet: m.callGet, callWrite: vi.fn() }))

import { fetchHomepageData } from "@/lib/homepage/backend-homepage"
import { resolveHomepageFromData, LOCAL_MEDIA_FALLBACK } from "@/lib/homepage/resolve-core"
import { DEFAULT_HOMEPAGE_CONTENT } from "@/lib/homepage/default-content"
import { DEFAULT_TV_RECT } from "@/lib/homepage/hero-layout"

const STORED_RECT = { x: 0.1, y: 0.2, width: 0.3, height: 0.25 }
const STORED = { ...DEFAULT_HOMEPAGE_CONTENT, hero: { ...DEFAULT_HOMEPAGE_CONTENT.hero, title: "from PostgreSQL" } }
const URL_OF = (p: string) => `https://cdn.example.test/${p}`

beforeEach(() => m.callGet.mockReset())

describe("fetchHomepageData", () => {
  it("is one anonymous GET of the public route (no assertion, no identity, no query)", async () => {
    m.callGet.mockResolvedValue({ ok: true, status: 200, body: { content: null, media: [], heroLayout: null } })
    await fetchHomepageData()
    expect(m.callGet).toHaveBeenCalledTimes(1)
    expect(m.callGet.mock.calls[0][0]).toBeNull()
    expect(m.callGet.mock.calls[0][2]).toBe("/v1/public/homepage")
    expect(m.callGet.mock.calls[0][3]).toBeUndefined()
  })

  it("maps the payload, keeping only typed fields", async () => {
    m.callGet.mockResolvedValue({
      ok: true,
      status: 200,
      body: {
        content: { contentJson: STORED, revision: 4 },
        media: [{ slotKey: "hero.background", mediaType: "image", storagePath: "homepage/hero-background/1-a.png", mimeType: "image/png", byteSize: 10, width: 1, height: 2, durationSeconds: null, updatedAt: "2026-01-01T00:00:00.000000+00:00", extra: "dropped" }],
        heroLayout: { tvRect: STORED_RECT, revision: 2 },
      },
    })
    const data = await fetchHomepageData()
    expect(data?.content).toEqual({ contentJson: STORED, revision: 4 })
    expect(data?.media[0]).not.toHaveProperty("extra")
    expect(data?.heroLayout).toEqual({ tvRect: STORED_RECT, revision: 2 })
  })

  it.each([
    [{ ok: false, kind: "unavailable", outcomeUnknown: false }],
    [{ ok: false, kind: "refused", status: 400, error: "invalid_request", body: {} }],
    [{ ok: true, status: 200, body: { content: null, heroLayout: null } }], // media missing: malformed
  ])("a backend that cannot answer (%j) is null", async (result) => {
    m.callGet.mockResolvedValue(result)
    expect(await fetchHomepageData()).toBeNull()
  })
})

describe("resolution over the backend payload", () => {
  it("all pieces from PostgreSQL when the payload is complete", () => {
    const r = resolveHomepageFromData(
      { content: { contentJson: STORED, revision: 4 }, media: [], heroLayout: { tvRect: STORED_RECT, revision: 2 } },
      URL_OF,
    )
    expect(r.sources.content).toBe("database")
    expect(r.content.hero.title).toBe("from PostgreSQL")
    expect(r.heroLayout).toEqual(STORED_RECT)
  })

  it("a backend outage serves the committed defaults for content, media and layout (never blank, never throws)", () => {
    const r = resolveHomepageFromData(null, URL_OF)
    expect(r.sources.content).toBe("default-read-error")
    expect(r.content).toEqual(DEFAULT_HOMEPAGE_CONTENT)
    expect(r.heroLayout).toEqual(DEFAULT_TV_RECT)
    expect(r.media).toEqual(LOCAL_MEDIA_FALLBACK)
  })

  it("a stored media row overrides only its own slot", () => {
    const r = resolveHomepageFromData(
      {
        content: null,
        media: [{ slotKey: "hero.background", mediaType: "image", storagePath: "homepage/hero-background/1-a.png", mimeType: "image/png", byteSize: 1, width: null, height: null, durationSeconds: null, updatedAt: "" }],
        heroLayout: null,
      },
      URL_OF,
    )
    expect(r.media["hero.background"]).toBe("https://cdn.example.test/homepage/hero-background/1-a.png")
    expect(r.media["sections.background"]).toBe(LOCAL_MEDIA_FALLBACK["sections.background"])
  })
})
