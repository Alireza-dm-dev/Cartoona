import { normalizeRemaining } from "@/lib/credits/welcome-image-credits";
import { runQuery } from "@/lib/db/query";
import type { Queryable } from "@/lib/db/types";
import { requireUuid } from "./actor";

const SELECT_CREDITS = `
  SELECT wc.granted_count, wc.used_count
  FROM public.parent_welcome_credits wc
  WHERE wc.parent_id = $1`;

/**
 * Welcome image credits left for one parent: max(granted_count - used_count, 0).
 *
 * Plain-PostgreSQL counterpart of `readWelcomeImageCredits`, using the same
 * `normalizeRemaining` rule. A parent with no row has 0. Only the count leaves
 * this function - no ledger or usage ids. A read failure throws `DbError`; the
 * caller turns that into "unknown" (null), never into a number.
 */
export async function getWelcomeImageCreditsRemaining(
  db: Queryable,
  input: { parentProfileId: string },
): Promise<number> {
  const parentProfileId = requireUuid(input.parentProfileId, "parentProfileId");
  const rows = await runQuery<{ granted_count: unknown; used_count: unknown }>(db, SELECT_CREDITS, [parentProfileId]);
  const row = rows[0];
  if (!row) return 0;
  return normalizeRemaining(row.granted_count, row.used_count);
}
