/**
 * Typed content contract for the marketing homepage CMS.
 *
 * The boundary this file draws: **code owns structure, admin owns content.**
 * Everything here is plain text, a bounded enum, a stable id, or an internal
 * link. Nothing here can express layout, scroll behaviour, breakpoints, colour,
 * HTML, Markdown, CSS, or script - those live in the components and stay under
 * version control.
 *
 * Deliberately NOT modelled here (see docs/HOMEPAGE_CMS_ARCHITECTURE.md):
 *   - nav route destinations (real app routes - labels only are editable)
 *   - the TV overlay rect, hero zoom/focus, horizontal-story mechanics
 *   - card tint gradients (raw CSS)
 *   - pricing plan names, prices and candy amounts (billing config)
 *   - FAQ answer bodies (config/faqs.ts, shared with /faq)
 */

/** A link an editor may point a button or text link at. */
export interface HomepageCta {
  label: string;
  /** Internal only: an absolute path ("/examples") or an anchor ("#creation-types"). */
  href: string;
}

/** Bounded set of badge treatments a build-option card may use. */
export const BUILD_OPTION_BADGE_VARIANTS = ["default", "info", "success"] as const;
export type BuildOptionBadgeVariant = (typeof BUILD_OPTION_BADGE_VARIANTS)[number];

/** Which media slot a build-option card shows. Constrains editors to known slots. */
export const BUILD_OPTION_MEDIA_KEYS = ["card_image", "card_video", "card_animation"] as const;
export type BuildOptionMediaKey = (typeof BUILD_OPTION_MEDIA_KEYS)[number];

export interface HeroContent {
  eyebrow: string;
  title: string;
  description: string;
  primaryCta: HomepageCta;
  secondaryCta: HomepageCta;
  trustLine: string;
}

export interface BuildOptionCard {
  /** Stable key. Survives reordering and relabelling; used as the React key. */
  id: string;
  badge: string;
  badgeVariant: BuildOptionBadgeVariant;
  title: string;
  description: string;
  cta: HomepageCta;
  media: BuildOptionMediaKey;
}

export interface BuildOptionsContent {
  title: string;
  description: string;
  cards: BuildOptionCard[];
  footnote: string;
}

export interface HomepageCharacterCard {
  id: string;
  emoji: string;
  name: string;
  /** Free text age range, e.g. "۳ تا ۶ سال" or "اختصاصی". */
  age: string;
  description: string;
}

export interface CharactersContent {
  eyebrow: string;
  title: string;
  description: string;
  cards: HomepageCharacterCard[];
  cta: HomepageCta;
}

export interface SafetyPoint {
  id: string;
  /** Short ordinal badge, e.g. "۱". */
  mark: string;
  title: string;
  description: string;
}

export interface SafetyContent {
  eyebrow: string;
  title: string;
  description: string;
  points: SafetyPoint[];
  /** Alt text for the safety image slot. The image itself is a media slot. */
  imageAlt: string;
  note: string;
}

export interface PricingContent {
  eyebrow: string;
  title: string;
  /**
   * Which plans from config/plans.ts to feature, in order. Prices, candy
   * amounts and benefits stay in billing config - an editor chooses what to
   * show, never what it costs.
   */
  featuredPlanIds: string[];
  linkLabel: string;
  linkHref: string;
  footnote: string;
}

export interface Testimonial {
  id: string;
  quote: string;
  name: string;
  role: string;
}

export interface TestimonialsContent {
  title: string;
  items: Testimonial[];
}

export interface FaqTeaserContent {
  eyebrow: string;
  title: string;
  /**
   * Questions to surface, matched against config/faqs.ts. Storing the selection
   * rather than the Q&A text keeps the teaser and the /faq page from drifting
   * apart; a full FAQ CMS is a later phase.
   */
  questions: string[];
  linkLabel: string;
  linkHref: string;
}

export interface FinalCtaContent {
  title: string;
  description: string;
  primaryCta: HomepageCta;
  secondaryCta: HomepageCta;
}

/**
 * Homepage navigation DISPLAY LABELS only. Route destinations are structural
 * product routing and stay fixed in code - the admin may relabel "شخصیت‌ها"
 * but can never change "/characters". Brand, auth routing and aria labels
 * are intentionally not modelled here.
 */
export interface NavigationContent {
  charactersLabel: string;
  examplesLabel: string;
  pricingLabel: string;
  safetyLabel: string;
  faqLabel: string;
  loginLabel: string;
  /** Internal name only: default copy matches the current "شروع کنید" button. */
  signupLabel: string;
}

export interface HomepageContent {
  hero: HeroContent;
  buildOptions: BuildOptionsContent;
  characters: CharactersContent;
  safety: SafetyContent;
  pricing: PricingContent;
  testimonials: TestimonialsContent;
  faqTeaser: FaqTeaserContent;
  finalCta: FinalCtaContent;
  navigation: NavigationContent;
}

/** The one row in public.homepage_content is addressed by this key. */
export const HOMEPAGE_SINGLETON_KEY = "homepage";

/** Shape of the persisted row, as read back from the database. */
export interface HomepageContentRecord {
  id: string;
  singleton_key: string;
  content_json: unknown;
  revision: number;
  updated_by_user_id: string | null;
  created_at: string;
  updated_at: string;
}
