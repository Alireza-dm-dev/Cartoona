/**
 * Admin homepage read path: normalization before validation.
 *
 * Regression cover for the Phase 4B production defect. The seeded row predates
 * the `navigation` section, and the admin read validated it raw — so the editor
 * opened in degraded mode with `revision: null` and save disabled. That is a
 * deadlock: only a save can add `navigation`, and the missing `navigation` is
 * what disables save.
 *
 * These tests drive the real `queryAdminHomepageContent` against a fake client,
 * so they exercise the actual admin code path rather than restating it.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import { queryAdminHomepageContent } from "@/lib/admin/homepage/service";
import { DEFAULT_HOMEPAGE_CONTENT } from "@/lib/homepage/default-content";

/** Minimal client stub shaped like the one query the admin read performs. */
function fakeClient(result: { data: unknown; error?: unknown }): SupabaseClient {
  const chain = {
    select: () => chain,
    eq: () => chain,
    maybeSingle: async () => result,
  };
  return { from: () => chain } as unknown as SupabaseClient;
}

/** The production seed shape: every section except `navigation`. */
function seededRowWithoutNavigation() {
  const content = { ...DEFAULT_HOMEPAGE_CONTENT } as Record<string, unknown>;
  delete content.navigation;
  return { content_json: content, revision: 1 };
}

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
});

describe("admin read: row missing only the newer navigation section", () => {
  it("resolves database content instead of degrading to defaults", async () => {
    const res = await queryAdminHomepageContent(fakeClient({ data: seededRowWithoutNavigation() }));

    expect(res.source).toBe("database");
    expect(res.isDefault).toBe(false);
  });

  it("keeps the real stored revision so save stays enabled", async () => {
    const res = await queryAdminHomepageContent(fakeClient({ data: seededRowWithoutNavigation() }));

    // `revision: null` is what disabled save in production.
    expect(res.revision).toBe(1);
    expect(res.revision).not.toBeNull();
    // The PUT route refuses expectedRevision < 1; this must clear that bar.
    expect(res.revision as number).toBeGreaterThanOrEqual(1);
  });

  it("supplies normalized navigation defaults", async () => {
    const res = await queryAdminHomepageContent(fakeClient({ data: seededRowWithoutNavigation() }));

    expect(res.content.navigation).toBeDefined();
    expect(res.content.navigation.signupLabel).toBe("شروع کنید");
    expect(res.content.navigation.pricingLabel).toBe("قیمت‌گذاری");
    expect(res.content.navigation.faqLabel).toBe("سوالات متداول");
  });

  it("preserves the stored content of every other section", async () => {
    const row = seededRowWithoutNavigation();
    (row.content_json as Record<string, unknown>).hero = {
      ...DEFAULT_HOMEPAGE_CONTENT.hero,
      eyebrow: "متن ذخیره‌شده",
    };

    const res = await queryAdminHomepageContent(fakeClient({ data: row }));

    expect(res.content.hero.eyebrow).toBe("متن ذخیره‌شده");
    expect(res.source).toBe("database");
  });

  it("does not mutate the row it read", async () => {
    const row = seededRowWithoutNavigation();
    const before = JSON.parse(JSON.stringify(row.content_json));

    await queryAdminHomepageContent(fakeClient({ data: row }));

    expect(row.content_json).toEqual(before);
    expect((row.content_json as Record<string, unknown>).navigation).toBeUndefined();
  });

  it("logs nothing for a merely-older row", async () => {
    await queryAdminHomepageContent(fakeClient({ data: seededRowWithoutNavigation() }));
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("admin read: normalization does not paper over real corruption", () => {
  it("still degrades when an existing section is malformed", async () => {
    const content = { ...DEFAULT_HOMEPAGE_CONTENT, pricing: "not-an-object" };
    const res = await queryAdminHomepageContent(
      fakeClient({ data: { content_json: content, revision: 4 } }),
    );

    expect(res.source).toBe("default");
    expect(res.isDefault).toBe(true);
    expect(res.revision).toBeNull();
    expect(res.content).toEqual(DEFAULT_HOMEPAGE_CONTENT);
  });

  it("still degrades when a required section is absent entirely", async () => {
    const content = { ...DEFAULT_HOMEPAGE_CONTENT } as Record<string, unknown>;
    delete content.hero;
    const res = await queryAdminHomepageContent(
      fakeClient({ data: { content_json: content, revision: 2 } }),
    );

    expect(res.source).toBe("default");
    expect(res.revision).toBeNull();
  });

  it("logs field paths only - never stored values - when content is invalid", async () => {
    const content = { ...DEFAULT_HOMEPAGE_CONTENT, pricing: "not-an-object" };
    await queryAdminHomepageContent(fakeClient({ data: { content_json: content, revision: 4 } }));

    expect(warn).toHaveBeenCalledOnce();
    const [message, detail] = warn.mock.calls[0] as [string, { fields: string[] }];
    expect(message).toContain("failed validation");
    expect(detail.fields.some((f) => f.startsWith("pricing"))).toBe(true);

    const serialized = JSON.stringify(warn.mock.calls[0]);
    expect(serialized).not.toContain("not-an-object");
    expect(serialized).not.toContain(DEFAULT_HOMEPAGE_CONTENT.hero.title);
  });
});

describe("admin read: absent row and failed read still degrade", () => {
  it("returns defaults when the row is missing", async () => {
    const res = await queryAdminHomepageContent(fakeClient({ data: null }));

    expect(res.source).toBe("default");
    expect(res.isDefault).toBe(true);
    expect(res.revision).toBeNull();
    expect(res.content).toEqual(DEFAULT_HOMEPAGE_CONTENT);
  });

  it("returns defaults when the table is absent", async () => {
    const res = await queryAdminHomepageContent(
      fakeClient({ data: null, error: { code: "42P01", message: "relation does not exist" } }),
    );

    expect(res.source).toBe("default");
    expect(res.revision).toBeNull();
  });

  it("returns defaults when the read throws", async () => {
    const throwing = {
      from: () => {
        throw new Error("transport failure");
      },
    } as unknown as SupabaseClient;

    const res = await queryAdminHomepageContent(throwing);

    expect(res.source).toBe("default");
    expect(res.revision).toBeNull();
  });

  it("degrades when revision is not a number", async () => {
    const row = seededRowWithoutNavigation();
    const res = await queryAdminHomepageContent(
      fakeClient({ data: { ...row, revision: "1" } }),
    );

    // Content is valid, but a non-numeric revision cannot gate a safe write.
    expect(res.revision).toBeNull();
  });
});
