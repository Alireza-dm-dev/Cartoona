/**
 * Phase 4A runtime wiring.
 *
 * These tests import the actual runtime resolution and composition code rather
 * than restating its behaviour: `resolve-core` (the read + compose path behind
 * `getResolvedHomepage`), and the pure selection helpers the sections use.
 */

import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  LOCAL_MEDIA_FALLBACK,
  composeHeroLayout,
  composeMedia,
  isSafeMediaUrl,
  readHomepageContentRow,
  resolveHomepageWith,
} from "@/lib/homepage/resolve-core";
import { DEFAULT_HOMEPAGE_CONTENT } from "@/lib/homepage/default-content";
import { normalizeHomepageContent } from "@/lib/homepage/content-resolution";
import { DEFAULT_TV_RECT } from "@/lib/homepage/hero-layout";
import {
  HOMEPAGE_MEDIA_SLOTS,
  HOMEPAGE_MEDIA_SLOT_VALUES,
} from "@/lib/homepage/media-slots";
import { queryAdminHomepageMedia } from "@/lib/admin/homepage/media-service";
import {
  DEFAULT_TEASER_PLAN_IDS,
  resolveFeaturedPlans,
} from "@/components/marketing/PricingSection";
import { resolveTeaserFaqs } from "@/components/marketing/FaqTeaserSection";
import { plans } from "@/config/plans";
import { faqs } from "@/config/faqs";

// ── fake Supabase client ────────────────────────────────────────────────────

interface FakeTables {
  homepage_content?: { data: unknown; error?: unknown };
  homepage_media_assets?: { data: unknown; error?: unknown };
  homepage_hero_layout?: { data: unknown; error?: unknown };
}

/** Records which tables were actually read, so we can assert the read path ran. */
interface FakeClient {
  client: SupabaseClient;
  reads: string[];
}

const MISSING_TABLE = {
  data: null,
  error: { code: "42P01", message: 'relation "x" does not exist' },
};

function fakeSupabase(tables: FakeTables, opts: { throwOn?: string } = {}): FakeClient {
  const reads: string[] = [];

  const builder = (table: string) => {
    if (opts.throwOn === table) throw new Error("transport failure");
    const result = tables[table as keyof FakeTables] ?? { data: null };
    const chain = {
      select: () => chain,
      eq: () => chain,
      maybeSingle: async () => result,
      then: (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve),
    };
    return chain;
  };

  const client = {
    from(table: string) {
      reads.push(table);
      return builder(table);
    },
    storage: {
      from: () => ({
        getPublicUrl: (storagePath: string) => ({
          data: { publicUrl: `https://cdn.example.test/storage/${storagePath}` },
        }),
      }),
    },
  } as unknown as SupabaseClient;

  return { client, reads };
}

function mediaRow(slotKey: string, storagePath: string, mediaType = "image") {
  return {
    slot_key: slotKey,
    media_type: mediaType,
    storage_path: storagePath,
    mime_type: mediaType === "image" ? "image/png" : "video/mp4",
    byte_size: 1234,
    width: 100,
    height: 100,
    duration_seconds: null,
    updated_at: "2026-08-02T10:00:00.000Z",
  };
}

// ── 1-4: content read path ──────────────────────────────────────────────────

describe("resolver content read path", () => {
  it("uses stored CMS content when the row is present and valid", async () => {
    const stored = {
      ...DEFAULT_HOMEPAGE_CONTENT,
      hero: { ...DEFAULT_HOMEPAGE_CONTENT.hero, title: "عنوان از دیتابیس" },
    };
    const { client, reads } = fakeSupabase({
      homepage_content: { data: { content_json: stored, revision: 7 } },
    });

    const resolved = await resolveHomepageWith(client);

    // Proves the read actually happened rather than silently falling back.
    expect(reads).toContain("homepage_content");
    expect(resolved.sources.content).toBe("database");
    expect(resolved.content.hero.title).toBe("عنوان از دیتابیس");
  });

  it("falls back to defaults when the content table is missing", async () => {
    const { client } = fakeSupabase({ homepage_content: MISSING_TABLE });
    const resolved = await resolveHomepageWith(client);

    expect(resolved.sources.content).toBe("default-read-error");
    expect(resolved.content).toEqual(DEFAULT_HOMEPAGE_CONTENT);
  });

  it("falls back to defaults when the row is missing on a fresh environment", async () => {
    const { client } = fakeSupabase({ homepage_content: { data: null } });
    const resolved = await resolveHomepageWith(client);

    expect(resolved.sources.content).toBe("default-missing-row");
    expect(resolved.content).toEqual(DEFAULT_HOMEPAGE_CONTENT);
  });

  it("falls back to defaults when stored content is malformed", async () => {
    const { client } = fakeSupabase({
      homepage_content: {
        data: { content_json: { hero: { title: 42 }, pricing: "nope" }, revision: 3 },
      },
    });
    const resolved = await resolveHomepageWith(client);

    expect(resolved.sources.content).toBe("default-invalid-content");
    expect(resolved.content).toEqual(DEFAULT_HOMEPAGE_CONTENT);
  });

  it("reports a transport failure as a read error rather than throwing", async () => {
    const { client } = fakeSupabase({}, { throwOn: "homepage_content" });
    const { row, readFailed } = await readHomepageContentRow(client);

    expect(row).toBeNull();
    expect(readFailed).toBe(true);
  });
});

