import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { getParentGalleryMedia } from "@/lib/parent/gallery/queries";
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
 * Gallery: batched signing + keyset pagination.
 *
 * The fake below applies the filters, ordering and limit the query asks for,
 * over a seeded media_assets table, so the assertions are about what a page
 * actually contains - not just which methods were called.
 */

const USER_A = "11111111-1111-4111-8111-111111111111";
const PROFILE_A = "aaaaaaaa-1111-4111-8111-111111111111";
const PROFILE_B = "bbbbbbbb-2222-4222-8222-222222222222";

interface Row {
  id: string;
  file_url: string;
  mime_type: string;
  created_at: string;
  original_filename: string;
  parent_id: string;
  type: string;
  asset_role: string;
}

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ts = (minute: number, micro = 0) =>
  `2026-03-01T10:${String(minute).padStart(2, "0")}:00.${String(micro).padStart(6, "0")}+00:00`;

function row(n: number, over: Partial<Row> = {}): Row {
  return {
    id: uuid(n),
    file_url: `${USER_A}/order-${n}/p${n}.png`,
    mime_type: "image/png",
    created_at: ts(n % 60),
    original_filename: `p${n}.png`,
    parent_id: PROFILE_A,
    type: "upload",
    asset_role: "source",
    ...over,
  };
}

