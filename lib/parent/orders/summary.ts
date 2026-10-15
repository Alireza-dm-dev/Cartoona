import type { ParentOrderSummary } from "./types";
import { toParentOrderStatus } from "./status-mapping";
import { isKnownOrderType } from "./type-mapping";

/**
 * The parent order list's row mapper, kept free of any data-access client so
 * both read paths share it: the Supabase query (queries.ts) and the
 * plain-PostgreSQL repository (lib/repositories/parent-orders.ts). One mapper
 * means the two cannot drift on what a parent may see.
 */

/** Untrusted shape of one row as it arrives from PostgREST or node-postgres. */
export interface RawOrderRow {
  id: unknown;
  type: unknown;
  status: unknown;
  title: unknown;
  candy_cost: unknown;
  created_at: unknown;
}

const FALLBACK_TITLE = "درخواست بدون عنوان";

/**
 * Narrow one database row to the parent read model.
 *
 * Exported for unit testing, which is why it takes a plain object rather than
 * a query builder. Returns null when the row cannot be safely presented: an
 * unknown type or a status with no parent-facing meaning is dropped rather
 * than guessed at, so a newer database than this build degrades by hiding a
 * row instead of leaking an internal string into the UI.
 *
 * `deliveredAt` is the row's earliest 'delivered' transition from
 * get_parent_orders_delivered_at (null when the order was never delivered,
 * or when the caller did not fetch one for it) — the same source of truth
 * the order detail page uses, so list and detail can never disagree for the
 * same order. Never derived from `orders.updated_at`.
 */
export function toParentOrderSummary(
  row: RawOrderRow,
  deliveredAt: string | null = null,
): ParentOrderSummary | null {
  if (typeof row.id !== "string" || row.id.length === 0) return null;

  const requestType = typeof row.type === "string" ? row.type : null;
  if (!isKnownOrderType(requestType)) return null;

  const status = toParentOrderStatus(typeof row.status === "string" ? row.status : null);
  if (status === null) return null;

  if (typeof row.created_at !== "string") return null;

  const candyCostRaw = typeof row.candy_cost === "number" ? row.candy_cost : 0;
  const candyCost = Number.isFinite(candyCostRaw) && candyCostRaw > 0 ? Math.trunc(candyCostRaw) : 0;

  const title = typeof row.title === "string" && row.title.trim().length > 0
    ? row.title.trim()
    : FALLBACK_TITLE;

  const completedAt = deliveredAt;

  return {
    id: row.id,
    requestType,
    createdAt: row.created_at,
    displayTitle: title,
    status,
    candyCost,
    completedAt,
  };
}
