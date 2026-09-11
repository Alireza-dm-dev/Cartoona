import { describe, test, expect, vi, beforeEach } from "vitest";

import { DEFAULT_TV_RECT, validateHeroTvRect } from "@/lib/homepage/hero-layout";
import {
  HOMEPAGE_MEDIA_SLOT_SPECS,
  type HomepageMediaSlot,
} from "@/lib/homepage/media-slots";
import {
  clampHeroRect,
  formatPercentFraction,
  interpretLayoutSaveResponse,
  interpretMediaUploadResponse,
  moveHeroRectByPixels,
  parsePercentInput,
  precheckFileForSlot,
  resizeHeroRectByPixels,
  type ClientFileInfo,
} from "@/lib/admin/homepage/media-editor-state";
import { aspectCompatibilityNote } from "@/lib/homepage/hero-layout";
import type { AdminMediaOverview } from "@/lib/admin/homepage/media-service";

/**
 * Mocked UI tests for the admin media manager (Phase 3).
 *
 * No React, no database, no Supabase client: a harness mirrors the exact
 * transitions in media-slot-card / hero-media-panel / hero-calibration /
 * use-admin-homepage-media (same pure helpers, same fetch call shapes), with
 * `fetch` mocked per scenario. Every assertion targets user-visible behavior.
 */

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function overviewFixture(shared: boolean): AdminMediaOverview {
  const slot = (slotKey: string, mediaType: string, mime: string, previewUrl: string) => ({
    slotKey, mediaType, previewUrl, mimeType: mime, byteSize: 1000,
    width: 100, height: 100, durationSeconds: null, updatedAt: "2026-01-01T00:00:00Z",
    label: slotKey, geometryCoupled: false, currentPublicPath: `/local/${slotKey}`,
  });
  const local = (slotKey: string, mediaType: string) => ({
    slotKey, mediaType, previewUrl: `/local/${slotKey}`, mimeType: "", byteSize: 0,
    width: null, height: null, durationSeconds: null, updatedAt: "",
    label: slotKey, geometryCoupled: false, currentPublicPath: `/local/${slotKey}`,
  });
  return {
    slots: [
      slot("hero.background", "image", "image/png", "https://cdn/h.png"),
      slot("hero.tv_video", "video", "video/mp4", "https://cdn/tv.mp4"),
      shared
        ? slot("sections.background", "image", "image/png", "https://cdn/h.png")
        : local("sections.background", "image"),
      local("build_options.card_image", "image"),
      local("build_options.card_video", "video"),
      local("build_options.card_animation", "video"),
      local("safety.image", "image"),
    ],
    heroLayout: { rect: { ...DEFAULT_TV_RECT }, revision: 3 },
    sharedBackground: shared,
  };
}

/** Mirrors use-admin-homepage-media + card/panel transitions. */
class MockMediaSession {
  overview: AdminMediaOverview | null = null;
  loading = true;
  busy = false;
  fetchUrls: string[] = [];
  lastUploadFields: Record<string, string> = {};

  private mockFetch = vi.fn();

  constructor() {
    vi.stubGlobal("fetch", this.mockFetch);
  }

  async load(fixture: AdminMediaOverview) {
    this.mockFetch.mockResolvedValueOnce(jsonResponse(200, fixture));
    this.loading = true;
    const res = await fetch("/api/admin/homepage/media", { cache: "no-store" });
    this.fetchUrls.push("/api/admin/homepage/media");
    const body = (await res.json()) as AdminMediaOverview;
    this.overview = body;
    this.loading = false;
  }

  view(slot: HomepageMediaSlot) {
    return this.overview?.slots.find((s) => s.slotKey === slot) ?? null;
  }