function makeSupabase(table: Row[], opts: { failPaths?: Set<string>; failBatch?: boolean } = {}) {
  const calls = { createSignedUrls: [] as string[][], createSignedUrl: 0, limit: [] as number[], rangeOrOffset: 0 };

  function builder() {
    const eqs: Array<[string, unknown]> = [];
    let orExpr: string | null = null;
    let limitN = Infinity;
    const api: Record<string, unknown> = {};
    api.select = () => api;
    api.eq = (c: string, v: unknown) => (eqs.push([c, v]), api);
    api.or = (e: string) => ((orExpr = e), api);
    api.order = () => api;
    api.limit = (n: number) => (calls.limit.push(n), (limitN = n), api);
    api.range = () => (calls.rangeOrOffset++, api);
    api.maybeSingle = () => ({ data: { id: PROFILE_A }, error: null });
    api.then = (resolve: (v: unknown) => unknown) => {
      let rows = table.filter((r) =>
        eqs.every(([c, v]) =>
          c === "orders.parent_id" ? r.parent_id === v : (r as unknown as Record<string, unknown>)[c] === v,
        ),
      );
      if (orExpr) {
        const m = orExpr.match(/^created_at\.lt\.(.+),and\(created_at\.eq\.(.+),id\.lt\.(.+)\)$/);
        expect(m).not.toBeNull();
        const [, lt, eq, idLt] = m!;
        rows = rows.filter((r) => r.created_at < lt || (r.created_at === eq && r.id < idLt));
      }
      rows = [...rows].sort((a, b) =>
        a.created_at === b.created_at ? (a.id < b.id ? 1 : -1) : a.created_at < b.created_at ? 1 : -1,
      );
      return resolve({ data: rows.slice(0, limitN), error: null });
    };
    return api;
  }

  return {
    calls,
    client: {
      auth: { getUser: async () => ({ data: { user: { id: USER_A } }, error: null }) },
      from: () => builder(),
      storage: {
        from: () => ({
          createSignedUrl: async () => (calls.createSignedUrl++, { data: { signedUrl: "https://single" }, error: null }),
          createSignedUrls: async (paths: string[]) => {
            calls.createSignedUrls.push(paths);
            if (opts.failBatch) return { data: null, error: new Error("storage down") };
            return {
              data: paths.map((p) =>
                opts.failPaths?.has(p)
                  ? { path: p, signedUrl: null, error: "Object not found" }
                  : { path: p, signedUrl: `https://signed.example/${encodeURIComponent(p)}?token=t`, error: null },
              ),
              error: null,
            };
          },
        }),
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
  };
}

const seed = (count: number) => Array.from({ length: count }, (_, i) => row(i + 1));

describe("batched signing", () => {
  it("signs a whole page with ONE storage call and never per asset", async () => {
    const { client, calls } = makeSupabase(seed(60));
    const r = await getParentGalleryMedia(client);
    expect(r.ok).toBe(true);
    expect(calls.createSignedUrls).toHaveLength(1);
    expect(calls.createSignedUrl).toBe(0);
    expect(calls.createSignedUrls[0]).toHaveLength(GALLERY_DEFAULT_PAGE_SIZE);
  });

  it("signs only the page, not the whole library (500 assets, first page = 24)", async () => {
    const { client, calls } = makeSupabase(seed(500));
    const r = await getParentGalleryMedia(client);
    if (!r.ok) throw new Error("expected ok");
    expect(r.media).toHaveLength(24);
    expect(calls.createSignedUrls[0]).toHaveLength(24);
    expect(calls.limit).toEqual([25]); // pageSize + 1 look-ahead row, not 500
    expect(calls.rangeOrOffset).toBe(0);
  });

  it("source contains no per-asset createSignedUrl call inside a loop", () => {
    const src = readFileSync(path.resolve(__dirname, "../../lib/parent/gallery/queries.ts"), "utf8");
    expect(src).not.toMatch(/createPrivateSignedUrl\(/);
    expect(src).not.toMatch(/\.createSignedUrl\(/);
    expect(src).toMatch(/createPrivateSignedUrls\(/);
  });

  it("a partial signing failure degrades only that item", async () => {
    const bad = row(3).file_url;
    const { client } = makeSupabase(seed(5), { failPaths: new Set([bad]) });
    const r = await getParentGalleryMedia(client);
    if (!r.ok) throw new Error("expected ok");
    expect(r.media).toHaveLength(5);
    const failed = r.media.filter((m) => m.signedUrl === null);
    expect(failed.map((m) => m.id)).toEqual([uuid(3)]);
    expect(r.media.filter((m) => m.signedUrl !== null)).toHaveLength(4);
  });

  it("a total batch failure still returns the page with unavailable previews", async () => {
    const { client } = makeSupabase(seed(4), { failBatch: true });
    const r = await getParentGalleryMedia(client);
    if (!r.ok) throw new Error("expected ok");
    expect(r.media).toHaveLength(4);
    expect(r.media.every((m) => m.signedUrl === null)).toBe(true);
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

describe("keyset pagination", () => {
  async function walk(table: Row[], limit?: number) {
    const { client } = makeSupabase(table);
    const pages: string[][] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 100; i++) {
      const r = await getParentGalleryMedia(client, { cursor, limit });
      if (!r.ok) throw new Error(r.reason);
      pages.push(r.media.map((m) => m.id));
      if (!r.nextCursor) break;
      cursor = r.nextCursor;
    }
    return pages;
  }

  it("first page has only pageSize items, newest first", async () => {
    const { client } = makeSupabase(seed(60));
    const r = await getParentGalleryMedia(client);
    if (!r.ok) throw new Error("expected ok");
    expect(r.media).toHaveLength(24);
    expect(r.nextCursor).not.toBeNull();
    const times = r.media.map((m) => m.uploadedAt);
    expect([...times].sort().reverse()).toEqual(times);
  });

  it("second page continues exactly where the first stopped; no duplicates, nothing skipped", async () => {
    const pages = await walk(seed(60));
    expect(pages.map((p) => p.length)).toEqual([24, 24, 12]);
    const all = pages.flat();
    expect(new Set(all).size).toBe(60);
    const expected = seed(60).sort((a, b) => (a.created_at === b.created_at ? (a.id < b.id ? 1 : -1) : a.created_at < b.created_at ? 1 : -1)).map((r) => r.id);
    expect(all).toEqual(expected);
  });

  it("ordering is deterministic when many rows share a created_at (id tie-break)", async () => {
    const tied = Array.from({ length: 30 }, (_, i) => row(i + 1, { created_at: ts(7, 123456) }));
    const a = (await walk(tied, 7)).flat();
    const b = (await walk(tied, 7)).flat();
    expect(a).toEqual(b);
    expect(new Set(a).size).toBe(30);
    expect(a).toEqual([...a].sort().reverse());
  });

  it("last page ends the list: exact multiple of pageSize has no phantom page", async () => {
    const pages = await walk(seed(48));
    expect(pages.map((p) => p.length)).toEqual([24, 24]);
    const { client } = makeSupabase(seed(24));
    const only = await getParentGalleryMedia(client);
    if (!only.ok) throw new Error("expected ok");
    expect(only.nextCursor).toBeNull();
  });

  it("empty gallery works", async () => {
    const { client, calls } = makeSupabase([]);
    expect(await getParentGalleryMedia(client)).toEqual({ ok: true, media: [], nextCursor: null });
    expect(calls.createSignedUrls).toHaveLength(0); // nothing to sign
  });

  it("an upload arriving between pages does not repeat or skip anything", async () => {
    const table = seed(30);
    const { client } = makeSupabase(table);
    const first = await getParentGalleryMedia(client, { limit: 10 });
    if (!first.ok) throw new Error("x");
    table.push(row(999, { created_at: ts(59, 999999) })); // newest, lands mid-walk
    const second = await getParentGalleryMedia(client, { cursor: first.nextCursor, limit: 10 });
    if (!second.ok) throw new Error("x");
    const ids = [...first.media, ...second.media].map((m) => m.id);
    expect(new Set(ids).size).toBe(20);
    expect(ids).not.toContain(uuid(999)); // it belongs to page 1 of a fresh load
  });

  it("a cursor whose row has since been deleted still resumes correctly", async () => {
    const table = seed(30);
    const { client } = makeSupabase(table);
    const first = await getParentGalleryMedia(client, { limit: 10 });
    if (!first.ok) throw new Error("x");
    const cursorRowId = first.media[first.media.length - 1].id;
    table.splice(table.findIndex((r) => r.id === cursorRowId), 1); // stale cursor
    const second = await getParentGalleryMedia(client, { cursor: first.nextCursor, limit: 10 });
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.media).toHaveLength(10);
  });

  it("rejects malformed / forged cursors without querying", async () => {
    const { client, calls } = makeSupabase(seed(5));
    for (const bad of [
      "not-base64!!",
      "AAAA",
      btoa("2026-03-01|nope"),
      btoa("x),or(true|" + uuid(1)),
      btoa(`2026-03-01T10:00:00Z,id.gt.0|${uuid(1)}`),
      "A".repeat(500),
    ]) {
      const r = await getParentGalleryMedia(client, { cursor: bad });
      expect(r).toEqual({ ok: false, reason: "invalid_cursor" });
    }
    expect(calls.limit).toHaveLength(0);
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

  it("a huge client-supplied limit still reads at most max+1 rows and signs at most max", async () => {
    const { client, calls } = makeSupabase(seed(500));
    const r = await getParentGalleryMedia(client, { limit: 1_000_000 });
    if (!r.ok) throw new Error("x");
    expect(r.media).toHaveLength(48);
    expect(calls.limit).toEqual([49]);
    expect(calls.createSignedUrls[0]).toHaveLength(48);
  });
});

describe("ownership and role filtering", () => {
  it("never returns another parent's media", async () => {
    const mixed = [...seed(10), ...Array.from({ length: 10 }, (_, i) => row(100 + i, { parent_id: PROFILE_B, file_url: `other/${i}.png` }))];
    const { client } = makeSupabase(mixed);
    const r = await getParentGalleryMedia(client);
    if (!r.ok) throw new Error("x");
    expect(r.media).toHaveLength(10);
    expect(r.media.every((m) => Number(m.id.slice(-12)) < 100)).toBe(true);
  });

  it("excludes final / preview deliverables; only source uploads", async () => {
    const mixed = [
      ...seed(5),
      row(50, { asset_role: "final", type: "generated" }),
      row(51, { asset_role: "preview", type: "generated" }),
      row(52, { asset_role: "supporting" }),
      row(53, { type: "generated" }),
    ];
    const { client } = makeSupabase(mixed);
    const r = await getParentGalleryMedia(client);
    if (!r.ok) throw new Error("x");
    expect(r.media).toHaveLength(5);
    expect(r.media.map((m) => m.id)).not.toContain(uuid(50));
  });

  it("never exposes storage paths in a page", async () => {
    const { client } = makeSupabase(seed(3));
    const r = await getParentGalleryMedia(client);
    if (!r.ok) throw new Error("x");
    for (const m of r.media) {
      expect(Object.keys(m)).toEqual(["id", "mimeType", "uploadedAt", "signedUrl", "isImage", "label"]);
    }
    expect(JSON.stringify(r)).not.toContain(`${USER_A}/order`);
    expect(JSON.stringify(r)).not.toContain("file_url");
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
  it("reuse resolves by id with an ownership filter, independent of pagination", () => {
    const src = readFileSync(path.resolve(__dirname, "../../lib/parent/gallery/source-asset.ts"), "utf8");
    expect(src).toMatch(/\.eq\("orders\.parent_id", profile\.id\)/);
    expect(src).toMatch(/\.eq\("asset_role", "source"\)/);
    expect(src).toMatch(/startsWith\(`\$\{user\.id\}\/`\)/);
  });
});
