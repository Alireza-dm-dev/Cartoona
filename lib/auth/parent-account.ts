import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { isParentRole } from "./parent-access";

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
 * The signed-in parent, or null for everyone else.
 *
 * Returns null for anonymous visitors, for admins, and for any account whose
 * role is not exactly `parent` — admin sessions are a separate area with their
 * own header, and must never be handed the parent account drawer. Failures are
 * treated as "not a parent" so a transient lookup error degrades to the
 * anonymous header rather than to a broken one.
 *
 * This is the only place the public site resolves a session. It runs on the
 * server, so the header is already correct in the first HTML the browser sees
 * and never flickers from logged-out to logged-in.
 */
export async function getParentAccountSummary(
  supabase: SupabaseClient,
): Promise<ParentAccountSummary | null> {
  let userId: string;
  try {
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser();
    if (error || !user) return null;
    userId = user.id;
  } catch {
    return null;
  }

  try {
    const { data: userRow, error: roleError } = await supabase
      .from("users")
      .select("role")
      .eq("id", userId)
      .maybeSingle();

    if (roleError || !userRow) return null;
    // Explicitly `parent`. An admin or super_admin falls through to null.
    if (!isParentRole(userRow.role)) return null;

    const { data: profile, error: profileError } = await supabase
      .from("parent_profiles")
      .select("full_name")
      .eq("user_id", userId)
      .maybeSingle();

    if (profileError) return null;

    const fullName =
      typeof profile?.full_name === "string" ? profile.full_name.trim() : "";
    // A parent without a profile row yet is still a parent: greet them
    // neutrally rather than hiding the account control.
    const displayName = fullName.length > 0 ? fullName : "حساب والد";

    return { displayName, initials: deriveInitials(displayName) };
  } catch {
    return null;
  }
}
