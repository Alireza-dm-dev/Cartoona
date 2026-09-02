import type { OrderStatus } from "@/types/app";

/**
 * Single source of truth for the order-status workflow used by the Admin
 * request fulfilment flow.
 *
 * The database enforces the same rules inside `update_order_status_trusted`
 * (see supabase/migrations/20260801120000_request_fulfilment_workflow.sql).
 * This module must stay in sync with that RPC — never introduce a transition
 * here without mirroring it in SQL, and vice versa.
 *
 * Status model (existing 8 values — no new values introduced):
 *   pending_review  → in_progress → ready → delivered
 *   pending_review/in_progress → rejected | cancelled  (terminal)
 *   draft / pending_payment are pre-submission legacy states with no workflow.
 */

export const ALL_ORDER_STATUSES: readonly OrderStatus[] = [
  "draft",
  "pending_payment",
  "pending_review",
  "in_progress",
  "ready",
  "delivered",
  "rejected",
  "cancelled",
];

/** Statuses reachable in the Admin fulfilment workflow. */
export const WORKFLOW_STATUSES: readonly OrderStatus[] = [
  "pending_review",
  "in_progress",
  "ready",
  "delivered",
  "rejected",
  "cancelled",
];

export const TERMINAL_STATUSES: readonly OrderStatus[] = ["delivered", "rejected", "cancelled"];

/** Statuses that allow uploading final deliverables. */
export const FINAL_UPLOAD_ALLOWED_STATUSES: readonly OrderStatus[] = [
  "pending_review",
  "in_progress",
  "ready",
];

/** Target statuses that require at least one approved, parent-visible final asset. */
export const STATUS_REQUIRES_APPROVED_FINAL_MEDIA: ReadonlySet<OrderStatus> = new Set(["ready"]);

/** Target statuses that require a reason (internal or parent-visible note). */
export const STATUS_REQUIRES_REASON: ReadonlySet<OrderStatus> = new Set(["rejected"]);

export const NOTE_MAX_LENGTH = 2000;

const TRANSITION_MAP: Record<OrderStatus, readonly OrderStatus[]> = {
  draft: [],
  pending_payment: [],
  pending_review: ["in_progress", "rejected", "cancelled"],
  in_progress: ["ready", "rejected", "cancelled"],
  ready: ["delivered"],
  delivered: [],
  rejected: [],
  cancelled: [],
};

export function isKnownOrderStatus(value: string | null | undefined): value is OrderStatus {
  return typeof value === "string" && (ALL_ORDER_STATUSES as readonly string[]).includes(value);
}

export function isWorkflowStatus(value: string | null | undefined): value is OrderStatus {
  return typeof value === "string" && (WORKFLOW_STATUSES as readonly string[]).includes(value);
}

export type TransitionCheckResult =
  | { ok: true }
  | {
      ok: false;
      code: "request_invalid_status" | "request_transition_invalid" | "request_status_unchanged";
    };

/**
 * Server-authoritative transition check. Mirrors the `update_order_status_trusted`
 * RPC exactly. The browser never defines allowed transitions — it only sends the
 * desired target status; this check (and the database) decide validity.
 */
export function checkTransition(
  from: OrderStatus | null | undefined,
  to: string,
): TransitionCheckResult {
  if (!from || !isKnownOrderStatus(to)) {
    return { ok: false, code: "request_invalid_status" };
  }
  if (from === to) {
    return { ok: false, code: "request_status_unchanged" };
  }
  const allowed = TRANSITION_MAP[from] ?? [];
  return allowed.includes(to as OrderStatus)
    ? { ok: true }
    : { ok: false, code: "request_transition_invalid" };
}

export function getAllowedNextStatuses(status: OrderStatus | null | undefined): OrderStatus[] {
  if (!status) return [];
  return [...(TRANSITION_MAP[status] ?? [])];
}

export function isTerminalStatus(status: OrderStatus | null | undefined): boolean {
  return !!status && (TERMINAL_STATUSES as readonly OrderStatus[]).includes(status);
}

export function canUploadFinalMedia(status: OrderStatus | null | undefined): boolean {
  return !!status && (FINAL_UPLOAD_ALLOWED_STATUSES as readonly OrderStatus[]).includes(status);
}

export function requiresApprovedFinalMedia(status: OrderStatus | null | undefined): boolean {
  return !!status && STATUS_REQUIRES_APPROVED_FINAL_MEDIA.has(status as OrderStatus);
}

export function requiresRejectionReason(status: OrderStatus | null | undefined): boolean {
  return !!status && STATUS_REQUIRES_REASON.has(status as OrderStatus);
}

/* ── Persian labels ─────────────────────────────────────────────────────────── */

export const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  draft: "پیش‌نویس",
  pending_payment: "در انتظار پرداخت",
  pending_review: "در انتظار بررسی",
  in_progress: "در حال انجام",
  ready: "آماده تحویل",
  delivered: "تحویل داده شده",
  rejected: "رد شده",
  cancelled: "لغو شده",
};

const UNKNOWN_STATUS_LABEL = "وضعیت نامشخص";

export function mapOrderStatusLabel(status: string | null | undefined): string {
  if (isKnownOrderStatus(status)) return ORDER_STATUS_LABELS[status];
  return UNKNOWN_STATUS_LABEL;
}

