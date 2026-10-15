import { runQuery } from "@/lib/db/query";
import type { Queryable } from "@/lib/db/types";
import {
  ORDERS_DEFAULT_PAGE_SIZE,
  clampOrdersPageSize,
  decodeOrdersCursor,
  encodeOrdersCursor,
} from "@/lib/parent/orders/pagination";
import { PARENT_VISIBLE_INTERNAL_STATUSES } from "@/lib/parent/orders/status-mapping";
import { toParentOrderSummary } from "@/lib/parent/orders/summary";
import type { ParentOrderSummary } from "@/lib/parent/orders/types";
import { requireUuid } from "./actor";

export type ParentOrdersRepoPage =
  | { ok: true; orders: ParentOrderSummary[]; nextCursor: string | null }
  | { ok: false; reason: "invalid_cursor" };

/**
 * One page of a parent's orders, newest first, with each row's first
 * 'delivered' transition - in ONE statement.
 *
 *  $1 parent profile id (ownership: the only rows this can ever return)
 *  $2 parent-visible statuses (text[]; draft/pending_payment are excluded)
 *  $3 cursor created_at, or NULL for the first page
 *  $4 cursor id, or NULL
 *  $5 page size + 1
 *
 * The page is selected and limited first; delivered_at is then a correlated
 * MIN over idx_order_status_history_order_created for just those rows - the
 * same rule as get_parent_orders_delivered_at(_trusted), without the second
 * round trip. Timestamps are rendered as fixed-format UTC text: node-postgres
 * would otherwise parse them into JS Dates and drop the microseconds, and a
 * cursor that loses precision repeats or skips rows.
 */
const SELECT_PARENT_ORDERS_PAGE = `
  WITH page AS (
    SELECT o.id, o.type, o.status, o.title, o.candy_cost, o.created_at
    FROM public.orders o
    WHERE o.parent_id = $1
      AND o.status = ANY ($2::text[])
      AND ($3::timestamptz IS NULL OR (o.created_at, o.id) < ($3::timestamptz, $4::uuid))
    ORDER BY o.created_at DESC, o.id DESC
    LIMIT $5
  )
  SELECT
    page.id, page.type, page.status, page.title, page.candy_cost,
    to_char(page.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"+00:00"') AS created_at,
    to_char(
      (SELECT min(h.created_at)
         FROM public.order_status_history h
        WHERE h.order_id = page.id AND h.new_status = 'delivered') AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"+00:00"'
    ) AS delivered_at
  FROM page
  ORDER BY page.created_at DESC, page.id DESC`;

interface OrderRow {
  id: string;
  type: string;
  status: string;
  title: string | null;
  candy_cost: number;
  created_at: string;
  delivered_at: string | null;
}

/**
 * Plain-PostgreSQL port of `getParentOrdersPage` (lib/parent/orders/queries.ts).
 * Same contract: keyset pagination on (created_at DESC, id DESC), default 20,
 * max 50, pageSize + 1 rows read to detect a next page, the same opaque cursor
 * codec, the same row mapper, and a cursor that follows the last row READ.
 *
 * Ownership is the `parent_id = $1` predicate - there is no RLS behind it, so
 * the caller must pass the parent profile it resolved for the signed-in user.
 * A malformed cursor is `invalid_cursor`; a database failure throws DbError.
 */
export async function getParentOrdersPage(
  db: Queryable,
  context: { parentProfileId: string },
  options: { cursor?: string | null; limit?: number } = {},
): Promise<ParentOrdersRepoPage> {
  const parentProfileId = requireUuid(context.parentProfileId, "parentProfileId");
  const pageSize = clampOrdersPageSize(options.limit ?? ORDERS_DEFAULT_PAGE_SIZE);

  let cursor = null;
  if (options.cursor !== undefined && options.cursor !== null && options.cursor !== "") {
    cursor = decodeOrdersCursor(options.cursor);
    if (!cursor) return { ok: false, reason: "invalid_cursor" };
  }

  const fetched = await runQuery<OrderRow>(db, SELECT_PARENT_ORDERS_PAGE, [
    parentProfileId,
    PARENT_VISIBLE_INTERNAL_STATUSES,
    cursor?.createdAt ?? null,
    cursor?.id ?? null,
    pageSize + 1,
  ]);

  const hasMore = fetched.length > pageSize;
  const rows = hasMore ? fetched.slice(0, pageSize) : fetched;

  const orders = rows
    .map((row) => toParentOrderSummary(row, row.delivered_at))
    .filter((o): o is ParentOrderSummary => o !== null);

  const last = rows[rows.length - 1];
  const nextCursor = hasMore && last ? encodeOrdersCursor({ createdAt: last.created_at, id: last.id }) : null;

  return { ok: true, orders, nextCursor };
}
