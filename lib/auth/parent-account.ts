import "server-only";

/**
 * What the public header is allowed to know about the signed-in parent.
 *
 * Deliberately tiny: a name to greet them by and initials to draw. No user id,
 * no email, no phone, no role string, no profile id — nothing that identifies
 * the session rather than the person, and nothing an onlooker could use.
 */
export interface ParentAccountSummary {
  displayName: string;
  initials: string;
}

/**
 * Initials for the avatar, derived from the parent's own name.
 *
 * Takes the first letter of the first two words, which reads correctly for
 * Persian names as well as Latin ones. Falls back to a neutral glyph rather
 * than rendering an empty circle, since `full_name` is NOT NULL but could
 * still be whitespace or punctuation.
 */
export function deriveInitials(fullName: string): string {
  const words = fullName
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0);

  const letters = words
    .slice(0, 2)
    .map((w) => Array.from(w)[0])
    // Skip anything that is not a letter or digit, so "«" or "-" never becomes
    // an initial.
    .filter((c) => c !== undefined && /[\p{L}\p{N}]/u.test(c));

  if (letters.length === 0) return "؟";
  return letters.join("");
}

/**
 * The header's summary from the parent's own profile name (V0.1.46: the name
 * comes from PostgreSQL through the backend; see public-header-account.ts).
 *
 * A parent without a profile row yet, or whose profile has no name, is still a
 * parent: greet them neutrally rather than hiding the account control.
 */
export function toParentAccountSummary(fullName: string | null): ParentAccountSummary {
  const name = typeof fullName === "string" ? fullName.trim() : "";
  const displayName = name.length > 0 ? name : "حساب والد";
  return { displayName, initials: deriveInitials(displayName) };
}
