import { describe, test, expect } from "vitest";

import { DEFAULT_HOMEPAGE_CONTENT } from "@/lib/homepage/default-content";
import { validateHomepageContent } from "@/lib/homepage/validation";
import type { HomepageContent } from "@/lib/homepage/types";
import { mapAdminHomepageRpcError } from "@/lib/admin/homepage/errors";
import { parseAdminHomepagePutBody } from "@/lib/admin/homepage/put-validation";
import {
  applyConflictSnapshot,
  cloneHomepageContent,
  interpretHomepageSaveResponse,
  isHomepageDirty,
  toFieldErrorMap,
} from "@/lib/admin/homepage/editor-state";

/** Deep clone so each test mutates an isolated copy of the defaults. */
function draft(): HomepageContent {
  return JSON.parse(JSON.stringify(DEFAULT_HOMEPAGE_CONTENT)) as HomepageContent;
}

// ─── 1. PUT body parsing ─────────────────────────────────────────────────────

describe("admin homepage PUT body parsing", () => {
  test("accepts valid content with an integer revision", () => {
    const parsed = parseAdminHomepagePutBody({ content: draft(), expectedRevision: 3 });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.expectedRevision).toBe(3);
      expect(parsed.content).toEqual(DEFAULT_HOMEPAGE_CONTENT);
    }
  });

  test("rejects non-object bodies", () => {
    for (const body of [null, undefined, 42, "text", [], true]) {
      const parsed = parseAdminHomepagePutBody(body);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.status).toBe(400);
    }
  });

  test("rejects missing, fractional, zero or negative revisions", () => {
    for (const expectedRevision of [undefined, null, "3", 1.5, 0, -2, NaN]) {
      const parsed = parseAdminHomepagePutBody({ content: draft(), expectedRevision });
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.status).toBe(400);
    }
  });

  test("rejects contract-violating content with per-field errors", () => {
    const bad = draft();
    bad.hero.primaryCta.href = "javascript:alert(1)";
    bad.hero.title = "";
    const parsed = parseAdminHomepagePutBody({ content: bad, expectedRevision: 1 });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.status).toBe(422);
      expect(parsed.code).toBe("HOMEPAGE_INVALID");
      const fields = (parsed.errors ?? []).map((e) => e.field);
      expect(fields).toContain("hero.primaryCta.href");
      expect(fields).toContain("hero.title");
    }
  });

  test("rejects a payload missing a whole section", () => {
    const bad = draft() as unknown as Record<string, unknown>;
    delete bad.pricing;
    const parsed = parseAdminHomepagePutBody({ content: bad, expectedRevision: 1 });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.status).toBe(422);
  });
});

// ─── 2. RPC error mapping ────────────────────────────────────────────────────

describe("admin homepage RPC error mapping", () => {
  test("maps conflict to a 409 with reload guidance", () => {
    const mapped = mapAdminHomepageRpcError("homepage_admin_conflict");
    expect(mapped.code).toBe("HOMEPAGE_CONFLICT");
    expect(mapped.status).toBe(409);
    expect(mapped.message.length).toBeGreaterThan(0);
  });

  test("maps forbidden / not-found / invalid", () => {
    expect(mapAdminHomepageRpcError("homepage_admin_forbidden").status).toBe(403);
    expect(mapAdminHomepageRpcError("homepage_admin_not_found").status).toBe(404);
    expect(mapAdminHomepageRpcError("homepage_admin_invalid").status).toBe(422);
  });

  test("never leaks raw database strings", () => {
    const secret = "SECRET-DB-DETAIL-DO-NOT-LEAK";
    for (const input of [`relation "x" does not exist: ${secret}`, secret, null, undefined, 42]) {
      const mapped = mapAdminHomepageRpcError(input);
      expect(JSON.stringify(mapped)).not.toContain(secret);
      if (input === secret || typeof input !== "string" || !input.startsWith("homepage_admin_")) {
        // Unknown codes collapse to the generic 500.
        if (!["homepage_admin_forbidden", "homepage_admin_not_found", "homepage_admin_conflict", "homepage_admin_invalid"].includes(String(input))) {
          expect(mapped.status).toBe(500);
          expect(mapped.code).toBe("HOMEPAGE_UNKNOWN_ERROR");
        }
      }
    }
  });
});

// ─── 3. editor state helpers ─────────────────────────────────────────────────

