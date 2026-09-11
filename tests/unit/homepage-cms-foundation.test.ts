import { describe, test, expect } from "vitest";

import { DEFAULT_HOMEPAGE_CONTENT } from "@/lib/homepage/default-content";
import {
  validateHomepageContent,
  isAllowedHomepageHref,
  LIMITS,
  MAX_ITEMS,
} from "@/lib/homepage/validation";
import { resolveHomepageContent } from "@/lib/homepage/content-resolution";
import {
  HOMEPAGE_MEDIA_SLOTS,
  HOMEPAGE_MEDIA_SLOT_SPECS,
  HOMEPAGE_MEDIA_SLOT_VALUES,
  isHomepageMediaSlot,
  isHomepageMediaType,
  mediaTypeMatchesSlot,
} from "@/lib/homepage/media-slots";
import type { HomepageContent } from "@/lib/homepage/types";

/** Deep clone so each test mutates an isolated copy of the defaults. */
function draft(): HomepageContent {
  return JSON.parse(JSON.stringify(DEFAULT_HOMEPAGE_CONTENT)) as HomepageContent;
}

function fieldsOf(result: ReturnType<typeof validateHomepageContent>): string[] {
  return result.ok ? [] : result.errors.map((e) => e.field);
}

// ─── 1. defaults ─────────────────────────────────────────────────────────────

