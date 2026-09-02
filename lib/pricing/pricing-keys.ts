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
