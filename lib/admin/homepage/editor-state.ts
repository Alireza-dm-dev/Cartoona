import type { HomepageContent } from "@/lib/homepage/types";
import type { HomepageValidationError } from "@/lib/homepage/validation";

/**
 * Pure state helpers for the admin homepage editor. No IO, no React — the
 * client component owns rendering while every decision here is unit-tested
 * directly (including the mocked UI-flow tests).
 */

export function cloneHomepageContent(content: HomepageContent): HomepageContent {
  return JSON.parse(JSON.stringify(content)) as HomepageContent;
}

/** True when the draft differs from the last loaded/saved snapshot. */
export function isHomepageDirty(draft: HomepageContent, baseline: HomepageContent): boolean {
  return JSON.stringify(draft) !== JSON.stringify(baseline);
}

export type FieldErrorMap = Record<string, string>;

/** Collapses the validator's error list to first-message-per-field for inline display. */
export function toFieldErrorMap(errors: HomepageValidationError[]): FieldErrorMap {
  const map: FieldErrorMap = {};
  for (const e of errors) {
    if (!(e.field in map)) map[e.field] = e.message;
  }
  return map;
}

export type SaveOutcome =
  | { kind: "saved"; content: HomepageContent; revision: number }
  | { kind: "conflict"; content: HomepageContent; revision: number; message: string }
  | { kind: "invalid"; errors: HomepageValidationError[]; message: string }
  | { kind: "error"; message: string };

interface SaveResponseBody {
  content?: unknown;
  revision?: unknown;
  errors?: unknown;
  error?: unknown;
  code?: unknown;
}

/**
 * Interprets a PUT response for the editor. Pure: takes the HTTP status plus
 * the already-parsed JSON body and returns the state transition. Network
 * failures are handled by the caller (fetch threw → { kind: "error" }).
 */
export function interpretHomepageSaveResponse(status: number, body: SaveResponseBody): SaveOutcome {
  if (status === 200) {
    if (
      typeof body === "object" &&
      body !== null &&
      typeof body.revision === "number" &&
      typeof body.content === "object" &&
      body.content !== null
    ) {
      return {
        kind: "saved",
        content: body.content as HomepageContent,
        revision: body.revision,
      };
    }
    return { kind: "error", message: "پاسخ سرور نامعتبر است." };
  }

  if (status === 409) {
    const message = typeof body?.error === "string" ? body.error : "این صفحه توسط مدیر دیگری تغییر کرده است.";
    if (typeof body?.content === "object" && body.content !== null && typeof body?.revision === "number") {
      return {
        kind: "conflict",
        content: body.content as HomepageContent,
        revision: body.revision as number,
        message,
      };
    }
    return { kind: "error", message };
  }

  if (status === 422) {
    const message = typeof body?.error === "string" ? body.error : "محتوای ارسال‌شده معتبر نیست.";
    const errors = Array.isArray(body?.errors)
      ? (body.errors as HomepageValidationError[]).filter(
          (e) => typeof e?.field === "string" && typeof e?.message === "string",
        )
      : [];
    return { kind: "invalid", errors, message };
  }

  const message =
    typeof body?.error === "string" ? body.error : "ذخیره تغییرات انجام نشد.";
  return { kind: "error", message };
}

/**
 * Applies a conflict snapshot: the server content becomes both the new draft
 * and the new baseline (the admin re-applies their changes on top).
 */
export function applyConflictSnapshot(content: HomepageContent): {
  draft: HomepageContent;
  baseline: HomepageContent;
} {
  const fresh = cloneHomepageContent(content);
  return { draft: fresh, baseline: cloneHomepageContent(fresh) };
}
