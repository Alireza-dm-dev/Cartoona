import type { OrderType } from "@/types/app";
import type { ParentOrderStatus, ParentOrderSummary } from "./types";

/**
 * One step in the parent-facing timeline.
 *
 * Derived from `order_status_history`, but only ever from the four columns the
 * `get_parent_order_status_history` function is willing to return. There is
 * deliberately no field for the admin who made the change and none for the
 * internal note.
 */
export interface ParentTimelineEvent {
  /** Parent-facing state this event moved the request into. */
  status: ParentOrderStatus;
  /** ISO-8601 UTC timestamp of the transition. */
  at: string;
  /**
   * The admin's parent-visible note, when one was written. Never the internal
   * note: the two are separate columns and only this one is returned to a
   * parent by the database function.
   */
  note: string | null;
}

/**
 * Why a request ended, in terms a parent can act on.
 *
 * `kind` distinguishes rejected from cancelled, which the list page collapses
 * into a single closed state. `reason` is present only when an admin wrote a
 * parent-visible note on the terminal transition; when it is null the page
 * shows a neutral explanation rather than reaching for the internal note.
 */
export interface ParentOrderClosure {
  kind: "rejected" | "cancelled";
  at: string;
  reason: string | null;
}

/** One label/value row of request-specific detail. */
export interface ParentDetailRow {
  label: string;
  value: string;
  multiline?: boolean;
}

/**
 * A parent-uploaded source file, as shown on the detail page.
 *
 * Carries a short-lived signed URL and never the storage path. Only assets the
 * parent uploaded themselves appear here; generated deliverables are excluded
 * at the query, because delivery is a later phase with its own audit surface.
 */
export interface ParentSourceMedia {
  id: string;
  mimeType: string | null;
  uploadedAt: string;
  /** Expires in minutes. Null when signing failed, so the UI degrades. */
  signedUrl: string | null;
  isImage: boolean;
}

/**
 * Everything the detail page is allowed to know about one request.
 *
 * Extends the list read model rather than restating it, so the two views
 * cannot drift on the fields they share. The same omissions apply and are
 * enforced in `detail-queries.ts`, which is the only constructor: no admin
 * notes, no `assigned_admin_id`, no `moderation_status`, no storage paths, no
 * other parent's identifiers, and no raw internal status or event name.
 */
export interface ParentOrderDetail extends ParentOrderSummary {
  requestType: OrderType;
  /** Parent-authored description, shown as the request brief. */
  description: string | null;
  /** Type-specific rows built only from columns that exist in the schema. */
  detailRows: ParentDetailRow[];
  /** Newest-first, matching the order the database function returns. */
  timeline: ParentTimelineEvent[];
  /** Present only for a terminal rejected/cancelled request. */
  closure: ParentOrderClosure | null;
  sourceMedia: ParentSourceMedia[];
}

export type ParentOrderDetailResult =
  | { ok: true; detail: ParentOrderDetail }
  | { ok: false; reason: "unauthenticated" | "no_parent_profile" | "not_found" | "read_failed" };