// ── 5: backward normalization ───────────────────────────────────────────────

describe("backward normalization of pre-navigation content", () => {
  it("accepts old stored content that predates the navigation section", async () => {
    const old = { ...DEFAULT_HOMEPAGE_CONTENT } as Record<string, unknown>;
    delete old.navigation;

    const { client } = fakeSupabase({
      homepage_content: { data: { content_json: old, revision: 1 } },
    });
    const resolved = await resolveHomepageWith(client);

    expect(resolved.sources.content).toBe("database");
    expect(resolved.content.navigation.signupLabel).toBe("شروع کنید");
    expect(resolved.content.navigation.pricingLabel).toBe("قیمت‌گذاری");
  });

  it("is pure: the input is never mutated and repeat calls are stable", () => {
    const old = { ...DEFAULT_HOMEPAGE_CONTENT } as Record<string, unknown>;
    delete old.navigation;
    const snapshot = JSON.parse(JSON.stringify(old));

    const once = normalizeHomepageContent(old);
    const twice = normalizeHomepageContent(once);

    expect(old).toEqual(snapshot);
    expect(old.navigation).toBeUndefined();
    expect(once).toEqual(twice);
  });

  it("never writes navigation onto the shared default content singleton", () => {
    const before = JSON.parse(JSON.stringify(DEFAULT_HOMEPAGE_CONTENT));
    normalizeHomepageContent(DEFAULT_HOMEPAGE_CONTENT);
    expect(DEFAULT_HOMEPAGE_CONTENT).toEqual(before);
  });

  it("does not repair a malformed existing section", () => {
    const broken = { ...DEFAULT_HOMEPAGE_CONTENT, pricing: null };
    expect(normalizeHomepageContent(broken)).toEqual(broken);
  });
});

// ── 6-9, 22: media resolution ───────────────────────────────────────────────

