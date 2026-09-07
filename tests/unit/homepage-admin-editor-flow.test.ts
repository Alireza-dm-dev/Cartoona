import { describe, test, expect, vi, beforeEach } from "vitest";

import { DEFAULT_HOMEPAGE_CONTENT } from "@/lib/homepage/default-content";
import { validateHomepageContent } from "@/lib/homepage/validation";
import type { HomepageContent } from "@/lib/homepage/types";
import {
  applyConflictSnapshot,
  cloneHomepageContent,
  interpretHomepageSaveResponse,
  isHomepageDirty,
  toFieldErrorMap,
} from "@/lib/admin/homepage/editor-state";

/**
 * Mocked UI tests for the admin homepage editor.
 *
 * No React, no database: a minimal harness mirrors the exact state machine
 * in components/admin/homepage/homepage-editor.tsx (draft / baseline /
 * revision / conflict / message + the same helpers), with `fetch` mocked per
 * scenario. Each test drives a full user-visible flow: load → edit → save →
 * conflict → reload, asserting what the UI would show at every step.
 */

function draft(): HomepageContent {
  return JSON.parse(JSON.stringify(DEFAULT_HOMEPAGE_CONTENT)) as HomepageContent;
}

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

/** Mirrors the editor component's state and transitions. */
class MockEditorSession {
  draft: HomepageContent;
  baseline: HomepageContent;
  revision: number | null;
  saving = false;
  message: { kind: "success" | "error"; text: string } | null = null;
  conflict: { content: HomepageContent; revision: number } | null = null;
  savedRequests: unknown[] = [];

  constructor(initial: HomepageContent, revision: number | null) {
    this.draft = cloneHomepageContent(initial);
    this.baseline = cloneHomepageContent(initial);
    this.revision = revision;
  }

  get tablesAvailable() {
    return this.revision !== null;
  }

  get dirty() {
    return isHomepageDirty(this.draft, this.baseline);
  }

  get fieldErrors() {
    const result = validateHomepageContent(this.draft);
    return result.ok ? {} : toFieldErrorMap(result.errors);
  }

  get canSave() {
    return (
      this.tablesAvailable &&
      this.dirty &&
      !this.saving &&
      Object.keys(this.fieldErrors).length === 0
    );
  }

  edit(mutator: (d: HomepageContent) => void) {
    mutator(this.draft);
    this.message = null;
  }

  async save() {
    if (!this.canSave) return;
    this.saving = true;
    this.message = null;
    try {
      const res = await fetch("/api/admin/homepage", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: this.draft, expectedRevision: this.revision }),
      });
      this.savedRequests.push(JSON.parse((global.fetch as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1]?.body ?? "{}"));
      const outcome = interpretHomepageSaveResponse(res.status, await res.json().catch(() => ({})));
      if (outcome.kind === "saved") {
        const fresh = cloneHomepageContent(outcome.content);
        this.draft = fresh;
        this.baseline = cloneHomepageContent(fresh);
        this.revision = outcome.revision;
        this.conflict = null;
        this.message = { kind: "success", text: `saved rev ${outcome.revision}` };
      } else if (outcome.kind === "conflict") {
        this.conflict = { content: outcome.content, revision: outcome.revision };
        this.message = { kind: "error", text: outcome.message };
      } else {
        this.message = { kind: "error", text: outcome.message };
      }
    } catch {
      this.message = { kind: "error", text: "network" };
    } finally {
      this.saving = false;
    }
  }

  reset() {
    this.draft = cloneHomepageContent(this.baseline);
    this.conflict = null;
    this.message = null;
  }

  reloadConflict() {
    if (!this.conflict) return;
    const applied = applyConflictSnapshot(this.conflict.content);
    this.draft = applied.draft;
    this.baseline = applied.baseline;
    this.revision = this.conflict.revision;
    this.conflict = null;
    this.message = { kind: "success", text: `reloaded rev ${this.revision}` };
  }
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});

