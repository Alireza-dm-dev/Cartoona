import { describe, test, expect } from "vitest";
import {
  FINAL_DELIVERABLES_BUCKET,
  FINAL_IMAGE_MIME_TYPES,
  FINAL_VIDEO_MIME_TYPES,
  FINAL_MEDIA_MIME_TYPES,
  MAX_FINAL_IMAGE_BYTES,
  MAX_FINAL_VIDEO_BYTES,
  MAX_FINAL_FILES_PER_UPLOAD,
  validateFinalMediaFile,
  buildFinalStoragePath,
  isSafeOrderId,
  sanitizeOriginalFilename,
} from "@/lib/admin/requests/media-validation";

const UUID = "123e4567-e89b-12d3-a456-426614174000";
const ASSET_UUID = "9c4b7a2e-5d3f-4f6a-8b1c-2d3e4f5a6b7c";

describe("file validation", () => {
  test("accepted MIME types pass", () => {
    expect(validateFinalMediaFile({ type: "image/png", size: 1024 }).ok).toBe(true);
    expect(validateFinalMediaFile({ type: "image/jpeg", size: 1024 }).ok).toBe(true);
    expect(validateFinalMediaFile({ type: "image/webp", size: 1024 }).ok).toBe(true);
    expect(validateFinalMediaFile({ type: "video/mp4", size: 1024 }).ok).toBe(true);
    expect(validateFinalMediaFile({ type: "video/webm", size: 1024 }).ok).toBe(true);
  });

  test("unsupported MIME types are rejected", () => {
    for (const t of ["text/plain", "application/pdf", "image/gif", "video/quicktime", ""]) {
      const r = validateFinalMediaFile({ type: t, size: 1024 });
      expect(r.ok).toBe(false);
    }
  });

  test("MIME type is normalized defensively", () => {
    const r = validateFinalMediaFile({ type: "IMAGE/PNG ", size: 1024 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.mimeType).toBe("image/png");
  });

  test("size limits: 10MiB images, 100MiB videos", () => {
    const img = validateFinalMediaFile({ type: "image/png", size: MAX_FINAL_IMAGE_BYTES });
    expect(img.ok).toBe(true);
    expect(validateFinalMediaFile({ type: "image/png", size: MAX_FINAL_IMAGE_BYTES + 1 }).ok).toBe(false);

    const vid = validateFinalMediaFile({ type: "video/mp4", size: MAX_FINAL_VIDEO_BYTES });
    expect(vid.ok).toBe(true);
    expect(validateFinalMediaFile({ type: "video/mp4", size: MAX_FINAL_VIDEO_BYTES + 1 }).ok).toBe(false);
  });

  test("constants stay consistent with the database bucket", () => {
    expect(FINAL_MEDIA_MIME_TYPES).toEqual([...FINAL_IMAGE_MIME_TYPES, ...FINAL_VIDEO_MIME_TYPES]);
    expect(FINAL_DELIVERABLES_BUCKET).toBe("final-deliverables");
    expect(MAX_FINAL_IMAGE_BYTES).toBe(10 * 1024 * 1024);
    expect(MAX_FINAL_VIDEO_BYTES).toBe(100 * 1024 * 1024);
    expect(MAX_FINAL_FILES_PER_UPLOAD).toBe(5);
  });
});

describe("storage path generation", () => {
  test("generates orders/<orderId>/final/<uuid>.<ext>", () => {
    expect(buildFinalStoragePath(UUID, "image/png", ASSET_UUID)).toBe(
      `orders/${UUID}/final/${ASSET_UUID}.png`,
    );
    expect(buildFinalStoragePath(UUID, "image/jpeg", ASSET_UUID)).toBe(
      `orders/${UUID}/final/${ASSET_UUID}.jpg`,
    );
    expect(buildFinalStoragePath(UUID, "video/mp4", ASSET_UUID)).toBe(
      `orders/${UUID}/final/${ASSET_UUID}.mp4`,
    );
    expect(buildFinalStoragePath(UUID, "video/webm", ASSET_UUID)).toBe(
      `orders/${UUID}/final/${ASSET_UUID}.webm`,
    );
  });

  test("rejects unsafe order ids and non-uuid asset ids", () => {
    expect(() => buildFinalStoragePath("../evil", "image/png", ASSET_UUID)).toThrow();
    expect(() => buildFinalStoragePath("orders/../x", "image/png", ASSET_UUID)).toThrow();
    expect(() => buildFinalStoragePath("not-a-uuid", "image/png", ASSET_UUID)).toThrow();
    expect(() => buildFinalStoragePath(UUID, "image/png", "not-a-uuid")).toThrow();
  });

  test("isSafeOrderId guards", () => {
    expect(isSafeOrderId(UUID)).toBe(true);
    expect(isSafeOrderId("../../../etc")).toBe(false);
    expect(isSafeOrderId("")).toBe(false);
    expect(isSafeOrderId("abc")).toBe(false);
  });
});

describe("original filename sanitization", () => {
  test("strips path separators", () => {
    expect(sanitizeOriginalFilename("../../evil.sh")).toBe("evil.sh");
    expect(sanitizeOriginalFilename("folder\\photo.png")).toBe("photo.png");
  });

  test("falls back to file for empty input", () => {
    expect(sanitizeOriginalFilename(null)).toBe("file");
    expect(sanitizeOriginalFilename(undefined)).toBe("file");
    expect(sanitizeOriginalFilename("   ")).toBe("file");
  });

  test("keeps Unicode/Persian filenames", () => {
    expect(sanitizeOriginalFilename("تصویر-نهایی.png")).toBe("تصویر-نهایی.png");
  });

  test("truncates very long names", () => {
    expect(sanitizeOriginalFilename("a".repeat(500) + ".png").length).toBeLessThanOrEqual(120);
  });
});
