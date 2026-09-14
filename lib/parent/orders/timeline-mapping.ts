import type { ParentOrderStatus } from "./types";
import type { ParentOrderClosure, ParentTimelineEvent } from "./detail-types";
import { toParentOrderStatus } from "./status-mapping";

/**
 * Turns raw `order_status_history` rows into the parent timeline.
 *
 * The rows arrive from `get_parent_order_status_history`, which already
 * restricts the columns to previous_status, new_status, parent_visible_note
 * and created_at, and already proves ownership. This module does the
 * translation and nothing else: it never sees an internal note, so it cannot
 * leak one.
 */

/** Shape returned by the database function. Everything is untrusted. */
export interface RawHistoryRow {
  previous_status?: unknown;
  new_status?: unknown;
  parent_visible_note?: unknown;
  created_at?: unknown;
}

/** Headline shown per step in the timeline. */
export const TIMELINE_LABELS: Record<ParentOrderStatus, string> = {
  submitted: "درخواست ثبت شد",
  creating: "در حال ساخت",
  final_review: "آماده بررسی نهایی",
  ready: "آماده است",
  closed: "بسته شد",
};

/** Short explanation under each step, so a parent knows what happens next. */
export const TIMELINE_DESCRIPTIONS: Record<ParentOrderStatus, string> = {
  submitted: "درخواست شما ثبت شد و در نوبت بررسی تیم کارتونا قرار گرفت.",
  creating: "تیم کارتونا در حال ساخت سفارش شماست.",
  final_review: "خروجی آماده شده و در مرحله بررسی نهایی است.",
  ready: "سفارش شما آماده است.",
  closed: "این درخواست بسته شده است.",
};

/** Terminal-state headings, where rejected and cancelled are distinguished. */
export const CLOSURE_LABELS: Record<ParentOrderClosure["kind"], string> = {
  rejected: "رد شده",
  cancelled: "لغو شده",
};

/**
 * Neutral wording used when no parent-visible reason was recorded. The
 * internal note is never substituted: it is written for admins and may contain
 * operational detail a parent should not read.
 */
export const CLOSURE_FALLBACK_REASON: Record<ParentOrderClosure["kind"], string> = {
  rejected: "این درخواست پذیرفته نشد. توضیح بیشتری برای نمایش ثبت نشده است.",
  cancelled: "این درخواست لغو شد. توضیح بیشتری برای نمایش ثبت نشده است.",
};

function safeNote(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Map history rows to timeline events, newest first.
 *
 * Rows whose `new_status` has no parent-facing meaning are dropped rather than
 * guessed at. That covers the pre-submission states and any status from a
 * newer database than this build, so an unrecognised value hides a step
 * instead of rendering a raw internal string.
 */
export function toParentTimeline(rows: readonly RawHistoryRow[]): ParentTimelineEvent[] {
  const events: ParentTimelineEvent[] = [];

  for (const row of rows) {
    const status = toParentOrderStatus(
      typeof row.new_status === "string" ? row.new_status : null,
    );
    if (status === null) continue;
    if (typeof row.created_at !== "string") continue;

    events.push({ status, at: row.created_at, note: safeNote(row.parent_visible_note) });
  }

  // The function already orders newest-first, but sorting here keeps the model
  // correct regardless of how the rows were fetched.
  return events.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}

/**
 * Extract the closure block from the same rows.
 *
 * Returns null unless the request actually ended in `rejected` or `cancelled`.
 * The distinction is safe to show here because it comes from `new_status`,
 * which the database function returns to parents by design.
 */
export function toParentClosure(rows: readonly RawHistoryRow[]): ParentOrderClosure | null {
  let latest: ParentOrderClosure | null = null;

  for (const row of rows) {
    const raw = typeof row.new_status === "string" ? row.new_status : null;
    if (raw !== "rejected" && raw !== "cancelled") continue;
    if (typeof row.created_at !== "string") continue;

    const candidate: ParentOrderClosure = {
      kind: raw,
      at: row.created_at,
      reason: safeNote(row.parent_visible_note),
    };
    if (!latest || candidate.at > latest.at) latest = candidate;
  }

  return latest;
}

export function closureReasonText(closure: ParentOrderClosure): string {
  return closure.reason ?? CLOSURE_FALLBACK_REASON[closure.kind];
}