describe("media slot resolution", () => {
  it("falls every slot back to its committed local asset when the table is missing", async () => {
    const { client } = fakeSupabase({ homepage_media_assets: MISSING_TABLE });
    const resolved = await resolveHomepageWith(client);

    expect(resolved.media).toEqual(LOCAL_MEDIA_FALLBACK);
    expect(resolved.media[HOMEPAGE_MEDIA_SLOTS.HERO_BACKGROUND]).toBe(
      "/images/homepage/sections-bg.png",
    );
    expect(resolved.media[HOMEPAGE_MEDIA_SLOTS.HERO_TV_VIDEO]).toBe(
      "/videos/homepage/hero-tv.mp4",
    );
    expect(resolved.media[HOMEPAGE_MEDIA_SLOTS.BUILD_OPTIONS_CARD_IMAGE]).toBe(
      "/images/homepage/card-image.jpg",
    );
    expect(resolved.media[HOMEPAGE_MEDIA_SLOTS.BUILD_OPTIONS_CARD_VIDEO]).toBe(
      "/videos/homepage/build-video.mp4",
    );
    expect(resolved.media[HOMEPAGE_MEDIA_SLOTS.BUILD_OPTIONS_CARD_ANIMATION]).toBe(
      "/videos/homepage/build-animate.mp4",
    );
    expect(resolved.media[HOMEPAGE_MEDIA_SLOTS.SAFETY_IMAGE]).toBe(
      "/images/homepage/family-tablet.jpg",
    );
  });

  it("applies a single CMS override and leaves every other slot local", async () => {
    const { client } = fakeSupabase({
      homepage_media_assets: { data: [mediaRow("safety.image", "safety/new.png")] },
    });
    const resolved = await resolveHomepageWith(client);

    expect(resolved.media[HOMEPAGE_MEDIA_SLOTS.SAFETY_IMAGE]).toBe(
      "https://cdn.example.test/storage/safety/new.png",
    );
    expect(resolved.sources.mediaPerSlot[HOMEPAGE_MEDIA_SLOTS.SAFETY_IMAGE]).toBe("database");

    for (const slot of HOMEPAGE_MEDIA_SLOT_VALUES) {
      if (slot === HOMEPAGE_MEDIA_SLOTS.SAFETY_IMAGE) continue;
      expect(resolved.media[slot]).toBe(LOCAL_MEDIA_FALLBACK[slot]);
      expect(resolved.sources.mediaPerSlot[slot]).toBe("local-fallback");
    }
  });

  it("resolves hero and sections backgrounds independently", async () => {
    const { client } = fakeSupabase({
      homepage_media_assets: { data: [mediaRow("hero.background", "hero/bg.png")] },
    });
    const resolved = await resolveHomepageWith(client);

    expect(resolved.media[HOMEPAGE_MEDIA_SLOTS.HERO_BACKGROUND]).toBe(
      "https://cdn.example.test/storage/hero/bg.png",
    );
    expect(resolved.media[HOMEPAGE_MEDIA_SLOTS.SECTIONS_BACKGROUND]).toBe(
      "/images/homepage/sections-bg.png",
    );
  });

  it("rejects a malformed storage path in favour of the local asset", async () => {
    const { client } = fakeSupabase({
      homepage_media_assets: {
        data: [
          mediaRow("safety.image", "../../etc/passwd"),
          mediaRow("hero.background", "hero/ bad name.png"),
        ],
      },
    });
    const resolved = await resolveHomepageWith(client);

    expect(resolved.media[HOMEPAGE_MEDIA_SLOTS.SAFETY_IMAGE]).toBe(
      "/images/homepage/family-tablet.jpg",
    );
    expect(resolved.media[HOMEPAGE_MEDIA_SLOTS.HERO_BACKGROUND]).toBe(
      "/images/homepage/sections-bg.png",
    );
  });

  it("only accepts rooted local paths and https URLs", () => {
    expect(isSafeMediaUrl("/images/homepage/sections-bg.png")).toBe(true);
    expect(isSafeMediaUrl("https://cdn.example.test/a.png")).toBe(true);

    expect(isSafeMediaUrl("data:image/png;base64,AAAA")).toBe(false);
    expect(isSafeMediaUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeMediaUrl("http://insecure.test/a.png")).toBe(false);
    expect(isSafeMediaUrl("//evil.test/a.png")).toBe(false);
    expect(isSafeMediaUrl("/images/../../secret")).toBe(false);
    expect(isSafeMediaUrl("")).toBe(false);
    expect(isSafeMediaUrl(undefined)).toBe(false);
    expect(isSafeMediaUrl(null)).toBe(false);
  });

  it("keys every slot with the canonical dot namespace and no underscore aliases", async () => {
    const { client } = fakeSupabase({});
    const resolved = await resolveHomepageWith(client);

    expect(Object.keys(resolved.media).sort()).toEqual([...HOMEPAGE_MEDIA_SLOT_VALUES].sort());
    for (const key of Object.keys(resolved.media)) {
      expect(key).toContain(".");
      expect(key).not.toMatch(/^(hero|sections|safety|build_options)_/);
    }
  });

  it("never leaves a slot undefined", async () => {
    const { client } = fakeSupabase({ homepage_media_assets: MISSING_TABLE });
    const resolved = await resolveHomepageWith(client);

    for (const slot of HOMEPAGE_MEDIA_SLOT_VALUES) {
      expect(typeof resolved.media[slot]).toBe("string");
      expect(resolved.media[slot].length).toBeGreaterThan(0);
    }
  });

  it("derives every local fallback from the slot specs", () => {
    expect(Object.keys(LOCAL_MEDIA_FALLBACK).sort()).toEqual(
      [...HOMEPAGE_MEDIA_SLOT_VALUES].sort(),
    );
    // The wrong-extension paths the audit found must not come back.
    for (const path of Object.values(LOCAL_MEDIA_FALLBACK)) {
      expect(path).not.toBe("/videos/homepage/sections-bg.png");
    }
  });
});

// ── 10-12: hero layout ──────────────────────────────────────────────────────

