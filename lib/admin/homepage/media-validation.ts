import {
  HOMEPAGE_MEDIA_MIME_ALLOWLIST,
  HOMEPAGE_MEDIA_SLOT_SPECS,
  isHomepageMediaSlot,
  mediaTypeMatchesSlot,
  type HomepageMediaSlot,
  type HomepageMediaType,
} from "@/lib/homepage/media-slots";

/**
 * Pure media-validation plane for the homepage Media Manager (Phase 3).
 * No IO, no React, no secrets — every decision here is unit-tested directly.
 *
 * Layers (outermost first):
 *   1. slot allowlist + slot/media-type compatibility
 *   2. MIME allowlist per type
 *   3. magic-byte sniff MUST match the claimed MIME (never trust extensions
 *      or the client-provided File.type alone)
 *   4. per-slot-class size caps
 *   5. server-side dimension probing (images must yield dimensions;
 *      video dimensions/duration stay nullable — no parser in the tree,
 *      and browser values are never persisted as authoritative metadata)
 */

export const HOMEPAGE_MEDIA_BUCKET = "homepage-media";

/** Coarse bucket ceiling (mirrors the storage bucket limit). */
export const HOMEPAGE_MEDIA_BUCKET_LIMIT = 50 * 1024 * 1024;

/**
 * Per-slot-class size caps. Hero/section art gets headroom for detailed
 * artwork; card/safety images are small by design; videos share one cap.
 */
export const HOMEPAGE_MEDIA_SIZE_LIMITS: Record<HomepageMediaSlot, number> = {
  "hero.background": 12 * 1024 * 1024,
  "hero.tv_video": 50 * 1024 * 1024,
  "sections.background": 12 * 1024 * 1024,
  "build_options.card_image": 6 * 1024 * 1024,
  "build_options.card_video": 50 * 1024 * 1024,
  "build_options.card_animation": 50 * 1024 * 1024,
  "safety.image": 6 * 1024 * 1024,
};

const MIME_TO_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "video/webm": "webm",
};

export interface MediaFileError {
  field: string;
  message: string;
}

/** True when the slot exists in the closed set. Unknown slots are rejected before any file is read. */
export function isKnownMediaSlot(value: unknown): value is HomepageMediaSlot {
  return isHomepageMediaSlot(value);
}

/** MIME allowlist for a media type. SVG, GIF and everything else are absent by design. */
export function isAllowedMediaMime(mediaType: HomepageMediaType, mime: unknown): boolean {
  return (
    typeof mime === "string" &&
    (HOMEPAGE_MEDIA_MIME_ALLOWLIST[mediaType] as readonly string[]).includes(mime)
  );
}

/** True when the file's MIME is allowed AND matches the slot's declared type. */
export function mimeMatchesSlot(slot: HomepageMediaSlot, mime: string): boolean {
  const spec = HOMEPAGE_MEDIA_SLOT_SPECS[slot];
  return (
    (HOMEPAGE_MEDIA_MIME_ALLOWLIST[spec.mediaType] as readonly string[]).includes(mime) &&
    mediaTypeMatchesSlot(slot, spec.mediaType)
  );
}

// ─── magic-byte sniffing ─────────────────────────────────────────────────────

/**
 * Detects the real container from leading bytes. Returns the MIME or null
 * when unrecognized. Never trusts extensions or client claims.
 *
 * Supported: PNG (89 50 4E 47 0D 0A 1A 0A), JPEG (FF D8 FF), WebP
 * (RIFF....WEBP), MP4 (....ftyp), WebM/Matroska (1A 45 DF A3).
 */
export function detectMediaSignature(bytes: Uint8Array): string | null {
  if (bytes.length < 12) return null;
  if (
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  if (
    bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70
  ) {
    return "video/mp4";
  }
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    return "video/webm";
  }
  return null;
}

// ─── server-side dimension probing (no new dependencies) ─────────────────────

export interface ProbedDimensions {
  width: number;
  height: number;
}

function readU32BE(b: Uint8Array, o: number): number {
  return (b[o] * 16777216 + b[o + 1] * 65536 + b[o + 2] * 256 + b[o + 3]) >>> 0;
}

function readU16BE(b: Uint8Array, o: number): number {
  return (b[o] << 8) | b[o + 1];
}

function probePng(b: Uint8Array): ProbedDimensions | null {
  // Signature (8) + IHDR length (4) + "IHDR" (4) + width (4) + height (4).
  if (b.length < 24) return null;
  if (b[12] !== 0x49 || b[13] !== 0x48 || b[14] !== 0x44 || b[15] !== 0x52) return null;
  const width = readU32BE(b, 16);
  const height = readU32BE(b, 20);
  return width > 0 && height > 0 ? { width, height } : null;
}

