import { runQuery } from "@/lib/db/query";
import type { Queryable } from "@/lib/db/types";
import { requireUuid } from "./actor";

const SELECT_PROFILE_ID = `
  SELECT p.id
  FROM public.parent_profiles p
  WHERE p.user_id = $1`;

/**
 * The parent profile id owned by a user - the `P` every parent-scoped
 * repository takes. Replaces `parent_profiles.select("id").eq("user_id", U)`
 * from ParentRequestContext. Null when the user has no profile (`user_id` is
 * unique, so there is at most one).
 */
export async function findParentProfileIdByUserId(
  db: Queryable,
  input: { userId: string },
): Promise<string | null> {
  const userId = requireUuid(input.userId, "userId");
  const rows = await runQuery<{ id: string }>(db, SELECT_PROFILE_ID, [userId]);
  return rows[0]?.id ?? null;
}

const SELECT_DISPLAY = `
  SELECT p.full_name
  FROM public.parent_profiles p
  WHERE p.user_id = $1`;

/**
 * What the parent UI shows of a user's own profile (V0.1.46): the name only.
 * Null when the user has no profile; `fullName` is null when the profile has
 * no name. No id, consent, referral code or timestamp leaves this function.
 */
export async function getParentProfileDisplay(
  db: Queryable,
  input: { userId: string },
): Promise<{ fullName: string | null } | null> {
  const userId = requireUuid(input.userId, "userId");
  const rows = await runQuery<{ full_name: string | null }>(db, SELECT_DISPLAY, [userId]);
  const row = rows[0];
  if (!row) return null;
  return { fullName: typeof row.full_name === "string" ? row.full_name : null };
}

const UPDATE_NAME = `
  UPDATE public.parent_profiles
  SET full_name = $2, updated_at = now()
  WHERE user_id = $1
  RETURNING full_name`;

/**
 * The first application WRITE on plain PostgreSQL (V0.1.47): set the user's
 * own display name. `fullName` must already be validated and normalized
 * (lib/parent/profile-name.ts); null clears it. Ownership is the predicate:
 * only the row whose user_id is the authenticated user can change. Null when
 * that user has no profile (nothing was written).
 *
 * The app role holds UPDATE on (full_name, updated_at) only (migration 0013).
 * Repeating the same value is harmless: the row ends in the same state.
 */
export async function updateParentProfileName(
  db: Queryable,
  input: { userId: string; fullName: string | null },
): Promise<{ fullName: string | null } | null> {
  const userId = requireUuid(input.userId, "userId");
  if (input.fullName !== null && typeof input.fullName !== "string") throw new TypeError("fullName must be a string or null");
  const rows = await runQuery<{ full_name: string | null }>(db, UPDATE_NAME, [userId, input.fullName]);
  const row = rows[0];
  if (!row) return null;
  return { fullName: typeof row.full_name === "string" ? row.full_name : null };
}
