import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  GALLERY_DEFAULT_PAGE_SIZE,
  GALLERY_MAX_PAGE_SIZE,
  appendUniqueById,
  clampGalleryPageSize,
  decodeGalleryCursor,
  encodeGalleryCursor,
} from "@/lib/parent/gallery/pagination";
import { createPrivateSignedUrls } from "@/lib/storage/private-signed-url";

/**
 * Gallery (V0.1.52): the page comes from PostgreSQL through the backend
 * (fetchGalleryPage, mocked here), Storage only signs the keys of that page.
 * Ownership, role filtering and keyset ordering are SQL: they are proven
 * against real PostgreSQL in order-fulfilment-cutover-db.test.ts. These tests
 * are about what the Next side does with a page: one batched signing call,
 * partial/total Storage failure, cursor validation, bounds, no path exposure.
 */

const m = vi.hoisted(() => ({
  fetchPage: vi.fn(),
  signed: [] as string[][],
  failPaths: new Set<string>(),
  failBatch: false,
  singleCalls: 0,
}));
vi.mock("@/lib/parent/backend-media", () => ({ fetchGalleryPage: m.fetchPage }));
vi.mock("@/lib/supabase/server", () => ({
  createServerSupabaseClient: async () => ({
    storage: {
      from: () => ({
        createSignedUrl: async () => (m.singleCalls++, { data: { signedUrl: "https://single" }, error: null }),
        createSignedUrls: async (paths: string[]) => {
          m.signed.push(paths);
          if (m.failBatch) return { data: null, error: new Error("storage down") };
          return {
            data: paths.map((p) =>
              m.failPaths.has(p)
                ? { path: p, signedUrl: null, error: "Object not found" }
                : { path: p, signedUrl: `https://signed.example/${encodeURIComponent(p)}?token=t`, error: null },
            ),
            error: null,
          };
        },
      }),
    },
  }),
}));

import { getParentGalleryMedia } from "@/lib/parent/gallery/queries";

const CONTEXT = { identity: { provider: "supabase", subject: "u1" }, authenticatedAt: 1 } as never;
const USER_A = "11111111-1111-4111-8111-111111111111";
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ts = (minute: number, micro = 0) =>
  `2026-03-01T10:${String(minute).padStart(2, "0")}:00.${String(micro).padStart(6, "0")}+00:00`;

const item = (n: number) => ({
  id: uuid(n),
  mimeType: "image/png",
  createdAt: ts(n % 60),
  originalFilename: `p${n}.png`,
  path: `${USER_A}/order-${n}/p${n}.png`,
});
const page = (count: number, nextCursor: string | null = null) => ({ ok: true as const, items: Array.from({ length: count }, (_, i) => item(i + 1)), nextCursor });

beforeEach(() => {
  m.fetchPage.mockReset();
  m.signed = [];
  m.failPaths = new Set();
  m.failBatch = false;
  m.singleCalls = 0;
});

