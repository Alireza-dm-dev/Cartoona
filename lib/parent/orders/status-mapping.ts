import type { OrderStatus } from "@/types/app";
import type { ParentOrderStatus } from "./types";

/**
 * The one place internal workflow statuses become parent-facing states.
 *
 * `lib/admin/requests/workflow.ts` stays the source of truth for the internal
 * model; this module only translates. Admin states are not renamed, reordered
 * or extended here, and nothing in this file may be imported by admin code.
 *
 * The translation is intentionally lossy in two places.
 *
 * `rejected` and `cancelled` both become `closed`, because the distinction is
 * operational and surfacing it would invite the parent to argue with a
 * workflow decision from a list view. The reason belongs in the detail page
 * (Phase 2), worded for a parent rather than lifted from an admin note.
 *
 * The brief also asked for a separate "در حال بررسی" state alongside "ثبت شد".
 * The workflow cannot produce one: `pending_review` is the single state
 * between submission and `in_progress`, so a second label would either
 * duplicate it or describe a status no transition can reach. "ثبت شد" is used
 * for it, and a distinct reviewing state should be added here only if the
 * admin workflow ever gains a matching status.
 */
const INTERNAL_TO_PARENT: Record<OrderStatus, ParentOrderStatus | null> = {
  // Pre-submission states. The list shows submitted requests only, so these
  // map to null and are filtered out before they reach the read model.
  draft: null,
  pending_payment: null,

  pending_review: "submitted",
  in_progress: "creating",
  ready: "final_review",
  delivered: "ready",
  rejected: "closed",
  cancelled: "closed",
};

/**
 * Internal statuses that belong in the parent list. Derived from the map above
 * so the two can never drift: adding a workflow status without deciding its
 * parent-facing meaning makes it absent here rather than silently visible.
 */
export const PARENT_VISIBLE_INTERNAL_STATUSES: readonly OrderStatus[] = (
  Object.keys(INTERNAL_TO_PARENT) as OrderStatus[]
).filter((status) => INTERNAL_TO_PARENT[status] !== null);

/** Persian labels shown to the parent. */
export const PARENT_STATUS_LABELS: Record<ParentOrderStatus, string> = {
  submitted: "ثبت شد",
  creating: "در حال ساخت",
  final_review: "آماده بررسی نهایی",
  ready: "آماده است",
  closed: "لغو/رد شده",
};

/** Badge tone per parent state, using the existing Badge variants. */
export const PARENT_STATUS_VARIANTS: Record<
  ParentOrderStatus,
  "default" | "success" | "warning" | "danger" | "info"
> = {
  submitted: "info",
  creating: "warning",
  final_review: "warning",
  ready: "success",
  closed: "danger",
};

/**
 * Translate one internal status. Returns null when the status has no
 * parent-facing meaning, which covers both pre-submission states and any
 * unrecognised value arriving from a newer database than this build.
 */
export function toParentOrderStatus(
  status: string | null | undefined,
): ParentOrderStatus | null {
  if (typeof status !== "string") return null;
  if (!(status in INTERNAL_TO_PARENT)) return null;
  return INTERNAL_TO_PARENT[status as OrderStatus];
}

export function isParentVisibleStatus(status: string | null | undefined): boolean {
  return toParentOrderStatus(status) !== null;
}

export function parentStatusLabel(status: ParentOrderStatus): string {
  return PARENT_STATUS_LABELS[status];
}
