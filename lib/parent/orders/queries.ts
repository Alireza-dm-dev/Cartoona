import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { ParentOrdersPageResult, ParentOrderSummary } from "./types";
import {
  ORDERS_DEFAULT_PAGE_SIZE,
  clampOrdersPageSize,
  decodeOrdersCursor,
  encodeOrdersCursor,
} from "./pagination";
import { PARENT_VISIBLE_INTERNAL_STATUSES, toParentOrderStatus } from "./status-mapping";
import { isKnownOrderType } from "./type-mapping";

/**
 * Columns the parent list reads. Listed explicitly rather than with `*` so a
 * future column on `orders` cannot widen what the parent sees by accident.
 * Notably absent: assigned_admin_id, moderation_status, description,
 * updated_at (touched by every status transition, not only delivery — never
 * a source of completedAt; see get_parent_orders_delivered_at instead).
 */
const PARENT_ORDER_COLUMNS = "id, type, status, title, candy_cost, created_at";

/** Untrusted shape of one row as it arrives from PostgREST. */
interface RawOrderRow {
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

/**
 * One page of the signed-in parent's submitted requests, newest first.
 *
 * The caller resolves identity once (see ParentRequestContext) and passes the
 * parent profile id; this function makes no auth or profile round trips.
 *
 * Ownership is enforced in the query itself: `eq("parent_id", ...)` means the
 * database never returns another parent's row to this process, and row level
 * security (`orders_select_own_parent`) independently enforces the same rule on
 * the anon key. Nothing is filtered in React.
 *
 * Keyset pagination on (created_at DESC, id DESC): one extra row is read to
 * learn whether another page exists, so a first page loads pageSize + 1 rows
 * and never the whole history. Stable while new orders arrive - a new order is
 * newer than every cursor already issued, so it can neither repeat nor displace
 * an older row the way an offset would.
 */
export async function getParentOrdersPage(
  supabase: SupabaseClient,
  context: { parentProfileId: string },
  options: { cursor?: string | null; limit?: number } = {},
): Promise<ParentOrdersPageResult> {
  const pageSize = clampOrdersPageSize(options.limit ?? ORDERS_DEFAULT_PAGE_SIZE);

  let cursor = null;
  if (options.cursor !== undefined && options.cursor !== null && options.cursor !== "") {
    cursor = decodeOrdersCursor(options.cursor);
    if (!cursor) return { ok: false, reason: "invalid_cursor" };
  }

  let query = supabase
    .from("orders")
    .select(PARENT_ORDER_COLUMNS)
    .eq("parent_id", context.parentProfileId)
    .in("status", PARENT_VISIBLE_INTERNAL_STATUSES as string[]);

  if (cursor) {
    // Strictly after the cursor row in (created_at DESC, id DESC) order. The
    // cursor was validated above, so nothing unexpected reaches the filter.
    query = query.or(
      `created_at.lt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.lt.${cursor.id})`,
    );
  }

  const { data, error } = await query
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(pageSize + 1);

  if (error) return { ok: false, reason: "read_failed" };

  const fetched = Array.isArray(data) ? (data as unknown as RawOrderRow[]) : [];
  const hasMore = fetched.length > pageSize;
  const rows = hasMore ? fetched.slice(0, pageSize) : fetched;

  // One batch call for THIS PAGE's delivered timestamps, never one call per
  // order (get_parent_order_status_history is single-order and would be N+1)
  // and never for the parent's whole history. Skipped for an empty page.
  const deliveredAtByOrderId = new Map<string, string>();
  const orderIds = rows
    .map((r) => r.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);

  if (orderIds.length > 0) {
    const { data: delivered } = await supabase.rpc("get_parent_orders_delivered_at", {
      p_order_ids: orderIds,
    });
    for (const row of Array.isArray(delivered) ? delivered : []) {
      if (typeof row?.order_id === "string" && typeof row?.delivered_at === "string") {
        deliveredAtByOrderId.set(row.order_id, row.delivered_at);
      }
    }
  }

  const orders = rows
    .map((row) =>
      toParentOrderSummary(
        row,
        typeof row.id === "string" ? deliveredAtByOrderId.get(row.id) ?? null : null,
      ),
    )
    .filter((o): o is ParentOrderSummary => o !== null);

  // The cursor follows the last row READ, not the last row shown: a row that
  // toParentOrderSummary drops must not stall or repeat the walk.
  let nextCursor: string | null = null;
  if (hasMore) {
    const last = rows[rows.length - 1];
    if (typeof last?.created_at === "string" && typeof last.id === "string") {
      nextCursor = encodeOrdersCursor({ createdAt: last.created_at, id: last.id });
    }
  }

  return { ok: true, orders, nextCursor };
}
