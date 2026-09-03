import {
  BUILD_OPTION_BADGE_VARIANTS,
  BUILD_OPTION_MEDIA_KEYS,
  type BuildOptionBadgeVariant,
  type BuildOptionMediaKey,
  type BuildOptionCard,
  type BuildOptionsContent,
  type CharactersContent,
  type FaqTeaserContent,
  type FinalCtaContent,
  type HeroContent,
  type HomepageCharacterCard,
  type HomepageContent,
  type HomepageCta,
  type PricingContent,
  type SafetyContent,
  type SafetyPoint,
  type Testimonial,
  type TestimonialsContent,
} from "@/lib/homepage/types";

export interface HomepageValidationError {
  /** Dotted path to the offending field, e.g. "hero.primaryCta.href". */
  field: string;
  message: string;
}

export type HomepageValidationResult =
  | { ok: true; content: HomepageContent; errors: [] }
  | { ok: false; content: null; errors: HomepageValidationError[] };

/** Field length ceilings. Generous enough for Persian copy, tight enough to bound payloads. */
export const LIMITS = {
  eyebrow: 120,
  title: 160,
  description: 600,
  ctaLabel: 60,
  trustLine: 200,
  cardTitle: 120,
  cardDescription: 400,
  badge: 40,
  emoji: 8,
  name: 80,
  age: 40,
  mark: 8,
  role: 120,
  quote: 600,
  note: 300,
  footnote: 400,
  imageAlt: 200,
  question: 300,
  planId: 40,
  href: 300,
  id: 48,
} as const;

/** Collection size ceilings. */
export const MAX_ITEMS = {
  buildOptionCards: 6,
  characterCards: 8,
  safetyPoints: 8,
  testimonials: 8,
  faqQuestions: 6,
  featuredPlans: 6,
} as const;

const ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;
const ANCHOR_PATTERN = /^#[A-Za-z0-9_-]+$/;
/** An internal path: single leading slash, no scheme, no protocol-relative "//". */
const INTERNAL_PATH_PATTERN = /^\/(?!\/)[A-Za-z0-9\-._~!$&'()*+,;=:@%/?#]*$/;

/**
 * Only internal destinations are accepted. Anything with a scheme
 * (javascript:, data:, http:, mailto:) or a protocol-relative prefix is
 * rejected outright - an editor must not be able to point a homepage button at
 * an arbitrary origin or execute script. External link support is a deliberate
 * later addition with its own allowlist.
 */
export function isAllowedHomepageHref(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const href = value.trim();
  if (href.length === 0 || href.length > LIMITS.href) return false;
  if (href !== value) return false; // no leading/trailing whitespace tricks
  // Reject whitespace and control characters, which can smuggle a scheme past
  // the checks below (an embedded newline inside "java\nscript:", say).
  // Note this class must not be written [\s -]: that spans space..hyphen and
  // would reject legitimate hrefs such as "#creation-types".
  if (/[\s\u0000-\u001F\u007F]/.test(href)) return false;
  if (href.startsWith("//")) return false;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(href)) return false;
  return ANCHOR_PATTERN.test(href) || INTERNAL_PATH_PATTERN.test(href);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class Collector {
  readonly errors: HomepageValidationError[] = [];

  fail(field: string, message: string): void {
    this.errors.push({ field, message });
  }

  /** Required non-empty plain-text string within `max`. Rejects HTML-looking input. */
  text(value: unknown, field: string, max: number): string {
    if (typeof value !== "string") {
      this.fail(field, "Must be a string");
      return "";
    }
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      this.fail(field, "Must not be empty");
      return "";
    }
    if (trimmed.length > max) {
      this.fail(field, `Must be at most ${max} characters`);
      return trimmed.slice(0, max);
    }
    if (/<[^>]*>/.test(trimmed)) {
      this.fail(field, "Must be plain text; markup is not allowed");
      return trimmed;
    }
    return trimmed;
  }

  href(value: unknown, field: string): string {
    if (!isAllowedHomepageHref(value)) {
      this.fail(
        field,
        "Must be an internal path starting with / or an anchor starting with #"
      );
      return "/";
    }
    return value;
  }

  cta(value: unknown, field: string): HomepageCta {
    if (!isPlainObject(value)) {
      this.fail(field, "Must be an object with label and href");
      return { label: "", href: "/" };
    }
    return {
      label: this.text(value.label, `${field}.label`, LIMITS.ctaLabel),
      href: this.href(value.href, `${field}.href`),
    };
  }

  id(value: unknown, field: string, seen: Set<string>): string {
    if (typeof value !== "string") {
      this.fail(field, "Must be a string");
      return "";
    }
    const id = value.trim();
    if (!ID_PATTERN.test(id) || id.length > LIMITS.id) {
      this.fail(
        field,
        `Must be lowercase alphanumeric with - or _, at most ${LIMITS.id} characters`
      );
      return id;
    }
    if (seen.has(id)) {
      this.fail(field, `Duplicate id "${id}"`);
      return id;
    }
    seen.add(id);
    return id;
  }

  /** Required array within `max`. Returns [] and records an error when invalid. */
  array(value: unknown, field: string, max: number): unknown[] {
    if (!Array.isArray(value)) {
      this.fail(field, "Must be an array");
      return [];
    }
    if (value.length === 0) {
      this.fail(field, "Must contain at least one item");
      return [];
    }
    if (value.length > max) {
      this.fail(field, `Must contain at most ${max} items`);
      return value.slice(0, max);
    }
    return value;
  }

  oneOf<T extends string>(
    value: unknown,
    field: string,
    allowed: readonly T[]
  ): T {
    if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
      this.fail(field, `Must be one of: ${allowed.join(", ")}`);
      return allowed[0];
    }
    return value as T;
  }

  section(value: unknown, field: string): Record<string, unknown> {
    if (!isPlainObject(value)) {
      this.fail(field, "Section is missing or malformed");
      return {};
    }
    return value;
  }
}

