import { describe, it, expect } from "vitest";
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
const PARENT_A_PROFILE = "aaaaaaaa-1111-4111-8111-111111111111";
const ASSET_A = "dddddddd-1111-4111-8111-111111111111";

const row = (over: Partial<RawGalleryRow> = {}): RawGalleryRow => ({
  id: ASSET_A,
  file_url: `${PARENT_A_USER}/order-1/photo.png`,
  mime_type: "image/png",
  created_at: "2026-03-01T10:00:00.000Z",
  original_filename: "photo.png",
  ...over,
});

/** Records every filter applied, so the ownership contract can be asserted. */
function makeSupabase(options: {
  user?: { id: string } | null;
  profile?: { id: string } | null;
  assetRows?: unknown[];
  assetRow?: unknown;
  signedUrl?: string | null;
  assetError?: boolean;
}) {
  const filters: Record<string, { column: string; value: unknown }[]> = {};

  function builder(table: string) {
    filters[table] ??= [];
    const api: Record<string, unknown> = {};
    const chain = () => api;
    api.select = chain;
    api.order = chain;
    api.limit = chain;
    api.or = chain;
    // The list query is awaited directly after .limit(), so the builder is thenable.
    api.then = (resolve: (v: unknown) => unknown) =>
      resolve(
        options.assetError
          ? { data: null, error: new Error("boom") }
          : { data: options.assetRows ?? [], error: null },
      );
    api.eq = (column: string, value: unknown) => {
      filters[table].push({ column, value });
      return api;
    };
    api.maybeSingle = () => {
      if (table === "parent_profiles") {
        return { data: options.profile ?? null, error: null };
      }
      if (options.assetError) return { data: null, error: new Error("boom") };
      return { data: options.assetRow ?? null, error: null };
    };
    return api;
  }

  return {
    filters,
    client: {
      auth: {
        getUser: async () => ({
          data: { user: options.user === undefined ? { id: PARENT_A_USER } : options.user },
          error: null,
        }),
      },
      from: (table: string) => builder(table),
      storage: {
        from: () => ({
          createSignedUrls: async (paths: string[]) =>
            options.signedUrl === null
              ? { data: null, error: new Error("sign failed") }
              : {
                  data: paths.map((path) => ({
                    path,
                    error: null,
                    signedUrl: options.signedUrl ?? "https://signed.example/x",
                  })),
                  error: null,
                },
        }),
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
  };
}

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

describe("gallery ownership filtering", () => {
  it("scopes the read to the caller's own parent profile and source uploads", async () => {
    const { client, filters } = makeSupabase({
      profile: { id: PARENT_A_PROFILE },
      assetRows: [row()],
    });

    const result = await getParentGalleryMedia(client);
    expect(result.ok).toBe(true);

    expect(filters.parent_profiles).toContainEqual({ column: "user_id", value: PARENT_A_USER });
    expect(filters.media_assets).toContainEqual({
      column: "orders.parent_id",
      value: PARENT_A_PROFILE,
    });
    expect(filters.media_assets).toContainEqual({ column: "type", value: "upload" });
    expect(filters.media_assets).toContainEqual({ column: "asset_role", value: "source" });
  });

  it("refuses to read anything for an anonymous caller", async () => {
    const { client, filters } = makeSupabase({ user: null });
    const result = await getParentGalleryMedia(client);
    expect(result).toEqual({ ok: false, reason: "unauthenticated" });
    expect(filters.media_assets).toBeUndefined();
  });

  it("reports a missing parent profile instead of returning unscoped media", async () => {
    const { client, filters } = makeSupabase({ profile: null });
    const result = await getParentGalleryMedia(client);
    expect(result).toEqual({ ok: false, reason: "no_parent_profile" });
    expect(filters.media_assets).toBeUndefined();
  });

  it("hides the backend reason when the read fails", async () => {
    const { client } = makeSupabase({ profile: { id: PARENT_A_PROFILE }, assetError: true });
    const result = await getParentGalleryMedia(client);
    expect(result).toEqual({ ok: false, reason: "read_failed" });
    expect(JSON.stringify(result)).not.toContain("boom");
  });

  it("returns an empty library rather than failing when there is no media", async () => {
    const { client } = makeSupabase({ profile: { id: PARENT_A_PROFILE }, assetRows: [] });
    const result = await getParentGalleryMedia(client);
    expect(result).toEqual({ ok: true, media: [], nextCursor: null });
  });
});

describe("existing-media selection validation", () => {
  it("rejects anything that is not a media asset id", () => {
    for (const bad of [
      "",
      "not-a-uuid",
      `${PARENT_A_USER}/order-1/photo.png`,
      "../../etc/passwd",
      null,
      undefined,
      42,
    ]) {
      expect(isValidAssetId(bad)).toBe(false);
    }
    expect(isValidAssetId(ASSET_A)).toBe(true);
  });

  it("resolves an owned asset by id, filtering on the caller's parent profile", async () => {
    const { client, filters } = makeSupabase({
      profile: { id: PARENT_A_PROFILE },
      assetRow: {
        file_url: `${PARENT_A_USER}/order-1/photo.png`,
        mime_type: "image/png",
        original_filename: "photo.png",
      },
    });

    const result = await resolveOwnedSourceAsset(client, ASSET_A);
    expect(result.ok).toBe(true);
    expect(filters.media_assets).toContainEqual({
      column: "orders.parent_id",
      value: PARENT_A_PROFILE,
    });
    expect(filters.media_assets).toContainEqual({ column: "id", value: ASSET_A });
    expect(filters.media_assets).toContainEqual({ column: "asset_role", value: "source" });
  });

  it("reports another parent's asset as not_found, indistinguishable from a missing one", async () => {
    // The ownership filter is what makes the row invisible, so the query
    // simply returns nothing — exactly as it would for an id that never existed.
    const foreign = await resolveOwnedSourceAsset(
      makeSupabase({ profile: { id: PARENT_A_PROFILE }, assetRow: null }).client,
      "cccccccc-2222-4222-8222-222222222222",
    );
    const missing = await resolveOwnedSourceAsset(
      makeSupabase({ profile: { id: PARENT_A_PROFILE }, assetRow: null }).client,
      ASSET_A,
    );
    expect(foreign).toEqual({ ok: false, reason: "not_found" });
    expect(missing).toEqual(foreign);
  });

  it("refuses a row whose path is outside the caller's own folder", async () => {
    const { client } = makeSupabase({
      profile: { id: PARENT_A_PROFILE },
      assetRow: {
        file_url: "22222222-2222-4222-8222-222222222222/order-9/photo.png",
        mime_type: "image/png",
        original_filename: "photo.png",
      },
    });
    const result = await resolveOwnedSourceAsset(client, ASSET_A);
    expect(result).toEqual({ ok: false, reason: "not_found" });
  });

  it("never queries for an anonymous caller", async () => {
    const { client, filters } = makeSupabase({ user: null });
    const result = await resolveOwnedSourceAsset(client, ASSET_A);
    expect(result).toEqual({ ok: false, reason: "unauthenticated" });
    expect(filters.media_assets).toBeUndefined();
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