function mockFetchOnce(status: number, body: unknown) {
  (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(jsonResponse(status, body));
}

// ─── flows ───────────────────────────────────────────────────────────────────

describe("mocked editor: happy-path save", () => {
  test("load → edit → save clears dirty and bumps revision", async () => {
    const session = new MockEditorSession(draft(), 4);
    expect(session.dirty).toBe(false);
    expect(session.canSave).toBe(false); // pristine: save disabled

    session.edit((d) => {
      d.hero.title = "عنوان تازه";
    });
    expect(session.dirty).toBe(true);
    expect(session.canSave).toBe(true);

    const saved = cloneHomepageContent(session.draft);
    mockFetchOnce(200, { content: saved, revision: 5, updatedAt: new Date().toISOString() });
    await session.save();

    expect(session.message?.kind).toBe("success");
    expect(session.revision).toBe(5);
    expect(session.dirty).toBe(false);
    expect(session.canSave).toBe(false);

    // The request carried the draft plus the revision it was loaded at.
    const sent = session.savedRequests[0] as { content: HomepageContent; expectedRevision: number };
    expect(sent.expectedRevision).toBe(4);
    expect(sent.content.hero.title).toBe("عنوان تازه");
  });
});

describe("mocked editor: inline validation blocks save", () => {
  test("script href disables save and surfaces the field error", async () => {
    const session = new MockEditorSession(draft(), 4);
    session.edit((d) => {
      d.hero.primaryCta.href = "javascript:alert(1)";
    });

    expect(session.fieldErrors["hero.primaryCta.href"]).toBeDefined();
    expect(session.canSave).toBe(false);

    await session.save(); // must not fire any request
    expect((fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
    expect(session.dirty).toBe(true); // edit preserved for correction
  });

  test("server-side 422 replaces local errors with the server list", async () => {
    const session = new MockEditorSession(draft(), 4);
    session.edit((d) => {
      d.hero.title = "معتبر در سمت کاربر";
    });
    mockFetchOnce(422, {
      error: "نامعتبر",
      code: "HOMEPAGE_INVALID",
      errors: [{ field: "hero.title", message: "Must not be empty" }],
    });
    await session.save();

    expect(session.message?.kind).toBe("error");
    expect(session.dirty).toBe(true); // nothing lost
    expect(session.revision).toBe(4);
  });
});

describe("mocked editor: conflict and reload", () => {
  test("409 shows the conflict banner; reload adopts the server snapshot", async () => {
    const session = new MockEditorSession(draft(), 4);
    session.edit((d) => {
      d.finalCta.title = "پیش‌نویس من";
    });

    const server = draft();
    server.finalCta.title = "نسخه مدیر دیگر";
    mockFetchOnce(409, {
      error: "تغییر کرده است",
      code: "HOMEPAGE_CONFLICT",
      content: server,
      revision: 5,
    });
    await session.save();

    // Conflict banner state, local edit untouched until the admin reloads.
    expect(session.conflict?.revision).toBe(5);
    expect(session.message?.kind).toBe("error");
    expect(session.draft.finalCta.title).toBe("پیش‌نویس من");

    session.reloadConflict();
    expect(session.draft.finalCta.title).toBe("نسخه مدیر دیگر");
    expect(session.revision).toBe(5);
    expect(session.dirty).toBe(false);
    expect(session.conflict).toBeNull();
  });
});

describe("mocked editor: reset and unavailable tables", () => {
  test("reset discards the draft back to the baseline", () => {
    const session = new MockEditorSession(draft(), 2);
    session.edit((d) => {
      d.safety.note = "یادداشت آزمایشی";
    });
    expect(session.dirty).toBe(true);
    session.reset();
    expect(session.dirty).toBe(false);
    expect(session.draft.safety.note).toBe(DEFAULT_HOMEPAGE_CONTENT.safety.note);
  });

  test("null revision (CMS tables absent) disables editing flow, shows defaults", async () => {
    const session = new MockEditorSession(draft(), null);
    expect(session.tablesAvailable).toBe(false);
    expect(session.draft).toEqual(DEFAULT_HOMEPAGE_CONTENT);

    session.edit((d) => {
      d.hero.title = "تلاش برای ویرایش";
    });
    expect(session.canSave).toBe(false);
    await session.save();
    expect((fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });

  test("network failure keeps the draft and reports an error", async () => {
    const session = new MockEditorSession(draft(), 4);
    session.edit((d) => {
      d.hero.title = "پیش‌نویس";
    });
    (fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("down"));
    await session.save();
    expect(session.message).toEqual({ kind: "error", text: "network" });
    expect(session.dirty).toBe(true);
    expect(session.saving).toBe(false);
  });
});