describe("admin homepage editor state", () => {
  test("clone is deep and isolated", () => {
    const a = draft();
    const b = cloneHomepageContent(a);
    expect(b).toEqual(a);
    b.hero.title = "CHANGED";
    b.testimonials.items[0].quote = "CHANGED";
    expect(a.hero.title).not.toBe("CHANGED");
    expect(a.testimonials.items[0].quote).not.toBe("CHANGED");
  });

  test("dirty tracking flips on edit and back on revert", () => {
    const baseline = draft();
    const edited = cloneHomepageContent(baseline);
    expect(isHomepageDirty(edited, baseline)).toBe(false);
    edited.finalCta.title = "عنوان جدید";
    expect(isHomepageDirty(edited, baseline)).toBe(true);
    edited.finalCta.title = baseline.finalCta.title;
    expect(isHomepageDirty(edited, baseline)).toBe(false);
  });

  test("nested collection edits mark the draft dirty", () => {
    const baseline = draft();
    const edited = cloneHomepageContent(baseline);
    edited.testimonials.items.push({ id: "new-one", quote: "نقل‌قول", name: "نام", role: "نقش" });
    expect(isHomepageDirty(edited, baseline)).toBe(true);
  });

  test("field error map keeps the first message per field", () => {
    const bad = draft();
    bad.hero.title = "";
    bad.hero.description = "<b>html</b>";
    const result = validateHomepageContent(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const map = toFieldErrorMap(result.errors);
      expect(typeof map["hero.title"]).toBe("string");
      expect(typeof map["hero.description"]).toBe("string");
    }
  });

  test("empty error list maps to an empty map", () => {
    expect(toFieldErrorMap([])).toEqual({});
  });
});

// ─── 4. save-response interpretation ─────────────────────────────────────────

describe("admin homepage save-response interpretation", () => {
  test("200 with content+revision is a save", () => {
    const content = draft();
    const outcome = interpretHomepageSaveResponse(200, { content, revision: 8 });
    expect(outcome).toEqual({ kind: "saved", content, revision: 8 });
  });

  test("200 with a malformed body is an error, never a silent save", () => {
    for (const body of [{}, { content: draft() }, { revision: 8 }, null]) {
      expect(interpretHomepageSaveResponse(200, body as never).kind).toBe("error");
    }
  });

  test("409 with a snapshot is a conflict with reload data", () => {
    const content = draft();
    const outcome = interpretHomepageSaveResponse(409, {
      error: "تغییر کرده است",
      code: "HOMEPAGE_CONFLICT",
      content,
      revision: 9,
    });
    expect(outcome.kind).toBe("conflict");
    if (outcome.kind === "conflict") {
      expect(outcome.revision).toBe(9);
      expect(outcome.content).toEqual(content);
    }
  });

  test("409 without a snapshot degrades to a plain error", () => {
    expect(interpretHomepageSaveResponse(409, { error: "conflict" }).kind).toBe("error");
  });

  test("422 surfaces field errors for inline display", () => {
    const errors = [{ field: "hero.title", message: "Must not be empty" }];
    const outcome = interpretHomepageSaveResponse(422, { error: "نامعتبر", errors });
    expect(outcome.kind).toBe("invalid");
    if (outcome.kind === "invalid") expect(outcome.errors).toEqual(errors);
  });

  test("422 without an error list still reports invalid, not a crash", () => {
    const outcome = interpretHomepageSaveResponse(422, {});
    expect(outcome.kind).toBe("invalid");
    if (outcome.kind === "invalid") expect(outcome.errors).toEqual([]);
  });

  test("5xx and unknown statuses are generic errors carrying the server message", () => {
    for (const status of [400, 401, 403, 404, 500]) {
      const outcome = interpretHomepageSaveResponse(status, { error: "پیام سرور" });
      expect(outcome.kind).toBe("error");
      if (outcome.kind === "error") expect(outcome.message).toBe("پیام سرور");
    }
  });

  test("applying a conflict snapshot resets dirty state", () => {
    const server = draft();
    server.hero.title = "نسخه سرور";
    const { draft: d, baseline } = applyConflictSnapshot(server);
    expect(d).toEqual(server);
    expect(isHomepageDirty(d, baseline)).toBe(false);
    // Mutating the applied draft must not touch the baseline.
    d.hero.title = "تغییر من";
    expect(isHomepageDirty(d, baseline)).toBe(true);
    expect(baseline.hero.title).toBe("نسخه سرور");
  });
});
