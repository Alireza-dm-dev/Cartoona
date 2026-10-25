import { describe, it, expect, vi, beforeEach } from "vitest";
import { toGalleryMedia, getParentGalleryMedia, type RawGalleryRow } from "@/lib/parent/gallery/queries";
import {
  isValidAssetId,
  resolveOwnedSourceAsset,
  sourceAssetCopyName,
} from "@/lib/parent/gallery/source-asset";
import { sanitizeFileName } from "@/lib/requests/sanitize-file-name";

/**
 * The private source-media library: its serializer, and the server-side
 * ownership rules behind reading it and reusing an item from it.
 *
 * The queries are exercised against a recording fake rather than a database,
 * so the assertions are about the filters the code *applies* — which is the
 * part that must never regress. The live behaviour is covered by the guarded
 * stateful spec.
 */

const PARENT_A_USER = "11111111-1111-4111-8111-111111111111";
const ASSET_A = "dddddddd-1111-4111-8111-111111111111";

const row = (over: Partial<RawGalleryRow> = {}): RawGalleryRow => ({
  id: ASSET_A,
  file_url: `${PARENT_A_USER}/order-1/photo.png`,
  mime_type: "image/png",
  created_at: "2026-03-01T10:00:00.000Z",
  original_filename: "photo.png",
  ...over,
});

const m = vi.hoisted(() => ({ fetchPage: vi.fn(), fetchAsset: vi.fn() }));
vi.mock("@/lib/parent/backend-media", () => ({ fetchGalleryPage: m.fetchPage, fetchOwnedSourceAsset: m.fetchAsset }));
vi.mock("@/lib/supabase/server", () => ({
  createServerSupabaseClient: async () => ({
    storage: { from: () => ({ createSignedUrls: async (paths: string[]) => ({ data: paths.map((path) => ({ path, error: null, signedUrl: "https://signed.example/x" })), error: null }) }) },
  }),
}));
const CONTEXT = { identity: { provider: "supabase", subject: PARENT_A_USER }, authenticatedAt: 1 } as never;
beforeEach(() => { m.fetchPage.mockReset(); m.fetchAsset.mockReset(); });

describe("gallery media serializer", () => {
  it("never carries a storage path into the read model", () => {
    const media = toGalleryMedia(row(), "https://signed.example/x");
    expect(media).not.toBeNull();
    expect(JSON.stringify(media)).not.toContain(PARENT_A_USER);
    expect(JSON.stringify(media)).not.toContain("order-1");
    expect(Object.keys(media!)).toEqual([
      "id",
      "mimeType",
      "uploadedAt",
      "signedUrl",
      "isImage",
      "label",
    ]);
  });

  it("keeps a failed signature as an unavailable item rather than dropping it", () => {
    const media = toGalleryMedia(row(), null);
    expect(media?.signedUrl).toBeNull();
  });

  it("flags images so non-images render without a preview", () => {
    expect(toGalleryMedia(row(), "u")?.isImage).toBe(true);
    expect(toGalleryMedia(row({ mime_type: "application/pdf" }), "u")?.isImage).toBe(false);
    expect(toGalleryMedia(row({ mime_type: null }), "u")?.isImage).toBe(false);
  });

  it("falls back to a null label rather than inventing a name", () => {
    expect(toGalleryMedia(row({ original_filename: null }), "u")?.label).toBeNull();
    expect(toGalleryMedia(row({ original_filename: "   " }), "u")?.label).toBeNull();
  });

  it("drops a row it cannot present safely", () => {
    expect(toGalleryMedia(row({ id: null }), "u")).toBeNull();
    expect(toGalleryMedia(row({ id: "" }), "u")).toBeNull();
    expect(toGalleryMedia(row({ created_at: 17 }), "u")).toBeNull();
  });
});

