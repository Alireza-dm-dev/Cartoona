import type { OrderType } from "@/types/app";

/**
 * The public website routes a creation request starts from.
 *
 * Creation lives on the public site, not inside the parent portal: the forms
 * support deferred auth and must stay reachable before login. The parent area
 * links into these rather than hosting its own copies, so there is exactly one
 * implementation of each form.
 */
export const CREATION_ROUTES = {
  image: "/create-image",
  video: "/request-video",
  drawing_animation: "/animate-drawing",
} as const satisfies Record<OrderType, string>;

export type CreationRoute = (typeof CREATION_ROUTES)[keyof typeof CREATION_ROUTES];

/** Parent-facing name of each creation choice. */
export const CREATION_LABELS = {
  image: "تصویر کارتونی",
  video: "ویدیوی کارتونی",
  drawing_animation: "جان‌بخشی به نقاشی",
} as const satisfies Record<OrderType, string>;

/** Decorative marker per creation choice. Hidden from assistive tech. */
export const CREATION_ICONS = {
  image: "🎨",
  video: "🎬",
  drawing_animation: "✏️",
} as const satisfies Record<OrderType, string>;

/** The three creation choices in the order the parent is offered them. */
export const CREATION_CHOICES: readonly {
  type: OrderType;
  href: CreationRoute;
  label: string;
  icon: string;
}[] = [
  { type: "image", href: CREATION_ROUTES.image, label: CREATION_LABELS.image, icon: CREATION_ICONS.image },
  { type: "video", href: CREATION_ROUTES.video, label: CREATION_LABELS.video, icon: CREATION_ICONS.video },
  {
    type: "drawing_animation",
    href: CREATION_ROUTES.drawing_animation,
    label: CREATION_LABELS.drawing_animation,
    icon: CREATION_ICONS.drawing_animation,
  },
];
