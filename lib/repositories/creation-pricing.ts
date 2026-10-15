import { runQuery } from "@/lib/db/query";
import type { Queryable } from "@/lib/db/types";

export type CreationPricesResult =
  | { ok: true; prices: Record<string, number> }
  /** The catalog is empty or has a row the app must not price with. */
  | { ok: false; reason: "invalid_catalog" };

const SELECT_ACTIVE_PRICES = `
  SELECT cp.pricing_key, cp.candy_cost
  FROM public.creation_pricing cp
  WHERE cp.is_active
  ORDER BY cp.pricing_key`;

/**
 * The active creation price catalog, `pricing_key -> candy_cost`. Public data:
 * no actor.
 *
 * Same acceptance rules as GET /api/creation-pricing, which still reads
 * Supabase: any blank or duplicate key, any cost that is not a positive
 * integer, or an empty catalog rejects the WHOLE catalog rather than serving a
 * partial one. A database failure throws `DbError` (the route maps both to its
 * 503).
 */
export async function getActiveCreationPrices(db: Queryable): Promise<CreationPricesResult> {
  const rows = await runQuery<{ pricing_key: unknown; candy_cost: unknown }>(db, SELECT_ACTIVE_PRICES);

  const prices: Record<string, number> = {};
  for (const row of rows) {
    const key = row.pricing_key;
    if (typeof key !== "string" || key.trim() === "" || Object.hasOwn(prices, key)) {
      return { ok: false, reason: "invalid_catalog" };
    }
    const cost = row.candy_cost;
    if (typeof cost !== "number" || !Number.isInteger(cost) || cost <= 0) {
      return { ok: false, reason: "invalid_catalog" };
    }
    prices[key] = cost;
  }

  if (Object.keys(prices).length === 0) return { ok: false, reason: "invalid_catalog" };
  return { ok: true, prices };
}
