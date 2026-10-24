import { isKnownRequestCode } from "./request-rpc-error";
import { toPaymentSource, type PaymentSource } from "@/lib/credits/welcome-image-credits";

/**
 * Strict validators for the backend's request-submission answers (V0.1.50).
 * Pure. Anything they throw on becomes `invalid_response` in the backend
 * client, which for the WRITE is an uncertain outcome (never "not saved"), so
 * a malformed or widened body can never decide a financial result. Each
 * success body is rebuilt with only its documented fields.
 */

export interface BackendRequestOrder {
  orderId: string;
  type: string;
  status: string;
  candyCost: number;
  paymentSource: PaymentSource;
}

export interface BackendCreatedRequest extends BackendRequestOrder {
  /** The ORIGINAL order was returned for an already-used submission key. */
  replayed: boolean;
}

export type BackendRequestWriteOutcome =
  | { kind: "created"; value: BackendCreatedRequest }
  | { kind: "rejected"; status: number; error: string };

export type BackendRequestLookupOutcome =
  | { kind: "found"; value: BackendRequestOrder }
  | { kind: "absent" }
  | { kind: "rejected"; status: number; error: string };

/** Statuses the write may answer with. 5xx other than the documented 503 are errors (uncertain). */
export const REQUEST_WRITE_ACCEPT_STATUSES = [400, 401, 402, 403, 404, 409, 422, 503] as const;
export const REQUEST_LOOKUP_ACCEPT_STATUSES = [400, 401, 403, 404] as const;

const AUTH_ERRORS = {
  401: ["unauthenticated", "session_expired", "session_invalidated"],
  403: ["identity_not_linked", "forbidden"],
} as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function errorOf(json: unknown): string {
  const error = (json as { error?: unknown } | null)?.error;
  if (typeof error !== "string") throw new Error("error");
  return error;
}

function order(json: Record<string, unknown>): BackendRequestOrder {
  const { orderId, type, status, candyCost, paymentSource } = json;
  if (typeof orderId !== "string" || !UUID.test(orderId)) throw new Error("orderId");
  if (typeof type !== "string" || typeof status !== "string") throw new Error("type/status");
  if (typeof candyCost !== "number" || !Number.isInteger(candyCost) || candyCost < 0) throw new Error("candyCost");
  if (typeof paymentSource !== "string") throw new Error("paymentSource");
  return { orderId, type, status, candyCost, paymentSource: toPaymentSource(paymentSource) };
}

function isObject(json: unknown): json is Record<string, unknown> {
  return json !== null && typeof json === "object" && !Array.isArray(json);
}

export function parseBackendRequestWrite(json: unknown, status: number): BackendRequestWriteOutcome {
  if (status === 200) {
    if (!isObject(json)) throw new Error("body");
    if (typeof json.replayed !== "boolean") throw new Error("replayed");
    return { kind: "created", value: { ...order(json), replayed: json.replayed } };
  }
  const error = errorOf(json);
  const allowed =
    status === 400 ? error === "invalid_request"
    : status === 401 ? (AUTH_ERRORS[401] as readonly string[]).includes(error)
    : status === 402 ? error === "INSUFFICIENT_CANDIES"
    : status === 403 ? (AUTH_ERRORS[403] as readonly string[]).includes(error) || isKnownRequestCode(error)
    : status === 404 ? error === "parent_profile_not_found"
    : status === 409 ? error === "replayed_request" || error === "CANDY_WALLET_NOT_FOUND"
    : status === 422 ? error === "character_unavailable" || error === "request_failed" || isKnownRequestCode(error)
    : status === 503 ? error === "CREATION_PRICING_UNAVAILABLE" || error === "service_unavailable"
    : false;
  if (!allowed) throw new Error("unexpected backend body");
  return { kind: "rejected", status, error };
}

export function parseBackendRequestLookup(json: unknown, status: number): BackendRequestLookupOutcome {
  if (status === 200) {
    if (!isObject(json)) throw new Error("body");
    if (json.found === false) return { kind: "absent" };
    if (json.found !== true) throw new Error("found");
    return { kind: "found", value: order(json) };
  }
  const error = errorOf(json);
  const allowed =
    status === 400 ? error === "invalid_request"
    : status === 401 ? (AUTH_ERRORS[401] as readonly string[]).includes(error)
    : status === 403 ? (AUTH_ERRORS[403] as readonly string[]).includes(error)
    : status === 404 ? error === "parent_profile_not_found"
    : false;
  if (!allowed) throw new Error("unexpected backend body");
  return { kind: "rejected", status, error };
}
