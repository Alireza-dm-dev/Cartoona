import {
  HOMEPAGE_MEDIA_MIME_ALLOWLIST,
  HOMEPAGE_MEDIA_SLOT_SPECS,
  type HomepageMediaSlot,
} from "@/lib/homepage/media-slots";
import {
  HOMEPAGE_MEDIA_SIZE_LIMITS,
  type SafeSlotRecord,
} from "@/lib/admin/homepage/media-validation";
import type { HeroTvRect } from "@/lib/homepage/hero-layout";

/**
 * Pure client-side state helpers for the admin media manager. No IO, no
 * fetch, no Supabase — components own rendering, tests drive these directly.
 * Everything the browser sends is re-validated server-side; these helpers
 * only shape UX (prechecks, clamping, response interpretation).
 */

export interface ClientFileInfo {
  name: string;
  type: string;
  size: number;
}

/** Client-side precheck: MIME allowlist + per-slot cap. Server re-checks everything. */
export function precheckFileForSlot(
  slot: HomepageMediaSlot,
  file: ClientFileInfo,
): { ok: true } | { ok: false; message: string } {
  const spec = HOMEPAGE_MEDIA_SLOT_SPECS[slot];
  const allowed = HOMEPAGE_MEDIA_MIME_ALLOWLIST[spec.mediaType] as readonly string[];
  if (!allowed.includes(file.type)) {
    return {
      ok: false,
      message: `نوع فایل مجاز نیست. فقط ${allowed.join("، ")} پذیرفته می‌شود.`,
    };
  }
  const cap = HOMEPAGE_MEDIA_SIZE_LIMITS[slot];
  if (!Number.isFinite(file.size) || file.size <= 0) {
    return { ok: false, message: "فایل خالی یا ناخواناست." };
  }
  if (file.size > cap) {
    return {
      ok: false,
      message: `حجم فایل از سقف ${formatFileSize(cap)} برای این جایگاه بیشتر است.`,
    };
  }
  return { ok: true };
}

export function formatFileSize(bytes: number | null): string {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes <= 0) return "—";
  if (bytes < 1024) return `${bytes} بایت`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} کیلوبایت`;
  return `${(bytes / 1048576).toFixed(1)} مگابایت`;
}

/** Normalized fraction → "10.5٪" for Admin display. Internally fractions stay authoritative. */
export function formatPercentFraction(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return `${(value * 100).toFixed(1)}٪`;
}

/** "12.5" (%) → 0.125 fraction, or null when unparseable. */
export function parsePercentInput(raw: string): number | null {
  const n = Number(raw.replace("٪", "").replace("%", "").trim());
  if (!Number.isFinite(n)) return null;
  return n / 100;
}

const MIN_RECT_SIZE = 0.02;

/** Clamps a rect into the unit square, preserving x+w≤1 / y+h≤1 and a minimum size. */
export function clampHeroRect(rect: HeroTvRect): HeroTvRect {
  const width = Math.min(1, Math.max(MIN_RECT_SIZE, rect.width));
  const height = Math.min(1, Math.max(MIN_RECT_SIZE, rect.height));
  const x = Math.min(1 - width, Math.max(0, rect.x));
  const y = Math.min(1 - height, Math.max(0, rect.y));
  return { x, y, width, height };
}

/** Applies a pixel drag delta to a rect given the rendered container size. Pure math for the overlay. */
export function moveHeroRectByPixels(
  rect: HeroTvRect,
  dxPx: number,
  dyPx: number,
  containerWidthPx: number,
  containerHeightPx: number,
): HeroTvRect {
  if (!(containerWidthPx > 0) || !(containerHeightPx > 0)) return rect;
  return clampHeroRect({
    ...rect,
    x: rect.x + dxPx / containerWidthPx,
    y: rect.y + dyPx / containerHeightPx,
  });
}

/** Resizes a rect by pixel deltas on width/height. */
export function resizeHeroRectByPixels(
  rect: HeroTvRect,
  dwPx: number,
  dhPx: number,
  containerWidthPx: number,
  containerHeightPx: number,
): HeroTvRect {
  if (!(containerWidthPx > 0) || !(containerHeightPx > 0)) return rect;
  return clampHeroRect({
    ...rect,
    width: rect.width + dwPx / containerWidthPx,
    height: rect.height + dhPx / containerHeightPx,
  });
}

export type MediaSaveOutcome =
  | { kind: "saved"; record: SafeSlotRecord; sectionsRecord: SafeSlotRecord | null; layoutRevision: number | null }
  | { kind: "conflict"; message: string }
  | { kind: "invalid"; message: string }
  | { kind: "error"; message: string };

/** Interprets a POST media/[slot] response. Pure: status + parsed body in, transition out. */
export function interpretMediaUploadResponse(status: number, body: Record<string, unknown> | null): MediaSaveOutcome {
  const b = body ?? {};
  if (status === 200 && typeof b.record === "object" && b.record !== null) {
    const layout = b.layout as { revision?: unknown } | null;
    return {
      kind: "saved",
      record: b.record as SafeSlotRecord,
      sectionsRecord: (b.sectionsRecord as SafeSlotRecord | null) ?? null,
      layoutRevision: typeof layout?.revision === "number" ? layout.revision : null,
    };
  }
  const message = typeof b.error === "string" ? b.error : "بارگذاری انجام نشد.";
  if (status === 409) return { kind: "conflict", message };
  if (status === 400 || status === 413 || status === 422) return { kind: "invalid", message };
  return { kind: "error", message };
}

export type LayoutSaveOutcome =
  | { kind: "saved"; rect: HeroTvRect; revision: number }
  | { kind: "conflict"; message: string }
  | { kind: "invalid"; message: string }
  | { kind: "error"; message: string };

/** Interprets a PUT hero-layout response. */
export function interpretLayoutSaveResponse(status: number, body: Record<string, unknown> | null): LayoutSaveOutcome {
  const b = body ?? {};
  if (status === 200 && typeof b.rect === "object" && b.rect !== null && typeof b.revision === "number") {
    return { kind: "saved", rect: b.rect as HeroTvRect, revision: b.revision };
  }
  const message = typeof b.error === "string" ? b.error : "ذخیره کالیبراسیون انجام نشد.";
  if (status === 409) return { kind: "conflict", message };
  if (status === 400 || status === 422) return { kind: "invalid", message };
  return { kind: "error", message };
}
