import type { OrderStatus } from "@/types/app";
import type { FulfilmentApiErrorCode } from "@/lib/admin/requests/fulfilment-error-codes";
import { isKnownOrderStatus, normalizeNote } from "@/lib/admin/requests/workflow";

/**
 * Safe API models for the request fulfilment flow.
 *
 * Raw database rows are converted to these shapes by serializers and then
 * serialized to JSON — no raw DB row is ever passed to a Client Component,
 * and signed URLs are added only at read time (never persisted).
 */

export type FinalMediaDeliveryStatus = "uploaded" | "approved" | "superseded";

export type FinalMediaApprovalAction = "approve" | "supersede";

/* ── Admin models ───────────────────────────────────────────────────────────── */

export interface AdminFinalMediaInfo {
  id: string;
  fileName: string | null;
  mimeType: string | null;
  byteSize: number | null;
  uploadedAt: string;
  supersededAt: string | null;
  signedUrl: string | null;
  signedUrlFailed: boolean;
  deliveryStatus: FinalMediaDeliveryStatus;
  parentVisible: boolean;
}

export interface AdminHistoryItem {
  id: string;
  previousStatus: OrderStatus | null;
  newStatus: OrderStatus;
  changedBy: string | null;
  changedByDeleted: boolean;
  internalNote: string | null;
  parentVisibleNote: string | null;
  createdAt: string;
}

export interface AdminStatusUpdateInput {
  status: OrderStatus;
  /** Row sent by the client so a concurrent change returns 409 instead of clobbering. */
  expectedUpdatedAt: string;
  internalNote: string | null;
  parentVisibleNote: string | null;
}

export interface AdminStatusUpdateResult {
  orderId: string;
  previousStatus: OrderStatus | null;
  status: OrderStatus;
  updatedAt: string;
  historyId: string;
}

/* ── Parent models (future tracking page; serializers reusable now) ────────── */

export interface ParentFinalAssetInfo {
  id: string;
  fileName: string | null;
  mimeType: string | null;
  byteSize: number | null;
  createdAt: string;
  signedUrl: string | null;
}

export interface ParentOrderHistoryItem {
  previousStatus: OrderStatus | null;
  newStatus: OrderStatus;
  parentVisibleNote: string | null;
  createdAt: string;
}

/* ── Raw row shapes (never exported across a fetch boundary) ────────────────── */

export interface FinalMediaRowShape {
  id: string;
  file_url: string | null;
  mime_type: string | null;
  byte_size: number | null;
  created_at: string;
  superseded_at: string | null;
  delivery_status: string;
  parent_visible: boolean;
}

export interface HistoryRowShape {
  id: string;
  previous_status: string | null;
  new_status: string;
  changed_by: string | null;
  changed_by_deleted: boolean;
  internal_note: string | null;
  parent_visible_note: string | null;
  created_at: string;
}

export interface ParentHistoryRowShape {
  previous_status: string | null;
  new_status: string;
  parent_visible_note: string | null;
  created_at: string;
}

/* ── Serializers ─────────────────────────────────────────────────────────────── */

function safeStatus(value: string | null | undefined): OrderStatus | null {
  return isKnownOrderStatus(value) ? value : null;
}

function safeFileName(path: string | null | undefined): string | null {
  if (!path) return null;
  const parts = path.split("/").filter(Boolean);
  const last = parts[parts.length - 1];
  return last || null;
}

export function toAdminFinalMediaInfo(row: FinalMediaRowShape, signedUrl: string | null): AdminFinalMediaInfo {
  const deliveryStatus =
    row.delivery_status === "approved" || row.delivery_status === "superseded"
      ? row.delivery_status
      : "uploaded";
  return {
    id: row.id,
    fileName: safeFileName(row.file_url),
    mimeType: row.mime_type || null,
    byteSize: row.byte_size ?? null,
    uploadedAt: row.created_at,
    supersededAt: row.superseded_at ?? null,
    signedUrl,
    signedUrlFailed: signedUrl === null,
    deliveryStatus,
    parentVisible: row.parent_visible === true,
  };
}