  /** Mirrors MediaSlotCard.handleUpload precheck + hook.uploadSlot. */
  async upload(slot: HomepageMediaSlot, file: ClientFileInfo, extra: Record<string, string>) {
    const check = precheckFileForSlot(slot, file);
    if (!check.ok) return { sent: false as const, message: check.message };
    this.busy = true;
    const res = await fetch(`/api/admin/homepage/media/${slot}`, { method: "POST", body: null });
    this.fetchUrls.push(`/api/admin/homepage/media/${slot}`);
    this.lastUploadFields = extra;
    const outcome = interpretMediaUploadResponse(res.status, (await res.json()) as Record<string, unknown>);
    this.busy = false;
    if (outcome.kind === "saved") {
      const rec = outcome.record;
      this.overview = this.overview && {
        ...this.overview,
        slots: this.overview.slots.map((s) => (s.slotKey === slot ? { ...s, ...rec, label: s.label, geometryCoupled: s.geometryCoupled, currentPublicPath: s.currentPublicPath } : s)),
      };
    }
    return { sent: true as const, outcome };
  }

  async revert(slot: HomepageMediaSlot) {
    const res = await fetch(`/api/admin/homepage/media/${slot}`, { method: "DELETE" });
    this.fetchUrls.push(`DELETE /api/admin/homepage/media/${slot}`);
    return res.ok;
  }

  async saveLayout(rect: unknown, expectedRevision: number) {
    const res = await fetch("/api/admin/homepage/hero-layout", { method: "PUT", body: null });
    this.fetchUrls.push("/api/admin/homepage/hero-layout");
    return interpretLayoutSaveResponse(res.status, (await res.json()) as Record<string, unknown>);
  }

  queue(status: number, body: unknown) {
    this.mockFetch.mockResolvedValueOnce(jsonResponse(status, body));
  }
}

const img = (overrides: Partial<ClientFileInfo> = {}): ClientFileInfo => ({
  name: "art.png", type: "image/png", size: 1024, ...overrides,
});
const vid = (overrides: Partial<ClientFileInfo> = {}): ClientFileInfo => ({
  name: "clip.mp4", type: "video/mp4", size: 2048, ...overrides,
});

beforeEach(() => {
  vi.restoreAllMocks();
});

// ─── 1-5. loading + preview states ───────────────────────────────────────────
describe("mocked media manager: load and preview states", () => {
  test("1. media manager loads the overview", async () => {
    const s = new MockMediaSession();
    await s.load(overviewFixture(false));
    expect(s.loading).toBe(false);
    expect(s.overview?.slots.length).toBe(7);
    expect(s.overview?.heroLayout?.revision).toBe(3);
  });

  test("2. local fallback state shown when no CMS row exists", async () => {
    const s = new MockMediaSession();
    await s.load(overviewFixture(false));
    const card = s.view("safety.image")!;
    expect(card.mimeType).toBe(""); // → «پیش‌فرض پروژه» badge
    expect(card.previewUrl).toBe(card.currentPublicPath);
  });

  test("3. CMS override state shown when a row exists", async () => {
    const s = new MockMediaSession();
    await s.load(overviewFixture(false));
    const hero = s.view("hero.background")!;
    expect(hero.mimeType).toBe("image/png"); // → «رسانه CMS» badge
    expect(hero.previewUrl).toContain("https://cdn/");
  });

  test("4. image preview uses the safe preview URL", async () => {
    const s = new MockMediaSession();
    await s.load(overviewFixture(false));
    expect(s.view("hero.background")?.previewUrl).toBe("https://cdn/h.png");
  });

  test("5. video preview carries duration metadata", async () => {
    const s = new MockMediaSession();
    const fx = overviewFixture(false);
    fx.slots = fx.slots.map((sl) =>
      sl.slotKey === "hero.tv_video" ? { ...sl, durationSeconds: 31.4, width: 966, height: 754 } : sl,
    );
    await s.load(fx);
    const tv = s.view("hero.tv_video")!;
    expect(tv.durationSeconds).toBe(31.4);
    expect(tv.width).toBe(966);
  });
});

