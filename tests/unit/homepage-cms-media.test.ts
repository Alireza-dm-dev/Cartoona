import { describe, test, expect } from "vitest";

import {
  DEFAULT_TV_RECT,
  aspectCompatibilityNote,
  validateHeroTvRect,
} from "@/lib/homepage/hero-layout";
import {
  HOMEPAGE_MEDIA_SIZE_LIMITS,
  buildMediaStoragePath,
  decideMediaRollback,
  detectMediaSignature,
  isAllowedMediaMime,
  isKnownMediaSlot,
  isSharedBackground,
  mimeMatchesSlot,
  probeImageDimensions,
  toSafeSlotRecord,
  validateUploadCandidate,
} from "@/lib/admin/homepage/media-validation";
import { mapAdminHomepageMediaRpcError } from "@/lib/admin/homepage/media-errors";

// Minimal valid file heads for sniff tests.
const PNG_HEAD = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const JPEG_HEAD = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 1, 2, 3, 4, 5, 6, 7]);
const WEBP_HEAD = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50]);
const MP4_HEAD = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 1, 2, 3, 4]);
const WEBM_HEAD = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4, 5, 6, 7, 8]);
const GARBAGE = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);

// A 1x1 PNG (signature + IHDR width=1 height=1) for probe tests.
const PNG_1X1 = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
  0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0,
]);

// ─── 1. slot allowlist ───────────────────────────────────────────────────────
describe("media slot allowlist", () => {
  test("1. accepts the seven declared slots, rejects everything else", () => {
    for (const s of [
      "hero.background", "hero.tv_video", "sections.background",
      "build_options.card_image", "build_options.card_video",
      "build_options.card_animation", "safety.image",
    ]) {
      expect(isKnownMediaSlot(s)).toBe(true);
    }
    for (const s of ["hero.unknown", "arbitrary", "", "hero.background ", "../x", null, 42, undefined]) {
      expect(isKnownMediaSlot(s)).toBe(false);
    }
  });

  test("8. unknown slot rejected before file inspection", () => {
    const result = validateUploadCandidate({
      slot: "hero.unknown", claimedMime: "image/png", byteSize: 10, headBytes: GARBAGE,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]?.field).toBe("slot");
  });
});

// ─── 2-4. MIME policy ────────────────────────────────────────────────────────
describe("media MIME policy", () => {
  test("2. image slots accept png/jpeg/webp and nothing else", () => {
    for (const m of ["image/png", "image/jpeg", "image/webp"]) {
      expect(isAllowedMediaMime("image", m)).toBe(true);
    }
    for (const m of ["image/svg+xml", "image/gif", "video/mp4", "text/html", "application/octet-stream", "", null]) {
      expect(isAllowedMediaMime("image", m)).toBe(false);
    }
  });

  test("3. video slots accept mp4/webm only", () => {
    expect(isAllowedMediaMime("video", "video/mp4")).toBe(true);
    expect(isAllowedMediaMime("video", "video/webm")).toBe(true);
    for (const m of ["video/avi", "image/png", "image/gif", "", null]) {
      expect(isAllowedMediaMime("video", m)).toBe(false);
    }
  });

  test("4. wrong type per slot rejected", () => {
    expect(mimeMatchesSlot("hero.tv_video", "image/png")).toBe(false);
    expect(mimeMatchesSlot("hero.background", "video/mp4")).toBe(false);
    expect(mimeMatchesSlot("build_options.card_video", "image/jpeg")).toBe(false);
    expect(mimeMatchesSlot("safety.image", "video/webm")).toBe(false);
    expect(mimeMatchesSlot("hero.background", "image/png")).toBe(true);
    expect(mimeMatchesSlot("hero.tv_video", "video/mp4")).toBe(true);
  });

  test("magic-byte sniff matches containers, rejects garbage", () => {
    expect(detectMediaSignature(PNG_HEAD)).toBe("image/png");
    expect(detectMediaSignature(JPEG_HEAD)).toBe("image/jpeg");
    expect(detectMediaSignature(WEBP_HEAD)).toBe("image/webp");
    expect(detectMediaSignature(MP4_HEAD)).toBe("video/mp4");
    expect(detectMediaSignature(WEBM_HEAD)).toBe("video/webm");
    expect(detectMediaSignature(GARBAGE)).toBeNull();
    expect(detectMediaSignature(new Uint8Array(3))).toBeNull();
  });

  test("content mismatching the claim is rejected (no extension trust)", () => {
    const result = validateUploadCandidate({
      slot: "safety.image", claimedMime: "image/png", byteSize: 100, headBytes: MP4_HEAD,
    });
    expect(result.ok).toBe(false);
  });
});

