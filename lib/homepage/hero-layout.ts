/**
 * Hero TV screen geometry: normalized fractional coordinates (0.0–1.0).
 *
 * The TV rect is the ONE piece of hero geometry with a CMS-backed
 * calibration model. Everything else stays code-controlled with no database
 * representation: HERO_ZOOM, HERO_TV_FOCUS, horizontal-story behavior,
 * sections-crop mechanics. Pixels are never authoritative — previews derive
 * pixel values as rect × rendered-image size.
 *
 * Phase 3 does NOT wire the public Hero to read this value; it backs the
 * admin calibration UI and the trusted layout RPC. Runtime wiring is Phase 4.
 */

/** Normalized TV screen rect: fractions of the hero background artwork. */
export interface HeroTvRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Seed transcription of TV_SCREEN_RECT in components/marketing/Hero.tsx
 * (cutout measured x 215..400, y 218..364 of 2048x1529). Also seeds the
 * homepage_hero_layout row in 20260802120000_homepage_cms_media.sql.
 */
export const DEFAULT_TV_RECT: HeroTvRect = {
  x: 0.105,
  y: 0.1426,
  width: 0.0908,
  height: 0.0961,
};

/** Intrinsic size of the currently shipped artwork (for aspect comparison). */
export const CURRENT_ARTWORK_INTRINSIC = { width: 2048, height: 1529 } as const;

export interface HeroGeometryError {
  field: "x" | "y" | "width" | "height" | "rect";
  message: string;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Validates a normalized TV rect. Pure: no IO, collects every problem.
 * Mirrors the server-side checks in the trusted layout RPCs so the editor
 * can show inline errors before submitting.
 */
export function validateHeroTvRect(raw: unknown): HeroGeometryError[] {
  const errors: HeroGeometryError[] = [];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return [{ field: "rect", message: "Geometry must be an object" }];
  }
  const o = raw as Record<string, unknown>;
  const v: Record<string, number | null> = { x: null, y: null, width: null, height: null };

  for (const key of ["x", "y", "width", "height"] as const) {
    if (!isFiniteNumber(o[key])) {
      errors.push({ field: key, message: "Must be a finite number" });
    } else {
      v[key] = o[key] as number;
    }
  }
  if (errors.length > 0) return errors;

  const { x, y, width, height } = v as Record<string, number>;
  if (x < 0 || x > 1) errors.push({ field: "x", message: "Must be between 0 and 1" });
  if (y < 0 || y > 1) errors.push({ field: "y", message: "Must be between 0 and 1" });
  if (width <= 0) errors.push({ field: "width", message: "Must be greater than 0" });
  if (height <= 0) errors.push({ field: "height", message: "Must be greater than 0" });
  if (errors.length === 0) {
    if (x + width > 1) errors.push({ field: "rect", message: "x + width must not exceed 1" });
    if (y + height > 1) errors.push({ field: "rect", message: "y + height must not exceed 1" });
  }
  return errors;
}

export function isValidHeroTvRect(raw: unknown): raw is HeroTvRect {
  return validateHeroTvRect(raw).length === 0;
}

/**
 * Compares replacement artwork aspect against the shipped 2048x1529 canvas.
 * Returns the Persian warning for the calibration UI when the deviation
 * exceeds 2% — old geometry must never be silently reused on incompatible
 * art. Returns null when compatible or when dimensions are unknown.
 */
export function aspectCompatibilityNote(
  width: number | null,
  height: number | null,
): string | null {
  if (
    typeof width !== "number" ||
    typeof height !== "number" ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return null;
  }
  const current = CURRENT_ARTWORK_INTRINSIC.width / CURRENT_ARTWORK_INTRINSIC.height;
  const next = width / height;
  if (Math.abs(next - current) / current > 0.02) {
    return "نسبت ابعاد تصویر جدید با تصویر فعلی متفاوت است. تنظیم مجدد محل ویدیوی تلویزیون ضروری است.";
  }
  return null;
}