function probeJpeg(b: Uint8Array): ProbedDimensions | null {
  // Walk markers to the first SOF (0xC0–0xCF excluding DHT/JPG/DAC).
  let o = 2;
  while (o + 9 < b.length) {
    if (b[o] !== 0xff) return null;
    const marker = b[o + 1];
    if (marker === 0xd8 || marker === 0xd9) {
      o += 2;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      o += 2;
      continue;
    }
    const len = readU16BE(b, o + 2);
    if (len < 2) return null;
    const isSof =
      (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc);
    if (isSof) {
      if (o + 9 >= b.length) return null;
      const height = readU16BE(b, o + 5);
      const width = readU16BE(b, o + 7);
      return width > 0 && height > 0 ? { width, height } : null;
    }
    o += 2 + len;
  }
  return null;
}

function probeWebp(b: Uint8Array): ProbedDimensions | null {
  if (b.length < 30) return null;
  const fourcc = String.fromCharCode(b[12], b[13], b[14], b[15]);
  if (fourcc === "VP8 ") {
    // Lossy bitstream: frame tag (3) + start code (3) + width/height 14-bit LE.
    if (b.length < 30) return null;
    if (b[20] !== 0x9d || b[21] !== 0x01 || b[22] !== 0x2a) return null;
    const width = b[23] | ((b[24] & 0x3f) << 8);
    const height = b[25] | ((b[26] & 0x3f) << 8);
    return width > 0 && height > 0 ? { width, height } : null;
  }
  if (fourcc === "VP8L") {
    // Lossless: signature byte 0x2F then 4 packed bytes, 14-bit width-1/height-1.
    if (b.length < 25 || b[20] !== 0x2f) return null;
    const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
    const width = (bits & 0x3fff) + 1;
    const height = ((bits >> 14) & 0x3fff) + 1;
    return width > 0 && height > 0 ? { width, height } : null;
  }
  if (fourcc === "VP8X") {
    // Extended: canvas size minus one, 24-bit BE at offset 24.
    if (b.length < 30) return null;
    const width = ((b[24] << 16) | (b[25] << 8) | b[26]) + 1;
    const height = ((b[27] << 16) | (b[28] << 8) | b[29]) + 1;
    return width > 0 && height > 0 ? { width, height } : null;
  }
  return null;
}

/**
 * Extracts real image dimensions server-side from file bytes. Returns null
 * for unrecognized/truncated data. Video containers are NOT probed — no
 * parser exists in the tree, so video dimensions stay nullable (documented
 * limitation; browser values are never persisted as authoritative metadata).
 */
export function probeImageDimensions(bytes: Uint8Array, mime: string): ProbedDimensions | null {
  try {
    if (mime === "image/png") return probePng(bytes);
    if (mime === "image/jpeg") return probeJpeg(bytes);
    if (mime === "image/webp") return probeWebp(bytes);
    return null;
  } catch {
    return null;
  }
}

// ─── combined file validation ────────────────────────────────────────────────

export interface ValidatedUpload {
  slot: HomepageMediaSlot;
  mediaType: HomepageMediaType;
  mime: string;
  byteSize: number;
  width: number | null;
  height: number | null;
}

/**
 * Validates an upload candidate end to end (pure; the route supplies bytes).
 * Order: slot → type/MIME → signature → size → dimensions. Images MUST yield
 * probed dimensions; videos skip probing (nullable by design).
 */
export function validateUploadCandidate(input: {
  slot: unknown;
  claimedMime: unknown;
  byteSize: unknown;
  headBytes: Uint8Array;
  fullBytesForProbe?: Uint8Array;
}): { ok: true; validated: ValidatedUpload } | { ok: false; errors: MediaFileError[] } {
  const errors: MediaFileError[] = [];

  if (!isKnownMediaSlot(input.slot)) {
    return { ok: false, errors: [{ field: "slot", message: "Unknown media slot" }] };
  }
  const slot = input.slot;
  const spec = HOMEPAGE_MEDIA_SLOT_SPECS[slot];
  const mediaType = spec.mediaType;

  if (typeof input.claimedMime !== "string" || !isAllowedMediaMime(mediaType, input.claimedMime)) {
    errors.push({ field: "file", message: `Only ${HOMEPAGE_MEDIA_MIME_ALLOWLIST[mediaType].join(", ")} are allowed for this slot` });
    return { ok: false, errors };
  }
  const mime = input.claimedMime;

  const sniffed = detectMediaSignature(input.headBytes);
  if (sniffed !== mime) {
    errors.push({ field: "file", message: "File content does not match its claimed type" });
    return { ok: false, errors };
  }

  if (typeof input.byteSize !== "number" || !Number.isFinite(input.byteSize) || input.byteSize <= 0) {
    errors.push({ field: "file", message: "File is empty or unreadable" });
    return { ok: false, errors };
  }
  const cap = HOMEPAGE_MEDIA_SIZE_LIMITS[slot];
  if (input.byteSize > cap) {
    errors.push({
      field: "file",
      message: `File exceeds the ${Math.round(cap / 1048576)} MB limit for this slot`,
    });
    return { ok: false, errors };
  }

  let width: number | null = null;
  let height: number | null = null;
  if (mediaType === "image") {
    const probed = input.fullBytesForProbe
      ? probeImageDimensions(input.fullBytesForProbe, mime)
      : null;
    if (!probed) {
      errors.push({ field: "file", message: "Could not read image dimensions" });
      return { ok: false, errors };
    }
    width = probed.width;
    height = probed.height;
  }

  return { ok: true, validated: { slot, mediaType, mime, byteSize: input.byteSize, width, height } };
}