describe("batched signing", () => {
  it("signs a whole page with ONE storage call and never per asset", async () => {
    m.fetchPage.mockResolvedValue(page(24, "next"));
    const r = await getParentGalleryMedia(CONTEXT);
    expect(r.ok).toBe(true);
    expect(m.signed).toHaveLength(1);
    expect(m.singleCalls).toBe(0);
    expect(m.signed[0]).toHaveLength(GALLERY_DEFAULT_PAGE_SIZE);
  });

  it("source contains no per-asset createSignedUrl call inside a loop", () => {
    const src = readFileSync(path.resolve(__dirname, "../../lib/parent/gallery/queries.ts"), "utf8");
    expect(src).not.toMatch(/createPrivateSignedUrl\(/);
    expect(src).not.toMatch(/\.createSignedUrl\(/);
    expect(src).toMatch(/createPrivateSignedUrls\(/);
  });

  it("a partial signing failure degrades only that item", async () => {
    m.fetchPage.mockResolvedValue(page(5));
    m.failPaths = new Set([item(3).path]);
    const r = await getParentGalleryMedia(CONTEXT);
    if (!r.ok) throw new Error("expected ok");
    expect(r.media).toHaveLength(5);
    expect(r.media.filter((x) => x.signedUrl === null).map((x) => x.id)).toEqual([uuid(3)]);
    expect(r.media.filter((x) => x.signedUrl !== null)).toHaveLength(4);
  });

  it("a total batch failure (Storage down) still returns the whole page with unavailable previews", async () => {
    m.fetchPage.mockResolvedValue(page(4));
    m.failBatch = true;
    const r = await getParentGalleryMedia(CONTEXT);
    if (!r.ok) throw new Error("expected ok");
    expect(r.media).toHaveLength(4);
    expect(r.media.every((x) => x.signedUrl === null)).toBe(true);
  });

  it("createPrivateSignedUrls dedupes paths and tolerates a thrown error", async () => {
    const createSignedUrls = vi.fn(async (paths: string[]) => ({
      data: paths.map((p) => ({ path: p, signedUrl: "u", error: null })),
      error: null,
    }));
    const sb = { storage: { from: () => ({ createSignedUrls }) } };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const map = await createPrivateSignedUrls(sb as any, ["a", "a", "b", ""]);
    expect(createSignedUrls.mock.calls[0][0]).toEqual(["a", "b"]);
    expect(map.get("a")).toBe("u");
    const boom = { storage: { from: () => ({ createSignedUrls: async () => { throw new Error("x"); } }) } };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((await createPrivateSignedUrls(boom as any, ["a"])).get("a")).toBeNull();
  });

  it("keeps the existing 300 s expiry and the private uploads bucket", () => {
    const src = readFileSync(path.resolve(__dirname, "../../lib/storage/private-signed-url.ts"), "utf8");
    expect(src).toMatch(/PRIVATE_MEDIA_SIGNED_URL_TTL_SECONDS = 300/);
    expect(src).toMatch(/PRIVATE_UPLOADS_BUCKET = "parent-uploads"/);
  });
});

describe("the backend page contract", () => {
  it("asks the backend with the verified context, the cursor and a clamped limit", async () => {
    m.fetchPage.mockResolvedValue(page(2));
    const cursor = encodeGalleryCursor({ createdAt: ts(3, 654321), id: uuid(7) });
    await getParentGalleryMedia(CONTEXT, { cursor, limit: 10 });
    expect(m.fetchPage).toHaveBeenCalledWith(CONTEXT, { cursor, limit: 10 });
  });

  it("a huge client-supplied limit is clamped to the maximum before the backend is asked", async () => {
    m.fetchPage.mockResolvedValue(page(48));
    const r = await getParentGalleryMedia(CONTEXT, { limit: 1_000_000 });
    if (!r.ok) throw new Error("x");
    expect(m.fetchPage.mock.calls[0][1].limit).toBe(GALLERY_MAX_PAGE_SIZE);
    expect(m.signed[0]).toHaveLength(48);
  });

  it("passes the backend's next cursor through and an empty page signs nothing", async () => {
    m.fetchPage.mockResolvedValue(page(3, "opaque-next"));
    const r = await getParentGalleryMedia(CONTEXT);
    expect(r.ok && r.nextCursor).toBe("opaque-next");
    m.fetchPage.mockResolvedValue(page(0));
    m.signed = [];
    expect(await getParentGalleryMedia(CONTEXT)).toEqual({ ok: true, media: [], nextCursor: null });
    expect(m.signed).toHaveLength(0);
  });

  it("rejects malformed / forged cursors without asking the backend", async () => {
    for (const bad of [
      "not-base64!!",
      "AAAA",
      btoa("2026-03-01|nope"),
      btoa("x),or(true|" + uuid(1)),
      btoa(`2026-03-01T10:00:00Z,id.gt.0|${uuid(1)}`),
      "A".repeat(500),
    ]) {
      expect(await getParentGalleryMedia(CONTEXT, { cursor: bad })).toEqual({ ok: false, reason: "invalid_cursor" });
    }
    expect(m.fetchPage).not.toHaveBeenCalled();
  });

  it("maps backend failures to safe reasons and never leaks a cause", async () => {
    const cases: Array<[unknown, string]> = [
      [{ ok: false, kind: "auth", reason: "no_parent_profile" }, "no_parent_profile"],
      [{ ok: false, kind: "auth", reason: "forbidden" }, "forbidden"],
      [{ ok: false, kind: "auth", reason: "service_unavailable" }, "read_failed"],
      [{ ok: false, kind: "unavailable", outcomeUnknown: false }, "read_failed"],
    ];
    for (const [failure, reason] of cases) {
      m.fetchPage.mockResolvedValue(failure);
      const r = await getParentGalleryMedia(CONTEXT);
      expect(r).toEqual({ ok: false, reason });
    }
  });

  it("never exposes storage paths in a page", async () => {
    m.fetchPage.mockResolvedValue(page(3));
    const r = await getParentGalleryMedia(CONTEXT);
    if (!r.ok) throw new Error("x");
    for (const x of r.media) expect(Object.keys(x)).toEqual(["id", "mimeType", "uploadedAt", "signedUrl", "isImage", "label"]);
    expect(JSON.stringify(r)).not.toContain(`${USER_A}/order`);
    expect(JSON.stringify(r)).not.toContain("file_url");
  });

  it("round-trips a real cursor", () => {
    const c = { createdAt: ts(3, 654321), id: uuid(7) };
    expect(decodeGalleryCursor(encodeGalleryCursor(c))).toEqual(c);
  });
});

describe("page size bounds", () => {
  it("clamps to a hard maximum and falls back to the default", () => {
    expect(clampGalleryPageSize(undefined)).toBe(GALLERY_DEFAULT_PAGE_SIZE);
    expect(clampGalleryPageSize(NaN)).toBe(GALLERY_DEFAULT_PAGE_SIZE);
    expect(clampGalleryPageSize(-5)).toBe(GALLERY_DEFAULT_PAGE_SIZE);
    expect(clampGalleryPageSize("abc")).toBe(GALLERY_DEFAULT_PAGE_SIZE);
    expect(clampGalleryPageSize(10_000_000)).toBe(GALLERY_MAX_PAGE_SIZE);
    expect(clampGalleryPageSize(12)).toBe(12);
    expect(GALLERY_MAX_PAGE_SIZE).toBe(48);
    expect(GALLERY_DEFAULT_PAGE_SIZE).toBe(24);
  });
});

describe("load-more client helper", () => {
  it("appends pages without duplicating ids", () => {
    const a = [{ id: "1" }, { id: "2" }];
    const b = [{ id: "2" }, { id: "3" }];
    expect(appendUniqueById(a, b).map((x) => x.id)).toEqual(["1", "2", "3"]);
    expect(appendUniqueById(a, [])).toEqual(a);
  });
});

describe("reuse flow stays server-validated", () => {
  it("reuse resolves by id through the backend (ownership in SQL) and re-checks the caller's own folder", () => {
    const src = readFileSync(path.resolve(__dirname, "../../lib/parent/gallery/source-asset.ts"), "utf8");
    expect(src).toMatch(/fetchOwnedSourceAsset\(context, assetId\)/);
    expect(src).toMatch(/startsWith\(`\$\{context\.identity\.subject\}\/`\)/);
    expect(src).not.toMatch(/\.from\("media_assets"\)/);
  });
});