describe("hero TV geometry", () => {
  it("uses the committed default when no layout row exists", async () => {
    const { client } = fakeSupabase({ homepage_hero_layout: { data: null } });
    const resolved = await resolveHomepageWith(client);

    expect(resolved.heroLayout).toEqual({
      x: 0.105,
      y: 0.1426,
      width: 0.0908,
      height: 0.0961,
    });
    expect(resolved.sources.heroLayout).toBe("default");
  });

  it("uses the committed default when the stored rect is malformed", async () => {
    for (const badRect of [
      { x: -1, y: 0.1, width: 0.1, height: 0.1 },
      { x: 0.9, y: 0.1, width: 0.5, height: 0.1 },
      { x: "a", y: 0.1, width: 0.1, height: 0.1 },
      { x: 0.1, y: 0.1, width: 0, height: 0.1 },
      null,
    ]) {
      const { client } = fakeSupabase({
        homepage_hero_layout: { data: { tv_rect: badRect, revision: 2 } },
      });
      const resolved = await resolveHomepageWith(client);

      expect(resolved.heroLayout).toEqual(DEFAULT_TV_RECT);
      expect(resolved.sources.heroLayout).toBe("default");
    }
  });

  it("passes a valid stored rect through", async () => {
    const rect = { x: 0.2, y: 0.3, width: 0.1, height: 0.15 };
    const { client } = fakeSupabase({
      homepage_hero_layout: { data: { tv_rect: rect, revision: 4 } },
    });
    const resolved = await resolveHomepageWith(client);

    expect(resolved.heroLayout).toEqual(rect);
    expect(resolved.sources.heroLayout).toBe("database");
  });

  it("hands the hero a rect with the canonical x/y vocabulary", async () => {
    const { client } = fakeSupabase({});
    const resolved = await resolveHomepageWith(client);

    expect(Object.keys(resolved.heroLayout).sort()).toEqual([
      "height",
      "width",
      "x",
      "y",
    ]);
    expect(resolved.heroLayout).not.toHaveProperty("left");
    expect(resolved.heroLayout).not.toHaveProperty("top");
  });

  it("keeps composeHeroLayout free of stored extra fields", () => {
    const { heroLayout } = composeHeroLayout({
      slots: [],
      heroLayout: {
        rect: { x: 0.2, y: 0.3, width: 0.1, height: 0.15, evil: "css" } as never,
        revision: 1,
      },
      sharedBackground: false,
    });
    expect(heroLayout).toEqual({ x: 0.2, y: 0.3, width: 0.1, height: 0.15 });
  });
});

// ── 13: page/section prop composition ───────────────────────────────────────

describe("section prop composition", () => {
  it("exposes every section the page module renders", async () => {
    const { client } = fakeSupabase({});
    const { content } = await resolveHomepageWith(client);

    for (const section of [
      "hero",
      "buildOptions",
      "characters",
      "safety",
      "pricing",
      "testimonials",
      "faqTeaser",
      "finalCta",
      "navigation",
    ] as const) {
      expect(content[section]).toBeDefined();
    }
  });

  it("reads all three bounded tables and nothing else", async () => {
    const { client, reads } = fakeSupabase({});
    await resolveHomepageWith(client);

    expect(new Set(reads)).toEqual(
      new Set(["homepage_content", "homepage_media_assets", "homepage_hero_layout"]),
    );
  });
});

// ── 14: navigation labels ───────────────────────────────────────────────────

describe("navigation labels", () => {
  it("resolves editor labels for every nav position", async () => {
    const stored = {
      ...DEFAULT_HOMEPAGE_CONTENT,
      navigation: {
        charactersLabel: "قهرمان‌ها",
        examplesLabel: "گالری",
        pricingLabel: "تعرفه",
        safetyLabel: "امنیت",
        faqLabel: "پرسش‌ها",
        loginLabel: "درود",
        signupLabel: "بزن بریم",
      },
    };
    const { client } = fakeSupabase({
      homepage_content: { data: { content_json: stored, revision: 2 } },
    });
    const resolved = await resolveHomepageWith(client);

    expect(resolved.content.navigation).toEqual(stored.navigation);
  });

  it("ships defaults free of the corrupted literals the audit found", () => {
    const nav = DEFAULT_HOMEPAGE_CONTENT.navigation;
    expect(nav.pricingLabel).toBe("قیمت‌گذاری");
    expect(nav.faqLabel).toBe("سوالات متداول");
    expect(nav.signupLabel).toBe("شروع کنید");
    expect(JSON.stringify(nav)).not.toContain("labelling");
    expect(nav.faqLabel).not.toContain("المتداول");
  });
});

// ── 15-16: build options + safety content ───────────────────────────────────

