import { describe, it, expect, vi, beforeEach } from "vitest";
import { encodeGalleryCursor } from "@/lib/parent/gallery/pagination";

const CONTEXT = { identity: { provider: "supabase", subject: "u1" }, authenticatedAt: 1 };
const m = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@/lib/parent/backend-caller", () => ({
  verifyParentCaller: async () => ({ ok: true, context: { identity: { provider: "supabase", subject: "u1" }, authenticatedAt: 1 } }),
}));
vi.mock("@/lib/parent/gallery/queries", async (orig) => {
  const real = await orig<typeof import("@/lib/parent/gallery/queries")>();
  return { ...real, getParentGalleryMedia: m.get };
});

describe("GET /api/parent/gallery paging contract", () => {
  beforeEach(() => {
    m.get.mockReset();
  });

  it("passes cursor and a bounded limit through, returns media + nextCursor", async () => {
    const { GET } = await import("@/app/api/parent/gallery/route");
    m.get.mockResolvedValue({ ok: true, media: [{ id: "a" }], nextCursor: "next" });
    const cur = encodeGalleryCursor({ createdAt: "2026-03-01T10:00:00.000000+00:00", id: "00000000-0000-4000-8000-000000000001" });
    const res = await GET(new Request(`http://x/api/parent/gallery?cursor=${cur}&limit=10`));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ media: [{ id: "a" }], nextCursor: "next" });
    expect(m.get.mock.calls[0][0]).toEqual(CONTEXT);
    expect(m.get.mock.calls[0][1]).toEqual({ cursor: cur, limit: 10 });
  });

  it("no params -> first page defaults (cursor null, limit undefined)", async () => {
    const { GET } = await import("@/app/api/parent/gallery/route");
    m.get.mockResolvedValue({ ok: true, media: [], nextCursor: null });
    await GET(new Request("http://x/api/parent/gallery"));
    expect(m.get.mock.calls[0][1]).toEqual({ cursor: null, limit: undefined });
  });

  it("an invalid cursor is a 400, not a 500 and not a full list", async () => {
    const { GET } = await import("@/app/api/parent/gallery/route");
    m.get.mockResolvedValue({ ok: false, reason: "invalid_cursor" });
    const res = await GET(new Request("http://x/api/parent/gallery?cursor=garbage"));
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).not.toMatch(/cursor|supabase|postgres/i);
  });

  it("a profile-less account still gets an empty first page shape", async () => {
    const { GET } = await import("@/app/api/parent/gallery/route");
    m.get.mockResolvedValue({ ok: false, reason: "no_parent_profile" });
    const res = await GET(new Request("http://x/api/parent/gallery"));
    expect(await res.json()).toEqual({ media: [], nextCursor: null });
  });
});