// ─── server-generated paths ──────────────────────────────────────────────────

function slugifySlot(slot: HomepageMediaSlot): string {
  return slot.replace(/\./g, "-");
}

function sanitizeRandomPart(value: string): string {
  const cleaned = value.toLowerCase().replace(/[^a-z0-9]/g, "");
  return cleaned.length >= 8 ? cleaned.slice(0, 16) : "x".repeat(8);
}

/**
 * Builds the storage object key. Only the slot (allowlisted), timestamp,
 * caller-supplied randomness and the MIME-derived extension participate —
 * the original filename NEVER affects the path (path traversal impossible).
 */
export function buildMediaStoragePath(
  slot: HomepageMediaSlot,
  mime: string,
  timestampMs: number,
  randomPart: string,
): string {
  const ext = MIME_TO_EXT[mime] ?? "bin";
  const ts = Number.isFinite(timestampMs) && timestampMs > 0 ? Math.floor(timestampMs) : 0;
  return `homepage/${slugifySlot(slot)}/${ts}-${sanitizeRandomPart(randomPart)}.${ext}`;
}

// ─── safe serializer ─────────────────────────────────────────────────────────

export interface MediaRowSnapshot {
  slot_key: string;
  media_type: string;
  storage_path: string;
  mime_type: string;
  byte_size: number;
  width: number | null;
  height: number | null;
  duration_seconds: number | string | null;
  updated_at: string;
}

export interface SafeSlotRecord {
  slotKey: string;
  mediaType: string;
  previewUrl: string;
  mimeType: string;
  byteSize: number;
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
  updatedAt: string;
}

/**
 * Converts a service-role row snapshot into the browser-safe shape. Drops
 * storage_path (internal key) — the caller supplies the already-resolved
 * previewUrl. Duration arrives from Postgres as string or number; normalized
 * here, never trusted from the client.
 */
export function toSafeSlotRecord(row: MediaRowSnapshot, previewUrl: string): SafeSlotRecord {
  const raw = row.duration_seconds;
  const durationSeconds =
    typeof raw === "number" && Number.isFinite(raw) && raw > 0
      ? raw
      : typeof raw === "string" && raw.trim() !== "" && Number.isFinite(Number(raw)) && Number(raw) > 0
        ? Number(raw)
        : null;
  return {
    slotKey: row.slot_key,
    mediaType: row.media_type,
    previewUrl,
    mimeType: row.mime_type,
    byteSize: row.byte_size,
    width: typeof row.width === "number" ? row.width : null,
    height: typeof row.height === "number" ? row.height : null,
    durationSeconds,
    updatedAt: row.updated_at,
  };
}

// ─── rollback decision matrix ────────────────────────────────────────────────

export type RollbackAction = "delete-new-object" | "delete-old-object" | "none";

export interface RollbackState {
  /** New storage object was uploaded successfully. */
  newObjectUploaded: boolean;
  /** The ONE atomic metadata RPC committed. */
  dbCommitted: boolean;
  /** A previous object exists and differs from the new one. */
  oldObjectSuperseded: boolean;
}

/**
 * Decides storage cleanup after a replacement attempt. Rules, in order:
 *   - DB committed → only the superseded old object may go (best-effort).
 *   - DB NOT committed but a new object exists → the new object must go;
 *     the old object is untouched (metadata still points at it).
 *   - Neither → nothing to do.
 * The old object is NEVER deleted before DB success.
 */
export function decideMediaRollback(state: RollbackState): RollbackAction[] {
  if (state.dbCommitted) {
    return state.oldObjectSuperseded ? ["delete-old-object"] : ["none"];
  }
  return state.newObjectUploaded ? ["delete-new-object"] : ["none"];
}

/** True when hero and sections rows reference the SAME stored object. */
export function isSharedBackground(
  heroStoragePath: string | null,
  sectionsStoragePath: string | null,
): boolean {
  return (
    typeof heroStoragePath === "string" &&
    heroStoragePath.length > 0 &&
    heroStoragePath === sectionsStoragePath
  );
}
