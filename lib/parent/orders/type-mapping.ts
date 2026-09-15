import type { OrderType } from "@/types/app";

/**
 * Parent-facing labels for the three creation types.
 *
 * The wording matches the creation pages the parent already used, so a request
 * is described the same way in the list as it was on the form that produced
 * it: /dashboard/create-image, /dashboard/request-video and
 * /dashboard/animate-drawing. No business logic from those pages is duplicated
 * here — this is presentation only.
 */
export const PARENT_TYPE_LABELS: Record<OrderType, string> = {
  image: "تصویر کارتونی",
  video: "ویدیوی کارتونی",
  drawing_animation: "جان‌بخشی به نقاشی",
};

/** Emoji marker per type. Decorative only, hidden from assistive tech. */
export const PARENT_TYPE_ICONS: Record<OrderType, string> = {
  image: "🎨",
  video: "🎬",
  drawing_animation: "✏️",
};

/** The creation route a parent starts this type of request from. */
export const PARENT_TYPE_ROUTES: Record<OrderType, string> = {
  image: "/dashboard/create-image",
  video: "/dashboard/request-video",
  drawing_animation: "/dashboard/animate-drawing",
};

export function isKnownOrderType(value: string | null | undefined): value is OrderType {
  return value === "image" || value === "video" || value === "drawing_animation";
}

export function parentTypeLabel(type: OrderType): string {
  return PARENT_TYPE_LABELS[type];
}

export function parentTypeIcon(type: OrderType): string {
  return PARENT_TYPE_ICONS[type];
}
