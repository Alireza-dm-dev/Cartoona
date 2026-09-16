import type { OrderType } from "@/types/app";
import { CREATION_ICONS, CREATION_LABELS, CREATION_ROUTES } from "@/lib/creation/creation-routes";

/**
 * Parent-facing labels for the three creation types.
 *
 * The wording matches the creation pages the parent already used, so a request
 * is described the same way in the list as it was on the form that produced
 * it: the public /create-image, /request-video and /animate-drawing routes. No
 * business logic from those pages is duplicated here — this is presentation
 * only, and the wording comes from the creation routes module so the list and
 * the forms cannot drift.
 */
export const PARENT_TYPE_LABELS: Record<OrderType, string> = CREATION_LABELS;

/** Emoji marker per type. Decorative only, hidden from assistive tech. */
export const PARENT_TYPE_ICONS: Record<OrderType, string> = CREATION_ICONS;

/**
 * The creation route a parent starts this type of request from.
 *
 * These are the public website routes. Creation is not a parent-portal
 * subsection: the portal links out to the one implementation of each form.
 */
export const PARENT_TYPE_ROUTES: Record<OrderType, string> = CREATION_ROUTES;

export function isKnownOrderType(value: string | null | undefined): value is OrderType {
  return value === "image" || value === "video" || value === "drawing_animation";
}

export function parentTypeLabel(type: OrderType): string {
  return PARENT_TYPE_LABELS[type];
}

export function parentTypeIcon(type: OrderType): string {
  return PARENT_TYPE_ICONS[type];
}
