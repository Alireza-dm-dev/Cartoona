export type CreationPricingKey =
  | "image.default"
  | "image.reference_file"
  | "video.short"
  | "video.medium"
  | "video.long"
  | "video.reference_file"
  | "drawing_animation.short"
  | "drawing_animation.medium"
  | "drawing_animation.long";

export const CREATION_PRICING_KEYS: Record<string, CreationPricingKey> = {
  imageDefault: "image.default",
  imageReferenceFile: "image.reference_file",
  videoShort: "video.short",
  videoMedium: "video.medium",
  videoLong: "video.long",
  videoReferenceFile: "video.reference_file",
  drawingAnimationShort: "drawing_animation.short",
  drawingAnimationMedium: "drawing_animation.medium",
  drawingAnimationLong: "drawing_animation.long",
} as const;

export type InternalDuration = "short" | "medium" | "long";

export type FormDuration = "کوتاه" | "متوسط" | "بلند";

export const FORM_TO_INTERNAL: Record<FormDuration, InternalDuration> = {
  "کوتاه": "short",
  "متوسط": "medium",
  "بلند": "long",
};

/**
 * Parent-facing video duration choices.
 *
 * Stable ASCII identifiers: the Persian text is a label only, never the
 * business key. Replaces the old Persian-keyed `FormDuration` for video
 * requests; drawing animation still uses `FormDuration` unchanged.
 */
export type VideoDurationChoice = "5_10" | "10_20" | "30_plus";

export const VIDEO_DURATION_CHOICES: readonly VideoDurationChoice[] = [
  "5_10",
  "10_20",
  "30_plus",
];

export const VIDEO_DURATION_LABELS: Record<VideoDurationChoice, string> = {
  "5_10": "۵ تا ۱۰ ثانیه",
  "10_20": "۱۰ تا ۲۰ ثانیه",
  "30_plus": "بیش از ۳۰ ثانیه",
};

/**
 * Maps a duration choice onto the existing internal pricing tier.
 *
 * A one-to-one relabel of the three tiers that already existed
 * (کوتاه/متوسط/بلند): no catalog row and no candy cost changes.
 */
export const VIDEO_DURATION_TO_INTERNAL: Record<VideoDurationChoice, InternalDuration> = {
  "5_10": "short",
  "10_20": "medium",
  "30_plus": "long",
};

export function isVideoDurationChoice(value: unknown): value is VideoDurationChoice {
  return typeof value === "string" && (VIDEO_DURATION_CHOICES as readonly string[]).includes(value);
}

export function mapVideoDurationLabel(value: unknown): string | null {
  return isVideoDurationChoice(value) ? VIDEO_DURATION_LABELS[value] : null;
}