describe("default homepage content", () => {
  test("validates against the contract", () => {
    const result = validateHomepageContent(DEFAULT_HOMEPAGE_CONTENT);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  test("round-trips through JSON unchanged, so it can seed a jsonb column", () => {
    const roundTripped = JSON.parse(JSON.stringify(DEFAULT_HOMEPAGE_CONTENT));
    expect(roundTripped).toEqual(DEFAULT_HOMEPAGE_CONTENT);
    expect(validateHomepageContent(roundTripped).ok).toBe(true);
  });

  test("every section is present", () => {
    expect(Object.keys(DEFAULT_HOMEPAGE_CONTENT).sort()).toEqual([
      "buildOptions",
      "characters",
      "faqTeaser",
      "finalCta",
      "hero",
      "navigation",
      "pricing",
      "safety",
      "testimonials",
    ]);
  });
});

// ─── 2-4. CTA href policy ────────────────────────────────────────────────────

describe("CTA href policy", () => {
  test("rejects javascript: URLs, in any casing", () => {
    for (const href of [
      "javascript:alert(1)",
      "JavaScript:alert(1)",
      "JAVASCRIPT:alert(1)",
      "  javascript:alert(1)",
    ]) {
      expect(isAllowedHomepageHref(href)).toBe(false);
    }
  });

  test("rejects data:, external and protocol-relative URLs", () => {
    for (const href of [
      "data:text/html;base64,PHNjcmlwdD4=",
      "https://evil.example.com",
      "http://evil.example.com",
      "//evil.example.com",
      "mailto:hello@example.com",
      "vbscript:msgbox(1)",
    ]) {
      expect(isAllowedHomepageHref(href)).toBe(false);
    }
  });

  test("allows internal absolute paths", () => {
    for (const href of ["/", "/examples", "/create-image", "/pricing", "/#creation-types"]) {
      expect(isAllowedHomepageHref(href)).toBe(true);
    }
  });

  test("allows internal anchors", () => {
    expect(isAllowedHomepageHref("#creation-types")).toBe(true);
    expect(isAllowedHomepageHref("#top")).toBe(true);
  });

  test("rejects bare relative paths and empty values", () => {
    for (const href of ["examples", "", "   ", "./x", "../x"]) {
      expect(isAllowedHomepageHref(href)).toBe(false);
    }
  });

  test("a javascript: CTA fails whole-document validation", () => {
    const bad = draft();
    bad.hero.primaryCta.href = "javascript:alert(1)";
    const result = validateHomepageContent(bad);
    expect(result.ok).toBe(false);
    expect(fieldsOf(result)).toContain("hero.primaryCta.href");
  });
});

// ─── 5. length limits ────────────────────────────────────────────────────────

describe("text limits", () => {
  test("rejects an overlong title", () => {
    const bad = draft();
    bad.hero.title = "ا".repeat(LIMITS.title + 1);
    const result = validateHomepageContent(bad);
    expect(result.ok).toBe(false);
    expect(fieldsOf(result)).toContain("hero.title");
  });

  test("rejects an overlong CTA label", () => {
    const bad = draft();
    bad.finalCta.primaryCta.label = "x".repeat(LIMITS.ctaLabel + 1);
    expect(fieldsOf(validateHomepageContent(bad))).toContain("finalCta.primaryCta.label");
  });

  test("rejects empty required text", () => {
    const bad = draft();
    bad.hero.eyebrow = "   ";
    expect(fieldsOf(validateHomepageContent(bad))).toContain("hero.eyebrow");
  });

  test("rejects markup in a text field", () => {
    const bad = draft();
    bad.hero.description = "<script>alert(1)</script>";
    expect(fieldsOf(validateHomepageContent(bad))).toContain("hero.description");
  });
});

// ─── 6. malformed structure ──────────────────────────────────────────────────

describe("malformed structure", () => {
  test("rejects a non-object payload", () => {
    for (const value of [null, undefined, 42, "text", [], true]) {
      expect(validateHomepageContent(value).ok).toBe(false);
    }
  });

  test("rejects a missing section", () => {
    const bad = draft() as Partial<HomepageContent>;
    delete bad.safety;
    const result = validateHomepageContent(bad);
    expect(result.ok).toBe(false);
    expect(fieldsOf(result)).toContain("safety");
  });

  test("rejects a section of the wrong shape", () => {
    const bad = draft() as unknown as Record<string, unknown>;
    bad.testimonials = "not an object";
    expect(fieldsOf(validateHomepageContent(bad))).toContain("testimonials");
  });

  test("rejects a card missing required fields", () => {
    const bad = draft() as unknown as Record<string, unknown>;
    (bad.buildOptions as { cards: unknown[] }).cards = [{ id: "only-id" }];
    const result = validateHomepageContent(bad);
    expect(result.ok).toBe(false);
    expect(fieldsOf(result)).toContain("buildOptions.cards[0].title");
  });

  test("rejects an unknown badge variant", () => {
    const bad = draft();
    (bad.buildOptions.cards[0] as { badgeVariant: string }).badgeVariant = "rainbow";
    expect(fieldsOf(validateHomepageContent(bad))).toContain(
      "buildOptions.cards[0].badgeVariant"
    );
  });

  test("rejects an unknown media key on a card", () => {
    const bad = draft();
    (bad.buildOptions.cards[0] as { media: string }).media = "hero.background";
    expect(fieldsOf(validateHomepageContent(bad))).toContain("buildOptions.cards[0].media");
  });
});

// ─── 7. duplicate ids ────────────────────────────────────────────────────────

describe("repeatable item ids", () => {
  test("rejects duplicate testimonial ids", () => {
    const bad = draft();
    bad.testimonials.items[1].id = bad.testimonials.items[0].id;
    const result = validateHomepageContent(bad);
    expect(result.ok).toBe(false);
    expect(fieldsOf(result)).toContain("testimonials.items[1].id");
  });

  test("rejects duplicate character ids", () => {
    const bad = draft();
    bad.characters.cards[2].id = bad.characters.cards[0].id;
    expect(fieldsOf(validateHomepageContent(bad))).toContain("characters.cards[2].id");
  });

  test("rejects a malformed id", () => {
    const bad = draft();
    bad.safety.points[0].id = "Not A Valid Id!";
    expect(fieldsOf(validateHomepageContent(bad))).toContain("safety.points[0].id");
  });

  test("rejects duplicate FAQ teaser questions", () => {
    const bad = draft();
    bad.faqTeaser.questions[1] = bad.faqTeaser.questions[0];
    expect(fieldsOf(validateHomepageContent(bad))).toContain("faqTeaser.questions");
  });
});

// ─── 8. collection size ──────────────────────────────────────────────────────

describe("collection limits", () => {
  test("rejects too many build-option cards", () => {
    const bad = draft();
    const template = bad.buildOptions.cards[0];
    bad.buildOptions.cards = Array.from(
      { length: MAX_ITEMS.buildOptionCards + 1 },
      (_, i) => ({ ...template, id: `card-${i}` })
    );
    const result = validateHomepageContent(bad);
    expect(result.ok).toBe(false);
    expect(fieldsOf(result)).toContain("buildOptions.cards");
  });

  test("rejects too many testimonials", () => {
    const bad = draft();
    const template = bad.testimonials.items[0];
    bad.testimonials.items = Array.from(
      { length: MAX_ITEMS.testimonials + 1 },
      (_, i) => ({ ...template, id: `t-${i}` })
    );
    expect(fieldsOf(validateHomepageContent(bad))).toContain("testimonials.items");
  });

  test("rejects an empty required collection", () => {
    const bad = draft();
    bad.characters.cards = [];
    expect(fieldsOf(validateHomepageContent(bad))).toContain("characters.cards");
  });

  test("rejects a non-array collection", () => {
    const bad = draft() as unknown as Record<string, unknown>;
    (bad.safety as { points: unknown }).points = { "0": "nope" };
    expect(fieldsOf(validateHomepageContent(bad))).toContain("safety.points");
  });
});

// ─── 9-11. media slots ───────────────────────────────────────────────────────

describe("media slots", () => {
  test("accepts every declared slot", () => {
    for (const slot of HOMEPAGE_MEDIA_SLOT_VALUES) {
      expect(isHomepageMediaSlot(slot)).toBe(true);
    }
    expect(HOMEPAGE_MEDIA_SLOT_VALUES.length).toBeGreaterThan(0);
  });

  test("rejects unknown or malformed slot keys", () => {
    for (const slot of [
      "hero.unknown",
      "arbitrary",
      "",
      "../../etc/passwd",
      "hero.background ",
      null,
      42,
      undefined,
    ]) {
      expect(isHomepageMediaSlot(slot)).toBe(false);
    }
  });

  test("validates media types", () => {
    expect(isHomepageMediaType("image")).toBe(true);
    expect(isHomepageMediaType("video")).toBe(true);
    for (const t of ["audio", "IMAGE", "", null, 7]) {
      expect(isHomepageMediaType(t)).toBe(false);
    }
  });

  test("a slot only accepts the media type it declares", () => {
    expect(mediaTypeMatchesSlot(HOMEPAGE_MEDIA_SLOTS.HERO_BACKGROUND, "image")).toBe(true);
    expect(mediaTypeMatchesSlot(HOMEPAGE_MEDIA_SLOTS.HERO_BACKGROUND, "video")).toBe(false);
    expect(mediaTypeMatchesSlot(HOMEPAGE_MEDIA_SLOTS.HERO_TV_VIDEO, "video")).toBe(true);
    expect(mediaTypeMatchesSlot(HOMEPAGE_MEDIA_SLOTS.HERO_TV_VIDEO, "image")).toBe(false);
  });

  test("every slot has a complete spec", () => {
    for (const slot of HOMEPAGE_MEDIA_SLOT_VALUES) {
      const spec = HOMEPAGE_MEDIA_SLOT_SPECS[slot];
      expect(spec.slot).toBe(slot);
      expect(["image", "video"]).toContain(spec.mediaType);
      expect(spec.label.length).toBeGreaterThan(0);
      expect(spec.currentPublicPath.startsWith("/")).toBe(true);
      expect(typeof spec.geometryCoupled).toBe("boolean");
    }
  });

  test("the hero and sections backgrounds are flagged geometry-coupled", () => {
    // Hero.tsx measures its TV overlay against the exact artwork; the sections
    // layer crops to keep that same TV out of view. Swapping either file without
    // preserving that geometry breaks the hero, so the upload phase must warn.
    expect(
      HOMEPAGE_MEDIA_SLOT_SPECS[HOMEPAGE_MEDIA_SLOTS.HERO_BACKGROUND].geometryCoupled
    ).toBe(true);
    expect(
      HOMEPAGE_MEDIA_SLOT_SPECS[HOMEPAGE_MEDIA_SLOTS.SECTIONS_BACKGROUND].geometryCoupled
    ).toBe(true);
  });
});

// ─── 12-13. fallback behaviour ───────────────────────────────────────────────

describe("content resolution fallback", () => {
  test("absent row falls back to defaults", () => {
    const outcome = resolveHomepageContent({ row: null });
    expect(outcome.content).toEqual(DEFAULT_HOMEPAGE_CONTENT);
    expect(outcome.source).toBe("default-missing-row");
    expect(outcome.revision).toBeNull();
    expect(outcome.diagnostic?.level).toBe("warn");
  });

  test("failed read falls back to defaults", () => {
    const outcome = resolveHomepageContent({ row: null, readFailed: true });
    expect(outcome.content).toEqual(DEFAULT_HOMEPAGE_CONTENT);
    expect(outcome.source).toBe("default-read-error");
    expect(outcome.diagnostic?.level).toBe("error");
  });

  test("malformed stored content falls back to defaults", () => {
    const outcome = resolveHomepageContent({
      row: { content_json: { hero: "broken" }, revision: 7 },
    });
    expect(outcome.content).toEqual(DEFAULT_HOMEPAGE_CONTENT);
    expect(outcome.source).toBe("default-invalid-content");
    expect(outcome.revision).toBeNull();
    expect(outcome.diagnostic?.fields?.length).toBeGreaterThan(0);
  });

  test("a stored javascript: CTA falls back rather than rendering", () => {
    const poisoned = draft();
    poisoned.hero.primaryCta.href = "javascript:alert(1)";
    const outcome = resolveHomepageContent({ row: { content_json: poisoned, revision: 3 } });
    expect(outcome.source).toBe("default-invalid-content");
    expect(outcome.content.hero.primaryCta.href).toBe("#creation-types");
  });

  test("diagnostics carry field paths only, never stored values", () => {
    const outcome = resolveHomepageContent({
      row: { content_json: { hero: { title: "SECRET-VALUE-SHOULD-NOT-LEAK" } }, revision: 1 },
    });
    const serialised = JSON.stringify(outcome.diagnostic);
    expect(serialised).not.toContain("SECRET-VALUE-SHOULD-NOT-LEAK");
  });

  test("valid stored content is returned with its revision", () => {
    const outcome = resolveHomepageContent({
      row: { content_json: draft(), revision: 12 },
    });
    expect(outcome.source).toBe("database");
    expect(outcome.revision).toBe(12);
    expect(outcome.content).toEqual(DEFAULT_HOMEPAGE_CONTENT);
    expect(outcome.diagnostic).toBeNull();
  });

  test("a non-numeric revision resolves to null rather than leaking through", () => {
    const outcome = resolveHomepageContent({
      row: { content_json: draft(), revision: "12" },
    });
    expect(outcome.source).toBe("database");
    expect(outcome.revision).toBeNull();
  });
});
