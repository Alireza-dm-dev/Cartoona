/**
 * Client-side / server validation of final deliverable uploads.
 * The authoritative limits are also enforced inside the database
 * (storage.objects.file_size_limit + allowed_mime_types on the
 * `final-deliverables` bucket) — these helpers exist to fail fast
 * and to keep the storage path generation in one place.
 */

export const FINAL_DELIVERABLES_BUCKET = "final-deliverables";

/** Relative storage prefix: `<bucket>/orders/<orderId>/final/<uuid>.<ext>`. */
export const FINAL_MEDIA_FOLDER = "orders";
export const FINAL_MEDIA_SUBFOLDER = "final";

export const FINAL_IMAGE_MIME_TYPES: readonly string[] = ["image/png", "image/jpeg", "image/webp"];
export const FINAL_VIDEO_MIME_TYPES: readonly string[] = ["video/mp4", "video/webm"];
export const FINAL_MEDIA_MIME_TYPES: readonly string[] = [
  ...FINAL_IMAGE_MIME_TYPES,
  ...FINAL_VIDEO_MIME_TYPES,
];

export const MAX_FINAL_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_FINAL_VIDEO_BYTES = 100 * 1024 * 1024;
export const MAX_FINAL_FILES_PER_UPLOAD = 5;

export const FINAL_MIME_TO_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "video/webm": "webm",
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type FinalMediaFileValidation =
  | { ok: true; mimeType: string }
  | { ok: false; error: string };

export function validateFinalMediaFile(file: { type: string; size: number }): FinalMediaFileValidation {
  const mimeType = (file.type || "").trim().toLowerCase();
  if (!FINAL_MEDIA_MIME_TYPES.includes(mimeType)) {
    return { ok: false, error: "فرمت فایل پشتیبانی نمی‌شود" };
  }
  const limit = FINAL_IMAGE_MIME_TYPES.includes(mimeType)
    ? MAX_FINAL_IMAGE_BYTES
    : MAX_FINAL_VIDEO_BYTES;
  if (file.size > limit) {
    const mb = Math.round(limit / 1024 / 1024);
    return { ok: false, error: `حجم فایل نباید بیشتر از ${mb} مگابایت باشد` };
  }
  return { ok: true, mimeType };
}

/**
 * Builds the relative storage path for a final deliverable:
 * `orders/<orderId>/final/<uuid>.<ext>`.
 * Throws if the orderId is not a plain UUID — this is the only injection
 * surface for the path, and the database re-checks the prefix inside
 * `record_final_media_trusted`.
 */
export function buildFinalStoragePath(orderId: string, mimeType: string, uuid: string): string {
  if (!UUID_RE.test(orderId)) {
    throw new Error("invalid_order_id_for_storage_path");
  }
  if (!UUID_RE.test(uuid)) {
    throw new Error("invalid_uuid_for_storage_path");
  }
  const ext = FINAL_MIME_TO_EXT[mimeType] ?? "bin";
  return `${FINAL_MEDIA_FOLDER}/${orderId}/${FINAL_MEDIA_SUBFOLDER}/${uuid}.${ext}`;
}

/** Rejects order ids that could escape the `orders/<id>/final/` folder. */
export function isSafeOrderId(orderId: string): boolean {
  return typeof orderId === "string" && UUID_RE.test(orderId);
}

/**
 * Sanitizes a client-supplied filename for display only.
 * Keeps a Unicode-safe basename (RTL Persian allowed) and strips
 * path separators and control characters. Never used for storage paths —
 * those come from buildFinalStoragePath.
 */
export function sanitizeOriginalFilename(name: string | undefined | null): string {
  if (!name) return "file";
  const cleaned = name
    .split(/[\\/]/)
    .pop()
    ?.replace(/[\u0000-\u001f\u007f]/g, "")
    .trim();
  return cleaned && cleaned.length > 0 ? cleaned.slice(0, 120) : "file";
}
