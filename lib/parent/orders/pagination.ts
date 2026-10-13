/**
 * Pagination for the parent order list.
 *
 * Same keyset scheme as the private gallery - (created_at DESC, id DESC), an
 * opaque base64url cursor carrying the last row's raw `created_at` and id - so
 * the cursor codec and the duplicate-safe append are shared rather than copied.
 * Only the page sizes differ.
 */
export {
  decodeGalleryCursor as decodeOrdersCursor,
  encodeGalleryCursor as encodeOrdersCursor,
  appendUniqueById,
} from "@/lib/parent/gallery/pagination";

export const ORDERS_DEFAULT_PAGE_SIZE = 20;
/** Hard ceiling: a client can never ask for an unbounded page. */
export const ORDERS_MAX_PAGE_SIZE = 50;

export function clampOrdersPageSize(value: unknown): number {
  const n = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(n) || n < 1) return ORDERS_DEFAULT_PAGE_SIZE;
  return Math.min(Math.trunc(n), ORDERS_MAX_PAGE_SIZE);
}
