/**
 * The closed set of homepage media slots.
 *
 * A slot is a named position in the design that an admin may later swap a file
 * into. Slots are declared here and nowhere else: the upload API will reject any
 * slot key not in this map, so an editor can never invent a position or point
 * the page at an arbitrary URL.
 */

export const HOMEPAGE_MEDIA_SLOTS = {
  HERO_BACKGROUND: "hero.background",
  HERO_TV_VIDEO: "hero.tv_video",
  SECTIONS_BACKGROUND: "sections.background",
  BUILD_OPTIONS_CARD_IMAGE: "build_options.card_image",
  BUILD_OPTIONS_CARD_VIDEO: "build_options.card_video",
  BUILD_OPTIONS_CARD_ANIMATION: "build_options.card_animation",
  SAFETY_IMAGE: "safety.image",
} as const;

export type HomepageMediaSlot =
  (typeof HOMEPAGE_MEDIA_SLOTS)[keyof typeof HOMEPAGE_MEDIA_SLOTS];

export const HOMEPAGE_MEDIA_SLOT_VALUES = Object.values(
  HOMEPAGE_MEDIA_SLOTS
) as readonly HomepageMediaSlot[];

export const HOMEPAGE_MEDIA_TYPES = ["image", "video"] as const;
export type HomepageMediaType = (typeof HOMEPAGE_MEDIA_TYPES)[number];

export interface HomepageMediaSlotSpec {
  slot: HomepageMediaSlot;
  mediaType: HomepageMediaType;
  /** Human label for the future admin editor. */
  label: string;
  /** The file currently shipped in /public for this position. */
  currentPublicPath: string;
  /**
   * True when swapping the file would break code that measures against the
   * artwork. The hero's TV overlay rect is calibrated to the exact pixel
   * geometry of sections-bg.png, so replacing it moves the video out of the
   * bezel. The upload phase must warn on these, or require the replacement to
   * keep the same TV placement.
   */
  geometryCoupled: boolean;
  notes?: string;
}

export const HOMEPAGE_MEDIA_SLOT_SPECS: Record<
  HomepageMediaSlot,
  HomepageMediaSlotSpec
> = {
  [HOMEPAGE_MEDIA_SLOTS.HERO_BACKGROUND]: {
    slot: HOMEPAGE_MEDIA_SLOTS.HERO_BACKGROUND,
    mediaType: "image",
    label: "تصویر پس‌زمینه هیرو",
    currentPublicPath: "/images/homepage/sections-bg.png",
    geometryCoupled: true,
    notes:
      "The hero frames this artwork on the television drawn inside it. TV_SCREEN_RECT in Hero.tsx is measured from this exact file; a replacement must keep the TV at the same fractional position or the overlay will not line up.",
  },
  [HOMEPAGE_MEDIA_SLOTS.HERO_TV_VIDEO]: {
    slot: HOMEPAGE_MEDIA_SLOTS.HERO_TV_VIDEO,
    mediaType: "video",
    label: "ویدیوی صفحه تلویزیون",
    currentPublicPath: "/videos/homepage/hero-tv.mp4",
    geometryCoupled: false,
    notes: "Plays muted, looped and inline inside the TV screen. Aspect close to 1.27 crops least.",
  },
  [HOMEPAGE_MEDIA_SLOTS.SECTIONS_BACKGROUND]: {
    slot: HOMEPAGE_MEDIA_SLOTS.SECTIONS_BACKGROUND,
    mediaType: "image",
    label: "تصویر پس‌زمینه بخش‌ها",
    currentPublicPath: "/images/homepage/sections-bg.png",
    geometryCoupled: true,
    notes:
      "Currently the same file as the hero background. The sections layer crops to the bottom ~63% to keep the television out of view, so a replacement must keep its focal content below that line.",
  },
  [HOMEPAGE_MEDIA_SLOTS.BUILD_OPTIONS_CARD_IMAGE]: {
    slot: HOMEPAGE_MEDIA_SLOTS.BUILD_OPTIONS_CARD_IMAGE,
    mediaType: "image",
    label: "تصویر کارت ساخت تصویر",
    currentPublicPath: "/images/homepage/card-image.jpg",
    geometryCoupled: false,
  },
  [HOMEPAGE_MEDIA_SLOTS.BUILD_OPTIONS_CARD_VIDEO]: {
    slot: HOMEPAGE_MEDIA_SLOTS.BUILD_OPTIONS_CARD_VIDEO,
    mediaType: "video",
    label: "ویدیوی کارت ساخت ویدیو",
    currentPublicPath: "/videos/homepage/build-video.mp4",
    geometryCoupled: false,
  },
  [HOMEPAGE_MEDIA_SLOTS.BUILD_OPTIONS_CARD_ANIMATION]: {
    slot: HOMEPAGE_MEDIA_SLOTS.BUILD_OPTIONS_CARD_ANIMATION,
    mediaType: "video",
    label: "ویدیوی کارت متحرک‌سازی نقاشی",
    currentPublicPath: "/videos/homepage/build-animate.mp4",
    geometryCoupled: false,
  },
  [HOMEPAGE_MEDIA_SLOTS.SAFETY_IMAGE]: {
    slot: HOMEPAGE_MEDIA_SLOTS.SAFETY_IMAGE,
    mediaType: "image",
    label: "تصویر بخش ایمنی",
    currentPublicPath: "/images/homepage/family-tablet.jpg",
    geometryCoupled: false,
  },
};

export function isHomepageMediaSlot(value: unknown): value is HomepageMediaSlot {
  return (
    typeof value === "string" &&
    (HOMEPAGE_MEDIA_SLOT_VALUES as readonly string[]).includes(value)
  );
}

export function isHomepageMediaType(value: unknown): value is HomepageMediaType {
  return (
    typeof value === "string" &&
    (HOMEPAGE_MEDIA_TYPES as readonly string[]).includes(value)
  );
}

/** True when `mediaType` is the type this slot is declared to hold. */
export function mediaTypeMatchesSlot(
  slot: HomepageMediaSlot,
  mediaType: HomepageMediaType
): boolean {
  return HOMEPAGE_MEDIA_SLOT_SPECS[slot].mediaType === mediaType;
}

/** MIME allowlists for the future upload API. Not enforced at this phase. */
export const HOMEPAGE_MEDIA_MIME_ALLOWLIST: Record<HomepageMediaType, readonly string[]> = {
  image: ["image/png", "image/jpeg", "image/webp"],
  video: ["video/mp4", "video/webm"],
};