/**
 * Semantic tone per status used for UI indicators (queue dots, legends).
 * Mapped to Tailwind classes in the components; statuses stay the source of
 * truth here.
 */
export const STATUS_TONES: Record<OrderStatus, "neutral" | "info" | "active" | "success" | "danger"> = {
  draft: "neutral",
  pending_payment: "neutral",
  pending_review: "info",
  in_progress: "active",
  ready: "success",
  delivered: "success",
  rejected: "danger",
  cancelled: "danger",
};

export function mapStatusTone(status: string | null | undefined): "neutral" | "info" | "active" | "success" | "danger" {
  if (isKnownOrderStatus(status)) return STATUS_TONES[status];
  return "neutral";
}

/* ── Per-status workflow definition (Part 2) ───────────────────────────────── */

export interface RequestStatusDefinition {
  label: string;
  meaning: string;
  /** Statuses from which this status may be entered (derived from the map). */
  allowedPrevious: readonly OrderStatus[];
  /** Statuses reachable from this status (derived from the map). */
  allowedNext: readonly OrderStatus[];
  requiresApprovedFinalMedia: boolean;
  /** Parent tracking page may show this status. */
  parentCanSee: boolean;
  /** Refund is deferred/not automatic (no wallet/ledger mutation in this task). */
  refundDeferred: boolean;
  terminal: boolean;
}

function buildDefinitions(): Record<OrderStatus, RequestStatusDefinition> {
  const allowedPrevious = (target: OrderStatus): readonly OrderStatus[] => {
    const prev: OrderStatus[] = [];
    for (const s of ALL_ORDER_STATUSES) {
      if ((TRANSITION_MAP[s] as readonly string[]).includes(target)) prev.push(s);
    }
    return prev;
  };

  const base: Record<OrderStatus, Omit<RequestStatusDefinition, "allowedPrevious" | "allowedNext">> = {
    draft: { label: ORDER_STATUS_LABELS.draft, meaning: "پیش‌نویس؛ قبل از ثبت نهایی. در گردش عملیاتی استفاده نمی‌شود.", requiresApprovedFinalMedia: false, parentCanSee: true, refundDeferred: false, terminal: false },
    pending_payment: { label: ORDER_STATUS_LABELS.pending_payment, meaning: "پیش از پرداخت/ثبت. در گردش عملیاتی استفاده نمی‌شود.", requiresApprovedFinalMedia: false, parentCanSee: true, refundDeferred: false, terminal: false },
    pending_review: { label: ORDER_STATUS_LABELS.pending_review, meaning: "درخواست تازه ثبت‌شده؛ در انتظار بررسی مدیر.", requiresApprovedFinalMedia: false, parentCanSee: true, refundDeferred: true, terminal: false },
    in_progress: { label: ORDER_STATUS_LABELS.in_progress, meaning: "تأیید شده و در حال تولید/آماده‌سازی دستی.", requiresApprovedFinalMedia: false, parentCanSee: true, refundDeferred: true, terminal: false },
    ready: { label: ORDER_STATUS_LABELS.ready, meaning: "حداقل یک فایل خروجی نهایی تأیید و برای والد قابل مشاهده است.", requiresApprovedFinalMedia: true, parentCanSee: true, refundDeferred: true, terminal: false },
    delivered: { label: ORDER_STATUS_LABELS.delivered, meaning: "تحویل نهایی به والد انجام شده است.", requiresApprovedFinalMedia: true, parentCanSee: true, refundDeferred: true, terminal: true },
    rejected: { label: ORDER_STATUS_LABELS.rejected, meaning: "رد شده با دلیل. آبنبات کسرشده در این مرحله بازگردانده نمی‌شود.", requiresApprovedFinalMedia: false, parentCanSee: true, refundDeferred: true, terminal: true },
    cancelled: { label: ORDER_STATUS_LABELS.cancelled, meaning: "لغو شده توسط مدیر. آبنبات کسرشده در این مرحله بازگردانده نمی‌شود.", requiresApprovedFinalMedia: false, parentCanSee: true, refundDeferred: true, terminal: true },
  };

  const out = {} as Record<OrderStatus, RequestStatusDefinition>;
  for (const s of ALL_ORDER_STATUSES) {
    out[s] = {
      ...base[s],
      allowedPrevious: allowedPrevious(s),
      allowedNext: [...(TRANSITION_MAP[s] ?? [])],
    };
  }
  return out;
}

export const REQUEST_STATUS_DEFINITIONS = buildDefinitions();

/* ── Notes (Part 10) ────────────────────────────────────────────────────────── */

export type NormalizedNoteResult =
  | { ok: true; value: string | null }
  | { ok: false; code: "request_note_too_long" | "request_note_invalid" };

/**
 * Trims whitespace, converts empty strings to null, and enforces the 2000
 * character limit. Internal and parent-visible notes are normalized the same
 * way but always kept as separate values.
 */
export function normalizeNote(raw: unknown): NormalizedNoteResult {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw !== "string") return { ok: false, code: "request_note_invalid" };
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: true, value: null };
  if (trimmed.length > NOTE_MAX_LENGTH) return { ok: false, code: "request_note_too_long" };
  return { ok: true, value: trimmed };
}