describe("gallery through the backend (ownership is SQL, proven against PostgreSQL elsewhere)", () => {
  it("asks only with the verified context; the browser supplies no parent id", async () => {
    m.fetchPage.mockResolvedValue({ ok: true, items: [{ id: ASSET_A, mimeType: "image/png", createdAt: "2026-03-01T10:00:00.000000+00:00", originalFilename: "photo.png", path: `${PARENT_A_USER}/order-1/photo.png` }], nextCursor: null });
    const result = await getParentGalleryMedia(CONTEXT);
    expect(result.ok).toBe(true);
    expect(m.fetchPage).toHaveBeenCalledTimes(1);
    expect(m.fetchPage.mock.calls[0][0]).toBe(CONTEXT);
  });

  it("reports a missing parent profile instead of returning unscoped media", async () => {
    m.fetchPage.mockResolvedValue({ ok: false, kind: "auth", reason: "no_parent_profile" });
    expect(await getParentGalleryMedia(CONTEXT)).toEqual({ ok: false, reason: "no_parent_profile" });
  });

  it("hides the backend reason when the read fails", async () => {
    m.fetchPage.mockResolvedValue({ ok: false, kind: "unavailable", outcomeUnknown: false });
    const result = await getParentGalleryMedia(CONTEXT);
    expect(result).toEqual({ ok: false, reason: "read_failed" });
    expect(JSON.stringify(result)).not.toContain("boom");
  });

  it("returns an empty library rather than failing when there is no media", async () => {
    m.fetchPage.mockResolvedValue({ ok: true, items: [], nextCursor: null });
    expect(await getParentGalleryMedia(CONTEXT)).toEqual({ ok: true, media: [], nextCursor: null });
  });
});

describe("existing-media selection validation", () => {
  it("rejects anything that is not a media asset id", async () => {
    for (const bad of ["", "not-a-uuid", `${PARENT_A_USER}/order-1/photo.png`, "../../etc/passwd", null, undefined, 42]) {
      expect(isValidAssetId(bad)).toBe(false);
      expect(await resolveOwnedSourceAsset(CONTEXT, bad)).toEqual({ ok: false, reason: "not_found" });
    }
    expect(isValidAssetId(ASSET_A)).toBe(true);
    expect(m.fetchAsset).not.toHaveBeenCalled();
  });

  it("resolves an owned asset by id through the backend", async () => {
    m.fetchAsset.mockResolvedValue({ ok: true, path: `${PARENT_A_USER}/order-1/photo.png`, mimeType: "image/png", originalFilename: "photo.png" });
    const result = await resolveOwnedSourceAsset(CONTEXT, ASSET_A);
    expect(result).toEqual({ ok: true, asset: { path: `${PARENT_A_USER}/order-1/photo.png`, mimeType: "image/png", originalFilename: "photo.png" } });
    expect(m.fetchAsset).toHaveBeenCalledWith(CONTEXT, ASSET_A);
  });

  it("reports another parent's asset as not_found, indistinguishable from a missing one", async () => {
    m.fetchAsset.mockResolvedValue({ ok: false, kind: "not_found" });
    const foreign = await resolveOwnedSourceAsset(CONTEXT, "cccccccc-2222-4222-8222-222222222222");
    const missing = await resolveOwnedSourceAsset(CONTEXT, ASSET_A);
    expect(foreign).toEqual({ ok: false, reason: "not_found" });
    expect(missing).toEqual(foreign);
  });

  it("refuses a row whose path is outside the caller's own folder", async () => {
    m.fetchAsset.mockResolvedValue({ ok: true, path: "22222222-2222-4222-8222-222222222222/order-9/photo.png", mimeType: "image/png", originalFilename: "photo.png" });
    expect(await resolveOwnedSourceAsset(CONTEXT, ASSET_A)).toEqual({ ok: false, reason: "not_found" });
  });

  it("a backend outage is read_failed, never a guess", async () => {
    m.fetchAsset.mockResolvedValue({ ok: false, kind: "unavailable", outcomeUnknown: false });
    expect(await resolveOwnedSourceAsset(CONTEXT, ASSET_A)).toEqual({ ok: false, reason: "read_failed" });
  });
});

describe("reused-asset copy naming", () => {
  const asset = (over = {}) => ({
    path: `${PARENT_A_USER}/order-1/photo.png`,
    mimeType: "image/png",
    originalFilename: "photo.png",
    ...over,
  });

  it("keeps the copy inside one path segment", () => {
    const name = sourceAssetCopyName(
      asset({ originalFilename: "../../escape.png" }),
      sanitizeFileName,
    );
    expect(name).not.toContain("/");
    expect(name).not.toContain("..");
  });

  it("falls back to the source file name when none was recorded", () => {
    expect(sourceAssetCopyName(asset({ originalFilename: null }), sanitizeFileName)).toBe("photo.png");
  });

  it("always produces a usable name", () => {
    expect(sourceAssetCopyName(asset({ originalFilename: "***" }), sanitizeFileName)).toBe("file");
  });
});

describe("file name sanitisation", () => {
  it("strips separators and traversal", () => {
    expect(sanitizeFileName("../../etc/passwd")).toBe("etc_passwd");
    expect(sanitizeFileName("a/b\\c.png")).toBe("a_b_c.png");
  });

  it("never returns an empty segment", () => {
    expect(sanitizeFileName("")).toBe("file");
    expect(sanitizeFileName("___")).toBe("file");
  });
});