// ─── 5-6. size caps ──────────────────────────────────────────────────────────
describe("media size caps", () => {
  test("5. oversized image rejected at the slot-class cap", () => {
    const over = HOMEPAGE_MEDIA_SIZE_LIMITS["safety.image"] + 1;
    const result = validateUploadCandidate({
      slot: "safety.image", claimedMime: "image/png", byteSize: over,
      headBytes: PNG_HEAD, fullBytesForProbe: PNG_1X1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]?.message).toContain("6 MB");
  });

  test("6. oversized video rejected at 50 MB", () => {
    const result = validateUploadCandidate({
      slot: "hero.tv_video", claimedMime: "video/mp4",
      byteSize: 50 * 1024 * 1024 + 1, headBytes: MP4_HEAD,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]?.message).toContain("50 MB");
  });

  test("hero/section images allow up to 12 MB", () => {
    expect(HOMEPAGE_MEDIA_SIZE_LIMITS["hero.background"]).toBe(12 * 1024 * 1024);
    expect(HOMEPAGE_MEDIA_SIZE_LIMITS["sections.background"]).toBe(12 * 1024 * 1024);
  });
});

// ─── 7. path safety ──────────────────────────────────────────────────────────
describe("server-generated storage paths", () => {
  test("7. original filename cannot affect the path; traversal inert", () => {
    for (const evil of ["../../etc/passwd.png", "a:b.png", "//host/x.png", "x".repeat(300)]) {
      const path = buildMediaStoragePath("hero.background", "image/png", 1754000000000, evil);
      expect(path).toMatch(/^homepage\/hero-background\/\d+-[a-z0-9]{8,16}\.png$/);
      expect(path).not.toContain("..");
      expect(path).not.toContain("//");
      expect(path).not.toContain(":");
    }
  });

  test("extension derives from validated MIME only", () => {
    expect(buildMediaStoragePath("hero.tv_video", "video/mp4", 1, "abcdefgh").endsWith(".mp4")).toBe(true);
    expect(buildMediaStoragePath("safety.image", "image/jpeg", 1, "abcdefgh").endsWith(".jpg")).toBe(true);
  });
});

// ─── dimension probing ───────────────────────────────────────────────────────
describe("server-side dimension probing", () => {
  test("reads real PNG dimensions", () => {
    expect(probeImageDimensions(PNG_1X1, "image/png")).toEqual({ width: 1, height: 1 });
  });

  test("images without readable dimensions fail validation", () => {
    const result = validateUploadCandidate({
      slot: "safety.image", claimedMime: "image/png", byteSize: 100,
      headBytes: PNG_HEAD, fullBytesForProbe: new Uint8Array(12),
    });
    expect(result.ok).toBe(false);
  });

  test("videos skip probing and stay nullable by design", () => {
    const result = validateUploadCandidate({
      slot: "hero.tv_video", claimedMime: "video/mp4", byteSize: 1000, headBytes: MP4_HEAD,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.validated.width).toBeNull();
      expect(result.validated.height).toBeNull();
    }
  });
});

// ─── 9-15. geometry validation ───────────────────────────────────────────────
describe("hero TV geometry validation", () => {
  test("9. x < 0 rejected", () => {
    expect(validateHeroTvRect({ ...DEFAULT_TV_RECT, x: -0.01 }).map((e) => e.field)).toContain("x");
  });
  test("10. y < 0 rejected", () => {
    expect(validateHeroTvRect({ ...DEFAULT_TV_RECT, y: -0.5 }).map((e) => e.field)).toContain("y");
  });
  test("11. width <= 0 rejected", () => {
    for (const w of [0, -0.1]) {
      expect(validateHeroTvRect({ ...DEFAULT_TV_RECT, width: w }).map((e) => e.field)).toContain("width");
    }
  });
  test("12. height <= 0 rejected", () => {
    expect(validateHeroTvRect({ ...DEFAULT_TV_RECT, height: 0 }).map((e) => e.field)).toContain("height");
  });
  test("13. x + width > 1 rejected", () => {
    expect(validateHeroTvRect({ x: 0.95, y: 0.1, width: 0.1, height: 0.1 }).map((e) => e.field)).toContain("rect");
  });
  test("14. y + height > 1 rejected", () => {
    expect(validateHeroTvRect({ x: 0.1, y: 0.95, width: 0.1, height: 0.1 }).map((e) => e.field)).toContain("rect");
  });
  test("15. valid geometry accepted, including edge-touching rect", () => {
    expect(validateHeroTvRect(DEFAULT_TV_RECT)).toEqual([]);
    expect(validateHeroTvRect({ x: 0, y: 0, width: 1, height: 1 })).toEqual([]);
  });
  test("non-finite and non-object geometry rejected", () => {
    expect(validateHeroTvRect({ x: NaN, y: 0, width: 1, height: 1 }).length).toBeGreaterThan(0);
    expect(validateHeroTvRect({ x: Infinity, y: 0, width: 1, height: 1 }).length).toBeGreaterThan(0);
    for (const bad of [null, 42, "x", [], { x: 0.1 }]) {
      expect(validateHeroTvRect(bad).length).toBeGreaterThan(0);
    }
  });
});

