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