function validateHero(raw: unknown, c: Collector): HeroContent {
  const o = c.section(raw, "hero");
  return {
    eyebrow: c.text(o.eyebrow, "hero.eyebrow", LIMITS.eyebrow),
    title: c.text(o.title, "hero.title", LIMITS.title),
    description: c.text(o.description, "hero.description", LIMITS.description),
    primaryCta: c.cta(o.primaryCta, "hero.primaryCta"),
    secondaryCta: c.cta(o.secondaryCta, "hero.secondaryCta"),
    trustLine: c.text(o.trustLine, "hero.trustLine", LIMITS.trustLine),
  };
}

function validateBuildOptions(raw: unknown, c: Collector): BuildOptionsContent {
  const o = c.section(raw, "buildOptions");
  const seen = new Set<string>();
  const cards = c
    .array(o.cards, "buildOptions.cards", MAX_ITEMS.buildOptionCards)
    .map((item, i): BuildOptionCard => {
      const f = `buildOptions.cards[${i}]`;
      const card = c.section(item, f);
      return {
        id: c.id(card.id, `${f}.id`, seen),
        badge: c.text(card.badge, `${f}.badge`, LIMITS.badge),
        badgeVariant: c.oneOf<BuildOptionBadgeVariant>(
          card.badgeVariant,
          `${f}.badgeVariant`,
          BUILD_OPTION_BADGE_VARIANTS
        ),
        title: c.text(card.title, `${f}.title`, LIMITS.cardTitle),
        description: c.text(card.description, `${f}.description`, LIMITS.cardDescription),
        cta: c.cta(card.cta, `${f}.cta`),
        media: c.oneOf<BuildOptionMediaKey>(card.media, `${f}.media`, BUILD_OPTION_MEDIA_KEYS),
      };
    });

  return {
    title: c.text(o.title, "buildOptions.title", LIMITS.title),
    description: c.text(o.description, "buildOptions.description", LIMITS.description),
    cards,
    footnote: c.text(o.footnote, "buildOptions.footnote", LIMITS.footnote),
  };
}

function validateCharacters(raw: unknown, c: Collector): CharactersContent {
  const o = c.section(raw, "characters");
  const seen = new Set<string>();
  const cards = c
    .array(o.cards, "characters.cards", MAX_ITEMS.characterCards)
    .map((item, i): HomepageCharacterCard => {
      const f = `characters.cards[${i}]`;
      const card = c.section(item, f);
      return {
        id: c.id(card.id, `${f}.id`, seen),
        emoji: c.text(card.emoji, `${f}.emoji`, LIMITS.emoji),
        name: c.text(card.name, `${f}.name`, LIMITS.name),
        age: c.text(card.age, `${f}.age`, LIMITS.age),
        description: c.text(card.description, `${f}.description`, LIMITS.cardDescription),
      };
    });

  return {
    eyebrow: c.text(o.eyebrow, "characters.eyebrow", LIMITS.eyebrow),
    title: c.text(o.title, "characters.title", LIMITS.title),
    description: c.text(o.description, "characters.description", LIMITS.description),
    cards,
    cta: c.cta(o.cta, "characters.cta"),
  };
}

function validateSafety(raw: unknown, c: Collector): SafetyContent {
  const o = c.section(raw, "safety");
  const seen = new Set<string>();
  const points = c
    .array(o.points, "safety.points", MAX_ITEMS.safetyPoints)
    .map((item, i): SafetyPoint => {
      const f = `safety.points[${i}]`;
      const p = c.section(item, f);
      return {
        id: c.id(p.id, `${f}.id`, seen),
        mark: c.text(p.mark, `${f}.mark`, LIMITS.mark),
        title: c.text(p.title, `${f}.title`, LIMITS.cardTitle),
        description: c.text(p.description, `${f}.description`, LIMITS.cardDescription),
      };
    });

  return {
    eyebrow: c.text(o.eyebrow, "safety.eyebrow", LIMITS.eyebrow),
    title: c.text(o.title, "safety.title", LIMITS.title),
    description: c.text(o.description, "safety.description", LIMITS.description),
    points,
    imageAlt: c.text(o.imageAlt, "safety.imageAlt", LIMITS.imageAlt),
    note: c.text(o.note, "safety.note", LIMITS.note),
  };
}