describe("build options and safety content", () => {
  it("carries a CMS footnote rather than a component literal", async () => {
    const stored = {
      ...DEFAULT_HOMEPAGE_CONTENT,
      buildOptions: { ...DEFAULT_HOMEPAGE_CONTENT.buildOptions, footnote: "پانویس تازه" },
    };
    const { client } = fakeSupabase({
      homepage_content: { data: { content_json: stored, revision: 5 } },
    });
    const resolved = await resolveHomepageWith(client);

    expect(resolved.content.buildOptions.footnote).toBe("پانویس تازه");
  });

  it("names only bounded media keys on build-option cards", async () => {
    const { client } = fakeSupabase({});
    const resolved = await resolveHomepageWith(client);

    for (const card of resolved.content.buildOptions.cards) {
      expect(["card_image", "card_video", "card_animation"]).toContain(card.media);
    }
  });

  it("keeps the safety points the section renders", async () => {
    const { client } = fakeSupabase({});
    const resolved = await resolveHomepageWith(client);

    expect(resolved.content.safety.points.length).toBeGreaterThan(0);
    for (const point of resolved.content.safety.points) {
      expect(point.mark).toBeTruthy();
      expect(point.title).toBeTruthy();
      expect(point.description).toBeTruthy();
    }
  });
});

// ── 18: FAQ teaser ──────────────────────────────────────────────────────────

describe("FAQ teaser selection", () => {
  it("resolves canonical answers for the selected questions", () => {
    const selected = DEFAULT_HOMEPAGE_CONTENT.faqTeaser.questions;
    const resolvedFaqs = resolveTeaserFaqs(selected);

    expect(resolvedFaqs.length).toBeGreaterThan(0);
    for (const faq of resolvedFaqs) {
      const canonical = faqs.find((f) => f.q === faq.q);
      expect(canonical).toBeDefined();
      expect(faq.a).toBe(canonical!.a);
      // The audited regression rendered the question again as its own answer.
      expect(faq.a).not.toBe(faq.q);
    }
  });

  it("preserves the editor's selection order", () => {
    const picked = [faqs[2].q, faqs[0].q];
    expect(resolveTeaserFaqs(picked).map((f) => f.q)).toEqual(picked);
  });

  it("drops an unknown question rather than rendering it answerless", () => {
    const resolvedFaqs = resolveTeaserFaqs([faqs[0].q, "سوالی که وجود ندارد"]);
    expect(resolvedFaqs.map((f) => f.q)).toEqual([faqs[0].q]);
  });
});

// ── 19-20: pricing ──────────────────────────────────────────────────────────

describe("pricing plan selection", () => {
  it("selects authoritative plans by id", () => {
    const selected = resolveFeaturedPlans(["plus"]);
    expect(selected.map((p) => p.id)).toEqual(["plus"]);
    expect(selected[0].priceToman).toBe(
      plans.find((p) => p.id === "plus")!.priceToman,
    );
  });

  it("ignores unknown ids", () => {
    expect(resolveFeaturedPlans(["plus", "not-a-plan"]).map((p) => p.id)).toEqual(["plus"]);
  });

  it("falls back to the default teaser set when the selection is empty", () => {
    expect(resolveFeaturedPlans([]).map((p) => p.id)).toEqual([
      ...DEFAULT_TEASER_PLAN_IDS,
    ]);
  });

  it("falls back when every selected id is unknown", () => {
    expect(resolveFeaturedPlans(["nope", "gone"]).map((p) => p.id)).toEqual([
      ...DEFAULT_TEASER_PLAN_IDS,
    ]);
  });

  it("never sources price, candy or benefits from the CMS", async () => {
    const { client } = fakeSupabase({});
    const resolved = await resolveHomepageWith(client);
    const pricing = resolved.content.pricing as unknown as Record<string, unknown>;

    for (const forbidden of ["price", "priceToman", "candies", "benefits", "amount"]) {
      expect(pricing[forbidden]).toBeUndefined();
    }
    expect(Array.isArray(resolved.content.pricing.featuredPlanIds)).toBe(true);
  });
});

// ── media-service degradation used by the resolver ──────────────────────────

describe("media overview degradation", () => {
  it("returns local preview paths when both media tables are missing", async () => {
    const { client } = fakeSupabase({
      homepage_media_assets: MISSING_TABLE,
      homepage_hero_layout: MISSING_TABLE,
    });
    const overview = await queryAdminHomepageMedia(client);

    expect(overview.slots).toHaveLength(HOMEPAGE_MEDIA_SLOT_VALUES.length);
    expect(overview.heroLayout).toBeNull();
    const { media } = composeMedia(overview);
    expect(media).toEqual(LOCAL_MEDIA_FALLBACK);
  });
});