export function toAdminHistoryItem(row: HistoryRowShape): AdminHistoryItem {
  const previous = safeStatus(row.previous_status);
  const next = safeStatus(row.new_status) ?? "pending_review";
  return {
    id: row.id,
    previousStatus: previous,
    newStatus: next,
    changedBy: row.changed_by || null,
    changedByDeleted: row.changed_by_deleted === true,
    internalNote: row.internal_note || null,
    parentVisibleNote: row.parent_visible_note || null,
    createdAt: row.created_at,
  };
}

/**
 * Parent-visible final assets only: approved and still parent-visible.
 * Superseded assets are permanently excluded for parents.
 */
export function toParentFinalAssetInfo(
  row: FinalMediaRowShape,
  signedUrl: string | null,
): ParentFinalAssetInfo | null {
  if (row.delivery_status !== "approved" || row.parent_visible !== true) return null;
  return {
    id: row.id,
    fileName: safeFileName(row.file_url),
    mimeType: row.mime_type || null,
    byteSize: row.byte_size ?? null,
    createdAt: row.created_at,
    signedUrl,
  };
}

export function toParentHistoryItem(row: ParentHistoryRowShape): ParentOrderHistoryItem {
  return {
    previousStatus: safeStatus(row.previous_status),
    newStatus: safeStatus(row.new_status) ?? "pending_review",
    parentVisibleNote: row.parent_visible_note || null,
    createdAt: row.created_at,
  };
}

/* ── PATCH /status input parsing (pure, route-level) ────────────────────────── */

export type ParseStatusUpdateResult =
  | { ok: true; input: AdminStatusUpdateInput }
  | { ok: false; status: number; error: string; code: FulfilmentApiErrorCode };

const STATUS_UPDATE_ALLOWED_KEYS = ["status", "expectedUpdatedAt", "internalNote", "parentVisibleNote"];

export function parseAdminStatusUpdateInput(raw: unknown): ParseStatusUpdateResult {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, status: 400, error: "درخواست نامعتبر است", code: "REQUEST_INVALID_BODY" };
  }
  const obj = raw as Record<string, unknown>;
  if (Object.keys(obj).some((k) => !STATUS_UPDATE_ALLOWED_KEYS.includes(k))) {
    return { ok: false, status: 400, error: "درخواست نامعتبر است", code: "REQUEST_INVALID_BODY" };
  }

  const { status, expectedUpdatedAt } = obj;
  if (typeof status !== "string" || !isKnownOrderStatus(status)) {
    return {
      ok: false,
      status: 422,
      error: "وضعیت ارسال‌شده معتبر نیست",
      code: "REQUEST_INVALID_STATUS",
    };
  }
  if (typeof expectedUpdatedAt !== "string" || Number.isNaN(new Date(expectedUpdatedAt).getTime())) {
    return {
      ok: false,
      status: 400,
      error: "expectedUpdatedAt نامعتبر است",
      code: "REQUEST_INVALID_BODY",
    };
  }

  const internalNote = normalizeNote(obj.internalNote);
  if (!internalNote.ok) {
    return {
      ok: false,
      status: internalNote.code === "request_note_too_long" ? 422 : 400,
      error:
        internalNote.code === "request_note_too_long"
          ? "متن یادداشت نباید بیشتر از ۲۰۰۰ نویسه باشد"
          : "یادداشت نامعتبر است",
      code: internalNote.code === "request_note_too_long" ? "REQUEST_NOTE_TOO_LONG" : "REQUEST_INVALID_BODY",
    };
  }
  const parentVisibleNote = normalizeNote(obj.parentVisibleNote);
  if (!parentVisibleNote.ok) {
    return {
      ok: false,
      status: parentVisibleNote.code === "request_note_too_long" ? 422 : 400,
      error:
        parentVisibleNote.code === "request_note_too_long"
          ? "متن یادداشت نباید بیشتر از ۲۰۰۰ نویسه باشد"
          : "یادداشت نامعتبر است",
      code:
        parentVisibleNote.code === "request_note_too_long" ? "REQUEST_NOTE_TOO_LONG" : "REQUEST_INVALID_BODY",
    };
  }

  return {
    ok: true,
    input: {
      status,
      expectedUpdatedAt: new Date(expectedUpdatedAt).toISOString(),
      internalNote: internalNote.value,
      parentVisibleNote: parentVisibleNote.value,
    },
  };
}
