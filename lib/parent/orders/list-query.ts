import { ORDERS_MAX_PAGE_SIZE, decodeOrdersCursor } from "./pagination";

/**
 * The only inputs of the parent orders LIST (V0.1.45), validated identically
 * by the Next BFF (/api/parent/orders) and the backend (/v1/parent/orders).
 * Pure: no I/O, no framework.
 *
 *  cursor  optional, opaque, must decode (an empty string means "first page")
 *  limit   optional, a plain decimal integer 1..50 (default 20 when absent)
 *
 * There is no sorting, filtering or identity input: the order is fixed
 * (created_at DESC, id DESC) and the owner is the authenticated parent.
 */

export interface OrdersListQuery {
  cursor: string | null;
  limit: number | null;
}

export const ORDERS_LIST_QUERY_KEYS = ["cursor", "limit"] as const;
const CURSOR_MAX = 512;
const LIMIT = /^[1-9][0-9]?$/;

export type OrdersListQueryResult = { ok: true; query: OrdersListQuery } | { ok: false };

/**
 * `rejectUnknown`: the backend refuses any other parameter (parentProfileId,
 * userId, sort...). The Next route never forwards one, so it simply ignores them.
 */
export function parseOrdersListQuery(
  input: Record<string, unknown>,
  options: { rejectUnknown: boolean },
): OrdersListQueryResult {
  if (options.rejectUnknown && Object.keys(input).some((k) => !(ORDERS_LIST_QUERY_KEYS as readonly string[]).includes(k))) {
    return { ok: false };
  }
  const rawCursor = input.cursor;
  const rawLimit = input.limit;
  // A repeated parameter arrives as an array: ambiguous, refused.
  if (rawCursor !== undefined && rawCursor !== null && typeof rawCursor !== "string") return { ok: false };
  if (rawLimit !== undefined && rawLimit !== null && typeof rawLimit !== "string") return { ok: false };

  let cursor: string | null = null;
  if (typeof rawCursor === "string" && rawCursor !== "") {
    if (rawCursor.length > CURSOR_MAX || decodeOrdersCursor(rawCursor) === null) return { ok: false };
    cursor = rawCursor;
  }

  let limit: number | null = null;
  if (typeof rawLimit === "string") {
    if (!LIMIT.test(rawLimit)) return { ok: false };
    limit = Number(rawLimit);
    if (limit > ORDERS_MAX_PAGE_SIZE) return { ok: false };
  }
  return { ok: true, query: { cursor, limit } };
}
