import type { ParentOrderStatus, ParentOrderSummary } from "./types";
import { PARENT_STATUS_LABELS } from "./status-mapping";
import { isKnownOrderType } from "./type-mapping";
import { decodeOrdersCursor } from "./pagination";

/**
 * Strict validator for the backend's GET /v1/parent/orders answers (V0.1.45).
 * Pure. The Next BFF passes it to the backend client as `parse`; anything it
 * throws on becomes `invalid_response` (a safe 503), so a malformed or
 * widened backend body can never reach the browser.
 *
 * The 200 body is rebuilt field by field: only the seven ParentOrderSummary
 * fields are kept, so an extra column the backend might add is dropped here.
 */

export type BackendOrdersOutcome =
  | { kind: "page"; orders: ParentOrderSummary[]; nextCursor: string | null }
  | { kind: "rejected"; status: 400; error: "invalid_request" }
  | { kind: "rejected"; status: 401; error: "unauthenticated" | "session_expired" | "session_invalidated" }
  | { kind: "rejected"; status: 403; error: "identity_not_linked" | "forbidden" }
  | { kind: "rejected"; status: 404; error: "parent_profile_not_found" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;
const STATUSES = Object.keys(PARENT_STATUS_LABELS) as ParentOrderStatus[];
const MAX_ORDERS = 50;

const ERRORS: Record<number, readonly string[]> = {
  400: ["invalid_request"],
  401: ["unauthenticated", "session_expired", "session_invalidated"],
  403: ["identity_not_linked", "forbidden"],
  404: ["parent_profile_not_found"],
};

function order(raw: unknown): ParentOrderSummary {
  const o = (raw ?? {}) as Record<string, unknown>;
  if (typeof o.id !== "string" || !UUID.test(o.id)) throw new Error("order.id");
  if (typeof o.requestType !== "string" || !isKnownOrderType(o.requestType)) throw new Error("order.requestType");
  if (typeof o.createdAt !== "string" || !TIMESTAMP.test(o.createdAt)) throw new Error("order.createdAt");
  if (typeof o.displayTitle !== "string" || o.displayTitle.length === 0 || o.displayTitle.length > 500) throw new Error("order.displayTitle");
  if (typeof o.status !== "string" || !(STATUSES as string[]).includes(o.status)) throw new Error("order.status");
  if (typeof o.candyCost !== "number" || !Number.isSafeInteger(o.candyCost) || o.candyCost < 0) throw new Error("order.candyCost");
  if (o.completedAt !== null && (typeof o.completedAt !== "string" || !TIMESTAMP.test(o.completedAt))) throw new Error("order.completedAt");
  return {
    id: o.id,
    requestType: o.requestType,
    createdAt: o.createdAt,
    displayTitle: o.displayTitle,
    status: o.status as ParentOrderStatus,
    candyCost: o.candyCost,
    completedAt: o.completedAt as string | null,
  };
}

export function parseBackendOrders(json: unknown, status: number): BackendOrdersOutcome {
  const body = (json ?? {}) as Record<string, unknown>;
  if (status === 200) {
    if (!Array.isArray(body.orders) || body.orders.length > MAX_ORDERS) throw new Error("orders");
    const next = body.nextCursor;
    if (next !== null && (typeof next !== "string" || decodeOrdersCursor(next) === null)) throw new Error("nextCursor");
    const orders = body.orders.map(order);
    if (new Set(orders.map((o) => o.id)).size !== orders.length) throw new Error("duplicate order ids");
    return { kind: "page", orders, nextCursor: next as string | null };
  }
  if (typeof body.error === "string" && ERRORS[status]?.includes(body.error)) {
    return { kind: "rejected", status, error: body.error } as BackendOrdersOutcome;
  }
  throw new Error("unexpected backend body");
}