function validatePricing(raw: unknown, c: Collector): PricingContent {
  const o = c.section(raw, "pricing");
  const seen = new Set<string>();
  const featuredPlanIds = c
    .array(o.featuredPlanIds, "pricing.featuredPlanIds", MAX_ITEMS.featuredPlans)
    .map((item, i) => c.id(item, `pricing.featuredPlanIds[${i}]`, seen));

  return {
    eyebrow: c.text(o.eyebrow, "pricing.eyebrow", LIMITS.eyebrow),
    title: c.text(o.title, "pricing.title", LIMITS.title),
    featuredPlanIds,
    linkLabel: c.text(o.linkLabel, "pricing.linkLabel", LIMITS.ctaLabel),
    linkHref: c.href(o.linkHref, "pricing.linkHref"),
    footnote: c.text(o.footnote, "pricing.footnote", LIMITS.footnote),
  };
}

function validateTestimonials(raw: unknown, c: Collector): TestimonialsContent {
  const o = c.section(raw, "testimonials");
  const seen = new Set<string>();
  const items = c
    .array(o.items, "testimonials.items", MAX_ITEMS.testimonials)
    .map((item, i): Testimonial => {
      const f = `testimonials.items[${i}]`;
      const t = c.section(item, f);
      return {
        id: c.id(t.id, `${f}.id`, seen),
        quote: c.text(t.quote, `${f}.quote`, LIMITS.quote),
        name: c.text(t.name, `${f}.name`, LIMITS.name),
        role: c.text(t.role, `${f}.role`, LIMITS.role),
      };
    });

  return {
    title: c.text(o.title, "testimonials.title", LIMITS.title),
    items,
  };
}

function validateFaqTeaser(raw: unknown, c: Collector): FaqTeaserContent {
  const o = c.section(raw, "faqTeaser");
  const questions = c
    .array(o.questions, "faqTeaser.questions", MAX_ITEMS.faqQuestions)
    .map((q, i) => c.text(q, `faqTeaser.questions[${i}]`, LIMITS.question));

  const unique = new Set(questions);
  if (unique.size !== questions.length) {
    c.fail("faqTeaser.questions", "Questions must be unique");
  }

  return {
    eyebrow: c.text(o.eyebrow, "faqTeaser.eyebrow", LIMITS.eyebrow),
    title: c.text(o.title, "faqTeaser.title", LIMITS.title),
    questions,
    linkLabel: c.text(o.linkLabel, "faqTeaser.linkLabel", LIMITS.ctaLabel),
    linkHref: c.href(o.linkHref, "faqTeaser.linkHref"),
  };
}

function validateFinalCta(raw: unknown, c: Collector): FinalCtaContent {
  const o = c.section(raw, "finalCta");
  return {
    title: c.text(o.title, "finalCta.title", LIMITS.title),
    description: c.text(o.description, "finalCta.description", LIMITS.description),
    primaryCta: c.cta(o.primaryCta, "finalCta.primaryCta"),
    secondaryCta: c.cta(o.secondaryCta, "finalCta.secondaryCta"),
  };
}

/**
 * Validates an untrusted homepage content payload - whether it came from the
 * database or from a future admin form - into the typed contract.
 *
 * Collects every problem rather than throwing on the first, so the admin editor
 * can show all of them at once. Returns ok:false with the full error list when
 * anything failed; callers fall back to DEFAULT_HOMEPAGE_CONTENT.
 */
export function validateHomepageContent(raw: unknown): HomepageValidationResult {
  const c = new Collector();

  if (!isPlainObject(raw)) {
    return {
      ok: false,
      content: null,
      errors: [{ field: "content", message: "Content must be a JSON object" }],
    };
  }

  const content: HomepageContent = {
    hero: validateHero(raw.hero, c),
    buildOptions: validateBuildOptions(raw.buildOptions, c),
    characters: validateCharacters(raw.characters, c),
    safety: validateSafety(raw.safety, c),
    pricing: validatePricing(raw.pricing, c),
    testimonials: validateTestimonials(raw.testimonials, c),
    faqTeaser: validateFaqTeaser(raw.faqTeaser, c),
    finalCta: validateFinalCta(raw.finalCta, c),
  };

  if (c.errors.length > 0) {
    return { ok: false, content: null, errors: c.errors };
  }
  return { ok: true, content, errors: [] };
}
