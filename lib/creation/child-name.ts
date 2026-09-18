/**
 * Rules for the optional child name on the creation forms.
 *
 * Shared by the two client forms, the draft parser and the submission path so
 * a name that the form accepted cannot later be rejected — or silently
 * reshaped — by the server. The module is deliberately free of Node-only
 * imports so Client Components run the exact same rules the API does, the same
 * arrangement `lib/auth/phone.ts` uses for phone numbers.
 *
 * The name is optional everywhere. "Absent" and "invalid" are different
 * answers: an empty field is a valid, complete form, while a field that has
 * been filled in with something unusable is reported to the parent.
 */

/** Matches the CHECK constraint on public.orders.child_name. */
export const CHILD_NAME_MAX_LENGTH = 60;

export const CHILD_NAME_LABEL = "نام کودک";
export const CHILD_NAME_PLACEHOLDER = "مثلاً: آریا";

export const CHILD_NAME_TOO_LONG_MESSAGE = `نام کودک نباید بیشتر از ${CHILD_NAME_MAX_LENGTH} کاراکتر باشد.`;
export const CHILD_NAME_INVALID_MESSAGE =
  "نام کودک را با حروف وارد کنید.";

/**
 * Collapse a raw field value to what would be stored.
 *
 * Trims the ends and squeezes runs of inner whitespace, so "آریا  " and
 * " آریا" are the same name rather than three different ones. Returns null for
 * anything that holds no characters — that is the shape the draft, the API and
 * the column all use for "no name given".
 */
export function normalizeChildName(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const collapsed = raw.trim().replace(/\s+/g, " ");
  return collapsed.length > 0 ? collapsed : null;
}

/**
 * Whether a non-empty name is usable.
 *
 * Only two things are rejected: a name longer than the column allows, and one
 * that contains no letter at all. The second rules out "12345" and "..." while
 * leaving every real name alone — Persian, Arabic-script, Latin, hyphenated,
 * or a name that happens to contain a digit. `\p{L}` is deliberately broader
 * than an allow-list of alphabets: guessing which scripts a family's name may
 * use is exactly the kind of rule that rejects real children.
 */
export function isValidChildName(name: string): boolean {
  if (typeof name !== "string") return false;
  const normalized = normalizeChildName(name);
  if (normalized === null) return false;
  if (normalized.length > CHILD_NAME_MAX_LENGTH) return false;
  return /\p{L}/u.test(normalized);
}

export type ChildNameCheck =
  | { ok: true; value: string | null }
  | { ok: false; message: string };

/**
 * One call for a form to use: normalize, then accept absence or validate.
 *
 * `{ ok: true, value: null }` means the parent left the field empty, which is
 * a complete answer and must not be reported as an error.
 */
export function checkChildName(raw: string | null | undefined): ChildNameCheck {
  const normalized = normalizeChildName(raw);
  if (normalized === null) return { ok: true, value: null };
  if (normalized.length > CHILD_NAME_MAX_LENGTH) {
    return { ok: false, message: CHILD_NAME_TOO_LONG_MESSAGE };
  }
  if (!/\p{L}/u.test(normalized)) {
    return { ok: false, message: CHILD_NAME_INVALID_MESSAGE };
  }
  return { ok: true, value: normalized };
}