// ─── 16-18. coupling + shared mode ───────────────────────────────────────────
describe("geometry coupling and shared background", () => {
  test("16. aspect deviation warns against silent geometry reuse", () => {
    expect(aspectCompatibilityNote(2048, 1529)).toBeNull();
    expect(aspectCompatibilityNote(1000, 1000)).not.toBeNull();
    expect(aspectCompatibilityNote(null, null)).toBeNull();
  });

  test("17. same-image mode detected by identical storage keys", () => {
    expect(isSharedBackground("homepage/a.jpg", "homepage/a.jpg")).toBe(true);
  });

  test("18. separate-image mode detected by differing keys", () => {
    expect(isSharedBackground("homepage/a.jpg", "homepage/b.jpg")).toBe(false);
    expect(isSharedBackground(null, null)).toBe(false);
    expect(isSharedBackground("homepage/a.jpg", null)).toBe(false);
  });
});

// ─── 19-20. serializer + rollback ────────────────────────────────────────────
describe("safe serializer and rollback matrix", () => {
  test("19. serializer hides storage internals, normalizes duration", () => {
    const safe = toSafeSlotRecord(
      {
        slot_key: "hero.tv_video", media_type: "video",
        storage_path: "homepage/secret-internal-key.mp4",
        mime_type: "video/mp4", byte_size: 100, width: null, height: null,
        duration_seconds: "31.466667", updated_at: "2026-01-01T00:00:00Z",
      },
      "https://cdn.example/preview.mp4",
    );
    expect(JSON.stringify(safe)).not.toContain("secret-internal");
    expect(safe.previewUrl).toBe("https://cdn.example/preview.mp4");
    expect(safe.durationSeconds).toBeCloseTo(31.466667);
    expect(toSafeSlotRecord(
      {
        slot_key: "s", media_type: "image", storage_path: "p", mime_type: "image/png",
        byte_size: 1, width: 2, height: 3, duration_seconds: null, updated_at: "t",
      }, "u",
    ).durationSeconds).toBeNull();
  });

  test("20. rollback matrix: old object never deleted before DB success", () => {
    // Committed + superseded → only old object goes.
    expect(decideMediaRollback({ newObjectUploaded: true, dbCommitted: true, oldObjectSuperseded: true }))
      .toEqual(["delete-old-object"]);
    // Committed, nothing superseded → nothing to do.
    expect(decideMediaRollback({ newObjectUploaded: true, dbCommitted: true, oldObjectSuperseded: false }))
      .toEqual(["none"]);
    // Failed commit with new object → new object must go, old untouched.
    expect(decideMediaRollback({ newObjectUploaded: true, dbCommitted: false, oldObjectSuperseded: true }))
      .toEqual(["delete-new-object"]);
    // Failed before upload → nothing.
    expect(decideMediaRollback({ newObjectUploaded: false, dbCommitted: false, oldObjectSuperseded: false }))
      .toEqual(["none"]);
  });

  test("media RPC codes map to safe Persian errors without leaking internals", () => {
    const secret = "SECRET-DB-DETAIL";
    const conflict = mapAdminHomepageMediaRpcError("homepage_media_layout_conflict");
    expect(conflict.status).toBe(409);
    const required = mapAdminHomepageMediaRpcError("homepage_media_geometry_required");
    expect(required.status).toBe(422);
    const unknown = mapAdminHomepageMediaRpcError(`boom ${secret}`);
    expect(unknown.status).toBe(500);
    expect(JSON.stringify(unknown)).not.toContain(secret);
  });
});
