/**
 * Rules for the parent's display name (`parent_profiles.full_name`), as
 * written by PATCH /v1/parent/profile (V0.1.47).
 *
 * Neutral module (no Node or server imports) so a future form can run the
 * exact rules the backend enforces. The backend validates independently of
 * any caller; nothing here trusts the browser.
 *
 * Same shape as lib/creation/child-name.ts:
 *  - NFC-normalized, ends trimmed, inner whitespace runs collapsed to one space;
 *  - null, "" or whitespace only -> null ("no name"; the column allows NULL and
 *    the UI falls back to "حساب والد"), never an empty string;
 *  - at most 60 characters after normalization;
 *  - at least one letter (\p{L}), so "12345" or "..." is not a name;
 *  - no control, format or private-use characters (\p{C}): no zero-width
 *    joiners smuggled in, no bidi overrides. (Tabs and line breaks are
 *    whitespace, so they collapse to a single space like any other run.)
 * Anything that is not a string or null is refused.
 */

export const PARENT_NAME_MAX_LENGTH = 60;

export type ParentNameCheck =
  | { ok: true; value: string | null }
  | { ok: false; reason: "invalid_type" | "too_long" | "no_letter" | "invalid_character" };

export function checkParentName(raw: unknown): ParentNameCheck {
  if (raw === null) return { ok: true, value: null };
  if (typeof raw !== "string") return { ok: false, reason: "invalid_type" };
  // Bound the work before normalizing an arbitrarily long value.
  if (raw.length > PARENT_NAME_MAX_LENGTH * 4) return { ok: false, reason: "too_long" };
  const normalized = raw.normalize("NFC").trim().replace(/\s+/g, " ");
  if (normalized.length === 0) return { ok: true, value: null };
  if (/\p{C}/u.test(normalized)) return { ok: false, reason: "invalid_character" };
  if (normalized.length > PARENT_NAME_MAX_LENGTH) return { ok: false, reason: "too_long" };
  if (!/\p{L}/u.test(normalized)) return { ok: false, reason: "no_letter" };
  return { ok: true, value: normalized };
}