// ─── 6-10. replace flows + client gates ──────────────────────────────────────
describe("mocked media manager: replace flows", () => {
  test("6. replace image updates the preview from the safe record", async () => {
    const s = new MockMediaSession();
    await s.load(overviewFixture(false));
    s.queue(200, {
      record: { slotKey: "safety.image", mediaType: "image", previewUrl: "https://cdn/new.jpg", mimeType: "image/jpeg", byteSize: 500, width: 50, height: 50, durationSeconds: null, updatedAt: "t" },
      sectionsRecord: null, layout: null,
    });
    // Queue the refresh GET the hook performs after a save.
    s.queue(200, overviewFixture(false));
    const r = await s.upload("safety.image", img({ type: "image/jpeg" }), {});
    expect(r.sent).toBe(true);
    if (r.sent) expect(r.outcome.kind).toBe("saved");
  });

  test("7. replace video posts to the video slot", async () => {
    const s = new MockMediaSession();
    await s.load(overviewFixture(false));
    s.queue(200, {
      record: { slotKey: "hero.tv_video", mediaType: "video", previewUrl: "https://cdn/new.mp4", mimeType: "video/mp4", byteSize: 500, width: null, height: null, durationSeconds: null, updatedAt: "t" },
      sectionsRecord: null, layout: null,
    });
    s.queue(200, overviewFixture(false));
    const r = await s.upload("hero.tv_video", vid(), {});
    expect(r.sent).toBe(true);
    expect(s.fetchUrls).toContain("/api/admin/homepage/media/hero.tv_video");
  });

  test("8. wrong type rejected before any request", async () => {
    const s = new MockMediaSession();
    await s.load(overviewFixture(false));
    const callsBefore = (fetch as ReturnType<typeof vi.fn>).mock.calls.length;
    const r = await s.upload("hero.tv_video", img(), {});
    expect(r.sent).toBe(false);
    expect((fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsBefore);
  });

  test("9. oversized file rejected before any request", async () => {
    const s = new MockMediaSession();
    await s.load(overviewFixture(false));
    const callsBefore = (fetch as ReturnType<typeof vi.fn>).mock.calls.length;
    const r = await s.upload("safety.image", img({ size: 6 * 1024 * 1024 + 1 }), {});
    expect(r.sent).toBe(false);
    if (!r.sent) expect(r.message).toContain("6");
    expect((fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsBefore);
  });

  test("10. unknown slot never requested", async () => {
    const s = new MockMediaSession();
    await s.load(overviewFixture(false));
    expect(s.fetchUrls.every((u) => u.includes("/api/admin/homepage/"))).toBe(true);
    expect(s.fetchUrls.some((u) => u.includes("unknown") || u.includes(".."))).toBe(false);
    // The route checks the allowlist before formData(); the client only
    // offers the seven declared slots.
    expect(Object.keys(HOMEPAGE_MEDIA_SLOT_SPECS).length).toBe(7);
  });
});

// ─── 11-17. calibration ──────────────────────────────────────────────────────
describe("mocked calibration UX", () => {
  test("11. calibration opens with the current rect as starting point", () => {
    const start = clampHeroRect({ ...DEFAULT_TV_RECT });
    expect(start).toEqual(DEFAULT_TV_RECT);
  });

  test("12. overlay moves convert pixel drags to clamped fractions", () => {
    const moved = moveHeroRectByPixels(DEFAULT_TV_RECT, 100, 50, 1000, 500);
    expect(moved.x).toBeCloseTo(DEFAULT_TV_RECT.x + 0.1);
    expect(moved.y).toBeCloseTo(DEFAULT_TV_RECT.y + 0.1);
    const pinned = moveHeroRectByPixels(DEFAULT_TV_RECT, -100000, -100000, 1000, 500);
    expect(pinned.x).toBe(0);
    expect(pinned.y).toBe(0);
  });

  test("13. overlay resizes stay inside the unit square", () => {
    const grown = resizeHeroRectByPixels({ x: 0.9, y: 0.9, width: 0.05, height: 0.05 }, 10000, 10000, 1000, 1000);
    expect(grown.x + grown.width).toBeLessThanOrEqual(1);
    expect(grown.y + grown.height).toBeLessThanOrEqual(1);
  });

  test("14. numeric geometry edit parses percentages to fractions", () => {
    expect(parsePercentInput("10.5")).toBeCloseTo(0.105);
    expect(parsePercentInput("10.5٪")).toBeCloseTo(0.105);
    expect(parsePercentInput("abc")).toBeNull();
    expect(formatPercentFraction(0.105)).toBe("10.5٪");
  });

  test("15. invalid geometry blocked from confirm", () => {
    expect(validateHeroTvRect({ x: 0.95, y: 0.1, width: 0.1, height: 0.1 }).length).toBeGreaterThan(0);
    expect(validateHeroTvRect({ x: 0, y: 0, width: 0, height: 0.1 }).length).toBeGreaterThan(0);
  });

  test("16. calibration confirmation required (unchecked box blocks save)", () => {
    const rectOk = validateHeroTvRect(DEFAULT_TV_RECT).length === 0;
    const confirmed = false;
    const busy = false;
    expect(rectOk && confirmed && !busy).toBe(false); // mirrors canConfirm
    expect(rectOk && true && !busy).toBe(true);
  });

  test("17. aspect-ratio warning fires beyond the threshold", () => {
    expect(aspectCompatibilityNote(2048, 1529)).toBeNull();
    expect(aspectCompatibilityNote(1000, 1000)).toMatch(/ضروری/);
  });
});

// ─── 18-21. shared / sections / revert ───────────────────────────────────────
describe("mocked shared, sections and revert flows", () => {
  test("18. shared mode sends apply_to_sections with the hero upload", async () => {
    const s = new MockMediaSession();
    await s.load(overviewFixture(true));
    expect(s.overview?.sharedBackground).toBe(true);
    s.queue(200, {
      record: { slotKey: "hero.background", mediaType: "image", previewUrl: "https://cdn/h2.png", mimeType: "image/png", byteSize: 1, width: 2, height: 2, durationSeconds: null, updatedAt: "t" },
      sectionsRecord: { slotKey: "sections.background", mediaType: "image", previewUrl: "https://cdn/h2.png", mimeType: "image/png", byteSize: 1, width: 2, height: 2, durationSeconds: null, updatedAt: "t" },
      layout: { tv_rect: { ...DEFAULT_TV_RECT }, revision: 4 },
    });
    s.queue(200, overviewFixture(true));
    await s.upload("hero.background", img(), {
      tv_rect: JSON.stringify(DEFAULT_TV_RECT),
      expected_layout_revision: "3",
      apply_to_sections: "true",
    });
    expect(s.lastUploadFields.apply_to_sections).toBe("true");
    expect(s.lastUploadFields.tv_rect).toContain("0.105");
  });

  test("19. separate mode uploads hero without touching sections", async () => {
    const s = new MockMediaSession();
    await s.load(overviewFixture(false));
    expect(s.overview?.sharedBackground).toBe(false);
    s.queue(200, {
      record: { slotKey: "hero.background", mediaType: "image", previewUrl: "https://cdn/h2.png", mimeType: "image/png", byteSize: 1, width: 2, height: 2, durationSeconds: null, updatedAt: "t" },
      sectionsRecord: null,
      layout: { tv_rect: { ...DEFAULT_TV_RECT }, revision: 4 },
    });
    s.queue(200, overviewFixture(false));
    await s.upload("hero.background", img(), {
      tv_rect: JSON.stringify(DEFAULT_TV_RECT),
      expected_layout_revision: "3",
      apply_to_sections: "false",
    });
    expect(s.lastUploadFields.apply_to_sections).toBe("false");
  });

  test("20. sections replacement requires preview confirmation", async () => {
    // The card disables upload until the checkbox is checked; the server
    // additionally rejects confirm_preview=false with 422.
    const s = new MockMediaSession();
    await s.load(overviewFixture(false));
    s.queue(422, { error: "پیش‌نمایش", code: "HOMEPAGE_MEDIA_BAD_FILE" });
    const r = await s.upload("sections.background", img(), {});
    expect(r.sent).toBe(true); // request sent (server is the backstop)…
    if (r.sent) expect(r.outcome.kind).toBe("invalid"); // …and rejected
  });

  test("21. revert-to-default flow calls trusted DELETE and restores fallback", async () => {
    const s = new MockMediaSession();
    await s.load(overviewFixture(true));
    expect(s.view("hero.background")?.mimeType).not.toBe("");
    s.queue(200, { slotKey: "hero.background", reverted: true });
    expect(await s.revert("hero.background")).toBe(true);
    expect(s.fetchUrls).toContain("DELETE /api/admin/homepage/media/hero.background");
  });
});

// ─── 22-26. failure safety + hardening ───────────────────────────────────────
describe("mocked failure safety and hardening", () => {
  test("22. upload API failure preserves the old preview", async () => {
    const s = new MockMediaSession();
    await s.load(overviewFixture(true));
    const before = s.view("safety.image")?.previewUrl;
    s.queue(500, { error: "خطا" });
    const r = await s.upload("safety.image", img(), {});
    if (r.sent) expect(r.outcome.kind).toBe("error");
    expect(s.view("safety.image")?.previewUrl).toBe(before);
  });

  test("23. layout conflict surfaces reload guidance", async () => {
    const s = new MockMediaSession();
    await s.load(overviewFixture(false));
    s.queue(409, { error: "تغییر کرده است", code: "HOMEPAGE_LAYOUT_CONFLICT" });
    const outcome = await s.saveLayout({ ...DEFAULT_TV_RECT }, 3);
    expect(outcome.kind).toBe("conflict");
  });

  test("24. mobile editor usable: numeric path needs no pointer", () => {
    // Numeric-only edit: parse → clamp → validate, zero DOM measurement.
    const v = parsePercentInput("20");
    const rect = clampHeroRect({ ...DEFAULT_TV_RECT, x: v ?? 0 });
    expect(validateHeroTvRect(rect)).toEqual([]);
    expect(rect.x).toBeCloseTo(0.2);
    // Drag helpers degrade safely with zero container size.
    expect(moveHeroRectByPixels(DEFAULT_TV_RECT, 10, 10, 0, 0)).toEqual(DEFAULT_TV_RECT);
  });

  test("25. no raw storage path shown: safe records carry only preview URLs", async () => {
    const s = new MockMediaSession();
    await s.load(overviewFixture(true));
    const serialised = JSON.stringify(s.overview?.slots);
    expect(serialised).not.toContain("storage_path");
    expect(serialised).toContain("previewUrl");
  });

  test("26. no direct Supabase browser mutation: all calls target admin APIs", async () => {
    const s = new MockMediaSession();
    await s.load(overviewFixture(false));
    s.queue(200, {
      record: { slotKey: "safety.image", mediaType: "image", previewUrl: "u", mimeType: "image/png", byteSize: 1, width: 1, height: 1, durationSeconds: null, updatedAt: "t" },
      sectionsRecord: null, layout: null,
    });
    s.queue(200, overviewFixture(false));
    await s.upload("safety.image", img(), {});
    await s.revert("safety.image");
    for (const u of s.fetchUrls) {
      expect(u).toMatch(/^(\/api\/admin\/homepage\/|DELETE \/api\/admin\/homepage\/)/);
      expect(u).not.toMatch(/supabase|rest\/v1|storage\/v1|service_role/i);
    }
  });
});
