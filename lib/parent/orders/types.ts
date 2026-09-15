import type { OrderType } from "@/types/app";

/**
 * Parent-facing status vocabulary.
 *
 * Deliberately smaller than the internal `OrderStatus` union: the parent is
 * told where their request is, not which admin workflow state backs it. The
 * mapping lives in `status-mapping.ts` and is the only place the two
 * vocabularies meet.
 */
export type ParentOrderStatus =
  | "submitted"
  | "creating"
  | "final_review"
  | "ready"
  | "closed";

/**
 * Everything the parent order list is allowed to know about one request.
 *
 * This is the security boundary for the list, not just a view model. Anything
 * absent here cannot leak to the browser, so the omissions are deliberate:
 * no `assigned_admin_id`, no `moderation_status`, no admin or fulfilment
 * notes, no storage paths or signed URLs, no other parent's identifiers, and
 * no raw internal status string. `toParentOrderSummary` in `queries.ts` is the
 * only constructor, and it is the only thing that sees the database row.
 */
export interface ParentOrderSummary {
  /** Order id. Safe to expose: it is the parent's own row, and the detail
   *  route re-checks ownership rather than trusting this value. */
  id: string;
  requestType: OrderType;
  /** ISO-8601 UTC. Formatting is the UI's job, not the read model's. */
  createdAt: string;
  displayTitle: string;
  status: ParentOrderStatus;
  candyCost: number;
  /** Set only once the request reaches a terminal delivered state. */
  completedAt: string | null;
}

/** Result shape for the list query, so the page can branch on failure
 *  without a thrown error crossing the server/client boundary. */
export type ParentOrderListResult =
  | { ok: true; orders: ParentOrderSummary[] }
  | { ok: false; reason: "unauthenticated" | "no_parent_profile" | "read_failed" };
