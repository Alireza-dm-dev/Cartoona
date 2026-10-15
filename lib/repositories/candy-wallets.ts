import { runQuery } from "@/lib/db/query";
import type { Queryable } from "@/lib/db/types";
import { requireUuid } from "./actor";

const SELECT_BALANCE = `
  SELECT w.balance
  FROM public.candy_wallets w
  WHERE w.parent_id = $1`;

/**
 * One parent's candy balance. Null when the parent has no wallet row (the
 * billing page then shows its own fallback), which is distinct from a balance
 * of 0. Read-only: balances move only inside the trusted SQL functions, under
 * the wallet row lock.
 */
export async function getCandyBalance(db: Queryable, input: { parentProfileId: string }): Promise<number | null> {
  const parentProfileId = requireUuid(input.parentProfileId, "parentProfileId");
  const rows = await runQuery<{ balance: number }>(db, SELECT_BALANCE, [parentProfileId]);
  return rows[0]?.balance ?? null;
}
